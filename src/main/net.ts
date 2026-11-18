// LAN discovery (UDP beacons + subnet scan fallback), TLS fingerprint probing and pinned HTTPS requests.
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import https from 'node:https';
import { BEACON_MAGIC, BEACON_PORT, BEACON_GROUP, normFp } from '../shared/joincode';

export interface Beacon { wid: string; name: string; port: number; fp: string; addr: string; seen: number }

const beacons = new Map<string, Beacon>();
let sock: dgram.Socket | null = null;
let onChange: (() => void) | null = null;

export function startDiscovery(changed: () => void) {
  onChange = changed;
  if (sock) return;
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => { try { sock?.close(); } catch { /* */ } sock = null; setTimeout(() => startDiscovery(changed), 5000); });
  sock.on('message', (buf, rinfo) => {
    if (buf.length > 1024) return;
    let m: any;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m?.m !== BEACON_MAGIC || typeof m.wid !== 'string' || typeof m.fp !== 'string' || !Number.isInteger(m.port)) return;
    if (!/^[0-9a-f]{64}$/.test(m.fp) || m.port < 1 || m.port > 65535) return;
    const key = `${m.wid}|${rinfo.address}`;
    const isNew = !beacons.has(key);
    beacons.set(key, { wid: m.wid.slice(0, 64), name: String(m.name || '').slice(0, 60), port: m.port, fp: m.fp, addr: rinfo.address, seen: Date.now() });
    if (isNew) onChange?.();
  });
  sock.bind(BEACON_PORT, () => {
    try { sock?.setBroadcast(true); } catch { /* */ }
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) { try { sock?.addMembership(BEACON_GROUP, a.address); } catch { /* not multicast capable */ } }
    }
  });
}
export function stopDiscovery() { try { sock?.close(); } catch { /* */ } sock = null; }

export function listBeacons(): Beacon[] {
  const cutoff = Date.now() - 10000;
  for (const [k, b] of beacons) if (b.seen < cutoff) beacons.delete(k);
  return [...beacons.values()];
}

// Connects with TLS and returns the server's certificate fingerprint + PEM. Sends no application data.
export function probeTls(addr: string, port: number, timeoutMs = 2500): Promise<{ fp: string; certPem: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { fp: string; certPem: string } | null) => { if (done) return; done = true; try { s.destroy(); } catch { /* */ } resolve(v); };
    const s = tls.connect({ host: addr, port, rejectUnauthorized: false, timeout: timeoutMs, ALPNProtocols: ['http/1.1'] }, () => {
      const c = s.getPeerCertificate(false);
      if (!c?.raw) return finish(null);
      const pem = `-----BEGIN CERTIFICATE-----\n${c.raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
      finish({ fp: normFp(c.fingerprint256), certPem: pem });
    });
    s.on('error', () => finish(null));
    s.on('timeout', () => finish(null));
    setTimeout(() => finish(null), timeoutMs + 200);
  });
}

function tcpOpen(addr: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: addr, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

// Fallback when broadcasts are blocked: probe the local /24 (or smaller) subnets for the host port.
export async function scanSubnets(port: number, match: (fp: string) => boolean, signal?: { cancelled: boolean }): Promise<{ addr: string; fp: string; certPem: string } | null> {
  const candidates: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number);
    const mask = a.netmask.split('.').map(Number);
    const hostBits = mask.reduce((n, m) => n + (8 - (m.toString(2).match(/1/g)?.length || 0)), 0);
    if (hostBits > 10) { // big network: only scan the /24 we are in
      for (let i = 1; i < 255; i++) candidates.push(`${ip[0]}.${ip[1]}.${ip[2]}.${i}`);
      continue;
    }
    const base = ip.map((o, i) => o & mask[i]);
    const count = 2 ** hostBits;
    const baseNum = ((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3];
    for (let i = 1; i < count - 1; i++) { const n = baseNum + i; candidates.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
  }
  const unique = [...new Set(candidates)];
  let found: { addr: string; fp: string; certPem: string } | null = null;
  let idx = 0;
  const worker = async () => {
    while (!found && !signal?.cancelled && idx < unique.length) {
      const addr = unique[idx++];
      if (await tcpOpen(addr, port, 400)) {
        const p = await probeTls(addr, port, 2000);
        if (p && match(p.fp) && !found) found = { addr, ...p };
      }
    }
  };
  await Promise.all(Array.from({ length: 96 }, worker));
  return found;
}

export interface Pin { addr: string; port: number; fp: string; certPem: string }

// HTTPS request that only succeeds if the server presents exactly the pinned certificate.
export function pinnedRequest(pin: Pin, method: string, p: string, body?: unknown, tokenStr?: string, timeoutMs = 20000): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    if (tokenStr) headers.Authorization = 'Bearer ' + tokenStr;
    const r = https.request({
      host: pin.addr, port: pin.port, path: p, method, headers, timeout: timeoutMs, ca: [pin.certPem], agent: false,
      checkServerIdentity: (_h, cert) => (normFp(cert.fingerprint256) === pin.fp ? undefined : new Error('The host identity does not match. Connection blocked for your safety.')),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 4 * 1024 * 1024) { r.destroy(new Error('Response too large')); return; } chunks.push(c); });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json }); });
    });
    r.on('timeout', () => r.destroy(new Error('The host did not respond in time.')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
