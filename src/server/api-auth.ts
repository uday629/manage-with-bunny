import { Router, HttpError, bad, forbidden, str, b64, id as vid, optStr, rateHit, rateReset } from './http';
import { S, settings, audit, sha256, token, safeEq, hashAuthKey, verifyAuthKey, burnVerify, fakeSalt, createSession, publicUser, pickColor, invalidateTree, rolePerms } from './core';
import { newId, now } from './db';
import os from 'node:os';
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address).slice(0, 8);
import { LIMITS, USERNAME_RE, CLIENT_KDF } from '../shared/kdf';
import { DEFAULT_ROLES } from '../shared/perms';

let setupToken = '';
export function setSetupToken(t: string) { setupToken = t; }

function creds(b: any) {
  return {
    salt: b64(b.salt, 'salt', 16, 32),
    authKey: b64(b.authKey, 'authKey', 32, 32),
    pubkey: b64(b.pubkey, 'pubkey', 32, 64),
    encPriv: b64(b.encPriv, 'encPriv', 40, 256),
    device: optStr(b.device, 'Device name', 80),
  };
}
function username(v: unknown) {
  const u = str(v, 'Username', LIMITS.username.min, LIMITS.username.max).toLowerCase();
  if (!USERNAME_RE.test(u)) throw bad('Username may use a-z, 0-9, dot, dash and underscore (3-32 characters).');
  return u;
}

export function meResponse(userId: string, sessionId?: string) {
  const u = S.db.get('SELECT * FROM users WHERE id=?', userId)!;
  const st = settings();
  return {
    user: publicUser(u),
    perms: [...rolePerms(u as any)],
    workspace: { id: S.wid, name: st.name },
    roles: S.db.all('SELECT id,name,rank,color,perms,is_owner FROM roles ORDER BY rank DESC, name').map((r) => ({ ...r, perms: JSON.parse(r.perms), isOwner: !!r.is_owner })),
    sessionId,
  };
}

export function registerAuth(r: Router) {
  r.get('/api/hello', () => ({ app: 'manage-with-bunny', v: 1, wid: S.wid, name: settings().name, setup: !S.db.get('SELECT 1 FROM users WHERE is_owner=1'), addresses: lanIps(), port: S.port }), { auth: false });

  r.get('/api/auth/salt', (c) => {
    const u = username(c.url.searchParams.get('u'));
    const row = S.db.get<{ kdf_salt: string }>("SELECT kdf_salt FROM users WHERE username=? AND status IN ('active','pending')", u);
    return { salt: row?.kdf_salt || fakeSalt(u), kdf: CLIENT_KDF };
  }, { auth: false, rate: { key: 'salt', max: 30, windowMs: 60000 } });

  // First-run: the host process hands main a one-time setup token through the IPC channel.
  r.post('/api/setup/owner', async (c) => {
    const b = c.body;
    if (!setupToken || typeof b.setupToken !== 'string' || !safeEq(b.setupToken, setupToken)) throw forbidden('Setup is not available.');
    if (S.db.get('SELECT 1 FROM users WHERE is_owner=1')) throw forbidden('This workspace already has an owner.');
    const name = str(b.workspaceName, 'Workspace name', 1, 60);
    const uname = username(b.username);
    const display = str(b.displayName, 'Your name', 1, LIMITS.displayName.max);
    const k = creds(b);
    const hash = await hashAuthKey(k.authKey);
    const uid = newId();
    S.db.tx(() => {
      let ownerRole = '';
      for (const t of DEFAULT_ROLES) {
        const rid = newId();
        if (t.name === 'Owner') ownerRole = rid;
        S.db.run('INSERT INTO roles(id,name,rank,color,perms,is_owner,created_at) VALUES(?,?,?,?,?,?,?)', rid, t.name, t.rank, t.color, JSON.stringify(t.perms), t.name === 'Owner' ? 1 : 0, now());
      }
      S.db.run(`INSERT INTO users(id,username,display_name,title,role_id,status,is_owner,kdf_salt,auth_hash,pubkey,enc_priv,color,created_at,approved_at,device_name)
        VALUES(?,?,?,?,?,'active',1,?,?,?,?,?,?,?,?)`, uid, uname, display, 'Owner', ownerRole, k.salt, hash, k.pubkey, k.encPriv, '#FF8A00', now(), now(), k.device);
      S.db.setMeta('workspace_name', name);
    });
    setupToken = '';
    invalidateTree();
    audit(uid, 'workspace.created', name, '', c.ip);
    const t = createSession(uid, k.device, c.ip);
    return { token: t, ...meResponse(uid) };
  }, { auth: false, rate: { key: 'setup', max: 10, windowMs: 60000 } });

  r.post('/api/join', async (c) => {
    const b = c.body;
    const st = settings();
    if (!st.joinOpen) throw forbidden('Joining is paused by the workspace admin.');
    if (typeof b.secret !== 'string' || !st.inviteSecret || !safeEq(b.secret.toLowerCase(), st.inviteSecret)) {
      audit(null, 'join.bad_code', '', '', c.ip);
      throw new HttpError(403, 'bad_code', 'That join code is not valid for this workspace.');
    }
    const uname = username(b.username);
    const display = str(b.displayName, 'Your name', 1, LIMITS.displayName.max);
    const k = creds(b);
    const existing = S.db.get('SELECT status FROM users WHERE username=?', uname);
    if (existing && existing.status !== 'rejected') throw new HttpError(409, 'taken', 'That username is already taken.');
    if (existing) S.db.run("DELETE FROM users WHERE username=? AND status='rejected'", uname);
    const pending = (S.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE status='pending'"))!.n;
    if (pending > 200) throw new HttpError(429, 'busy', 'Too many pending requests. Ask the admin to review them.');
    const hash = await hashAuthKey(k.authKey);
    const pt = token();
    const uid = newId();
    S.db.run(`INSERT INTO users(id,username,display_name,status,kdf_salt,auth_hash,pubkey,enc_priv,color,created_at,pending_token_hash,device_name)
      VALUES(?,?,?,'pending',?,?,?,?,?,?,?,?)`, uid, uname, display, k.salt, hash, k.pubkey, k.encPriv, pickColor(), now(), sha256(pt), k.device);
    audit(uid, 'join.requested', uname, k.device, c.ip);
    const approvers = S.db.all<{ id: string; is_owner: number; role_id: string }>("SELECT id,is_owner,role_id FROM users WHERE status='active'").filter((u) => rolePerms(u as any).has('users.approve')).map((u) => u.id);
    S.hub.send(approvers, { t: 'pending' });
    S.hub.send(approvers, { t: 'notify', title: 'New join request', body: `${display} (@${uname}) wants to join.` });
    return { pendingToken: pt, userId: uid };
  }, { auth: false, rate: { key: 'join', max: 8, windowMs: 15 * 60000 } });

  r.post('/api/join/status', (c) => {
    const pt = typeof c.body.pendingToken === 'string' ? c.body.pendingToken : '';
    if (pt.length < 20 || pt.length > 100) throw bad('Invalid token.');
    const u = S.db.get('SELECT * FROM users WHERE pending_token_hash=?', sha256(pt));
    if (!u) throw new HttpError(404, 'gone', 'This join request no longer exists.');
    if (u.status === 'pending') return { status: 'pending' };
    if (u.status === 'rejected') { S.db.run('UPDATE users SET pending_token_hash=NULL WHERE id=?', u.id); return { status: 'rejected' }; }
    if (u.status !== 'active') return { status: 'rejected' };
    S.db.run('UPDATE users SET pending_token_hash=NULL WHERE id=?', u.id); // one-time
    const t = createSession(u.id, u.device_name, c.ip);
    return { status: 'approved', token: t, ...meResponse(u.id) };
  }, { auth: false, rate: { key: 'jstat', max: 40, windowMs: 60000 } });

  r.post('/api/auth/login', async (c) => {
    const uname = username(c.body.username);
    const authKey = b64(c.body.authKey, 'authKey', 32, 32);
    const device = optStr(c.body.device, 'Device name', 80);
    const lockKey = 'lock:' + uname;
    if (!rateHit(lockKey, 8, 15 * 60000)) {
      audit(null, 'login.locked', uname, '', c.ip);
      throw new HttpError(429, 'locked', 'Too many failed attempts for this account. Try again in 15 minutes.');
    }
    const u = S.db.get('SELECT * FROM users WHERE username=?', uname);
    if (!u) { await burnVerify(authKey); throw new HttpError(401, 'bad_login', 'Wrong username or password.'); }
    const ok = await verifyAuthKey(authKey, u.auth_hash);
    if (!ok) { audit(u.id, 'login.failed', uname, '', c.ip); throw new HttpError(401, 'bad_login', 'Wrong username or password.'); }
    if (u.is_remote) throw new HttpError(403, 'remote', 'This is a remote profile kept by a caretaker. Ask an admin for a reset code to activate it.');
    if (u.status === 'pending') throw new HttpError(403, 'pending', 'Your join request is still waiting for approval.');
    if (u.status !== 'active') throw new HttpError(403, 'disabled', 'This account is not active. Contact your admin.');
    rateReset(lockKey);
    audit(u.id, 'login.ok', device, '', c.ip);
    const t = createSession(u.id, device, c.ip);
    return { token: t, encPriv: u.enc_priv, ...meResponse(u.id) };
  }, { auth: false, rate: { key: 'login', max: 20, windowMs: 5 * 60000 } });

  // Account recovery with an admin-issued one-time code. A new key pair is required, so old private messages stay unreadable (by design).
  r.post('/api/auth/reset', async (c) => {
    const uname = username(c.body.username);
    const code = str(c.body.code, 'Reset code', 8, 64).replace(/[\s-]/g, '').toUpperCase();
    const k = creds(c.body);
    const u = S.db.get("SELECT * FROM users WHERE username=? AND status='active'", uname);
    if (!u || !u.reset_hash || u.reset_expires < now() || !safeEq(sha256(code), u.reset_hash)) {
      audit(u?.id ?? null, 'reset.failed', uname, '', c.ip);
      throw new HttpError(403, 'bad_code', 'That reset code is not valid or has expired.');
    }
    const hash = await hashAuthKey(k.authKey);
    S.db.tx(() => {
      S.db.run('UPDATE users SET kdf_salt=?, auth_hash=?, pubkey=?, enc_priv=?, key_version=key_version+1, reset_hash=NULL, reset_expires=NULL, is_remote=0, caretaker_id=NULL WHERE id=?', k.salt, hash, k.pubkey, k.encPriv, u.id);
      S.db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    });
    S.hub.kick(u.id);
    invalidateTree();
    audit(u.id, u.is_remote ? 'remote.activated' : 'reset.ok', uname, '', c.ip);
    S.hub.send(allActive(), { t: 'users' });
    const t = createSession(u.id, k.device, c.ip);
    return { token: t, ...meResponse(u.id) };
  }, { auth: false, rate: { key: 'reset', max: 6, windowMs: 15 * 60000 } });

  r.get('/api/me', (c) => meResponse(c.user.id, c.user.sessionId));

  r.post('/api/auth/logout', (c) => {
    S.db.run('DELETE FROM sessions WHERE id=?', c.user.sessionId);
    audit(c.user.id, 'logout', '', '', c.ip);
    return { ok: true };
  });

  r.post('/api/auth/password', async (c) => {
    const old = b64(c.body.oldAuthKey, 'oldAuthKey', 32, 32);
    const k = creds(c.body);
    const u = S.db.get('SELECT auth_hash FROM users WHERE id=?', c.user.id)!;
    if (!(await verifyAuthKey(old, u.auth_hash))) { audit(c.user.id, 'password.failed', '', '', c.ip); throw new HttpError(403, 'bad_password', 'Current password is wrong.'); }
    const hash = await hashAuthKey(k.authKey);
    // Same key pair, re-wrapped with the new password (so history stays readable).
    S.db.tx(() => {
      S.db.run('UPDATE users SET kdf_salt=?, auth_hash=?, enc_priv=? WHERE id=?', k.salt, hash, k.encPriv, c.user.id);
      S.db.run('DELETE FROM sessions WHERE user_id=? AND id<>?', c.user.id, c.user.sessionId);
    });
    audit(c.user.id, 'password.changed', '', '', c.ip);
    return { ok: true };
  }, { rate: { key: 'pw', max: 6, windowMs: 15 * 60000 } });

  r.get('/api/auth/sessions', (c) => S.db.all('SELECT id, device_name, ip, created_at, last_used FROM sessions WHERE user_id=? ORDER BY last_used DESC', c.user.id).map((s) => ({ ...s, current: s.id === c.user.sessionId })));
  r.del('/api/auth/sessions/:id', (c) => {
    const sid = vid(c.params.id);
    S.db.run('DELETE FROM sessions WHERE id=? AND user_id=?', sid, c.user.id);
    S.hub.kick(c.user.id, sid);
    audit(c.user.id, 'session.revoked', sid, '', c.ip);
    return { ok: true };
  });
}

export const allActive = () => S.db.all<{ id: string }>("SELECT id FROM users WHERE status='active'").map((r) => r.id);
