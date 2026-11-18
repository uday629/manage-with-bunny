// Renderer data layer: REST client with auto-reconnect, realtime WebSocket, offline outbox,
// resumable uploads and a tiny global store.
import { useSyncExternalStore } from 'react';
import type { Perm } from '../shared/perms';

// ------------------------------------------------------------------ types
export interface User { id: string; username: string; displayName: string; title: string; roleId: string | null; managerId: string | null; status: string; isOwner: boolean; color: string; pubkey: string; online: boolean; lastSeen: number | null; reports?: number; avatarVer?: number; isRemote?: boolean; caretakerId?: string | null; remoteNote?: string }
export interface Role { id: string; name: string; rank: number; color: string; perms: Perm[]; isOwner: boolean; members?: number }
export interface FileInfo { id: string; name: string; size: number; mime: string; version: number; versions?: number; ext?: string; uploaderId?: string; scope?: string; scopeId?: string; groupId?: string; createdAt?: number; sha?: string }
export interface Msg { id: number; convId: string; senderId: string | null; kind: 'text' | 'file' | 'system'; body: string; e2e: boolean; replyTo: number | null; clientId: string | null; createdAt: number; editedAt: number | null; deleted: boolean; file: FileInfo | null; plain?: string | null; pending?: 'sending' | 'failed'; localFile?: string }
export interface Conv { id: string; type: 'dm' | 'group'; name: string; createdBy: string; lastMsgAt: number; unread: number; muted: boolean; isAdmin: boolean; lastReadId: number; members: string[]; last: Msg | null }
export interface Task { client?: string; hoursSpent?: number | null; rating?: number | null; id: string; title: string; description: string; links: string[]; assignerId: string | null; assigneeId: string | null; parentId: string | null; status: string; priority: string; dueAt: number | null; createdAt: number; updatedAt: number; startedAt: number | null; submittedAt: number | null; completedAt: number | null; revisions: number; subtasks: number; files: number }
export interface Me { user: User; perms: Perm[]; workspace: { id: string; name: string }; roles: Role[] }
export interface Upload { id: string; name: string; size: number; sent: number; status: 'queued' | 'uploading' | 'paused' | 'done' | 'error'; error?: string; speed: number; scopeId: string }
export interface Toast { id: number; kind: 'ok' | 'err' | 'info'; text: string }
export interface AppState {
  mode: 'host' | 'member' | null; version: string; platform: string; signedIn: boolean; sessionLost?: boolean; pending: boolean; online: boolean; autoStart: boolean; closeToTray: boolean;
  workspace: { wid: string; name: string; username?: string; userId?: string; port: number; lastAddr: string } | null;
  host: { running: boolean; port: number; fp: string; name: string; filesDir: string; joinCode: string; addresses: string[]; error: string | null; dataDir?: string; movePct?: number } | null;
}

type BridgeFn = (...a: any[]) => Promise<any>;
export const bunny = (window as any).bunny as Record<string, BridgeFn> & { onEvent(cb: (ch: string, p: any) => void): () => void };

// ------------------------------------------------------------------ store
export interface Store {
  app: AppState | null; conn: 'online' | 'connecting' | 'offline'; me: Me | null; users: Record<string, User>;
  convs: Conv[]; msgs: Record<string, Msg[]>; typing: Record<string, { userId: string; until: number }>; pending: number;
  uploads: Upload[]; toasts: Toast[]; ver: { tasks: number; sheets: number; users: number; files: number; worklog: number; avatars: number }; route: string; routeArg: string | null;
  downloads: Record<string, { received: number; total: number; state: string }>;
  jump: { convId: string; msgId: number } | null;
}
let state: Store = {
  app: null, conn: 'connecting', me: null, users: {}, convs: [], msgs: {}, typing: {}, pending: 0, uploads: [], toasts: [],
  ver: { tasks: 0, sheets: 0, users: 0, files: 0, worklog: 0, avatars: 0 }, route: 'home', routeArg: null, downloads: {}, jump: null,
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<Store> | ((s: Store) => Partial<Store>)) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  for (const s of subs) s();
}
export function useStore<T>(sel: (s: Store) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state));
}
export const bump = (k: keyof Store['ver']) => setState((s) => ({ ver: { ...s.ver, [k]: s.ver[k] + 1 } }));
export function navigate(route: string, arg: string | null = null) { setState({ route, routeArg: arg }); }

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'err' ? 6000 : 3500);
}
export const can = (p: Perm) => !!state.me?.perms.includes(p);

// ------------------------------------------------------------------ REST
export class ApiError extends Error { constructor(public status: number, msg: string, public code = '') { super(msg); } }
let base: string | null = null;
let token: string | null = null;

export async function initSession(): Promise<boolean> {
  const s = await bunny.session();
  if (!s) return false;
  token = s.token; base = s.base;
  return true;
}
async function reconnectBase() {
  setState({ conn: 'connecting' });
  base = await bunny.reconnect().catch(() => null);
  return base;
}
export function clearSession() { token = null; base = null; ws?.close(); ws = null; wsStop = true; }

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { retry?: boolean; raw?: Blob; signal?: AbortSignal } = {}): Promise<T> {
  const retry = opts.retry ?? method === 'GET';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!base) await reconnectBase();
    if (!base || !token) { if (attempt < 2 && retry) { await sleep(1500); continue; } throw new ApiError(0, 'Not connected to the host. Reconnecting...'); }
    let res: Response;
    try {
      res = await fetch(base + path, {
        method, signal: opts.signal,
        headers: { Authorization: 'Bearer ' + token, ...(opts.raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      if (attempt < 2 && retry) { await sleep(600 * (attempt + 1)); await reconnectBase(); continue; }
      void reconnectBase();
      throw new ApiError(0, 'Connection lost. Reconnecting to the host...');
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* */ }
    if (res.status === 401) { await handleSignedOut(); throw new ApiError(401, 'Your session ended. Please sign in again.'); }
    if (!res.ok) throw new ApiError(res.status, json?.message || 'Request failed', json?.error);
    return json as T;
  }
  throw new ApiError(0, 'Not connected.');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let signedOutHandler: () => void = () => {};
export function onSignedOut(fn: () => void) { signedOutHandler = fn; }
async function handleSignedOut() { clearSession(); await bunny.signedOut().catch(() => {}); signedOutHandler(); }

// ------------------------------------------------------------------ realtime
let ws: WebSocket | null = null;
let wsStop = false;
let wsFails = 0;
let pingTimer: number | undefined;
let lastPong = Date.now();
const listeners = new Set<(ev: any) => void>();
export function onRealtime(fn: (ev: any) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export function connectRealtime() {
  wsStop = false;
  if (!base || !token || (ws && ws.readyState <= 1)) return;
  setState({ conn: 'connecting' });
  const sock = new WebSocket(base.replace(/^https/, 'wss') + '/ws');
  ws = sock;
  sock.onopen = () => { sock.send(JSON.stringify({ t: 'auth', token })); };
  sock.onmessage = (e) => {
    let ev: any; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.t === 'pong') { lastPong = Date.now(); return; }
    if (ev.t === 'ready') { wsFails = 0; lastPong = Date.now(); setState({ conn: 'online' }); void resync(); }
    if (ev.t === 'kicked') { void handleSignedOut(); return; }
    for (const l of listeners) l(ev);
  };
  sock.onclose = (e) => {
    if (ws === sock) ws = null;
    window.clearInterval(pingTimer);
    if (wsStop) return;
    if (e.code === 4003) { void handleSignedOut(); return; }
    setState({ conn: wsFails > 1 ? 'offline' : 'connecting' });
    wsFails++;
    const delay = Math.min(8000, 400 * 2 ** Math.min(wsFails, 5));
    setTimeout(async () => { if (wsStop) return; if (wsFails >= 2) await reconnectBase(); connectRealtime(); }, delay);
  };
  window.clearInterval(pingTimer);
  pingTimer = window.setInterval(() => {
    if (sock.readyState !== 1) return;
    if (Date.now() - lastPong > 45000) { sock.close(); return; }
    sock.send('{"t":"ping"}');
  }, 15000);
}
export function sendTyping(convId: string) { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'typing', convId })); }

// ------------------------------------------------------------------ data loaders
export async function loadMe() { const me = await api<Me>('GET', '/api/me'); setState({ me }); return me; }
export async function loadUsers() {
  const list = await api<User[]>('GET', '/api/users');
  const users: Record<string, User> = {};
  for (const u of list) users[u.id] = u;
  setState({ users });
  bump('users');
}
export async function loadConvs() {
  const convs = await api<Conv[]>('GET', '/api/convs');
  await decryptMsgs(convs.map((c) => c.last).filter(Boolean) as Msg[], convs);
  setState({ convs });
  updateBadge();
}
export async function loadPending() { if (!can('users.approve')) return; const p = await api<any[]>('GET', '/api/users/pending'); setState({ pending: p.length }); }

function updateBadge() { const n = state.convs.reduce((a, c) => a + (c.muted ? 0 : c.unread), 0); void bunny.setBadge(n).catch(() => {}); }

export function peerOf(conv: Conv): User | null {
  if (conv.type !== 'dm') return null;
  const me = state.me?.user.id;
  const other = conv.members.find((m) => m !== me);
  return other ? state.users[other] || null : null;
}

export async function decryptMsgs(msgs: Msg[], convs = state.convs) {
  const items: { m: Msg; peerPub: string }[] = [];
  for (const m of msgs) {
    if (!m.e2e || m.plain !== undefined || !m.body) continue;
    const conv = convs.find((c) => c.id === m.convId);
    const peer = conv ? peerOf(conv) : null;
    if (peer?.pubkey) items.push({ m, peerPub: peer.pubkey });
  }
  if (!items.length) return;
  const out: (string | null)[] = await bunny.decryptMany(items.map((i) => ({ convId: i.m.convId, peerPub: i.peerPub, body: i.m.body }))).catch(() => []);
  items.forEach((it, i) => { it.m.plain = out[i] ?? null; });
}
export const textOf = (m: Msg) => (m.e2e ? (m.plain === undefined ? '' : m.plain ?? '[This message could not be decrypted. A security key changed.]') : m.body);

export async function loadMessages(convId: string, before?: number) {
  const r = await api<{ messages: Msg[]; reads: { user_id: string; last_read_id: number }[] }>('GET', `/api/convs/${convId}/messages?limit=60${before ? '&before=' + before : ''}`);
  await decryptMsgs(r.messages);
  setState((s) => {
    const cur = before ? s.msgs[convId] || [] : (s.msgs[convId] || []).filter((m) => m.pending);
    const merged = mergeMsgs(before ? [...r.messages, ...cur] : [...r.messages, ...cur]);
    return { msgs: { ...s.msgs, [convId]: merged } };
  });
  return r;
}
// Jump to a message (from search): replace the loaded window with messages around it.
export async function loadAround(convId: string, msgId: number) {
  const r = await api<{ messages: Msg[]; reads: { user_id: string; last_read_id: number }[] }>('GET', `/api/convs/${convId}/messages?limit=80&around=${msgId}`);
  await decryptMsgs(r.messages);
  setState((s) => ({ msgs: { ...s.msgs, [convId]: mergeMsgs([...r.messages, ...(s.msgs[convId] || []).filter((m) => m.pending)]) } }));
  return r;
}

// ---- search: group messages on the host (full-text index), direct messages on this device (they are end-to-end encrypted)
export interface Hit { convId: string; msgId: number; senderId: string | null; createdAt: number; text: string; file?: string }
const dmCache = new Map<string, { lastId: number; items: { id: number; senderId: string | null; createdAt: number; text: string; file?: string }[] }>();
async function dmIndex(conv: Conv) {
  const lastId = conv.last?.id || 0;
  const hit = dmCache.get(conv.id);
  if (hit && hit.lastId >= lastId) return hit.items;
  const all: Msg[] = [];
  let before: number | undefined;
  for (let page = 0; page < 10; page++) { // newest 2000 messages per direct chat
    const r = await api<{ messages: Msg[] }>('GET', `/api/convs/${conv.id}/messages?limit=200${before ? '&before=' + before : ''}`);
    all.push(...r.messages);
    if (r.messages.length < 200) break;
    before = r.messages[0].id;
  }
  await decryptMsgs(all);
  const items = all.filter((m) => !m.deleted && m.kind !== 'system').map((m) => ({ id: m.id, senderId: m.senderId, createdAt: m.createdAt, text: textOf(m), file: m.file?.name }));
  dmCache.set(conv.id, { lastId, items });
  return items;
}
export async function searchMessages(q: string): Promise<Hit[]> {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const server = await api<{ messages: Msg[]; files: Msg[] }>('GET', `/api/search?q=${encodeURIComponent(q.trim())}`);
  const hits: Hit[] = [...server.messages, ...server.files].map((m) => ({ convId: m.convId, msgId: m.id, senderId: m.senderId, createdAt: m.createdAt, text: m.body, file: m.file?.name }));
  for (const c of state.convs.filter((x) => x.type === 'dm')) {
    for (const m of await dmIndex(c)) {
      if (m.text.toLowerCase().includes(needle) || (m.file || '').toLowerCase().includes(needle)) hits.push({ convId: c.id, msgId: m.id, senderId: m.senderId, createdAt: m.createdAt, text: m.text, file: m.file });
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => { const k = h.convId + ':' + h.msgId; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
export type Cell = string | number | boolean | null;
export interface ExportTable { title: string; subtitle?: string; columns: string[]; rows: Cell[][] }
export async function exportTable(format: 'xlsx' | 'pdf', table: ExportTable) {
  try {
    const r = await bunny.exportTable({ format, table });
    if (r) toast(`Saved ${format === 'pdf' ? 'PDF' : 'Excel file'} (${table.rows.length} rows)`, 'ok');
  } catch (e) { toast((e as Error).message, 'err'); }
}
export const isVoice = (f: { name: string; mime: string } | null | undefined) => !!f && f.name.startsWith('voice-') && f.mime.startsWith('audio/');

function mergeMsgs(list: Msg[]) {
  const byKey = new Map<string, Msg>();
  for (const m of list) {
    const k = m.clientId && m.pending ? 'c:' + m.clientId : 'i:' + m.id;
    if (!m.pending && m.clientId) byKey.delete('c:' + m.clientId);
    if (m.pending && [...byKey.values()].some((x) => !x.pending && x.clientId === m.clientId)) continue;
    byKey.set(k, m);
  }
  return [...byKey.values()].sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.id - b.id);
}

async function resync() {
  try {
    await Promise.all([loadMe(), loadUsers()]);
    await loadConvs();
    await loadPending();
    const open = state.route === 'chat' ? state.routeArg : null;
    if (open) await loadMessages(open);
    void flushOutbox();
    bump('tasks'); bump('files');
  } catch { /* next reconnect retries */ }
}

// ------------------------------------------------------------------ messaging with outbox
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
interface Outgoing { convId: string; text: string; clientId: string; replyTo: number | null; fileId?: string }
const outbox: Outgoing[] = [];

export async function sendMessage(convId: string, text: string, replyTo: number | null = null, fileId?: string) {
  const o: Outgoing = { convId, text, clientId: rid(), replyTo, fileId };
  const me = state.me!.user.id;
  const temp: Msg = { id: Date.now(), convId, senderId: me, kind: fileId ? 'file' : 'text', body: text, e2e: false, plain: text, replyTo, clientId: o.clientId, createdAt: Date.now(), editedAt: null, deleted: false, file: null, pending: 'sending' };
  if (!fileId) setState((s) => ({ msgs: { ...s.msgs, [convId]: [...(s.msgs[convId] || []), temp] } }));
  outbox.push(o);
  await deliver(o);
}
async function deliver(o: Outgoing) {
  const conv = state.convs.find((c) => c.id === o.convId);
  try {
    let body = o.text;
    let e2e = false;
    if (conv?.type === 'dm') {
      const peer = peerOf(conv);
      if (!peer) throw new ApiError(400, 'Recipient not found.');
      body = o.text ? await bunny.encrypt({ convId: o.convId, peerPub: peer.pubkey, text: o.text }) : '';
      e2e = true;
    }
    const m = await api<Msg>('POST', `/api/convs/${o.convId}/messages`, { body, e2e, clientId: o.clientId, replyTo: o.replyTo, fileId: o.fileId }, { retry: true });
    m.plain = e2e ? o.text : undefined;
    outbox.splice(outbox.indexOf(o), 1);
    addMessage(m);
  } catch (e) {
    const err = e as ApiError;
    if (err.status && err.status !== 0) { // permanent failure
      outbox.splice(outbox.indexOf(o), 1);
      markPending(o, 'failed');
      toast(err.message, 'err');
    } else markPending(o, 'sending'); // stays in outbox, retried on reconnect
  }
}
function markPending(o: Outgoing, st: 'sending' | 'failed') {
  setState((s) => ({ msgs: { ...s.msgs, [o.convId]: (s.msgs[o.convId] || []).map((m) => (m.clientId === o.clientId && m.pending ? { ...m, pending: st } : m)) } }));
}
async function flushOutbox() { for (const o of [...outbox]) await deliver(o); }
export function retryFailed(m: Msg) {
  setState((s) => ({ msgs: { ...s.msgs, [m.convId]: (s.msgs[m.convId] || []).filter((x) => x !== m) } }));
  void sendMessage(m.convId, m.plain ?? m.body, m.replyTo);
}

export function addMessage(m: Msg) {
  setState((s) => {
    const list = mergeMsgs([...(s.msgs[m.convId] || []).filter((x) => !(x.pending && x.clientId && x.clientId === m.clientId)), m]);
    const convs = s.convs.map((c) => (c.id === m.convId ? { ...c, last: m, lastMsgAt: m.createdAt } : c)).sort((a, b) => b.lastMsgAt - a.lastMsgAt);
    return { msgs: { ...s.msgs, [m.convId]: list }, convs };
  });
}

// ------------------------------------------------------------------ profile photos (fetched with the session token, kept as blob URLs)
const avatarCache = new Map<string, string>();
const avatarLoading = new Set<string>();
export function avatarSrc(id: string, ver: number | undefined): string | null {
  if (!ver) return null;
  const key = `${id}:${ver}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  if (!avatarLoading.has(key) && base && token) {
    avatarLoading.add(key);
    fetch(`${base}/api/users/${id}/avatar?v=${ver}`, { headers: { Authorization: 'Bearer ' + token } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b) { for (const [k, u] of avatarCache) if (k.startsWith(id + ':')) { URL.revokeObjectURL(u); avatarCache.delete(k); } avatarCache.set(key, URL.createObjectURL(b)); bump('avatars'); } })
      .catch(() => {})
      .finally(() => avatarLoading.delete(key));
  }
  return null;
}

// ------------------------------------------------------------------ files
const linkCache = new Map<string, { url: string; path: string; exp: number }>();
export async function fileUrl(id: string): Promise<{ url: string; path: string }> {
  const hit = linkCache.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  const r = await api<{ path: string }>('POST', `/api/files/${id}/link`, {});
  const v = { url: base + r.path, path: r.path, exp: Date.now() + 90 * 60000 };
  linkCache.set(id, v);
  return v;
}
export async function downloadFile(f: { id: string; name: string }) {
  const { path } = await fileUrl(f.id);
  await bunny.download({ path, name: f.name });
  toast(`Downloading ${f.name}...`);
}

const queue: { up: Upload; file: File; scope: 'conv' | 'task'; onDone: (f: FileInfo) => void; serverId?: string }[] = [];
let active = 0;
export function uploadFiles(files: File[], scope: 'conv' | 'task', scopeId: string, onDone: (f: FileInfo) => void) {
  for (const file of files) {
    const up: Upload = { id: rid(), name: file.name, size: file.size, sent: 0, status: 'queued', speed: 0, scopeId };
    queue.push({ up, file, scope, onDone });
    setState((s) => ({ uploads: [...s.uploads, up] }));
  }
  pump();
}
function patchUpload(id: string, p: Partial<Upload>) { setState((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) })); }
export function dismissUpload(id: string) {
  const q = queue.find((x) => x.up.id === id);
  if (q) { queue.splice(queue.indexOf(q), 1); if (q.serverId) api('DELETE', `/api/uploads/${q.serverId}`).catch(() => {}); }
  setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
}
function pump() {
  while (active < 2) {
    const next = queue.find((q) => getState().uploads.find((u) => u.id === q.up.id)?.status === 'queued');
    if (!next) return;
    active++;
    patchUpload(next.up.id, { status: 'uploading' });
    runUpload(next).finally(() => { active--; pump(); });
  }
}
async function runUpload(q: (typeof queue)[number]) {
  const id = q.up.id;
  try {
    const init = await api<{ id: string; received: number; chunk: number }>('POST', '/api/uploads', { name: q.file.name, size: q.file.size, scope: q.scope, scopeId: q.up.scopeId });
    q.serverId = init.id;
    let off = 0;
    let fails = 0;
    let t0 = performance.now(), b0 = 0;
    while (off < q.file.size) {
      if (!getState().uploads.find((u) => u.id === id)) return; // cancelled
      try {
        const r = await api<{ received: number }>('PUT', `/api/uploads/${init.id}?offset=${off}`, undefined, { raw: q.file.slice(off, off + init.chunk), retry: false });
        off = r.received; fails = 0;
        const dt = (performance.now() - t0) / 1000;
        if (dt > 0.7) { patchUpload(id, { speed: (off - b0) / dt }); t0 = performance.now(); b0 = off; }
        patchUpload(id, { sent: off, status: 'uploading', error: undefined });
      } catch (e) {
        const err = e as ApiError;
        if (err.status && err.status !== 409 && err.status < 500) throw err;
        if (++fails > 40) throw new ApiError(0, 'Upload stopped: the host is unreachable.');
        patchUpload(id, { status: 'paused', error: 'Waiting for connection...' });
        await sleep(Math.min(10000, 1000 * fails));
        try { const st = await api<{ received: number }>('GET', `/api/uploads/${init.id}`); off = st.received; } catch { /* keep trying */ }
      }
    }
    const f = await api<FileInfo>('POST', `/api/uploads/${init.id}/finish`, {}, { retry: true });
    patchUpload(id, { status: 'done', sent: q.file.size });
    queue.splice(queue.indexOf(q), 1);
    q.onDone(f);
    bump('files');
    setTimeout(() => setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) })), 2500);
  } catch (e) {
    patchUpload(id, { status: 'error', error: (e as Error).message });
  }
}
export function retryUpload(id: string) { patchUpload(id, { status: 'queued', sent: 0, error: undefined }); pump(); }

// ------------------------------------------------------------------ formatting
export const fmtBytes = (n: number) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`; };
export const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
export const fmtDateTime = (t: number) => `${fmtDate(t)}, ${fmtTime(t)}`;
export function fmtAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(t);
}
export const monthNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }); };
export const shiftMonth = (m: string, d: number) => { const [y, mo] = m.split('-').map(Number); const x = new Date(y, mo - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
export const userName = (id: string | null | undefined) => (id ? state.users[id]?.displayName || 'Former member' : 'System');
