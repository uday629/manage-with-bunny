// Private record sheets ("who got what, when"): visible only to the creator and people they share with.
import crypto from 'node:crypto';
import { Router, bad, forbidden, notFound, str, id as vid, type AuthUser } from './http';
import { S, audit, isActive, isRemote } from './core';
import { newId, now } from './db';

const COL_TYPES = ['text', 'number', 'date', 'link', 'status', 'person', 'check'] as const;

function parseColumns(v: unknown) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 30) throw bad('A sheet needs 1 to 30 columns.');
  const seen = new Set<string>();
  return v.map((c: any) => {
    const id = typeof c?.id === 'string' && /^[a-z0-9]{1,12}$/.test(c.id) ? c.id : crypto.randomBytes(5).toString('hex');
    if (seen.has(id)) throw bad('Duplicate column.');
    seen.add(id);
    const type = COL_TYPES.includes(c?.type) ? c.type : 'text';
    return { id, name: str(c?.name, 'Column name', 1, 40), type };
  });
}

function parseRow(cols: { id: string; type: string }[], data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Invalid row.');
  const out: Record<string, string | number | boolean> = {};
  for (const col of cols) {
    const v = (data as any)[col.id];
    if (v === undefined || v === null || v === '') continue;
    if (col.type === 'check') out[col.id] = !!v;
    else if (col.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) throw bad(`"${v}" is not a number.`); out[col.id] = n; }
    else if (col.type === 'link') {
      const s = String(v).trim().slice(0, 2000);
      let u: URL; try { u = new URL(s); } catch { throw bad('Links must be full http(s) URLs.'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('Links must start with http(s)://');
      out[col.id] = u.toString();
    } else out[col.id] = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2000);
  }
  return out;
}

function access(u: AuthUser, sheetId: string) {
  const s = S.db.get('SELECT * FROM sheets WHERE id=?', sheetId);
  if (!s) throw notFound('Sheet not found.');
  if (s.owner_id === u.id) return { s, edit: true, owner: true };
  const sh = S.db.get('SELECT can_edit FROM sheet_shares WHERE sheet_id=? AND user_id=?', s.id, u.id);
  if (!sh) throw notFound('Sheet not found.');
  return { s, edit: !!sh.can_edit, owner: false };
}
const sheetOut = (s: any, edit: boolean, owner: boolean) => ({
  id: s.id, title: s.title, ownerId: s.owner_id, columns: JSON.parse(s.columns), createdAt: s.created_at, updatedAt: s.updated_at, canEdit: edit, isOwner: owner,
  rows: S.db.get<{ n: number }>('SELECT COUNT(*) n FROM sheet_rows WHERE sheet_id=?', s.id)!.n,
  shares: owner ? S.db.all('SELECT user_id, can_edit FROM sheet_shares WHERE sheet_id=?', s.id).map((x) => ({ userId: x.user_id, canEdit: !!x.can_edit })) : [],
});
const touch = (id: string) => S.db.run('UPDATE sheets SET updated_at=? WHERE id=?', now(), id);
const notifySheet = (sheetId: string) => {
  const s = S.db.get('SELECT owner_id FROM sheets WHERE id=?', sheetId);
  if (!s) return;
  S.hub.send([s.owner_id, ...S.db.all<{ user_id: string }>('SELECT user_id FROM sheet_shares WHERE sheet_id=?', sheetId).map((x) => x.user_id)], { t: 'sheet', id: sheetId });
};

export function registerRecords(r: Router) {
  r.get('/api/sheets', (c) => {
    const own = S.db.all('SELECT * FROM sheets WHERE owner_id=? ORDER BY updated_at DESC', c.user.id).map((s) => sheetOut(s, true, true));
    const shared = S.db.all('SELECT s.*, sh.can_edit FROM sheets s JOIN sheet_shares sh ON sh.sheet_id=s.id WHERE sh.user_id=? ORDER BY s.updated_at DESC', c.user.id).map((s) => sheetOut(s, !!s.can_edit, false));
    return [...own, ...shared];
  });

  r.post('/api/sheets', (c) => {
    const title = str(c.body.title, 'Title', 1, 80);
    const cols = parseColumns(c.body.columns);
    if (S.db.get<{ n: number }>('SELECT COUNT(*) n FROM sheets WHERE owner_id=?', c.user.id)!.n >= 200) throw bad('You have too many sheets.');
    const id = newId();
    S.db.run('INSERT INTO sheets(id,owner_id,title,columns,created_at,updated_at) VALUES(?,?,?,?,?,?)', id, c.user.id, title, JSON.stringify(cols), now(), now());
    return sheetOut(S.db.get('SELECT * FROM sheets WHERE id=?', id), true, true);
  });

  r.get('/api/sheets/:id', (c) => {
    const a = access(c.user, vid(c.params.id));
    const rows = S.db.all('SELECT * FROM sheet_rows WHERE sheet_id=? ORDER BY position, created_at LIMIT 5000', a.s.id).map((x) => ({ id: x.id, data: JSON.parse(x.data), createdBy: x.created_by, updatedAt: x.updated_at }));
    return { sheet: sheetOut(a.s, a.edit, a.owner), rows };
  });

  r.patch('/api/sheets/:id', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.owner) throw forbidden('Only the sheet owner can change its structure.');
    if (c.body.title !== undefined) S.db.run('UPDATE sheets SET title=? WHERE id=?', str(c.body.title, 'Title', 1, 80), a.s.id);
    if (c.body.columns !== undefined) S.db.run('UPDATE sheets SET columns=? WHERE id=?', JSON.stringify(parseColumns(c.body.columns)), a.s.id);
    touch(a.s.id); notifySheet(a.s.id);
    return { ok: true };
  });

  r.del('/api/sheets/:id', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.owner) throw forbidden('Only the sheet owner can delete it.');
    S.db.run('DELETE FROM sheets WHERE id=?', a.s.id);
    audit(c.user.id, 'sheet.deleted', a.s.id, a.s.title, c.ip);
    return { ok: true };
  });

  r.put('/api/sheets/:id/shares', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.owner) throw forbidden('Only the sheet owner can share it.');
    if (!Array.isArray(c.body.shares) || c.body.shares.length > 200) throw bad('Invalid shares.');
    const list = (c.body.shares as any[]).map((x) => ({ userId: vid(x?.userId, 'user'), canEdit: !!x?.canEdit })).filter((x) => x.userId !== c.user.id);
    for (const x of list) if (!isActive(x.userId) || isRemote(x.userId)) throw bad('Can only share with active members who can sign in.');
    S.db.tx(() => {
      S.db.run('DELETE FROM sheet_shares WHERE sheet_id=?', a.s.id);
      for (const x of list) S.db.run('INSERT INTO sheet_shares(sheet_id,user_id,can_edit) VALUES(?,?,?)', a.s.id, x.userId, x.canEdit ? 1 : 0);
    });
    audit(c.user.id, 'sheet.shared', a.s.id, `${list.length} people`, c.ip);
    notifySheet(a.s.id);
    return { ok: true };
  });

  r.post('/api/sheets/:id/rows', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.edit) throw forbidden('You can only view this sheet.');
    if (S.db.get<{ n: number }>('SELECT COUNT(*) n FROM sheet_rows WHERE sheet_id=?', a.s.id)!.n >= 5000) throw bad('This sheet is full (5000 rows).');
    const data = parseRow(JSON.parse(a.s.columns), c.body.data);
    const pos = (S.db.get<{ p: number | null }>('SELECT MAX(position) p FROM sheet_rows WHERE sheet_id=?', a.s.id)!.p ?? 0) + 1;
    const id = newId();
    S.db.run('INSERT INTO sheet_rows(id,sheet_id,data,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, a.s.id, JSON.stringify(data), pos, c.user.id, now(), now());
    touch(a.s.id); notifySheet(a.s.id);
    return { id, data };
  }, { rate: { key: 'row', max: 600, windowMs: 60000 } });

  r.patch('/api/sheets/:id/rows/:rowId', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.edit) throw forbidden('You can only view this sheet.');
    const row = S.db.get('SELECT id FROM sheet_rows WHERE id=? AND sheet_id=?', vid(c.params.rowId), a.s.id);
    if (!row) throw notFound('Row not found.');
    const data = parseRow(JSON.parse(a.s.columns), c.body.data);
    S.db.run('UPDATE sheet_rows SET data=?, updated_at=? WHERE id=?', JSON.stringify(data), now(), row.id);
    touch(a.s.id); notifySheet(a.s.id);
    return { id: row.id, data };
  }, { rate: { key: 'row', max: 600, windowMs: 60000 } });

  r.del('/api/sheets/:id/rows/:rowId', (c) => {
    const a = access(c.user, vid(c.params.id));
    if (!a.edit) throw forbidden('You can only view this sheet.');
    S.db.run('DELETE FROM sheet_rows WHERE id=? AND sheet_id=?', vid(c.params.rowId), a.s.id);
    touch(a.s.id); notifySheet(a.s.id);
    return { ok: true };
  });
}
