import crypto from 'node:crypto';
import { Router, HttpError, bad, forbidden, notFound, str, optStr, id as vid, optId, int, safeUrl, type AuthUser } from './http';
import { S, audit, sha256, publicUser, invalidateTree, wouldCycle, visibleUserIds, assertCanGrant, rolePerms, ancestors, descendants, isRemote, caretakerOf, analyticsVisible, pickColor } from './core';
import { allActive } from './api-auth';
import { newId, now } from './db';
import { isPerm, type Perm } from '../shared/perms';
import { LIMITS } from '../shared/kdf';

function roleRow(id: string) {
  const r = S.db.get<any>('SELECT * FROM roles WHERE id=?', id);
  if (!r) throw bad('Role not found.');
  return { ...r, permList: (JSON.parse(r.perms) as unknown[]).filter(isPerm) as Perm[] };
}

// An actor may only manage users whose permissions are a subset of their own (never the owner).
function assertCanManage(actor: AuthUser, target: any) {
  if (target.is_owner && !actor.isOwner) throw forbidden('Only the owner can change the owner account.');
  if (target.id === actor.id && !actor.isOwner) throw forbidden('You cannot change your own role or status.');
  if (!actor.isOwner) assertCanGrant(actor, [...rolePerms(target)]);
}

function broadcastUsers(...changed: string[]) {
  S.hub.send(allActive(), { t: 'users' });
  for (const id of changed) S.hub.send([id], { t: 'me' });
}

export function registerUsers(r: Router) {
  r.get('/api/users', (c) => {
    const vis = visibleUserIds(c.user);
    const rows = S.db.all("SELECT * FROM users WHERE status IN ('active','disabled') ORDER BY display_name COLLATE NOCASE");
    return rows.filter((u) => vis === 'all' || vis.has(u.id)).map(publicUser);
  });

  r.get('/api/users/pending', () =>
    S.db.all("SELECT id, username, display_name, device_name, created_at FROM users WHERE status='pending' ORDER BY created_at"), { perm: 'users.approve' });

  r.post('/api/users/:id/approve', (c) => {
    const u = S.db.get("SELECT * FROM users WHERE id=? AND status='pending'", vid(c.params.id));
    if (!u) throw notFound('Request not found.');
    const role = roleRow(vid(c.body.roleId, 'role'));
    if (role.is_owner) throw forbidden('Use ownership transfer to make someone the owner.');
    assertCanGrant(c.user, role.permList);
    const mgr = optId(c.body.managerId, 'manager');
    if (mgr && !S.db.get("SELECT 1 FROM users WHERE id=? AND status='active'", mgr)) throw bad('Manager not found.');
    const title = c.body.title ? str(c.body.title, 'Title', 0, 60) : role.name;
    S.db.run("UPDATE users SET status='active', role_id=?, manager_id=?, title=?, approved_at=? WHERE id=?", role.id, mgr, title, now(), u.id);
    invalidateTree();
    audit(c.user.id, 'join.approved', u.id, `${u.username} as ${role.name}`, c.ip);
    broadcastUsers();
    return { ok: true };
  }, { perm: 'users.approve' });

  r.post('/api/users/:id/reject', (c) => {
    const u = S.db.get("SELECT * FROM users WHERE id=? AND status='pending'", vid(c.params.id));
    if (!u) throw notFound('Request not found.');
    S.db.run("UPDATE users SET status='rejected' WHERE id=?", u.id);
    audit(c.user.id, 'join.rejected', u.id, u.username, c.ip);
    return { ok: true };
  }, { perm: 'users.approve' });

  r.patch('/api/users/:id', (c) => {
    const target = S.db.get("SELECT * FROM users WHERE id=? AND status IN ('active','disabled')", vid(c.params.id));
    if (!target) throw notFound('Member not found.');
    const b = c.body;
    const changes: string[] = [];
    if (b.displayName !== undefined || b.title !== undefined) {
      // Display name / title: managers with users.manage, or the person themself.
      if (target.id !== c.user.id) assertCanManage(c.user, target);
      if (b.displayName !== undefined) { S.db.run('UPDATE users SET display_name=? WHERE id=?', str(b.displayName, 'Name', 1, LIMITS.displayName.max), target.id); changes.push('name'); }
      if (b.title !== undefined) { S.db.run('UPDATE users SET title=? WHERE id=?', str(b.title, 'Title', 0, 60), target.id); changes.push('title'); }
    }
    if (b.roleId !== undefined || b.managerId !== undefined || b.status !== undefined || b.caretakerId !== undefined || b.remoteNote !== undefined) {
      if (!c.user.perms.has('users.manage')) throw forbidden();
      assertCanManage(c.user, target);
      if (b.roleId !== undefined) {
        if (target.is_owner) throw forbidden('The owner role cannot be changed. Transfer ownership instead.');
        const role = roleRow(vid(b.roleId, 'role'));
        if (role.is_owner) throw forbidden('Use ownership transfer to make someone the owner.');
        assertCanGrant(c.user, role.permList);
        S.db.run('UPDATE users SET role_id=? WHERE id=?', role.id, target.id); changes.push('role=' + role.name);
      }
      if (b.managerId !== undefined) {
        const mgr = optId(b.managerId, 'manager');
        if (mgr && !S.db.get("SELECT 1 FROM users WHERE id=? AND status='active'", mgr)) throw bad('Manager not found.');
        if (wouldCycle(target.id, mgr)) throw bad('That would create a loop in the reporting chain.');
        S.db.run('UPDATE users SET manager_id=? WHERE id=?', mgr, target.id); changes.push('manager');
      }
      if (b.caretakerId !== undefined) {
        if (!target.is_remote) throw bad('Only remote profiles have a caretaker.');
        const ct = optId(b.caretakerId, 'caretaker');
        if (ct && !S.db.get("SELECT 1 FROM users WHERE id=? AND status='active' AND is_remote=0", ct)) throw bad('Caretaker must be an active member who can sign in.');
        S.db.run('UPDATE users SET caretaker_id=? WHERE id=?', ct, target.id); changes.push('caretaker');
        if (ct) S.hub.send([ct], { t: 'notify', kind: 'remote', title: 'You are now a caretaker', body: `You keep ${target.display_name}'s work updated.` });
      }
      if (b.remoteNote !== undefined) {
        if (!target.is_remote) throw bad('Not a remote profile.');
        S.db.run('UPDATE users SET remote_note=? WHERE id=?', optStr(b.remoteNote, 'Note', 300), target.id); changes.push('note');
      }
      if (b.status !== undefined) {
        if (b.status !== 'active' && b.status !== 'disabled') throw bad('Invalid status.');
        if (target.is_owner) throw forbidden('The owner cannot be disabled.');
        S.db.run('UPDATE users SET status=? WHERE id=?', b.status, target.id); changes.push('status=' + b.status);
        if (b.status === 'disabled') { S.db.run('DELETE FROM sessions WHERE user_id=?', target.id); S.hub.kick(target.id); }
      }
    }
    invalidateTree();
    audit(c.user.id, 'user.updated', target.id, changes.join(','), c.ip);
    broadcastUsers(target.id);
    return publicUser(S.db.get('SELECT * FROM users WHERE id=?', target.id));
  });

  r.post('/api/users/:id/reset-code', (c) => {
    const target = S.db.get("SELECT * FROM users WHERE id=? AND status='active'", vid(c.params.id));
    if (!target) throw notFound('Member not found.');
    if (target.id === c.user.id) throw bad('Use "Change password" for your own account.');
    assertCanManage(c.user, target);
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    S.db.run('UPDATE users SET reset_hash=?, reset_expires=? WHERE id=?', sha256(raw), now() + 24 * 3600000, target.id);
    audit(c.user.id, 'user.reset_code', target.id, target.username, c.ip);
    return { code: raw.match(/.{4}/g)!.join('-'), expiresInHours: 24 };
  }, { perm: 'users.manage', rate: { key: 'rc', max: 20, windowMs: 3600000 } });

  r.post('/api/users/:id/revoke-sessions', (c) => {
    const target = S.db.get('SELECT * FROM users WHERE id=?', vid(c.params.id));
    if (!target) throw notFound('Member not found.');
    assertCanManage(c.user, target);
    S.db.run('DELETE FROM sessions WHERE user_id=?', target.id);
    S.hub.kick(target.id);
    audit(c.user.id, 'user.sessions_revoked', target.id, '', c.ip);
    return { ok: true };
  }, { perm: 'users.manage' });

  // ---------- remote profiles ----------
  // A member who cannot be on the office Wi-Fi. No login, no chat; a caretaker updates their tasks and work log
  // so the whole team's data stays in one place. Later an admin can issue a reset code to activate a real login.
  r.post('/api/users/remote', (c) => {
    const b = c.body;
    const display = str(b.displayName, 'Name', 1, LIMITS.displayName.max);
    const role = roleRow(vid(b.roleId, 'role'));
    if (role.is_owner) throw forbidden('A remote profile cannot be the owner.');
    assertCanGrant(c.user, role.permList);
    const mgr = optId(b.managerId, 'manager');
    if (mgr && !S.db.get("SELECT 1 FROM users WHERE id=? AND status='active'", mgr)) throw bad('Manager not found.');
    const ct = optId(b.caretakerId, 'caretaker') || c.user.id;
    if (!S.db.get("SELECT 1 FROM users WHERE id=? AND status='active' AND is_remote=0", ct)) throw bad('Caretaker must be an active member who can sign in.');
    if ((S.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE is_remote=1"))!.n >= 500) throw bad('Too many remote profiles.');
    const base = display.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 20) || 'member';
    let uname = '';
    for (let i = 0; i < 20 && !uname; i++) { const cand = `${base}.${crypto.randomBytes(2).toString('hex')}`.slice(0, 32); if (!S.db.get('SELECT 1 FROM users WHERE username=?', cand)) uname = cand; }
    if (!uname) throw new HttpError(409, 'taken', 'Could not create a username. Try again.');
    const uid = newId();
    // Unusable credentials: '!' is never a valid Argon2 hash, so the profile cannot sign in until activated with a reset code.
    S.db.run(`INSERT INTO users(id,username,display_name,title,role_id,manager_id,status,is_owner,kdf_salt,auth_hash,pubkey,enc_priv,color,created_at,approved_at,device_name,is_remote,caretaker_id,remote_note)
      VALUES(?,?,?,?,?,?,'active',0,?,'!','','',?,?,?,'Remote',1,?,?)`, uid, uname, display, b.title ? str(b.title, 'Title', 0, 60) : role.name, role.id, mgr,
      crypto.randomBytes(16).toString('base64'), pickColor(), now(), now(), ct, optStr(b.remoteNote, 'Note', 300));
    invalidateTree();
    audit(c.user.id, 'remote.created', uid, `${display} (@${uname})`, c.ip);
    broadcastUsers();
    if (ct !== c.user.id) S.hub.send([ct], { t: 'notify', kind: 'remote', title: 'You are now a caretaker', body: `You keep ${display}'s work updated.` });
    return publicUser(S.db.get('SELECT * FROM users WHERE id=?', uid));
  }, { perm: 'users.manage' });

  // ---------- work log (daily updates; mainly for remote profiles, works for everyone) ----------
  const canWriteLog = (u: AuthUser, target: string) => target === u.id || (isRemote(target) && (caretakerOf(target) === u.id || u.perms.has('users.manage'))) || ancestors(target).includes(u.id);
  r.get('/api/users/:id/worklog', (c) => {
    const uid = vid(c.params.id);
    if (!analyticsVisible(c.user, uid)) throw notFound('Member not found.');
    const month = c.url.searchParams.get('month');
    const rows = month && /^\d{4}-\d{2}$/.test(month)
      ? S.db.all('SELECT * FROM worklog WHERE user_id=? AND day LIKE ? ORDER BY day DESC, created_at DESC LIMIT 500', uid, month + '-%')
      : S.db.all('SELECT * FROM worklog WHERE user_id=? ORDER BY day DESC, created_at DESC LIMIT 200', uid);
    return { canWrite: canWriteLog(c.user, uid), entries: rows.map((w) => ({ id: w.id, userId: w.user_id, authorId: w.author_id, day: w.day, hours: w.hours, note: w.note, links: JSON.parse(w.links), createdAt: w.created_at })) };
  });
  r.post('/api/users/:id/worklog', (c) => {
    const uid = vid(c.params.id);
    if (!S.db.get("SELECT 1 FROM users WHERE id=? AND status='active'", uid)) throw notFound('Member not found.');
    if (!canWriteLog(c.user, uid)) throw forbidden('Only the person, their caretaker or someone above them can add work updates.');
    const day = String(c.body.day || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day)) throw bad('Invalid date.');
    let hours: number | null = null;
    if (c.body.hours !== undefined && c.body.hours !== null && c.body.hours !== '') {
      hours = Number(c.body.hours);
      if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw bad('Hours must be between 0 and 24.');
      hours = Math.round(hours * 4) / 4;
    }
    const note = str(c.body.note, 'Update', 1, LIMITS.note, { multiline: true });
    if (c.body.links !== undefined && (!Array.isArray(c.body.links) || c.body.links.length > LIMITS.maxLinks)) throw bad('Invalid links.');
    const links = ((c.body.links || []) as unknown[]).filter((x) => typeof x === 'string' && x.trim()).map(safeUrl);
    const wid = newId();
    S.db.run('INSERT INTO worklog(id,user_id,author_id,day,hours,note,links,created_at) VALUES(?,?,?,?,?,?,?,?)', wid, uid, c.user.id, day, hours, note, JSON.stringify(links), now());
    const aud = new Set([uid, ...ancestors(uid)]);
    const ct = caretakerOf(uid); if (ct) aud.add(ct);
    S.hub.send(aud, { t: 'worklog', userId: uid });
    return { id: wid };
  }, { rate: { key: 'wl', max: 120, windowMs: 60000 } });
  r.del('/api/worklog/:id', (c) => {
    const w = S.db.get('SELECT * FROM worklog WHERE id=?', vid(c.params.id));
    if (!w || !analyticsVisible(c.user, w.user_id)) throw notFound('Entry not found.');
    if (w.author_id !== c.user.id && !c.user.perms.has('users.manage')) throw forbidden('Only the author can delete this update.');
    S.db.run('DELETE FROM worklog WHERE id=?', w.id);
    S.hub.send([w.user_id, ...ancestors(w.user_id)], { t: 'worklog', userId: w.user_id });
    return { ok: true };
  });

  r.post('/api/owner/transfer', (c) => {
    if (!c.user.isOwner) throw forbidden('Only the owner can transfer ownership.');
    const to = S.db.get("SELECT * FROM users WHERE id=? AND status='active'", vid(c.body.userId, 'user'));
    if (!to || to.id === c.user.id) throw bad('Pick another active member.');
    const ownerRole = S.db.get('SELECT id FROM roles WHERE is_owner=1')!;
    const fallback = S.db.get('SELECT id FROM roles WHERE is_owner=0 ORDER BY rank DESC LIMIT 1');
    S.db.tx(() => {
      S.db.run('UPDATE users SET is_owner=0, role_id=? WHERE id=?', fallback?.id ?? null, c.user.id);
      S.db.run('UPDATE users SET is_owner=1, role_id=?, manager_id=NULL WHERE id=?', ownerRole.id, to.id);
    });
    invalidateTree();
    audit(c.user.id, 'owner.transferred', to.id, to.username, c.ip);
    broadcastUsers(c.user.id, to.id);
    return { ok: true };
  });

  // ---------- roles ----------
  r.get('/api/roles', () => S.db.all('SELECT * FROM roles ORDER BY rank DESC, name').map((x) => ({ id: x.id, name: x.name, rank: x.rank, color: x.color, perms: JSON.parse(x.perms), isOwner: !!x.is_owner, members: S.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role_id=? AND status='active'", x.id)!.n })));

  const parseRole = (b: any, u: AuthUser) => {
    const name = str(b.name, 'Role name', 1, 40);
    const rank = int(b.rank ?? 10, 'rank', 0, 99);
    const color = typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#1F6BFF';
    if (!Array.isArray(b.perms) || b.perms.length > 50) throw bad('Invalid permissions.');
    const perms = [...new Set(b.perms.filter(isPerm))] as Perm[];
    assertCanGrant(u, perms);
    return { name, rank, color, perms };
  };
  r.post('/api/roles', (c) => {
    const x = parseRole(c.body, c.user);
    if ((S.db.get<{ n: number }>('SELECT COUNT(*) n FROM roles'))!.n >= 100) throw bad('Too many roles.');
    const rid = newId();
    S.db.run('INSERT INTO roles(id,name,rank,color,perms,is_owner,created_at) VALUES(?,?,?,?,?,0,?)', rid, x.name, x.rank, x.color, JSON.stringify(x.perms), now());
    audit(c.user.id, 'role.created', rid, x.name + ': ' + x.perms.join(' '), c.ip);
    broadcastUsers();
    return { id: rid };
  }, { perm: 'roles.manage' });
  r.patch('/api/roles/:id', (c) => {
    const role = roleRow(vid(c.params.id));
    if (role.is_owner) throw forbidden('The Owner role always has every permission.');
    if (!c.user.isOwner) assertCanGrant(c.user, role.permList); // cannot edit a role more powerful than yourself
    if (!c.user.isOwner && c.user.roleId === role.id) throw forbidden('You cannot edit your own role.');
    const x = parseRole(c.body, c.user);
    S.db.run('UPDATE roles SET name=?, rank=?, color=?, perms=? WHERE id=?', x.name, x.rank, x.color, JSON.stringify(x.perms), role.id);
    audit(c.user.id, 'role.updated', role.id, x.name + ': ' + x.perms.join(' '), c.ip);
    const affected = S.db.all<{ id: string }>('SELECT id FROM users WHERE role_id=?', role.id).map((u) => u.id);
    broadcastUsers(...affected);
    return { ok: true };
  }, { perm: 'roles.manage' });
  r.del('/api/roles/:id', (c) => {
    const role = roleRow(vid(c.params.id));
    if (role.is_owner) throw forbidden('The Owner role cannot be deleted.');
    if (!c.user.isOwner) assertCanGrant(c.user, role.permList);
    if (S.db.get("SELECT 1 FROM users WHERE role_id=? AND status IN ('active','disabled')", role.id)) throw new HttpError(409, 'in_use', 'Move the members in this role to another role first.');
    S.db.run('UPDATE users SET role_id=NULL WHERE role_id=?', role.id);
    S.db.run('DELETE FROM roles WHERE id=?', role.id);
    audit(c.user.id, 'role.deleted', role.id, role.name, c.ip);
    broadcastUsers();
    return { ok: true };
  }, { perm: 'roles.manage' });

  // ---------- org chart ----------
  r.get('/api/org', (c) => {
    const vis = visibleUserIds(c.user);
    const rows = S.db.all("SELECT * FROM users WHERE status='active'");
    const scoped = vis === 'all' ? rows : rows.filter((u) => u.id === c.user.id || ancestors(c.user.id).includes(u.id) || descendants(c.user.id).has(u.id) || (c.user.managerId && u.manager_id === c.user.managerId));
    const ids = new Set(scoped.map((u) => u.id));
    return scoped.map((u) => ({ ...publicUser(u), managerId: u.manager_id && ids.has(u.manager_id) ? u.manager_id : null, reports: descendants(u.id).size }));
  });
}
