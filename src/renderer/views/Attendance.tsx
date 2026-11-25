import { useEffect, useState } from 'react';
import { api, useStore, can, toast, userName, fmtTime, monthNow, monthLabel, shiftMonth } from '../api';
import { Avatar, Btn, ErrorBox, ExportButtons, Field, Icon, Modal, Spinner, Tabs, useAsync } from '../ui';

interface Cell { s: string; in: number | null; out: number | null; note: string }
interface Sheet {
  from: string; to: string; today: string; canManage: boolean;
  settings: { start: string; end: string; grace: number; days: number[]; holidays: { day: string; name: string }[] };
  days: { day: string; working: boolean; holiday: string | null }[];
  people: { userId: string; cells: Record<string, Cell>; summary: { present: number; late: number; half: number; leave: number; absent: number; holiday: number; workingDays: number; rate: number | null } }[];
}

export const ATT: Record<string, { label: string; code: string; cls: string }> = {
  present: { label: 'Present', code: 'P', cls: 'ok' }, late: { label: 'Late', code: 'L', cls: 'warn' }, half: { label: 'Half day', code: '½', cls: 'half' },
  leave: { label: 'Leave', code: 'LV', cls: 'leave' }, absent: { label: 'Absent', code: 'A', cls: 'bad' }, holiday: { label: 'Holiday', code: 'H', cls: 'hol' },
  off: { label: 'Day off', code: '-', cls: 'off' }, pending: { label: 'Not checked in yet', code: '?', cls: 'pend' }, future: { label: '', code: '', cls: 'off' }, na: { label: '', code: '', cls: 'off' },
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const to12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const monthRange = (m: string) => { const [y, mo] = m.split('-').map(Number); const last = new Date(y, mo, 0).getDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }; };

/** "Check in" card for the signed-in person (Home + Attendance page). */
export function MyAttendance({ compact }: { compact?: boolean }) {
  const me = useStore((s) => s.me!.user.id);
  const ver = useStore((s) => s.ver.attendance);
  const { data, reload } = useAsync(async () => { const t = (await api<{ today: string }>('GET', '/api/attendance/settings')).today; return api<Sheet>('GET', `/api/attendance?from=${t}&to=${t}&userId=${me}`); }, [ver, me]);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const st = data.settings; const cell = data.people[0]?.cells[data.today];
  const act = async (what: 'check-in' | 'check-out') => {
    setBusy(true);
    try { const r = await api<any>('POST', `/api/attendance/${what}`, {}); toast(what === 'check-in' ? (r.status === 'late' ? 'Checked in (late)' : 'Checked in. Have a great day!') : 'Checked out. See you tomorrow!', 'ok'); reload(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const s = cell?.s || 'pending';
  const working = data.days[0]?.working && !data.days[0]?.holiday;
  return (
    <div className={'card att-card' + (compact ? ' compact' : '')}>
      <div className="row between wrap" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 14 }}>
          <span className={'att-big ' + (ATT[s]?.cls || 'pend')}><Icon name="clock" size={22} /></span>
          <div>
            <span className="mono">Attendance today</span>
            <h3 style={{ marginTop: 4 }}>{cell?.in ? `${ATT[s].label} · checked in ${fmtTime(cell.in)}` : !working ? (data.days[0]?.holiday ? `Holiday: ${data.days[0].holiday}` : 'Day off today') : s === 'absent' ? 'Marked absent today' : ['leave', 'half', 'holiday'].includes(s) ? ATT[s].label : 'You have not checked in yet'}</h3>
            <p className="dim" style={{ fontSize: 12.5 }}>Office hours {to12(st.start)} - {to12(st.end)} · late after {st.grace} min{cell?.out ? ` · checked out ${fmtTime(cell.out)}` : ''}</p>
          </div>
        </div>
        <div className="row">
          {!cell?.in && s !== 'leave' && <Btn kind="primary" icon="check" loading={busy} onClick={() => act('check-in')}>{working ? 'Check in' : 'Check in (extra day)'}</Btn>}
          {cell?.in && !cell.out && <Btn icon="logout" loading={busy} onClick={() => act('check-out')}>Check out</Btn>}
        </div>
      </div>
    </div>
  );
}

export function Attendance() {
  const [tab, setTab] = useState<'today' | 'month' | 'settings'>('today');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Attendance</h1><p>Office hours, check-ins, late arrivals and absences for your team. Days without a check-in become absent automatically.</p></div></div>
      <MyAttendance />
      <div className="toolbar" style={{ marginTop: 16 }}>
        <Tabs value={tab} onChange={setTab} items={[{ id: 'today', label: 'Today' }, { id: 'month', label: 'Monthly sheet' }, { id: 'settings', label: 'Office hours', hidden: !can('attendance.manage') }]} />
      </div>
      {tab === 'today' && <Today />}
      {tab === 'month' && <Month />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}

function useSheet(from: string | null, to: string | null) {
  const ver = useStore((s) => s.ver.attendance);
  return useAsync(async () => {
    let f = from, t = to;
    if (!f || !t) { const today = (await api<{ today: string }>('GET', '/api/attendance/settings')).today; f = today; t = today; }
    return api<Sheet>('GET', `/api/attendance?from=${f}&to=${t}`);
  }, [from, to, ver]);
}

function Today() {
  const users = useStore((s) => s.users);
  const { data, error, loading, reload } = useSheet(null, null);
  const [edit, setEdit] = useState<{ userId: string; day: string; cell: Cell } | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} retry={reload} />;
  if (!data) return null;
  const rows = data.people.map((p) => ({ ...p, cell: p.cells[data.today] })).sort((a, b) => (a.cell.in || 9e15) - (b.cell.in || 9e15));
  const count = (k: string) => rows.filter((r) => r.cell.s === k).length;
  return (
    <>
      <div className="kpis">
        <div className="kpi hl"><span>Present</span><b>{count('present') + count('late') + count('half')}</b><span className="dim">of {rows.length} people</span></div>
        <div className="kpi"><span>Late</span><b style={{ color: count('late') ? 'var(--yellow)' : undefined }}>{count('late')}</b></div>
        <div className="kpi"><span>Not checked in yet</span><b>{count('pending')}</b></div>
        <div className="kpi"><span>Absent</span><b style={{ color: count('absent') ? '#FF6B8E' : undefined }}>{count('absent')}</b></div>
        <div className="kpi"><span>On leave</span><b>{count('leave')}</b></div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Person</th><th>Status</th><th>Check in</th><th>Check out</th><th>Note</th>{data.canManage && <th />}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td><div className="row" style={{ gap: 8 }}><Avatar user={users[r.userId]} size={26} />{userName(r.userId)}{users[r.userId]?.isRemote && <span className="pill blue" style={{ height: 20 }}>Remote</span>}</div></td>
                <td><span className={'att-pill ' + (ATT[r.cell.s]?.cls || '')}>{ATT[r.cell.s]?.label || '-'}</span></td>
                <td>{r.cell.in ? fmtTime(r.cell.in) : <span className="dim">-</span>}</td>
                <td>{r.cell.out ? fmtTime(r.cell.out) : <span className="dim">-</span>}</td>
                <td className="dim" style={{ fontSize: 12 }}>{r.cell.note}</td>
                {data.canManage && <td style={{ textAlign: 'right' }}><Btn small kind="soft" icon="edit" onClick={() => setEdit({ userId: r.userId, day: data.today, cell: r.cell })}>Change</Btn></td>}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="dim" style={{ textAlign: 'center', padding: 24 }}>No one to show.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <EditCell {...edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function Month() {
  const users = useStore((s) => s.users);
  const [month, setMonth] = useState(monthNow());
  const { from, to } = monthRange(month);
  const { data, error, loading, reload } = useSheet(from, to);
  const [edit, setEdit] = useState<{ userId: string; day: string; cell: Cell } | null>(null);
  const exportTable = () => ({
    title: `Attendance ${monthLabel(month)}`,
    subtitle: 'P present · L late · ½ half day · LV leave · A absent · H holiday · - day off',
    columns: ['Person', ...data!.days.map((d) => d.day.slice(8)), 'Present', 'Late', 'Half', 'Leave', 'Absent', 'Attendance %'],
    rows: data!.people.map((p) => [userName(p.userId), ...data!.days.map((d) => ATT[p.cells[d.day].s]?.code || ''), p.summary.present, p.summary.late, p.summary.half, p.summary.leave, p.summary.absent, p.summary.rate]),
  });
  return (
    <>
      <div className="toolbar">
        <div className="month-pick">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="left" size={16} /></button>
          <span>{monthLabel(month)}</span>
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthNow()} aria-label="Next month"><Icon name="right" size={16} /></button>
        </div>
        <ExportButtons disabled={!data} table={exportTable} />
        <span className="att-legend">{['present', 'late', 'half', 'leave', 'absent', 'holiday', 'off'].map((k) => <span key={k}><i className={'att-cell ' + ATT[k].cls}>{ATT[k].code}</i>{ATT[k].label}</span>)}</span>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && (
        <div className="table-wrap">
          <table className="t att-grid">
            <thead><tr><th>Person</th>{data.days.map((d) => <th key={d.day} className={d.working && !d.holiday ? '' : 'dimcol'} title={d.holiday || DAYS[new Date(d.day + 'T12:00:00').getDay()]}>{Number(d.day.slice(8))}<br /><small>{DAYS[new Date(d.day + 'T12:00:00').getDay()].slice(0, 2)}</small></th>)}<th>P</th><th>L</th><th>A</th><th>LV</th><th>%</th></tr></thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.userId}>
                  <td style={{ whiteSpace: 'nowrap' }}><div className="row" style={{ gap: 6 }}><Avatar user={users[p.userId]} size={22} />{userName(p.userId)}</div></td>
                  {data.days.map((d) => {
                    const c = p.cells[d.day]; const a = ATT[c.s];
                    return (
                      <td key={d.day} className="att-td">
                        <button className={'att-cell ' + (a?.cls || '')} disabled={!data.canManage || c.s === 'na' || c.s === 'future'} title={`${d.day}: ${a?.label || ''}${c.in ? ` · in ${fmtTime(c.in)}` : ''}${c.out ? ` · out ${fmtTime(c.out)}` : ''}${c.note ? ` · ${c.note}` : ''}`}
                          onClick={() => setEdit({ userId: p.userId, day: d.day, cell: c })}>{a?.code}</button>
                      </td>
                    );
                  })}
                  <td>{p.summary.present + p.summary.late}</td><td>{p.summary.late}</td><td style={{ color: p.summary.absent ? '#FF6B8E' : undefined }}>{p.summary.absent}</td><td>{p.summary.leave}</td><td><b>{p.summary.rate ?? '-'}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <EditCell {...edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function EditCell({ userId, day, cell, onClose, onSaved }: { userId: string; day: string; cell: Cell; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(['present', 'late', 'half', 'leave', 'absent', 'holiday'].includes(cell.s) ? cell.s : 'auto');
  const [note, setNote] = useState(cell.note || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api('PUT', `/api/attendance/${userId}/${day}`, { status, note }); toast('Attendance updated', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`${userName(userId)} · ${new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} onClick={save}>Save</Btn></>}>
      {cell.in && <p className="dim">Checked in {fmtTime(cell.in)}{cell.out ? `, checked out ${fmtTime(cell.out)}` : ''}</p>}
      <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="auto">Automatic (from the check-in time)</option><option value="present">Present</option><option value="late">Late</option><option value="half">Half day</option><option value="leave">Leave</option><option value="absent">Absent</option><option value="holiday">Holiday</option>
      </select></Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Sick leave, approved by HR" /></Field>
    </Modal>
  );
}

function Settings() {
  const { data, loading, reload } = useAsync(() => api<Sheet['settings']>('GET', '/api/attendance/settings'), []);
  const [st, setSt] = useState<Sheet['settings'] | null>(null);
  const [hDay, setHDay] = useState(''); const [hName, setHName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setSt({ start: data.start, end: data.end, grace: data.grace, days: data.days, holidays: data.holidays }); }, [data]);
  if (loading || !st) return <Spinner />;
  const save = async () => {
    setBusy(true);
    try { await api('PUT', '/api/attendance/settings', st); toast('Office hours saved', 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="settings-grid">
      <div className="card col">
        <h3>Office hours</h3>
        <div className="form-row">
          <Field label="Office starts"><input type="time" value={st.start} onChange={(e) => setSt({ ...st, start: e.target.value })} /></Field>
          <Field label="Office ends" hint="No check-in by this time = absent"><input type="time" value={st.end} onChange={(e) => setSt({ ...st, end: e.target.value })} /></Field>
        </div>
        <Field label="Late after (minutes past start)"><input type="number" min={0} max={240} value={st.grace} onChange={(e) => setSt({ ...st, grace: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })} /></Field>
        <Field label="Working days">
          <div className="row wrap">{DAYS.map((d, i) => (
            <label key={d} className={'day-chip' + (st.days.includes(i) ? ' on' : '')}><input type="checkbox" checked={st.days.includes(i)} onChange={() => setSt({ ...st, days: st.days.includes(i) ? st.days.filter((x) => x !== i) : [...st.days, i] })} />{d}</label>
          ))}</div>
        </Field>
        <Btn kind="primary" loading={busy} onClick={save} style={{ alignSelf: 'flex-start' }}>Save office hours</Btn>
      </div>
      <div className="card col">
        <h3>Holidays</h3>
        <p className="dim" style={{ fontSize: 12.5 }}>Nobody is marked absent on these dates.</p>
        <div className="row"><input type="date" value={hDay} onChange={(e) => setHDay(e.target.value)} style={{ width: 170 }} /><input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="e.g. Eid-ul-Fitr" maxLength={60} className="grow" />
          <Btn icon="plus" disabled={!hDay} onClick={() => { setSt({ ...st, holidays: [...st.holidays.filter((h) => h.day !== hDay), { day: hDay, name: hName || 'Holiday' }].sort((a, b) => a.day.localeCompare(b.day)) }); setHDay(''); setHName(''); }}>Add</Btn></div>
        {st.holidays.map((h) => (
          <div key={h.day} className="row between" style={{ fontSize: 13 }}><span><b>{h.day}</b> · {h.name}</span><button className="icon-btn" aria-label="Remove holiday" onClick={() => setSt({ ...st, holidays: st.holidays.filter((x) => x.day !== h.day) })}><Icon name="trash" size={14} /></button></div>
        ))}
        {!st.holidays.length && <p className="dim">No holidays added.</p>}
        <Btn loading={busy} onClick={save} style={{ alignSelf: 'flex-start' }}>Save holidays</Btn>
      </div>
    </div>
  );
}
