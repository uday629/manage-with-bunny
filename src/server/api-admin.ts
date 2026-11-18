import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, bad, int, oneOf, str, monthKey } from './http';
import { S, settings, audit } from './core';
import { blobPath } from './api-files';
import { now } from './db';
import { encodeJoinCode } from '../shared/joincode';
import { log } from './log';

export function joinCode() { return encodeJoinCode(S.fp, settings().inviteSecret); }

function dbSize() {
  let n = 0;
  for (const f of ['bunny.db', 'bunny.db-wal']) { try { n += fs.statSync(path.join(S.dataDir, 'db', f)).size; } catch { /* */ } }
  return n;
}

// Remove blobs no longer referenced by any live file. Returns bytes freed.
export function gcBlobs(): { freed: number; blobs: number } {
  const dead = S.db.all('SELECT sha, size FROM blobs WHERE sha NOT IN (SELECT sha FROM files WHERE deleted=0)');
  let freed = 0;
  for (const b of dead) {
    try { fs.rmSync(blobPath(b.sha), { force: true }); freed += b.size; } catch (e) { log.warn('gc failed', { err: (e as Error).message }); continue; }
    S.db.run('DELETE FROM files WHERE sha=? AND deleted=1', b.sha);
    S.db.run('DELETE FROM blobs WHERE sha=?', b.sha);
  }
  return { freed, blobs: dead.length };
}

export function backupNow(reason: string) {
  fs.mkdirSync(S.backupDir, { recursive: true });
  const d = new Date();
  const name = `bunny-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.db`;
  const dest = path.join(S.backupDir, name);
  S.db.raw.prepare('VACUUM INTO ?').run(dest);
  S.db.setMeta('last_backup', String(now()));
  const all = fs.readdirSync(S.backupDir).filter((f) => /^bunny-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(S.backupDir, old), { force: true });
  log.info('backup', { reason, name });
  return name;
}

export function registerAdmin(r: Router) {
  r.get('/api/admin/settings', () => {
    const s = settings();
    return { name: s.name, joinOpen: s.joinOpen, maxUploadGB: s.maxUploadGB, blockedExts: s.blockedExts, joinCode: joinCode(), fingerprint: S.fp.match(/.{4}/g)!.slice(0, 8).join(' ').toUpperCase(), port: S.port };
  }, { perm: 'workspace.settings' });

  r.patch('/api/admin/settings', (c) => {
    const b = c.body;
    const ch: string[] = [];
    if (b.name !== undefined) { S.db.setMeta('workspace_name', str(b.name, 'Workspace name', 1, 60)); ch.push('name'); }
    if (b.joinOpen !== undefined) { S.db.setMeta('join_open', b.joinOpen ? '1' : '0'); ch.push('joinOpen=' + !!b.joinOpen); }
    if (b.maxUploadGB !== undefined) { S.db.setMeta('max_upload_gb', String(int(b.maxUploadGB, 'max upload', 1, 1000))); ch.push('maxUpload'); }
    if (b.blockedExts !== undefined) {
      if (!Array.isArray(b.blockedExts) || b.blockedExts.length > 200) throw bad('Invalid list.');
      const list = [...new Set(b.blockedExts.map((x: unknown) => String(x).toLowerCase().replace(/^\./, '')).filter((x: string) => /^[a-z0-9]{1,16}$/.test(x)))];
      S.db.setMeta('blocked_exts', list.join(',')); ch.push('blockedExts');
    }
    audit(c.user.id, 'settings.updated', '', ch.join(','), c.ip);
    return { ok: true };
  }, { perm: 'workspace.settings' });

  r.post('/api/admin/rotate-code', (c) => {
    S.db.setMeta('invite_secret', crypto.randomBytes(5).toString('hex'));
    audit(c.user.id, 'joincode.rotated', '', '', c.ip);
    return { joinCode: joinCode() };
  }, { perm: 'workspace.settings' });

  r.get('/api/admin/storage', () => {
    const g = (sql: string) => S.db.get<{ n: number }>(sql)!.n || 0;
    const physical = g('SELECT IFNULL(SUM(size),0) n FROM blobs');
    const logical = g('SELECT IFNULL(SUM(size),0) n FROM files WHERE deleted=0');
    const reclaimable = g('SELECT IFNULL(SUM(size),0) n FROM blobs WHERE sha NOT IN (SELECT sha FROM files WHERE deleted=0)');
    const oldVersions = S.db.get<{ n: number; b: number }>('SELECT COUNT(*) n, IFNULL(SUM(size),0) b FROM files f WHERE deleted=0 AND version < (SELECT MAX(version) FROM files g WHERE g.group_id=f.group_id AND g.deleted=0)')!;
    const duplicates = S.db.all(`SELECT f.sha, MAX(f.size) size, COUNT(*) copies, GROUP_CONCAT(f.name, ' | ') names FROM files f WHERE deleted=0 GROUP BY f.sha HAVING COUNT(*)>1 ORDER BY MAX(f.size)*COUNT(*) DESC LIMIT 100`)
      .map((d) => ({ sha: d.sha.slice(0, 12), size: d.size, copies: d.copies, names: [...new Set(String(d.names).split(' | '))].slice(0, 6) }));
    const versioned = S.db.all(`SELECT group_id, name, COUNT(*) versions, SUM(size) bytes FROM files WHERE deleted=0 GROUP BY group_id HAVING COUNT(*)>1 ORDER BY SUM(size) DESC LIMIT 100`)
      .map((v) => ({ groupId: v.group_id, name: v.name, versions: v.versions, bytes: v.bytes }));
    const byUser = S.db.all(`SELECT u.display_name name, COUNT(f.id) files, IFNULL(SUM(f.size),0) bytes FROM files f LEFT JOIN users u ON u.id=f.uploader_id WHERE f.deleted=0 GROUP BY f.uploader_id ORDER BY bytes DESC LIMIT 50`);
    let disk = { free: 0, total: 0 };
    try { const s = fs.statfsSync(S.filesDir); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* */ }
    return {
      physical, logical, savedByDedup: Math.max(0, logical - physical), reclaimable, oldVersions: { count: oldVersions.n, bytes: oldVersions.b },
      duplicates, versioned, byUser, db: dbSize(), disk, filesDir: S.filesDir,
      messages: g('SELECT COUNT(*) n FROM messages'), files: g('SELECT COUNT(*) n FROM files WHERE deleted=0'),
      lastBackup: Number(S.db.meta('last_backup') || 0),
      backups: fs.existsSync(S.backupDir) ? fs.readdirSync(S.backupDir).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 14).map((f) => ({ name: f, size: fs.statSync(path.join(S.backupDir, f)).size })) : [],
    };
  }, { perm: 'storage.manage' });

  r.post('/api/admin/cleanup', (c) => {
    const action = oneOf(c.body.action, 'action', ['purge_deleted', 'old_versions', 'older_than', 'version_group'] as const);
    let marked = 0;
    if (action === 'old_versions') {
      marked = Number(S.db.run('UPDATE files SET deleted=1 WHERE deleted=0 AND version < (SELECT MAX(version) FROM files g WHERE g.group_id=files.group_id AND g.deleted=0)').changes);
    } else if (action === 'version_group') {
      const gid = String(c.body.groupId || '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(gid)) throw bad('Invalid group.');
      marked = Number(S.db.run('UPDATE files SET deleted=1 WHERE group_id=? AND deleted=0 AND version < (SELECT MAX(version) FROM files g WHERE g.group_id=? AND g.deleted=0)', gid, gid).changes);
    } else if (action === 'older_than') {
      const days = int(c.body.days, 'days', 7, 3650);
      const kind = oneOf(c.body.kind || 'all', 'kind', ['all', 'video'] as const);
      marked = Number(S.db.run(`UPDATE files SET deleted=1 WHERE deleted=0 AND created_at<?${kind === 'video' ? " AND mime LIKE 'video/%'" : ''}`, now() - days * 86400000).changes);
    }
    const gc = gcBlobs();
    audit(c.user.id, 'storage.cleanup', action, `marked=${marked} freed=${gc.freed}`, c.ip);
    return { marked, freed: gc.freed };
  }, { perm: 'storage.manage', rate: { key: 'cleanup', max: 20, windowMs: 60000 } });

  r.post('/api/admin/clear-messages', (c) => {
    const days = int(c.body.days, 'days', 30, 3650);
    const which = oneOf(c.body.which || 'group', 'which', ['group', 'all'] as const);
    const cutoff = now() - days * 86400000;
    const sql = which === 'group'
      ? "DELETE FROM messages WHERE created_at<? AND conv_id IN (SELECT id FROM conversations WHERE type='group')"
      : 'DELETE FROM messages WHERE created_at<?';
    const n = Number(S.db.run(sql, cutoff).changes);
    S.db.run(`UPDATE files SET deleted=1 WHERE scope='conv' AND created_at<? AND deleted=0${which === 'group' ? " AND scope_id IN (SELECT id FROM conversations WHERE type='group')" : ''}`, cutoff);
    const gc = gcBlobs();
    audit(c.user.id, 'storage.clear_messages', which, `days=${days} removed=${n}`, c.ip);
    return { removed: n, freed: gc.freed };
  }, { perm: 'storage.manage', rate: { key: 'cleanup', max: 20, windowMs: 60000 } });

  r.post('/api/admin/vacuum', (c) => {
    S.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    audit(c.user.id, 'storage.vacuum', '', '', c.ip);
    return { db: dbSize() };
  }, { perm: 'storage.manage', rate: { key: 'vac', max: 5, windowMs: 60000 } });

  r.post('/api/admin/backup', (c) => {
    const name = backupNow('manual');
    audit(c.user.id, 'storage.backup', name, '', c.ip);
    return { name };
  }, { perm: 'storage.manage', rate: { key: 'bk', max: 10, windowMs: 60000 } });

  r.get('/api/admin/audit', (c) => {
    const before = c.url.searchParams.get('before');
    const rows = before
      ? S.db.all('SELECT a.*, u.display_name actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id<? ORDER BY a.id DESC LIMIT 200', int(before, 'before', 1, Number.MAX_SAFE_INTEGER))
      : S.db.all('SELECT a.*, u.display_name actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200');
    return rows.map((a) => ({ id: a.id, at: a.at, actor: a.actor || (a.actor_id ? 'deleted user' : 'system'), action: a.action, target: a.target, detail: a.detail, ip: a.ip }));
  }, { perm: 'audit.view' });

  r.get('/api/admin/overview', () => {
    const g = (sql: string, ...p: unknown[]) => S.db.get<{ n: number }>(sql, ...p)!.n || 0;
    return {
      members: g("SELECT COUNT(*) n FROM users WHERE status='active'"),
      pending: g("SELECT COUNT(*) n FROM users WHERE status='pending'"),
      openTasks: g("SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','in_progress','submitted','changes')"),
      month: monthKey(now()),
    };
  });
}
