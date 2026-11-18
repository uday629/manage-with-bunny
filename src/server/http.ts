// Minimal hardened HTTP router: strict origin policy, security headers, JSON size limits,
// safe error responses (no stack traces), per-route auth/permission/rate-limit options.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_ORIGIN } from '../shared/joincode';
import type { Perm } from '../shared/perms';
import { log } from './log';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message || code); }
}
export const bad = (msg: string) => new HttpError(400, 'bad_request', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);

export interface AuthUser {
  id: string; username: string; displayName: string; roleId: string | null; managerId: string | null;
  isOwner: boolean; perms: Set<Perm>; sessionId: string;
}

export interface Ctx {
  req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; ip: string;
  user: AuthUser; body: any;
}

type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface RouteOpts { auth?: boolean; perm?: Perm; raw?: boolean; limit?: number; rate?: { key: string; max: number; windowMs: number } }
interface Route { method: string; re: RegExp; keys: string[]; h: Handler; o: RouteOpts }

// ---------- rate limiting (fixed window per key) ----------
const buckets = new Map<string, { n: number; reset: number }>();
export function rateHit(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
export function rateReset(key: string) { buckets.delete(key); }
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

// ---------- router ----------
export class Router {
  private routes: Route[] = [];
  authenticate: (req: IncomingMessage, ip: string) => AuthUser | null = () => null;

  add(method: string, pattern: string, h: Handler, o: RouteOpts = {}) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{1,64})'; }) + '$');
    this.routes.push({ method, re, keys, h, o: { auth: true, ...o } });
  }
  get(p: string, h: Handler, o?: RouteOpts) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: RouteOpts) { this.add('POST', p, h, o); }
  put(p: string, h: Handler, o?: RouteOpts) { this.add('PUT', p, h, o); }
  patch(p: string, h: Handler, o?: RouteOpts) { this.add('PATCH', p, h, o); }
  del(p: string, h: Handler, o?: RouteOpts) { this.add('DELETE', p, h, o); }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const origin = req.headers.origin;
    baseHeaders(res);
    if (origin) {
      if (origin !== APP_ORIGIN) return sendErr(res, new HttpError(403, 'origin', 'Origin not allowed.'));
      res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204).end();
      return;
    }
    let url: URL;
    try { url = new URL(req.url || '/', 'https://host.local'); } catch { return sendErr(res, bad('Bad URL.')); }
    const route = this.routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return sendErr(res, notFound());
    const m = route.re.exec(url.pathname)!;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = m[i + 1]));
    try {
      if (!rateHit('ip:' + ip, 1200, 60000)) throw new HttpError(429, 'rate', 'Too many requests. Slow down.');
      let user: AuthUser | null = null;
      if (route.o.auth) {
        user = this.authenticate(req, ip);
        if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in again.');
        if (route.o.perm && !user.perms.has(route.o.perm)) throw forbidden();
      }
      if (route.o.rate) {
        const k = `${route.o.rate.key}:${user ? user.id : ip}`;
        if (!rateHit(k, route.o.rate.max, route.o.rate.windowMs)) throw new HttpError(429, 'rate', 'Too many attempts. Please wait a moment.');
      }
      let body: any = undefined;
      if (!route.o.raw && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) body = await readJson(req, route.o.limit ?? 256 * 1024);
      const out = await route.h({ req, res, url, params, ip, user: user as AuthUser, body });
      if (res.writableEnded || res.headersSent) return;
      sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      sendErr(res, e);
    }
  }
}

export function baseHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function sendErr(res: ServerResponse, e: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message });
  log.error('unhandled', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split('\n').slice(0, 4).join(' | ') : undefined });
  sendJson(res, 500, { error: 'internal', message: 'Something went wrong on the host. Please try again.' });
}

function readJson(req: IncomingMessage, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, 'too_large', 'Request too large.')); }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new HttpError(413, 'too_large', 'Request too large.')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      if (!ct.startsWith('application/json')) return reject(new HttpError(415, 'content_type', 'Expected JSON.'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(bad('Expected a JSON object.'));
        resolve(v);
      } catch { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// ---------- validation helpers ----------
export function str(v: unknown, name: string, min: number, max: number, opts: { trim?: boolean; multiline?: boolean } = {}): string {
  if (typeof v !== 'string') throw bad(`${name} is required.`);
  let s = opts.trim === false ? v : v.trim();
  // strip control chars (keep newlines/tabs for multiline fields)
  s = opts.multiline ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, '');
  if (s.length < min) throw bad(min <= 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
}
export function optStr(v: unknown, name: string, max: number, multiline = false): string {
  if (v === undefined || v === null || v === '') return '';
  return str(v, name, 0, max, { multiline });
}
export function id(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw bad(`Invalid ${name}.`);
  return v;
}
export function optId(v: unknown, name = 'id'): string | null {
  if (v === undefined || v === null || v === '') return null;
  return id(v, name);
}
export function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' && v !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw bad(`Invalid ${name}.`);
  return n;
}
export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw bad(`Invalid ${name}.`);
  return v as T;
}
export function b64(v: unknown, name: string, minBytes: number, maxBytes: number): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) throw bad(`Invalid ${name}.`);
  const n = Buffer.from(v, 'base64').length;
  if (n < minBytes || n > maxBytes) throw bad(`Invalid ${name}.`);
  return v;
}
export function safeUrl(v: unknown): string {
  const s = str(v, 'Link', 1, 2000);
  let u: URL;
  try { u = new URL(s); } catch { throw bad('Links must be full http(s) URLs.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Links must start with http:// or https://');
  return u.toString();
}
export const monthKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export function monthRange(m: string): [number, number] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad('Invalid month.');
  const [y, mo] = m.split('-').map(Number);
  return [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime()];
}
