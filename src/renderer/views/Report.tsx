// Work report: one sheet with every task and daily update for a period. Who did what, for whom, for which client,
// how long it took, how it went, and links to the work (Drive links and files stored on the host).
import { useMemo, useState } from 'react';
import { api, bunny, useStore, navigate, userName, downloadFile, fmtDate, fmtBytes, toast } from '../api';
import { Avatar, ErrorBox, ExportButtons, Icon, Spinner, Stars, useAsync } from '../ui';
import { STATUS } from './Tasks';

interface Row {
  kind: 'task' | 'log'; id: string; date: number; personId: string | null; byId: string | null; work: string; details: string; client: string;
  status: string; hours: number | null; elapsedHours: number | null; dueAt: number | null; completedAt: number | null; onTime: boolean | null;
  revisions: number; rating: number | null; links: string[]; files: { id: string; name: string; size: number }[];
}

const RANGES: { id: string; label: string; days: number }[] = [
  { id: '1d', label: 'Today', days: 1 }, { id: '2d', label: '2 days', days: 2 }, { id: '3d', label: '3 days', days: 3 }, { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 }, { id: '90d', label: '90 days', days: 90 }, { id: '6m', label: '6 months', days: 182 }, { id: '1y', label: '1 year', days: 365 },
];
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const toInput = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtH = (h: number | null) => (h === null || h === undefined ? '' : h < 1 / 60 ? '< 1 min' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} days`);

export function perfLabel(r: Row): { text: string; tone: string } {
  if (r.kind === 'log') return { text: r.hours ? `${r.hours} h logged` : 'Update', tone: '' };
  if (r.status === 'cancelled') return { text: 'Cancelled', tone: '' };
  const parts: string[] = [];
  let tone = '';
  if (r.completedAt) {
    if (r.onTime) { parts.push('On time'); tone = 'ok'; } else { parts.push(`Late ${fmtH((r.completedAt - (r.dueAt || r.completedAt)) / 3600000)}`); tone = 'bad'; }
  } else if (r.onTime === false) { parts.push('Overdue'); tone = 'bad'; } else parts.push('In progress');
  if (r.revisions) { parts.push(`${r.revisions} revision${r.revisions > 1 ? 's' : ''}`); if (tone === 'ok') tone = 'warn'; }
  if (r.rating) parts.push(`${r.rating}/5`);
  return { text: parts.join(' · '), tone };
}

export function Report() {
  const users = useStore((s) => s.users);
  const [range, setRange] = useState('7d');
  const [from, setFrom] = useState(toInput(Date.now() - 6 * 86400000));
  const [to, setTo] = useState(toInput(Date.now()));
  const [person, setPerson] = useState('');
  const [client, setClient] = useState('');
  const [kind, setKind] = useState<'all' | 'task' | 'log'>('all');
  const [q, setQ] = useState('');
  const period = useMemo(() => {
    if (range === 'custom') { const f = new Date(from + 'T00:00:00').getTime(); const t = new Date(to + 'T00:00:00').getTime() + 86400000; return { f, t: Math.max(t, f + 86400000) }; }
    const days = RANGES.find((r) => r.id === range)!.days;
    return { f: dayStart(new Date(Date.now() - (days - 1) * 86400000)), t: Date.now() + 60000 };
  }, [range, from, to]);
  const ver = useStore((s) => s.ver.tasks + s.ver.worklog);
  const { data, error, loading, reload } = useAsync(() => api<{ rows: Row[]; clients: string[] }>('GET', `/api/report?from=${period.f}&to=${period.t}${person ? '&userId=' + person : ''}${client ? '&client=' + encodeURIComponent(client) : ''}`), [period.f, period.t, person, client, ver]);
  const rows = (data?.rows || []).filter((r) => (kind === 'all' || r.kind === kind) && (!q || `${r.work} ${r.details} ${r.client} ${userName(r.personId)} ${userName(r.byId)}`.toLowerCase().includes(q.toLowerCase())));
  const tasks = rows.filter((r) => r.kind === 'task');
  const done = tasks.filter((r) => r.status === 'done');
  const hours = rows.reduce((a, r) => a + (r.hours ?? (r.kind === 'task' ? 0 : 0)), 0);
  const onTimePct = done.length ? Math.round((done.filter((r) => r.onTime).length / done.length) * 100) : null;
  const rated = done.filter((r) => r.rating);
  const avgRating = rated.length ? Math.round((rated.reduce((a, r) => a + (r.rating || 0), 0) / rated.length) * 10) / 10 : null;
  const people = Object.values(users).filter((u) => u.status === 'active').sort((a, b) => a.displayName.localeCompare(b.displayName));
  const periodLabel = `${fmtDate(period.f)} - ${fmtDate(Math.min(period.t, Date.now()))}`;
  const exportTable = () => ({
    title: `Work report ${periodLabel}`,
    subtitle: [person && userName(person), client && `Client: ${client}`, `${rows.length} items`, `${Math.round(hours * 10) / 10} h`, onTimePct !== null ? `${onTimePct}% on time` : ''].filter(Boolean).join(' · '),
    columns: ['Date', 'Person', 'Work', 'Given by / logged by', 'Client', 'Type', 'Status', 'Hours spent', 'Elapsed', 'Performance', 'Rating', 'Revisions', 'Links', 'Files on host', 'Details'],
    rows: rows.map((r) => [fmtDate(r.date), userName(r.personId), r.work, userName(r.byId), r.client, r.kind === 'task' ? 'Task' : 'Daily update', r.kind === 'task' ? STATUS[r.status]?.label || r.status : 'Logged',
      r.hours, r.elapsedHours !== null ? fmtH(r.elapsedHours) : '', perfLabel(r).text, r.rating, r.kind === 'task' ? r.revisions : null, r.links.join('\n'), r.files.map((f) => f.name).join('\n'), r.details]),
  });
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Work report</h1><p>Everything in one sheet: who did which work, for whom and which client, how long it took, how it went, and links to the work.</p></div>
        <ExportButtons disabled={!rows.length} table={exportTable} />
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {RANGES.map((r) => <button key={r.id} role="tab" aria-selected={range === r.id} className={'tab' + (range === r.id ? ' on' : '')} onClick={() => setRange(r.id)}>{r.label}</button>)}
          <button role="tab" aria-selected={range === 'custom'} className={'tab' + (range === 'custom' ? ' on' : '')} onClick={() => setRange('custom')}>Custom</button>
        </div>
        {range === 'custom' && <span className="row"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} /><span className="dim">to</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} /></span>}
      </div>
      <div className="toolbar">
        <select value={person} onChange={(e) => setPerson(e.target.value)} style={{ width: 200 }} aria-label="Person"><option value="">Everyone I can see</option>{people.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.isRemote ? ' (remote)' : ''}</option>)}</select>
        <select value={client} onChange={(e) => setClient(e.target.value)} style={{ width: 200 }} aria-label="Client"><option value="">All clients</option>{(data?.clients || []).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} style={{ width: 210 }} aria-label="Type"><option value="all">Tasks + daily updates</option><option value="task">Tasks only</option><option value="log">Daily updates only</option></select>
        <div className="search-box grow" style={{ maxWidth: 280 }}><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search work, client, person" /></div>
        <span className="dim" style={{ fontSize: 12.5 }}>{periodLabel}</span>
      </div>
      <div className="kpis">
        <div className="kpi hl"><span>Items in this period</span><b>{rows.length}</b><span className="dim">{tasks.length} tasks · {rows.length - tasks.length} daily updates</span></div>
        <div className="kpi"><span>Completed tasks</span><b>{done.length}</b></div>
        <div className="kpi"><span>Hours spent (reported)</span><b>{Math.round(hours * 10) / 10}</b></div>
        <div className="kpi"><span>On time</span><b>{onTimePct === null ? '-' : onTimePct + '%'}</b></div>
        <div className="kpi"><span>Average quality</span><b>{avgRating ?? '-'}{avgRating ? <span className="dim" style={{ fontSize: 16 }}> / 5</span> : null}</b></div>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : (
        <div className="table-wrap report">
          <table className="t">
            <thead><tr><th>Date</th><th>Person</th><th>Work</th><th>Given by</th><th>Client</th><th>Status</th><th>Time</th><th>Performance</th><th>Links &amp; files</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const p = perfLabel(r);
                return (
                  <tr key={r.kind + r.id} className={r.kind === 'task' ? 'click' : ''} onClick={(e) => { if (r.kind === 'task' && !(e.target as HTMLElement).closest('a,button')) navigate('tasks', r.id); }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                    <td><div className="row" style={{ gap: 8, whiteSpace: 'nowrap' }}><Avatar user={r.personId ? users[r.personId] : null} size={24} />{userName(r.personId)}</div></td>
                    <td style={{ minWidth: 220 }}><b style={{ display: 'block' }}>{r.work.length > 140 ? r.work.slice(0, 140) + '...' : r.work}</b>{r.kind === 'log' && <small className="dim">Daily update</small>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.byId && r.byId !== r.personId ? userName(r.byId) : <span className="dim">-</span>}</td>
                    <td>{r.client || <span className="dim">-</span>}</td>
                    <td>{r.kind === 'task' ? <span className="pill" style={{ color: STATUS[r.status]?.color }}>{STATUS[r.status]?.label}</span> : <span className="pill blue">Logged</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.hours !== null && r.hours !== undefined ? `${r.hours} h` : r.elapsedHours !== null ? <span title="Time from start to completion">{fmtH(r.elapsedHours)}</span> : <span className="dim">-</span>}</td>
                    <td style={{ minWidth: 150 }}><span className={'pill' + (p.tone ? ' ' + p.tone : '')}>{p.text}</span>{r.rating ? <div style={{ marginTop: 4 }}><Stars value={r.rating} size={12} /></div> : null}</td>
                    <td style={{ minWidth: 180 }}>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {r.links.map((l) => <a key={l} className="pill blue" title={l} onClick={() => bunny.openExternal(l)}><Icon name="link" size={11} />{(() => { try { return new URL(l).hostname.replace(/^www\./, ''); } catch { return 'link'; } })()}</a>)}
                        {r.files.map((f) => <button key={f.id} className="pill" title={`${f.name} (${fmtBytes(f.size)})`} onClick={() => downloadFile(f).catch((e) => toast(e.message, 'err'))}><Icon name="download" size={11} />{f.name.length > 22 ? f.name.slice(0, 20) + '...' : f.name}</button>)}
                        {!r.links.length && !r.files.length && <span className="dim">-</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={9} className="dim" style={{ textAlign: 'center', padding: 30 }}>Nothing in this period. Try a longer range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>Time: hours reported by the person when submitting (or in their daily update); otherwise the time from start to completion. Quality stars are given by the person who approved the work.</p>
    </div>
  );
}
