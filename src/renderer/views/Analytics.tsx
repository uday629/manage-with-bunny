import { useEffect, useState } from 'react';
import { api, useStore, monthNow, monthLabel, shiftMonth, userName, toast, navigate } from '../api';
import { Avatar, Btn, ErrorBox, ExportButtons, Field, Icon, Modal, Progress, Spinner, Stars, useAsync } from '../ui';
import { STATUS } from './Tasks';
import { WorkLog } from './WorkLog';

interface Person { loggedHours: number; updates: number; userId: string; assigned: number; completed: number; onTime: number; overdue: number; open: number; avgHours: number | null; revisions: number; score: number | null; review: { rating: number; note: string; reviewerId: string } | null; canReview: boolean }
interface Data { month: string; people: Person[]; byStatus: { status: string; n: number }[] }
type SortKey = 'name' | 'score' | 'completed' | 'assigned' | 'onTime' | 'overdue' | 'avgHours';

const scoreTone = (s: number | null) => (s === null ? 'var(--faint)' : s >= 80 ? 'linear-gradient(90deg,#2BD488,#7BE8B5)' : s >= 55 ? 'linear-gradient(90deg,#FF8A00,#FFC53D)' : 'linear-gradient(90deg,#FF1F56,#FF6B8E)');

export function Analytics() {
  const arg = useStore((s) => s.routeArg);
  const ver = useStore((s) => s.ver.tasks);
  const users = useStore((s) => s.users);
  const [month, setMonth] = useState(monthNow());
  const [sort, setSort] = useState<SortKey>('score');
  const [detail, setDetail] = useState<string | null>(arg);
  useEffect(() => { if (arg) setDetail(arg); }, [arg]);
  const { data, error, loading, reload } = useAsync(() => api<Data>('GET', `/api/analytics?month=${month}`), [month, ver]);
  const people = [...(data?.people || [])].sort((a, b) => {
    if (sort === 'name') return userName(a.userId).localeCompare(userName(b.userId));
    const av = (a as any)[sort] ?? -1, bv = (b as any)[sort] ?? -1;
    return sort === 'overdue' || sort === 'avgHours' ? av - bv : bv - av;
  });
  const tot = (k: keyof Person) => (data?.people || []).reduce((s, p) => s + ((p[k] as number) || 0), 0);
  const completed = tot('completed'), onTime = tot('onTime');
  const th = (k: SortKey, label: string) => <th className="sortable" onClick={() => setSort(k)} aria-sort={sort === k ? 'descending' : undefined}>{label}{sort === k ? ' ▾' : ''}</th>;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Performance</h1><p>{people.length > 1 ? 'How your team is doing, month by month. Click a person for their history and reviews.' : 'Your monthly performance and reviews from your manager.'}</p></div>
        <div className="row">
        <ExportButtons disabled={!data} table={() => ({ title: `Performance ${monthLabel(month)}`, subtitle: 'Score = 60% on-time delivery + 40% completion rate',
          columns: ['Person', 'Title', 'Remote', 'Score', 'Assigned', 'Completed', 'On time', 'On-time %', 'Overdue', 'Open', 'Avg hours', 'Revisions', 'Logged hours', 'Updates', 'Rating', 'Review note'],
          rows: people.map((p) => [userName(p.userId), users[p.userId]?.title || '', !!users[p.userId]?.isRemote, p.score, p.assigned, p.completed, p.onTime, p.completed ? Math.round((p.onTime / p.completed) * 100) : null, p.overdue, p.open, p.avgHours, p.revisions, p.loggedHours, p.updates, p.review?.rating ?? null, p.review?.note || '']) })} />
        <div className="month-pick">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="left" size={16} /></button>
          <span>{monthLabel(month)}</span>
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthNow()} aria-label="Next month"><Icon name="right" size={16} /></button>
        </div>
        </div>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && <>
        <div className="kpis">
          <div className="kpi hl"><span>Tasks completed</span><b>{completed}</b><span className="dim">of {tot('assigned')} assigned this month</span></div>
          <div className="kpi"><span>On-time rate</span><b>{completed ? Math.round((onTime / completed) * 100) : 0}%</b></div>
          <div className="kpi"><span>Overdue</span><b style={{ color: tot('overdue') ? '#FF6B8E' : undefined }}>{tot('overdue')}</b></div>
          <div className="kpi"><span>Revisions requested</span><b>{tot('revisions')}</b></div>
        </div>
        {data.byStatus.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h4>Pipeline this month</h4>
            <div className="usage" style={{ marginTop: 10, height: 14 }}>
              {data.byStatus.map((s) => <i key={s.status} title={`${STATUS[s.status]?.label}: ${s.n}`} style={{ width: `${(s.n / data.byStatus.reduce((a, x) => a + x.n, 0)) * 100}%`, background: STATUS[s.status]?.color }} />)}
            </div>
            <div className="legend" style={{ marginTop: 10, flexWrap: 'wrap' }}>{data.byStatus.map((s) => <span key={s.status}><i style={{ background: STATUS[s.status]?.color }} />{STATUS[s.status]?.label} {s.n}</span>)}</div>
          </div>
        )}
        <div className="table-wrap">
          <table className="t">
            <thead><tr>{th('name', 'Person')}{th('score', 'Score')}{th('assigned', 'Assigned')}{th('completed', 'Done')}{th('onTime', 'On time')}{th('overdue', 'Overdue')}{th('avgHours', 'Avg time')}<th>Logged</th><th>Rating</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className="click" onClick={() => setDetail(p.userId)}>
                  <td><div className="row" style={{ gap: 8 }}><Avatar user={users[p.userId]} size={26} /><span>{userName(p.userId)}</span>{users[p.userId]?.isRemote && <span className="pill blue" style={{ height: 20 }}>Remote</span>}</div></td>
                  <td><div className="score"><Progress value={p.score ?? 0} tone={scoreTone(p.score)} /><b>{p.score ?? '-'}</b></div></td>
                  <td>{p.assigned}</td><td>{p.completed}</td><td>{p.completed ? `${Math.round((p.onTime / p.completed) * 100)}%` : '-'}</td>
                  <td style={{ color: p.overdue ? '#FF6B8E' : undefined }}>{p.overdue}</td>
                  <td>{p.avgHours === null ? '-' : p.avgHours < 1 ? '<1h' : p.avgHours < 48 ? `${p.avgHours}h` : `${Math.round(p.avgHours / 24)}d`}</td>
                  <td>{p.updates ? `${p.loggedHours} h · ${p.updates}` : <span className="dim">-</span>}</td>
                  <td>{p.review ? <Stars value={p.review.rating} size={13} /> : <span className="dim">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>Score = 60% on-time delivery + 40% completion rate for the month.</p>
      </>}
      {detail && <PersonDetail userId={detail} month={month} canReview={!!data?.people.find((p) => p.userId === detail)?.canReview} onClose={() => { setDetail(null); if (arg) navigate('analytics'); }} onReviewed={reload} />}
    </div>
  );
}

interface Series { userId: string; series: ({ month: string } & Person)[]; reviews: { month: string; rating: number; note: string; reviewerId: string; updatedAt: number }[] }

function PersonDetail({ userId, month, canReview, onClose, onReviewed }: { userId: string; month: string; canReview: boolean; onClose: () => void; onReviewed: () => void }) {
  const users = useStore((s) => s.users);
  const { data, error, loading, reload } = useAsync(() => api<Series>('GET', `/api/analytics/user/${userId}?months=12`), [userId]);
  const current = data?.reviews.find((r) => r.month === month);
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRating(current?.rating || 0); setNote(current?.note || ''); }, [current?.month, current?.rating]);
  const max = Math.max(1, ...(data?.series || []).map((s) => Math.max(s.assigned, s.completed)));
  const save = async () => {
    setBusy(true);
    try { await api('PUT', `/api/reviews/${userId}/${month}`, { rating, note }); toast('Review saved', 'ok'); reload(); onReviewed(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={userName(userId)} onClose={onClose} wide>
      {error && <ErrorBox text={error} />}
      {loading ? <Spinner /> : data && <>
        <div className="row"><Avatar user={users[userId]} size={44} /><div><h3>{userName(userId)}</h3><p className="dim">{users[userId]?.title}</p></div></div>
        <div className="card">
          <div className="row between"><h4>Last 12 months</h4><div className="legend"><span><i style={{ background: 'rgba(255,255,255,.22)' }} />Assigned</span><span><i style={{ background: 'var(--blue)' }} />Completed</span><span><i style={{ background: 'var(--orange)' }} />On time</span></div></div>
          <div className="bars">
            {data.series.map((s) => (
              <div key={s.month} className="bcol" title={`${monthLabel(s.month)}: ${s.completed}/${s.assigned} done, ${s.onTime} on time, score ${s.score ?? '-'}`}>
                <div className="bstack">
                  <i style={{ height: `${(s.assigned / max) * 100}%`, background: 'rgba(255,255,255,.22)' }} />
                  <i style={{ height: `${(s.completed / max) * 100}%`, background: 'var(--blue)' }} />
                  <i style={{ height: `${(s.onTime / max) * 100}%`, background: 'var(--orange)' }} />
                </div>
                <small>{s.month.slice(5)}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="card"><WorkLog userId={userId} compact /></div>
        {canReview && (
          <div className="card col">
            <h4>Your review for {monthLabel(month)}</h4>
            <Stars value={rating} onChange={setRating} size={22} />
            <Field label="Feedback"><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} rows={3} placeholder="What went well, what to improve..." /></Field>
            <Btn kind="primary" loading={busy} disabled={!rating} onClick={save} style={{ alignSelf: 'flex-start' }}>Save review</Btn>
          </div>
        )}
        <h4>Reviews</h4>
        {data.reviews.length ? data.reviews.map((r) => (
          <div key={r.month} className="card" style={{ padding: 14 }}>
            <div className="row between"><b>{monthLabel(r.month)}</b><Stars value={r.rating} size={14} /></div>
            {r.note && <p className="muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.note}</p>}
            <p className="dim" style={{ fontSize: 12, marginTop: 6 }}>by {userName(r.reviewerId)}</p>
          </div>
        )) : <p className="dim">No reviews yet.</p>}
      </>}
    </Modal>
  );
}
