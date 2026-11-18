import { Router, bad, forbidden, notFound, str, id as vid, optId, int } from './http';
import { S, audit, canStartDm, requireMember, isActive, isRemote, visibleUserIds } from './core';
import { newId, now } from './db';
import { LIMITS } from '../shared/kdf';

const memberIds = (convId: string) => S.db.all<{ user_id: string }>('SELECT user_id FROM conv_members WHERE conv_id=?', convId).map((r) => r.user_id);

export function messageOut(m: any) {
  const file = m.file_id ? S.db.get('SELECT id,name,size,mime,version,group_id,deleted FROM files WHERE id=?', m.file_id) : null;
  return {
    id: m.id, convId: m.conv_id, senderId: m.sender_id, kind: m.kind, body: m.deleted ? '' : m.body, e2e: !!m.e2e,
    replyTo: m.reply_to, clientId: m.client_id, createdAt: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted,
    file: file && !file.deleted && !m.deleted ? { id: file.id, name: file.name, size: file.size, mime: file.mime, version: file.version } : null,
  };
}

export function postSystem(convId: string, text: string) {
  const r = S.db.run("INSERT INTO messages(conv_id,sender_id,kind,body,created_at) VALUES(?,NULL,'system',?,?)", convId, text, now());
  S.db.run('UPDATE conversations SET last_msg_at=? WHERE id=?', now(), convId);
  const m = S.db.get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid)!;
  S.hub.send(memberIds(convId), { t: 'msg', msg: messageOut(m) });
}

export function registerChat(r: Router) {
  r.get('/api/convs', (c) => {
    const rows = S.db.all(`SELECT c.*, cm.last_read_id, cm.muted, cm.is_admin,
        (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id AND m.id>cm.last_read_id AND m.sender_id IS NOT ? AND m.deleted=0) unread,
        (SELECT id FROM messages m WHERE m.conv_id=c.id ORDER BY id DESC LIMIT 1) last_id
      FROM conversations c JOIN conv_members cm ON cm.conv_id=c.id WHERE cm.user_id=? ORDER BY c.last_msg_at DESC`, c.user.id, c.user.id);
    return rows.map((x) => {
      const last = x.last_id ? S.db.get('SELECT * FROM messages WHERE id=?', x.last_id) : null;
      return {
        id: x.id, type: x.type, name: x.name, createdBy: x.created_by, lastMsgAt: x.last_msg_at, unread: x.unread, muted: !!x.muted, isAdmin: !!x.is_admin,
        lastReadId: x.last_read_id, members: memberIds(x.id), last: last ? messageOut(last) : null,
      };
    });
  });

  r.post('/api/convs/dm', (c) => {
    const other = vid(c.body.userId, 'user');
    const key = [c.user.id, other].sort().join(':');
    const existing = S.db.get('SELECT id FROM conversations WHERE dm_key=?', key);
    if (existing) return { id: existing.id };
    if (!canStartDm(c.user, other)) throw forbidden('You can message your manager, your team and your direct reports. Ask an admin for wider access.');
    const cid = newId();
    S.db.tx(() => {
      S.db.run("INSERT INTO conversations(id,type,dm_key,created_by,created_at,last_msg_at) VALUES(?,'dm',?,?,?,?)", cid, key, c.user.id, now(), now());
      for (const u of [c.user.id, other]) S.db.run('INSERT INTO conv_members(conv_id,user_id,joined_at) VALUES(?,?,?)', cid, u, now());
    });
    S.hub.send([c.user.id, other], { t: 'conv' });
    return { id: cid };
  });

  const checkAddable = (actor: any, ids: string[]) => {
    const vis = visibleUserIds(actor);
    for (const u of ids) {
      if (!isActive(u)) throw bad('One of the selected members is not active.');
      if (isRemote(u)) throw bad('Remote profiles cannot join chats. Their caretaker keeps their work updated.');
      if (!actor.perms.has('chat.message_anyone') && vis !== 'all' && !vis.has(u)) throw forbidden('You can only add people from your own team chain.');
    }
  };

  r.post('/api/convs/group', (c) => {
    const name = str(c.body.name, 'Group name', 1, 60);
    if (!Array.isArray(c.body.memberIds) || c.body.memberIds.length > LIMITS.groupMembers) throw bad('Invalid members.');
    const ids = [...new Set((c.body.memberIds as unknown[]).map((x) => vid(x, 'member')))].filter((x) => x !== c.user.id);
    checkAddable(c.user, ids);
    const cid = newId();
    S.db.tx(() => {
      S.db.run("INSERT INTO conversations(id,type,name,created_by,created_at,last_msg_at) VALUES(?,'group',?,?,?,?)", cid, name, c.user.id, now(), now());
      S.db.run('INSERT INTO conv_members(conv_id,user_id,is_admin,joined_at) VALUES(?,?,1,?)', cid, c.user.id, now());
      for (const u of ids) S.db.run('INSERT INTO conv_members(conv_id,user_id,joined_at) VALUES(?,?,?)', cid, u, now());
    });
    audit(c.user.id, 'group.created', cid, name, c.ip);
    postSystem(cid, `${c.user.displayName} created the group "${name}".`);
    S.hub.send([c.user.id, ...ids], { t: 'conv' });
    return { id: cid };
  }, { perm: 'chat.create_groups' });

  r.patch('/api/convs/:id', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    if (conv.type !== 'group') throw bad('Only groups can be edited.');
    if (!conv.is_admin && conv.created_by !== c.user.id) throw forbidden('Only group admins can edit this group.');
    const before = memberIds(conv.id);
    if (c.body.name !== undefined) {
      const name = str(c.body.name, 'Group name', 1, 60);
      S.db.run('UPDATE conversations SET name=? WHERE id=?', name, conv.id);
      postSystem(conv.id, `${c.user.displayName} renamed the group to "${name}".`);
    }
    if (Array.isArray(c.body.addIds) && c.body.addIds.length) {
      const ids = [...new Set((c.body.addIds as unknown[]).map((x) => vid(x, 'member')))].filter((x) => !before.includes(x));
      checkAddable(c.user, ids);
      if (before.length + ids.length > LIMITS.groupMembers) throw bad('Group is full.');
      for (const u of ids) S.db.run('INSERT OR IGNORE INTO conv_members(conv_id,user_id,joined_at,last_read_id) VALUES(?,?,?,(SELECT IFNULL(MAX(id),0) FROM messages WHERE conv_id=?))', conv.id, u, now(), conv.id);
      if (ids.length) postSystem(conv.id, `${c.user.displayName} added ${ids.length} member${ids.length > 1 ? 's' : ''}.`);
    }
    if (Array.isArray(c.body.removeIds) && c.body.removeIds.length) {
      const ids = (c.body.removeIds as unknown[]).map((x) => vid(x, 'member')).filter((x) => x !== c.user.id);
      for (const u of ids) S.db.run('DELETE FROM conv_members WHERE conv_id=? AND user_id=?', conv.id, u);
      if (ids.length) postSystem(conv.id, `${c.user.displayName} removed ${ids.length} member${ids.length > 1 ? 's' : ''}.`);
    }
    if (Array.isArray(c.body.adminIds)) {
      for (const u of (c.body.adminIds as unknown[]).map((x) => vid(x, 'member'))) S.db.run('UPDATE conv_members SET is_admin=1 WHERE conv_id=? AND user_id=?', conv.id, u);
    }
    S.hub.send(new Set([...before, ...memberIds(conv.id)]), { t: 'conv' });
    return { ok: true };
  });

  r.post('/api/convs/:id/leave', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    if (conv.type !== 'group') throw bad('You cannot leave a direct chat.');
    S.db.run('DELETE FROM conv_members WHERE conv_id=? AND user_id=?', conv.id, c.user.id);
    const rest = memberIds(conv.id);
    if (rest.length && !S.db.get('SELECT 1 FROM conv_members WHERE conv_id=? AND is_admin=1', conv.id)) S.db.run('UPDATE conv_members SET is_admin=1 WHERE conv_id=? AND user_id=?', conv.id, rest[0]);
    postSystem(conv.id, `${c.user.displayName} left the group.`);
    S.hub.send([c.user.id, ...rest], { t: 'conv' });
    return { ok: true };
  });

  r.post('/api/convs/:id/mute', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    S.db.run('UPDATE conv_members SET muted=? WHERE conv_id=? AND user_id=?', c.body.muted ? 1 : 0, conv.id, c.user.id);
    return { ok: true };
  });

  r.get('/api/convs/:id/messages', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    const before = c.url.searchParams.get('before');
    const after = c.url.searchParams.get('after');
    const around = c.url.searchParams.get('around');
    const limit = int(c.url.searchParams.get('limit') ?? 50, 'limit', 1, 200);
    let rows;
    if (around) {
      const mid = int(around, 'around', 1, Number.MAX_SAFE_INTEGER);
      const older = S.db.all('SELECT * FROM messages WHERE conv_id=? AND id<=? ORDER BY id DESC LIMIT ?', conv.id, mid, Math.ceil(limit / 2)).reverse();
      const newer = S.db.all('SELECT * FROM messages WHERE conv_id=? AND id>? ORDER BY id ASC LIMIT ?', conv.id, mid, Math.floor(limit / 2));
      rows = [...older, ...newer];
    } else if (after) rows = S.db.all('SELECT * FROM messages WHERE conv_id=? AND id>? ORDER BY id ASC LIMIT ?', conv.id, int(after, 'after', 0, Number.MAX_SAFE_INTEGER), limit);
    else if (before) rows = S.db.all('SELECT * FROM messages WHERE conv_id=? AND id<? ORDER BY id DESC LIMIT ?', conv.id, int(before, 'before', 0, Number.MAX_SAFE_INTEGER), limit).reverse();
    else rows = S.db.all('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?', conv.id, limit).reverse();
    const reads = S.db.all('SELECT user_id, last_read_id FROM conv_members WHERE conv_id=?', conv.id);
    return { messages: rows.map(messageOut), reads };
  });

  // Search group messages and file names in conversations the member belongs to (DMs are searched on-device).
  r.get('/api/search', (c) => {
    const q = String(c.url.searchParams.get('q') || '').replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 100);
    if (q.length < 2) return { messages: [], files: [] };
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    // Walk the index newest-first in batches and keep only messages from the member's own chats.
    // (A JOIN lets SQLite pick a slow plan when a word appears in a large share of messages.)
    const mine = new Set(S.db.all<{ conv_id: string }>('SELECT conv_id FROM conv_members WHERE user_id=?', c.user.id).map((r) => r.conv_id));
    const phrase = '"' + q.replace(/"/g, '""') + '"';
    const ids: number[] = [];
    let cursor = Number.MAX_SAFE_INTEGER, scanned = 0;
    while (ids.length < 60 && scanned < 30000) {
      const batch = q.length >= 3
        ? S.db.all<{ id: number }>('SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT 500', phrase, cursor)
        : S.db.all<{ id: number }>("SELECT id FROM messages WHERE id < ? AND e2e=0 AND kind<>'system' AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 500", cursor, like);
      if (!batch.length) break;
      scanned += batch.length;
      cursor = batch[batch.length - 1].id;
      const meta = S.db.all<{ id: number; conv_id: string; deleted: number }>(`SELECT id, conv_id, deleted FROM messages WHERE id IN (${batch.map(() => '?').join(',')}) ORDER BY id DESC`, ...batch.map((b) => b.id));
      for (const m of meta) if (!m.deleted && mine.has(m.conv_id) && ids.length < 60) ids.push(m.id);
    }
    const messages = ids.map((id) => messageOut(S.db.get('SELECT * FROM messages WHERE id=?', id)));
    const files = S.db.all(`SELECT m.* FROM messages m JOIN files f ON f.id=m.file_id JOIN conv_members cm ON cm.conv_id=m.conv_id AND cm.user_id=?
      WHERE m.deleted=0 AND f.deleted=0 AND f.name LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 30`, c.user.id, like).map(messageOut);
    return { messages, files };
  }, { rate: { key: 'search', max: 120, windowMs: 60000 } });

  r.post('/api/convs/:id/messages', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    const b = c.body;
    const isDm = conv.type === 'dm';
    const e2e = !!b.e2e;
    if (isDm && !e2e) throw bad('Direct messages must be end-to-end encrypted.');
    if (!isDm && e2e) throw bad('Group messages are not end-to-end encrypted.');
    if (isDm) {
      const other = memberIds(conv.id).find((x) => x !== c.user.id);
      if (!other || !isActive(other)) throw forbidden('This person is no longer active.');
    }
    const fileId = optId(b.fileId, 'file');
    const body = fileId ? (b.body ? str(b.body, 'Message', 0, e2e ? LIMITS.e2eMessage : LIMITS.message, { multiline: true }) : '') : str(b.body, 'Message', 1, e2e ? LIMITS.e2eMessage : LIMITS.message, { multiline: true });
    if (e2e && body && !/^e1:[A-Za-z0-9+/=]+$/.test(body)) throw bad('Invalid encrypted payload.');
    if (fileId) {
      const f = S.db.get("SELECT 1 FROM files WHERE id=? AND scope='conv' AND scope_id=? AND deleted=0", fileId, conv.id);
      if (!f) throw bad('Attachment not found.');
    }
    const clientId = typeof b.clientId === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(b.clientId) ? b.clientId : null;
    if (clientId) {
      const dup = S.db.get('SELECT * FROM messages WHERE sender_id=? AND client_id=?', c.user.id, clientId);
      if (dup) return messageOut(dup); // idempotent retry after reconnect
    }
    let replyTo: number | null = null;
    if (b.replyTo !== undefined && b.replyTo !== null) {
      replyTo = int(b.replyTo, 'replyTo', 1, Number.MAX_SAFE_INTEGER);
      if (!S.db.get('SELECT 1 FROM messages WHERE id=? AND conv_id=?', replyTo, conv.id)) replyTo = null;
    }
    const ts = now();
    const res = S.db.run('INSERT INTO messages(conv_id,sender_id,kind,body,e2e,file_id,reply_to,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      conv.id, c.user.id, fileId ? 'file' : 'text', body, e2e ? 1 : 0, fileId, replyTo, clientId, ts);
    S.db.run('UPDATE conversations SET last_msg_at=? WHERE id=?', ts, conv.id);
    S.db.run('UPDATE conv_members SET last_read_id=? WHERE conv_id=? AND user_id=?', res.lastInsertRowid, conv.id, c.user.id);
    const m = messageOut(S.db.get('SELECT * FROM messages WHERE id=?', res.lastInsertRowid));
    S.hub.send(memberIds(conv.id), { t: 'msg', msg: m });
    return m;
  }, { rate: { key: 'msg', max: 120, windowMs: 60000 } });

  r.patch('/api/messages/:id', (c) => {
    const m = S.db.get('SELECT * FROM messages WHERE id=?', int(c.params.id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!m || m.sender_id !== c.user.id || m.deleted || m.kind === 'system') throw notFound('Message not found.');
    requireMember(m.conv_id, c.user.id);
    const body = str(c.body.body, 'Message', m.file_id ? 0 : 1, m.e2e ? LIMITS.e2eMessage : LIMITS.message, { multiline: true });
    if (m.e2e && body && !/^e1:[A-Za-z0-9+/=]+$/.test(body)) throw bad('Invalid encrypted payload.');
    S.db.run('UPDATE messages SET body=?, edited_at=? WHERE id=?', body, now(), m.id);
    const out = messageOut(S.db.get('SELECT * FROM messages WHERE id=?', m.id));
    S.hub.send(memberIds(m.conv_id), { t: 'msg_edit', msg: out });
    return out;
  });

  r.del('/api/messages/:id', (c) => {
    const m = S.db.get('SELECT * FROM messages WHERE id=?', int(c.params.id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!m || m.deleted) throw notFound('Message not found.');
    const conv = requireMember(m.conv_id, c.user.id);
    const canModerate = conv.type === 'group' && conv.is_admin;
    if (m.sender_id !== c.user.id && !canModerate) throw forbidden('You can only delete your own messages.');
    S.db.run("UPDATE messages SET deleted=1, body='' WHERE id=?", m.id);
    if (m.file_id) S.db.run('UPDATE files SET deleted=1 WHERE id=?', m.file_id);
    S.hub.send(memberIds(m.conv_id), { t: 'msg_del', convId: m.conv_id, id: m.id });
    return { ok: true };
  });

  r.post('/api/convs/:id/read', (c) => {
    const conv = requireMember(vid(c.params.id), c.user.id);
    const last = int(c.body.lastId, 'lastId', 0, Number.MAX_SAFE_INTEGER);
    S.db.run('UPDATE conv_members SET last_read_id=MAX(last_read_id, ?) WHERE conv_id=? AND user_id=?', last, conv.id, c.user.id);
    S.hub.send(memberIds(conv.id), { t: 'read', convId: conv.id, userId: c.user.id, lastId: last });
    return { ok: true };
  });
}

export { memberIds };
