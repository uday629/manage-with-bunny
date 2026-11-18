// Shared host state, authentication, sessions and access-control rules.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { argon2id, argon2Verify } from 'hash-wasm';
import { Db, newId, now } from './db';
import { ALL_PERMS, isPerm, type Perm } from '../shared/perms';
import { SERVER_KDF } from '../shared/kdf';
import { type AuthUser, forbidden, notFound } from './http';

export interface Hub { send(userIds: Iterable<string>, ev: object): void; isOnline(id: string): boolean; kick(userId: string, sessionId?: string): void }

export const S = {
  db: null as unknown as Db,
  dataDir: '', filesDir: '', tmpDir: '', backupDir: '',
  fp: '', wid: '', port: 0,
  hub: null as unknown as Hub,
  secret: Buffer.alloc(0), // HMAC key for fake salts and signed file URLs (never leaves the host)
};

export const SESSION_TTL = 30 * 86400000;

export function settings() {
  const d = S.db;
  return {
    name: d.meta('workspace_name') || 'My Team',
    joinOpen: d.meta('join_open') !== '0',
    maxUploadGB: Number(d.meta('max_upload_gb') || 50),
    blockedExts: (d.meta('blocked_exts') ?? 'exe,msi,bat,cmd,com,scr,pif,ps1,vbs,vbe,js,jse,wsf,wsh,hta,cpl,jar,reg,lnk,dll,sys,sh,command,app,pkg').split(',').filter(Boolean),
    inviteSecret: d.meta('invite_secret') || '',
  };
}

export function audit(actor: string | null, action: string, target = '', detail = '', ip = '') {
  S.db.run('INSERT INTO audit(at,actor_id,action,target,detail,ip) VALUES(?,?,?,?,?,?)', now(), actor, action, target, detail.slice(0, 500), ip);
}

// ---------- hashing / tokens ----------
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const token = () => crypto.randomBytes(32).toString('base64url');
export function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function hashAuthKey(authKeyB64: string): Promise<string> {
  return argon2id({ password: Buffer.from(authKeyB64, 'base64'), salt: crypto.randomBytes(16), parallelism: SERVER_KDF.parallelism, iterations: SERVER_KDF.iterations, memorySize: SERVER_KDF.memoryKiB, hashLength: SERVER_KDF.hashLength, outputType: 'encoded' });
}
export async function verifyAuthKey(authKeyB64: string, hash: string): Promise<boolean> {
  try { return await argon2Verify({ password: Buffer.from(authKeyB64, 'base64'), hash }); } catch { return false; }
}
let dummyHash = '';
export async function burnVerify(authKeyB64: string) { // equalise timing for unknown users
  if (!dummyHash) dummyHash = await hashAuthKey(crypto.randomBytes(32).toString('base64'));
  await verifyAuthKey(authKeyB64, dummyHash);
}
export function fakeSalt(username: string) {
  return crypto.createHmac('sha256', S.secret).update('salt:' + username.toLowerCase()).digest().subarray(0, 16).toString('base64');
}

// ---------- sessions ----------
export function createSession(userId: string, device: string, ip: string) {
  const t = token();
  const ts = now();
  S.db.run('INSERT INTO sessions(id,user_id,token_hash,device_name,ip,created_at,last_used,expires_at) VALUES(?,?,?,?,?,?,?,?)', newId(), userId, sha256(t), device.slice(0, 80), ip, ts, ts, ts + SESSION_TTL);
  return t;
}

export function rolePerms(u: { is_owner: number; role_id: string | null }): Set<Perm> {
  if (u.is_owner) return new Set(ALL_PERMS);
  if (!u.role_id) return new Set();
  const r = S.db.get<{ perms: string }>('SELECT perms FROM roles WHERE id=?', u.role_id);
  let list: unknown[] = [];
  try { list = JSON.parse(r?.perms || '[]'); } catch { /* corrupt row => no perms */ }
  return new Set(list.filter(isPerm));
}

export function authenticateToken(raw: string | undefined | null): AuthUser | null {
  if (!raw || raw.length < 20 || raw.length > 100) return null;
  const s = S.db.get('SELECT s.id sid, s.expires_at, s.last_used, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sha256(raw));
  if (!s) return null;
  const t = now();
  if (s.expires_at < t || s.status !== 'active') return null;
  if (t - s.last_used > 10 * 60000) S.db.run('UPDATE sessions SET last_used=?, expires_at=? WHERE id=?', t, t + SESSION_TTL, s.sid);
  return { id: s.id, username: s.username, displayName: s.display_name, roleId: s.role_id, managerId: s.manager_id, isOwner: !!s.is_owner, perms: rolePerms(s as any), sessionId: s.sid };
}

export function authenticate(req: IncomingMessage): AuthUser | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return authenticateToken(h.slice(7).trim());
}

// ---------- hierarchy (cached, rebuilt when users change) ----------
let tree: { mgr: Map<string, string | null>; kids: Map<string, string[]>; active: Set<string>; remote: Map<string, string | null> } | null = null;
export function invalidateTree() { tree = null; }
function getTree() {
  if (tree) return tree;
  const rows = S.db.all<{ id: string; manager_id: string | null; status: string; is_remote: number; caretaker_id: string | null }>("SELECT id, manager_id, status, is_remote, caretaker_id FROM users WHERE status IN ('active','disabled')");
  const mgr = new Map<string, string | null>(), kids = new Map<string, string[]>(), active = new Set<string>(), remote = new Map<string, string | null>();
  for (const r of rows) {
    mgr.set(r.id, r.manager_id);
    if (r.is_remote) remote.set(r.id, r.caretaker_id);
    if (r.status === 'active') active.add(r.id);
    if (r.manager_id) { const k = kids.get(r.manager_id) || []; k.push(r.id); kids.set(r.manager_id, k); }
  }
  tree = { mgr, kids, active, remote };
  return tree;
}
export function ancestors(id: string): string[] {
  const t = getTree(); const out: string[] = []; const seen = new Set([id]);
  let cur = t.mgr.get(id) ?? null;
  while (cur && !seen.has(cur) && out.length < 64) { out.push(cur); seen.add(cur); cur = t.mgr.get(cur) ?? null; }
  return out;
}
export function descendants(id: string): Set<string> {
  const t = getTree(); const out = new Set<string>(); const q = [...(t.kids.get(id) || [])];
  while (q.length) { const x = q.pop()!; if (out.has(x) || x === id) continue; out.add(x); q.push(...(t.kids.get(x) || [])); }
  return out;
}
export function directReports(id: string): string[] { return [...(getTree().kids.get(id) || [])]; }
export function isActive(id: string) { return getTree().active.has(id); }
// Remote profiles have no login; their caretaker (or a users.manage admin) keeps their work updated.
export function isRemote(id: string | null | undefined) { return !!id && getTree().remote.has(id); }
export function caretakerOf(id: string): string | null { return getTree().remote.get(id) ?? null; }
export function caredFor(userId: string): string[] { return [...getTree().remote].filter(([, c]) => c === userId).map(([id]) => id); }
export function canActFor(u: AuthUser, target: string | null): boolean {
  if (!target) return false;
  if (target === u.id) return true;
  if (!isRemote(target) || !isActive(target)) return false;
  return caretakerOf(target) === u.id || u.perms.has('users.manage') || ancestors(target).includes(u.id);
}
export function wouldCycle(userId: string, newManager: string | null) {
  if (!newManager) return false;
  return newManager === userId || descendants(userId).has(newManager);
}

// People a user may see in directory/org chart.
export function visibleUserIds(u: AuthUser): Set<string> | 'all' {
  if (u.perms.has('org.view_all')) return 'all';
  const set = new Set<string>([u.id, ...ancestors(u.id), ...descendants(u.id)]);
  if (u.managerId) for (const p of directReports(u.managerId)) set.add(p);
  for (const r of caredFor(u.id)) set.add(r);
  for (const r of S.db.all<{ user_id: string }>('SELECT DISTINCT m2.user_id FROM conv_members m1 JOIN conv_members m2 ON m1.conv_id=m2.conv_id WHERE m1.user_id=?', u.id)) set.add(r.user_id);
  return set;
}

export function canStartDm(u: AuthUser, other: string): boolean {
  if (other === u.id || !isActive(other) || isRemote(other)) return false;
  if (u.perms.has('chat.message_anyone')) return true;
  if (u.managerId === other) return true;
  const t = getTree();
  if (t.mgr.get(other) === u.id) return true;
  if (u.managerId && t.mgr.get(other) === u.managerId) return true;
  return false;
}

export function canAssignTo(u: AuthUser, assignee: string): boolean {
  if (!isActive(assignee)) return false;
  return assignee === u.id || u.perms.has('tasks.assign_any') || descendants(u.id).has(assignee);
}

export function taskVisible(u: AuthUser, t: { assigner_id: string | null; assignee_id: string | null }): boolean {
  if (u.perms.has('tasks.view_all')) return true;
  if (t.assigner_id === u.id || t.assignee_id === u.id) return true;
  if (t.assignee_id && ancestors(t.assignee_id).includes(u.id)) return true;
  if (t.assigner_id && ancestors(t.assigner_id).includes(u.id)) return true;
  if (t.assignee_id && isRemote(t.assignee_id) && caretakerOf(t.assignee_id) === u.id) return true;
  return false;
}

export function analyticsVisible(u: AuthUser, target: string): boolean {
  return target === u.id || u.perms.has('analytics.view_all') || descendants(u.id).has(target) || (isRemote(target) && caretakerOf(target) === u.id);
}

export function requireMember(convId: string, userId: string) {
  const m = S.db.get('SELECT c.*, cm.is_admin FROM conversations c JOIN conv_members cm ON cm.conv_id=c.id WHERE c.id=? AND cm.user_id=?', convId, userId);
  if (!m) throw notFound('Conversation not found.');
  return m;
}

export function requireTask(u: AuthUser, taskId: string) {
  const t = S.db.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!t || !taskVisible(u, t as any)) throw notFound('Task not found.');
  return t;
}

// Prevent privilege escalation: an actor may only grant permissions they hold.
export function assertCanGrant(u: AuthUser, perms: Perm[]) {
  if (u.isOwner) return;
  for (const p of perms) if (!u.perms.has(p)) throw forbidden('You cannot grant a permission you do not have.');
}

export function publicUser(r: any) {
  return {
    id: r.id, username: r.username, displayName: r.display_name, title: r.title, roleId: r.role_id, managerId: r.manager_id,
    status: r.status, isOwner: !!r.is_owner, color: r.color, pubkey: r.pubkey, keyVersion: r.key_version,
    online: S.hub?.isOnline(r.id) ?? false, lastSeen: r.last_seen,
    avatarVer: r.avatar_ver || 0,
    isRemote: !!r.is_remote, caretakerId: r.caretaker_id ?? null, remoteNote: r.is_remote ? r.remote_note || '' : '',
  };
}

const COLORS = ['#1F6BFF', '#6A2BFF', '#FF1F56', '#FF8A00', '#11A9C9', '#3FB98B', '#C04BFF', '#FF5E3A'];
export const pickColor = () => COLORS[crypto.randomInt(COLORS.length)];

// Signed, short-lived, user-bound URLs for file content (needed for <video>/<img> which cannot send headers).
export function signFileUrl(fileId: string, userId: string, ttlMs = 2 * 3600000) {
  const exp = Math.floor((now() + ttlMs) / 1000).toString(36);
  const payload = `${fileId}.${userId}.${exp}`;
  const mac = crypto.createHmac('sha256', S.secret).update('file:' + payload).digest('base64url').slice(0, 32);
  return `${payload}.${mac}`;
}
export function verifyFileUrl(tok: string): { fileId: string; userId: string } | null {
  const p = tok.split('.');
  if (p.length !== 4) return null;
  const [fileId, userId, exp, mac] = p;
  const want = crypto.createHmac('sha256', S.secret).update(`file:${fileId}.${userId}.${exp}`).digest('base64url').slice(0, 32);
  if (!safeEq(mac, want)) return null;
  if (parseInt(exp, 36) * 1000 < now()) return null;
  return { fileId, userId };
}
