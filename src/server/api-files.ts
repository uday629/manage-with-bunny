// Resumable chunked uploads into a content-addressed blob store (automatic de-duplication),
// versioning by name within a chat/task, and range-capable streaming downloads via signed URLs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router, HttpError, bad, forbidden, notFound, str, id as vid, int, oneOf, baseHeaders, sendJson, type AuthUser } from './http';
import { S, settings, audit, requireMember, requireTask, taskVisible, signFileUrl, verifyFileUrl, rolePerms } from './core';
import { newId, now } from './db';
import { log } from './log';

export const CHUNK = 16 * 1024 * 1024;

// LocalSend-style live progress: everyone else in the chat sees "X is sending file.zip 45%".
function notifyIncoming(u: { id: string; user_id: string; name: string; size: number; scope: string; scope_id: string }, received: number, done = false) {
  if (u.scope !== 'conv') return;
  const to = S.db.all<{ user_id: string }>('SELECT user_id FROM conv_members WHERE conv_id=? AND user_id<>?', u.scope_id, u.user_id).map((r) => r.user_id);
  S.hub.send(to, done ? { t: 'incoming_done', id: u.id, convId: u.scope_id } : { t: 'incoming', id: u.id, convId: u.scope_id, userId: u.user_id, name: u.name, size: u.size, received });
}
const hashes = new Map<string, { h: crypto.Hash; n: number }>();
const finishing = new Set<string>();

export function blobPath(sha: string) { return path.join(S.filesDir, sha.slice(0, 2), sha.slice(2, 4), sha); }
const tmpPath = (uploadId: string) => path.join(S.tmpDir, uploadId + '.part');

export function cleanName(raw: string): string {
  let n = raw.normalize('NFC').replace(/[\u0000-\u001F\u007F<>:"/\\|?*‪-‮⁦-⁩]/g, '_').replace(/^[.\s]+/, '').trim();
  if (!n) n = 'file';
  if (n.length > 180) { const ext = path.extname(n).slice(0, 16); n = n.slice(0, 180 - ext.length) + ext; }
  return n;
}
const extOf = (n: string) => path.extname(n).slice(1).toLowerCase().slice(0, 16);

export function assertScopeAccess(u: AuthUser, scope: string, scopeId: string) {
  if (scope === 'conv') requireMember(scopeId, u.id);
  else if (scope === 'task') requireTask(u, scopeId);
  else throw bad('Invalid scope.');
}

export function canAccessFile(u: AuthUser, f: any): boolean {
  if (!f || f.deleted) return false;
  if (f.scope === 'conv') return !!S.db.get('SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=?', f.scope_id, u.id);
  if (f.scope === 'task') { const t = S.db.get('SELECT assigner_id, assignee_id FROM tasks WHERE id=?', f.scope_id); return !!t && taskVisible(u, t as any); }
  return false;
}

function sniff(file: string): string {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(16);
  try { fs.readSync(fd, b, 0, 16, 0); } finally { fs.closeSync(fd); }
  const hex = b.toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (hex.startsWith('52494646') && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.toString('ascii', 4, 8) === 'ftyp') return b.toString('ascii', 8, 10) === 'qt' ? 'video/quicktime' : (b.toString('ascii', 8, 11) === 'M4A' ? 'audio/mp4' : 'video/mp4');
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'audio/mpeg';
  if (hex.startsWith('25504446')) return 'application/pdf';
  return 'application/octet-stream';
}

export function fileOut(f: any) {
  const versions = S.db.get<{ n: number }>('SELECT COUNT(*) n FROM files WHERE group_id=? AND deleted=0', f.group_id)!.n;
  return { id: f.id, name: f.name, ext: f.ext, size: f.size, mime: f.mime, uploaderId: f.uploader_id, scope: f.scope, scopeId: f.scope_id, groupId: f.group_id, version: f.version, versions, createdAt: f.created_at, sha: f.sha.slice(0, 12) };
}

const quiet = new Set<string>();
function closeQuietUploads() {
  for (const u of S.db.all("SELECT * FROM uploads WHERE scope='conv' AND updated_at<?", now() - 60000)) {
    if (quiet.has(u.id)) continue;
    quiet.add(u.id);
    notifyIncoming(u as any, u.received, true);
  }
  if (quiet.size > 5000) quiet.clear();
}
function cleanupUploads() {
  const old = S.db.all('SELECT id FROM uploads WHERE updated_at<?', now() - 48 * 3600000);
  for (const u of old) { try { fs.rmSync(tmpPath(u.id), { force: true }); } catch { /* */ } S.db.run('DELETE FROM uploads WHERE id=?', u.id); hashes.delete(u.id); }
}

export function registerFiles(r: Router) {
  setInterval(cleanupUploads, 3600000).unref();
  setInterval(closeQuietUploads, 20000).unref();

  r.post('/api/uploads', (c) => {
    const b = c.body;
    const scope = oneOf(b.scope, 'scope', ['conv', 'task'] as const);
    const scopeId = vid(b.scopeId, 'scopeId');
    assertScopeAccess(c.user, scope, scopeId);
    const name = cleanName(str(b.name, 'File name', 1, 255));
    const st = settings();
    const max = st.maxUploadGB * 1024 ** 3;
    const size = int(b.size, 'size', 0, Number.MAX_SAFE_INTEGER);
    if (size > max) throw new HttpError(413, 'too_large', `Files can be at most ${st.maxUploadGB} GB.`);
    if (st.blockedExts.includes(extOf(name))) throw forbidden(`.${extOf(name)} files are blocked for safety. Zip it first or ask an admin.`);
    try {
      const fsInfo = fs.statfsSync(S.filesDir);
      if (fsInfo.bavail * fsInfo.bsize < size + 512 * 1024 * 1024) throw new HttpError(507, 'disk_full', 'The host storage drive is almost full. Ask the admin to free space.');
    } catch (e) { if (e instanceof HttpError) throw e; }
    if ((S.db.get<{ n: number }>('SELECT COUNT(*) n FROM uploads WHERE user_id=?', c.user.id))!.n > 20) throw new HttpError(429, 'busy', 'Too many unfinished uploads. Wait for them to finish.');
    const uid = newId();
    fs.writeFileSync(tmpPath(uid), Buffer.alloc(0));
    S.db.run('INSERT INTO uploads(id,user_id,name,size,received,scope,scope_id,created_at,updated_at) VALUES(?,?,?,?,0,?,?,?,?)', uid, c.user.id, name, size, scope, scopeId, now(), now());
    hashes.set(uid, { h: crypto.createHash('sha256'), n: 0 });
    if (size > 0) notifyIncoming({ id: uid, user_id: c.user.id, name, size, scope, scope_id: scopeId }, 0);
    return { id: uid, received: 0, chunk: CHUNK };
  }, { rate: { key: 'up', max: 300, windowMs: 60000 } });

  r.get('/api/uploads/:id', (c) => {
    const u = S.db.get('SELECT * FROM uploads WHERE id=? AND user_id=?', vid(c.params.id), c.user.id);
    if (!u) throw notFound('Upload not found.');
    return { id: u.id, received: u.received, size: u.size };
  });

  r.put('/api/uploads/:id', async (c) => {
    const u = S.db.get('SELECT * FROM uploads WHERE id=? AND user_id=?', vid(c.params.id), c.user.id);
    if (!u) { c.req.resume(); throw notFound('Upload not found.'); }
    const offset = int(c.url.searchParams.get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER);
    if (offset !== u.received) { c.req.resume(); return sendJson(c.res, 409, { error: 'offset', received: u.received }); }
    const declared = Number(c.req.headers['content-length'] || -1);
    if (declared < 0 || declared > CHUNK * 2 || offset + declared > u.size) { c.req.resume(); throw bad('Invalid chunk.'); }
    let st = hashes.get(u.id);
    const hashable = st && st.n === offset;
    let n = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        if (n > declared) return cb(bad('Chunk larger than declared.'));
        if (hashable) st!.h.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(c.req, counter, fs.createWriteStream(tmpPath(u.id), { flags: 'r+', start: offset }));
    } catch (e) {
      // A broken chunk invalidates the incremental hash; finish() will re-hash from disk.
      hashes.delete(u.id);
      try { fs.truncateSync(tmpPath(u.id), offset); } catch { /* */ }
      throw e instanceof HttpError ? e : new HttpError(400, 'aborted', 'Upload interrupted. It will resume.');
    }
    if (n !== declared) { hashes.delete(u.id); fs.truncateSync(tmpPath(u.id), offset); throw bad('Incomplete chunk.'); }
    if (hashable) st!.n += n; else hashes.delete(u.id);
    S.db.run('UPDATE uploads SET received=?, updated_at=? WHERE id=?', offset + n, now(), u.id);
    quiet.delete(u.id);
    notifyIncoming(u as any, offset + n);
    return { received: offset + n };
  }, { raw: true, rate: { key: 'chunk', max: 6000, windowMs: 60000 } });

  r.del('/api/uploads/:id', (c) => {
    const u = S.db.get('SELECT * FROM uploads WHERE id=? AND user_id=?', vid(c.params.id), c.user.id);
    if (u) { fs.rmSync(tmpPath(u.id), { force: true }); S.db.run('DELETE FROM uploads WHERE id=?', u.id); hashes.delete(u.id); notifyIncoming(u as any, 0, true); }
    return { ok: true };
  });

  r.post('/api/uploads/:id/finish', async (c) => {
    const u = S.db.get('SELECT * FROM uploads WHERE id=? AND user_id=?', vid(c.params.id), c.user.id);
    if (!u) throw notFound('Upload not found.');
    if (u.received !== u.size) throw bad('Upload is not complete yet.');
    if (finishing.has(u.id)) throw new HttpError(409, 'busy', 'This upload is already being finished.');
    finishing.add(u.id);
    try {
    assertScopeAccess(c.user, u.scope, u.scope_id);
    const tmp = tmpPath(u.id);
    let sha: string;
    const st = hashes.get(u.id);
    if (st && st.n === u.size) sha = st.h.digest('hex');
    else {
      const h = crypto.createHash('sha256');
      await pipeline(fs.createReadStream(tmp), new Transform({ transform(ch, _e, cb) { h.update(ch); cb(); } }));
      sha = h.digest('hex');
    }
    hashes.delete(u.id);
    let mime = u.size > 0 ? sniff(tmp) : 'application/octet-stream';
    // Voice messages are recorded as WebM/Opus audio (.weba); the container sniffs as WebM.
    if (mime === 'video/webm' && extOf(u.name) === 'weba') mime = 'audio/webm';
    const dest = blobPath(sha);
    if (S.db.get('SELECT 1 FROM blobs WHERE sha=?', sha) && fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmp, dest);
      S.db.run('INSERT OR IGNORE INTO blobs(sha,size,created_at) VALUES(?,?,?)', sha, u.size, now());
    }
    const prev = S.db.get("SELECT group_id, MAX(version) v FROM files WHERE scope=? AND scope_id=? AND name=? COLLATE NOCASE AND deleted=0 GROUP BY group_id ORDER BY v DESC LIMIT 1", u.scope, u.scope_id, u.name);
    const fid = newId();
    S.db.tx(() => {
      S.db.run('INSERT INTO files(id,sha,name,ext,size,mime,uploader_id,scope,scope_id,group_id,version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        fid, sha, u.name, extOf(u.name), u.size, mime, c.user.id, u.scope, u.scope_id, prev?.group_id ?? fid, (prev?.v ?? 0) + 1, now());
      S.db.run('DELETE FROM uploads WHERE id=?', u.id);
    });
    notifyIncoming(u as any, u.size, true);
    log.info('upload', { size: u.size });
    return fileOut(S.db.get('SELECT * FROM files WHERE id=?', fid));
    } finally { finishing.delete(u.id); }
  });

  r.get('/api/files', (c) => {
    const scope = oneOf(c.url.searchParams.get('scope'), 'scope', ['conv', 'task'] as const);
    const scopeId = vid(c.url.searchParams.get('scopeId'), 'scopeId');
    assertScopeAccess(c.user, scope, scopeId);
    return S.db.all('SELECT * FROM files WHERE scope=? AND scope_id=? AND deleted=0 ORDER BY created_at DESC LIMIT 500', scope, scopeId).map(fileOut);
  });

  // Everything this member can access, newest first (latest version of each file).
  r.get('/api/files/browse', (c) => {
    const kind = c.url.searchParams.get('kind') || 'all';
    const q = (c.url.searchParams.get('q') || '').slice(0, 80).toLowerCase();
    const convIds = S.db.all<{ conv_id: string }>('SELECT conv_id FROM conv_members WHERE user_id=?', c.user.id).map((x) => x.conv_id);
    const rows = S.db.all(`SELECT f.* FROM files f WHERE f.deleted=0 AND f.version=(SELECT MAX(version) FROM files g WHERE g.group_id=f.group_id AND g.deleted=0) ORDER BY f.created_at DESC LIMIT 3000`);
    const convSet = new Set(convIds);
    const taskCache = new Map<string, boolean>();
    const out = [];
    for (const f of rows) {
      let ok = false;
      if (f.scope === 'conv') ok = convSet.has(f.scope_id);
      else {
        if (!taskCache.has(f.scope_id)) { const t = S.db.get('SELECT assigner_id, assignee_id FROM tasks WHERE id=?', f.scope_id); taskCache.set(f.scope_id, !!t && taskVisible(c.user, t as any)); }
        ok = taskCache.get(f.scope_id)!;
      }
      if (!ok) continue;
      if (q && !f.name.toLowerCase().includes(q)) continue;
      if (kind === 'image' && !f.mime.startsWith('image/')) continue;
      if (kind === 'video' && !f.mime.startsWith('video/')) continue;
      if (kind === 'doc' && (f.mime.startsWith('image/') || f.mime.startsWith('video/'))) continue;
      out.push(fileOut(f));
      if (out.length >= 500) break;
    }
    return out;
  });

  r.get('/api/files/:id/versions', (c) => {
    const f = S.db.get('SELECT * FROM files WHERE id=?', vid(c.params.id));
    if (!canAccessFile(c.user, f)) throw notFound('File not found.');
    return S.db.all('SELECT * FROM files WHERE group_id=? AND deleted=0 ORDER BY version DESC', f!.group_id).map(fileOut);
  });

  r.post('/api/files/:id/link', (c) => {
    const f = S.db.get('SELECT * FROM files WHERE id=?', vid(c.params.id));
    if (!canAccessFile(c.user, f)) throw notFound('File not found.');
    return { path: '/f/' + signFileUrl(f!.id, c.user.id) };
  }, { rate: { key: 'link', max: 600, windowMs: 60000 } });

  r.del('/api/files/:id', (c) => {
    const f = S.db.get('SELECT * FROM files WHERE id=?', vid(c.params.id));
    if (!canAccessFile(c.user, f)) throw notFound('File not found.');
    let allowed = f!.uploader_id === c.user.id || c.user.perms.has('storage.manage');
    if (!allowed && f!.scope === 'conv') allowed = !!S.db.get('SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND is_admin=1', f!.scope_id, c.user.id);
    if (!allowed) throw forbidden('Only the uploader or an admin can delete this file.');
    const all = c.body?.allVersions || c.url.searchParams.get('all') === '1';
    if (all) S.db.run('UPDATE files SET deleted=1 WHERE group_id=?', f!.group_id); else S.db.run('UPDATE files SET deleted=1 WHERE id=?', f!.id);
    audit(c.user.id, 'file.deleted', f!.id, f!.name + (all ? ' (all versions)' : ''), c.ip);
    return { ok: true };
  });
}

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm', 'application/pdf']);

// GET /f/<signed-token>[?dl=1] : no bearer header possible for <video>/<img>, so the URL is signed, short-lived and user-bound.
export async function serveFile(req: IncomingMessage, res: ServerResponse, tok: string, dl: boolean) {
  baseHeaders(res);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const v = verifyFileUrl(tok);
  const fail = (s: number, m: string) => { res.writeHead(s, { 'Content-Type': 'text/plain' }); res.end(m); };
  if (!v) return fail(403, 'Link expired');
  const u = S.db.get("SELECT * FROM users WHERE id=? AND status='active'", v.userId);
  if (!u) return fail(403, 'Forbidden');
  const auth: AuthUser = { id: u.id, username: u.username, displayName: u.display_name, roleId: u.role_id, managerId: u.manager_id, isOwner: !!u.is_owner, perms: rolePerms(u as any), sessionId: '' };
  const f = S.db.get('SELECT * FROM files WHERE id=?', v.fileId);
  if (!canAccessFile(auth, f)) return fail(404, 'Not found');
  const p = blobPath(f!.sha);
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { return fail(410, 'File is missing from storage'); }
  const type = !dl && INLINE.has(f!.mime) ? f!.mime : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f!.name)}`);
  const range = req.headers.range;
  let start = 0, end = stat.size - 1;
  if (range && stat.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) { res.setHeader('Content-Range', `bytes */${stat.size}`); return fail(416, 'Bad range'); }
    if (m[1] === '') { start = Math.max(0, stat.size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), stat.size - 1); }
    if (start > end || start >= stat.size) { res.setHeader('Content-Range', `bytes */${stat.size}`); return fail(416, 'Bad range'); }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
  } else res.writeHead(200, { 'Content-Length': stat.size });
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  try { await pipeline(fs.createReadStream(p, { start, end, highWaterMark: 1024 * 1024 }), res); } catch { /* client aborted */ }
}

