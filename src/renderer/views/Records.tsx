import { useEffect, useState } from 'react';
import { api, useStore, toast, fmtAgo, userName, bunny, type User } from '../api';
import { Avatar, Btn, Empty, ErrorBox, ExportButtons, Field, Icon, Modal, Spinner, UserPicker, confirmDialog, useAsync } from '../ui';

interface Col { id: string; name: string; type: 'text' | 'number' | 'date' | 'link' | 'status' | 'person' | 'check' }
interface Sheet { id: string; title: string; ownerId: string; columns: Col[]; rows: number; updatedAt: number; canEdit: boolean; isOwner: boolean; shares: { userId: string; canEdit: boolean }[] }
interface Row { id: string; data: Record<string, any>; createdBy: string; updatedAt: number }
const TYPES: Col['type'][] = ['text', 'number', 'date', 'link', 'status', 'person', 'check'];
const TEMPLATES: { title: string; cols: Omit<Col, 'id'>[] }[] = [
  { title: 'Work handed out', cols: [{ name: 'Person', type: 'person' }, { name: 'Work', type: 'text' }, { name: 'Given on', type: 'date' }, { name: 'Deadline', type: 'date' }, { name: 'Status', type: 'status' }, { name: 'Link', type: 'link' }] },
  { title: 'Hiring tracker', cols: [{ name: 'Candidate', type: 'text' }, { name: 'Role', type: 'text' }, { name: 'Stage', type: 'status' }, { name: 'Interview', type: 'date' }, { name: 'Hired', type: 'check' }] },
  { title: 'Monthly expenses', cols: [{ name: 'Item', type: 'text' }, { name: 'Amount', type: 'number' }, { name: 'Date', type: 'date' }, { name: 'Paid', type: 'check' }] },
  { title: 'Leads', cols: [{ name: 'Client', type: 'text' }, { name: 'Contact', type: 'text' }, { name: 'Source', type: 'link' }, { name: 'Stage', type: 'status' }, { name: 'Owner', type: 'person' }] },
];
const cid = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');

export function Records() {
  const ver = useStore((s) => s.ver.sheets);
  const { data, error, loading, reload } = useAsync(() => api<Sheet[]>('GET', '/api/sheets'), [ver]);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (data && !sel && data[0]) setSel(data[0].id); }, [data]);
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div><h1>Records</h1><p>Private sheets for your own notes: who got which work, hiring, expenses, leads. Only you and the people you share with can see them.</p></div>
        <Btn kind="primary" icon="plus" onClick={() => setCreating(true)}>New sheet</Btn>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon="records" title="No sheets yet" text="Create one from a template to start keeping records." action={<Btn kind="primary" icon="plus" onClick={() => setCreating(true)}>New sheet</Btn>} /> : (
        <div className="records" style={{ flex: 1 }}>
          <div className="sheet-list">
            {data.map((s) => (
              <button key={s.id} className={'sheet-item' + (s.id === sel ? ' on' : '')} onClick={() => setSel(s.id)}>
                <Icon name="records" />
                <span className="grow"><b className="ellipsis">{s.title}</b><small>{s.rows} rows · {s.isOwner ? (s.shares.length ? `shared with ${s.shares.length}` : 'private') : `from ${userName(s.ownerId)}`}</small></span>
              </button>
            ))}
          </div>
          {sel && <SheetView key={sel} id={sel} onDeleted={() => { setSel(null); reload(); }} onChanged={reload} />}
        </div>
      )}
      {creating && <NewSheet onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); reload(); setSel(id); }} />}
    </div>
  );
}

function NewSheet({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [tpl, setTpl] = useState(0);
  const [title, setTitle] = useState(TEMPLATES[0].title);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const s = await api<Sheet>('POST', '/api/sheets', { title, columns: TEMPLATES[tpl].cols.map((c) => ({ ...c, id: cid() })) }); onDone(s.id); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="New sheet" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!title.trim()} onClick={go}>Create</Btn></>}>
      <Field label="Start from"><select value={tpl} onChange={(e) => { setTpl(Number(e.target.value)); setTitle(TEMPLATES[Number(e.target.value)].title); }}>{TEMPLATES.map((t, i) => <option key={i} value={i}>{t.title}</option>)}</select></Field>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} /></Field>
      <p className="dim" style={{ fontSize: 12 }}>Columns: {TEMPLATES[tpl].cols.map((c) => c.name).join(', ')}. You can change them later.</p>
    </Modal>
  );
}

function Cell({ col, value, edit, onSave, users }: { col: Col; value: any; edit: boolean; onSave: (v: any) => void; users: User[] }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  if (col.type === 'check') return <input type="checkbox" checked={!!value} disabled={!edit} onChange={(e) => onSave(e.target.checked)} />;
  if (!edit) {
    if (col.type === 'link' && value) return <a onClick={() => bunny.openExternal(value)} className="ellipsis" style={{ maxWidth: 220, display: 'inline-block' }}>{value}</a>;
    if (col.type === 'person') return <span>{value ? userName(value) : ''}</span>;
    return <span>{String(value ?? '')}</span>;
  }
  if (col.type === 'person') return <select className="cell-input" value={v} onChange={(e) => { setV(e.target.value); onSave(e.target.value); }}><option value="" />{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>;
  const commit = () => { if (String(v) !== String(value ?? '')) onSave(v); };
  return (
    <div className="row" style={{ gap: 4 }}>
      <input className="cell-input" type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {col.type === 'link' && value && <button className="icon-btn" title="Open link" onClick={() => bunny.openExternal(value)}><Icon name="link" size={14} /></button>}
    </div>
  );
}

function SheetView({ id, onDeleted, onChanged }: { id: string; onDeleted: () => void; onChanged: () => void }) {
  const ver = useStore((s) => s.ver.sheets);
  const users = useStore((s) => s.users);
  const { data, error, loading, reload } = useAsync(() => api<{ sheet: Sheet; rows: Row[] }>('GET', `/api/sheets/${id}`), [id, ver]);
  const [cols, setCols] = useState(false);
  const [share, setShare] = useState(false);
  const [q, setQ] = useState('');
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} retry={reload} />;
  if (!data) return null;
  const { sheet, rows } = data;
  const people = Object.values(users).filter((u) => u.status === 'active');
  const save = async (row: Row, colId: string, v: any) => {
    try { await api('PATCH', `/api/sheets/${id}/rows/${row.id}`, { data: { ...row.data, [colId]: v } }); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const add = async () => { try { await api('POST', `/api/sheets/${id}/rows`, { data: {} }); reload(); onChanged(); } catch (e) { toast((e as Error).message, 'err'); } };
  const delRow = async (r: Row) => { try { await api('DELETE', `/api/sheets/${id}/rows/${r.id}`); reload(); onChanged(); } catch (e) { toast((e as Error).message, 'err'); } };
  const delSheet = async () => {
    if (!(await confirmDialog({ title: `Delete "${sheet.title}"?`, text: 'All rows are deleted permanently.', ok: 'Delete', danger: true, input: 'DELETE' }))) return;
    await api('DELETE', `/api/sheets/${id}`); onDeleted();
  };
  const shown = rows.filter((r) => !q || Object.values(r.data).some((v) => String(v).toLowerCase().includes(q.toLowerCase()) || (users[String(v)]?.displayName || '').toLowerCase().includes(q.toLowerCase())));
  const exportCsv = () => {
    const esc = (s: unknown) => { let t = String(s ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const lines = [sheet.columns.map((c) => esc(c.name)).join(','), ...rows.map((r) => sheet.columns.map((c) => esc(c.type === 'person' ? userName(r.data[c.id]) : r.data[c.id])).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    a.download = sheet.title.replace(/[^\w\- ]/g, '_') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="col" style={{ minWidth: 0 }}>
      <div className="row between wrap">
        <div><h2>{sheet.title}</h2><p className="dim" style={{ fontSize: 12 }}>{sheet.isOwner ? (sheet.shares.length ? `Shared with ${sheet.shares.length} people` : 'Private to you') : `Owned by ${userName(sheet.ownerId)}${sheet.canEdit ? ' · you can edit' : ' · view only'}`} · updated {fmtAgo(sheet.updatedAt)}</p></div>
        <div className="row">
          <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter rows" /></div>
          <ExportButtons table={() => ({ title: sheet.title, subtitle: `Records sheet · ${rows.length} rows`, columns: sheet.columns.map((c) => c.name), rows: shown.map((r) => sheet.columns.map((c) => { const v = r.data[c.id]; return c.type === 'person' ? (v ? userName(v) : '') : c.type === 'check' ? !!v : c.type === 'number' && v !== undefined ? Number(v) : v ?? ''; })) })} />
          <Btn small icon="download" onClick={exportCsv}>CSV</Btn>
          {sheet.isOwner && <><Btn small icon="users" onClick={() => setShare(true)}>Share</Btn><Btn small icon="settings" onClick={() => setCols(true)}>Columns</Btn><button className="icon-btn" title="Delete sheet" onClick={delSheet}><Icon name="trash" /></button></>}
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr>{sheet.columns.map((c) => <th key={c.id}>{c.name}</th>)}{sheet.canEdit && <th />}</tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                {sheet.columns.map((c) => <td key={c.id}><Cell col={c} value={r.data[c.id]} edit={sheet.canEdit} users={people} onSave={(v) => save(r, c.id, v)} /></td>)}
                {sheet.canEdit && <td style={{ width: 40 }}><button className="icon-btn" title="Delete row" onClick={() => delRow(r)}><Icon name="trash" size={14} /></button></td>}
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={sheet.columns.length + 1} className="dim" style={{ textAlign: 'center', padding: 24 }}>{rows.length ? 'No rows match.' : 'No rows yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {sheet.canEdit && <Btn icon="plus" onClick={add} style={{ alignSelf: 'flex-start' }}>Add row</Btn>}
      {cols && <ColumnsEditor sheet={sheet} onClose={() => setCols(false)} onSaved={() => { setCols(false); reload(); }} />}
      {share && <ShareEditor sheet={sheet} onClose={() => setShare(false)} onSaved={() => { setShare(false); reload(); onChanged(); }} />}
    </div>
  );
}

function ColumnsEditor({ sheet, onClose, onSaved }: { sheet: Sheet; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(sheet.title);
  const [cols, setCols] = useState<Col[]>(sheet.columns);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api('PATCH', `/api/sheets/${sheet.id}`, { title, columns: cols }); onSaved(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const move = (i: number, d: number) => { const c = [...cols]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x); setCols(c); };
  return (
    <Modal title="Edit sheet" onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!title.trim() || !cols.length || cols.some((c) => !c.name.trim())} onClick={save}>Save</Btn></>}>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} /></Field>
      {cols.map((c, i) => (
        <div key={c.id} className="row">
          <input value={c.name} onChange={(e) => setCols(cols.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} maxLength={40} className="grow" />
          <select value={c.type} onChange={(e) => setCols(cols.map((x) => (x.id === c.id ? { ...x, type: e.target.value as Col['type'] } : x)))} style={{ width: 130 }}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="up" size={14} /></button>
          <button className="icon-btn" disabled={i === cols.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="down" size={14} /></button>
          <button className="icon-btn" onClick={() => setCols(cols.filter((x) => x.id !== c.id))} aria-label="Remove column"><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <Btn small icon="plus" disabled={cols.length >= 30} onClick={() => setCols([...cols, { id: cid(), name: 'New column', type: 'text' }])} style={{ alignSelf: 'flex-start' }}>Add column</Btn>
    </Modal>
  );
}

function ShareEditor({ sheet, onClose, onSaved }: { sheet: Sheet; onClose: () => void; onSaved: () => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user.id);
  const [shares, setShares] = useState(sheet.shares);
  const [busy, setBusy] = useState(false);
  const people = Object.values(users).filter((u) => u.id !== me && u.status === 'active' && !u.isRemote);
  const save = async () => {
    setBusy(true);
    try { await api('PUT', `/api/sheets/${sheet.id}/shares`, { shares }); toast('Sharing updated', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Share sheet" onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} onClick={save}>Save</Btn></>}>
      <p className="muted">Only the people below can see this sheet. Nobody else can, including admins.</p>
      {shares.map((s) => (
        <div key={s.userId} className="row">
          <Avatar user={users[s.userId]} size={28} /><span className="grow">{userName(s.userId)}</span>
          <select value={s.canEdit ? 'edit' : 'view'} onChange={(e) => setShares(shares.map((x) => (x.userId === s.userId ? { ...x, canEdit: e.target.value === 'edit' } : x)))} style={{ width: 130 }}><option value="view">Can view</option><option value="edit">Can edit</option></select>
          <button className="icon-btn" onClick={() => setShares(shares.filter((x) => x.userId !== s.userId))} aria-label="Remove"><Icon name="x" /></button>
        </div>
      ))}
      <UserPicker users={people.filter((u) => !shares.some((s) => s.userId === u.id))} selected={[]} onChange={(ids) => setShares([...shares, ...ids.map((userId) => ({ userId, canEdit: false }))])} placeholder="Add people" />
    </Modal>
  );
}
