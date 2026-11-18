// Daily work updates. For remote profiles the caretaker writes them, so off-Wi-Fi work is tracked with the rest of the team.
import { useState } from 'react';
import { api, bunny, useStore, toast, userName, fmtDate, monthNow, monthLabel, shiftMonth } from '../api';
import { Btn, ErrorBox, ExportButtons, Field, Icon, Modal, RichText, Spinner, confirmDialog, useAsync } from '../ui';

interface Entry { id: string; userId: string; authorId: string | null; day: string; hours: number | null; note: string; links: string[]; createdAt: number }

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function WorkLog({ userId, compact }: { userId: string; compact?: boolean }) {
  const ver = useStore((s) => s.ver.worklog);
  const me = useStore((s) => s.me!.user.id);
  const [month, setMonth] = useState(monthNow());
  const { data, error, loading, reload } = useAsync(() => api<{ canWrite: boolean; entries: Entry[] }>('GET', `/api/users/${userId}/worklog?month=${month}`), [userId, month, ver]);
  const [day, setDay] = useState(todayStr());
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [links, setLinks] = useState('');
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/users/${userId}/worklog`, { day, hours: hours === '' ? null : Number(hours), note, client, links: links.split(/\s+/).filter(Boolean) });
      setNote(''); setLinks(''); setHours(''); reload();
      toast('Work update saved', 'ok');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const del = async (e: Entry) => {
    if (!(await confirmDialog({ title: 'Delete this update?', text: 'It is removed from the work log.', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/worklog/${e.id}`); reload(); } catch (err) { toast((err as Error).message, 'err'); }
  };
  const total = (data?.entries || []).reduce((a, e) => a + (e.hours || 0), 0);
  return (
    <div className="col">
      <div className="row between wrap">
        <div className="row"><h4>Work log</h4>{!!data?.entries.length && <ExportButtons table={() => ({ title: `Work log - ${userName(userId)} - ${monthLabel(month)}`, subtitle: `${total} hours logged`, columns: ['Date', 'Hours', 'What was done', 'Links', 'Written by'], rows: data!.entries.map((e) => [e.day, e.hours, e.note, e.links.join('\n'), userName(e.authorId)]) })} />}</div>
        <div className="month-pick">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="left" size={16} /></button>
          <span>{monthLabel(month)}</span>
          <button className="icon-btn" disabled={month >= monthNow()} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><Icon name="right" size={16} /></button>
        </div>
      </div>
      {data?.canWrite && (
        <div className="card col" style={{ padding: 14 }}>
          <div className="form-row">
            <Field label="Date"><input type="date" value={day} max={todayStr()} onChange={(e) => setDay(e.target.value)} /></Field>
            <Field label="Hours (optional)"><input type="number" min={0} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
          </div>
          <Field label="What was done"><textarea rows={compact ? 2 : 3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} placeholder="e.g. Finished 3 reels for XYZ, sent drafts by email" /></Field>
          <Field label="Client (optional)"><input value={client} onChange={(e) => setClient(e.target.value)} maxLength={80} placeholder="Which client was this for?" /></Field>
          <Field label="Links (optional, one per line)"><textarea rows={1} style={{ minHeight: 42 }} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://drive.google.com/..." /></Field>
          <Btn kind="primary" icon="plus" loading={busy} disabled={!note.trim() || !day} onClick={add} style={{ alignSelf: 'flex-start' }}>Add update</Btn>
        </div>
      )}
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && (data.entries.length ? <>
        <p className="dim" style={{ fontSize: 12 }}>{data.entries.length} update{data.entries.length > 1 ? 's' : ''}{total ? ` · ${total} h logged` : ''} this month</p>
        {data.entries.map((e) => (
          <div key={e.id} className="ev">
            <span className="pill" style={{ height: 'auto', padding: '4px 8px', flexDirection: 'column', gap: 0, minWidth: 64 }}><b style={{ color: 'var(--ink)' }}>{fmtDate(new Date(e.day + 'T12:00:00').getTime())}</b>{e.hours !== null && <span>{e.hours} h</span>}</span>
            <div className="evb">
              <div className="note" style={{ marginTop: 0 }}><RichText text={e.note} /></div>
              {e.links.length > 0 && <div className="row wrap" style={{ marginTop: 6 }}>{e.links.map((l) => <a key={l} className="pill blue" onClick={() => bunny.openExternal(l)}><Icon name="link" size={12} />{new URL(l).hostname}</a>)}</div>}
              <div className="evh" style={{ marginTop: 4 }}>by {e.authorId === me ? 'you' : userName(e.authorId)}{e.authorId !== e.userId ? ' (on their behalf)' : ''}{e.authorId === me && <> · <a onClick={() => del(e)}>delete</a></>}</div>
            </div>
          </div>
        ))}
      </> : <p className="dim">No updates in {monthLabel(month)}.</p>)}
    </div>
  );
}

export function WorkLogModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  return <Modal title={`Work log: ${userName(userId)}`} onClose={onClose} wide><WorkLog userId={userId} /></Modal>;
}
