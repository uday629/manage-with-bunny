import { api, useStore, navigate, fmtDate, userName, monthLabel, bunny, toast, type Task } from '../api';
import { Avatar, Btn, Empty, ErrorBox, Icon, Spinner, useAsync } from '../ui';
import { STATUS } from './Tasks';
import { WorkLogModal } from './WorkLog';
import { inviteText } from './NetCheck';
import { useState } from 'react';

interface Dash { mine: Task[]; review: Task[]; myStats: any; teamStats: any; month: string; remote: { userId: string; open: Task[]; lastUpdate: string | null }[] }

export function TaskRow({ t, who }: { t: Task; who: 'assigner' | 'assignee' }) {
  const users = useStore((s) => s.users);
  const late = t.dueAt && t.dueAt < Date.now() && !['done', 'cancelled'].includes(t.status);
  const u = users[(who === 'assigner' ? t.assignerId : t.assigneeId) || ''];
  return (
    <div className="list-row" onClick={() => navigate('tasks', t.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate('tasks', t.id)}>
      <span className="status-dot" style={{ background: STATUS[t.status]?.color }} />
      <span className="grow"><b className="ellipsis" style={{ display: 'block' }}>{t.title}</b><small className="dim">{who === 'assigner' ? 'From ' : 'By '}{userName(who === 'assigner' ? t.assignerId : t.assigneeId)} · {STATUS[t.status]?.label}</small></span>
      {t.dueAt && <span className={'pill' + (late ? ' bad' : '')}><Icon name="clock" size={12} />{fmtDate(t.dueAt)}</span>}
      <Avatar user={u} size={26} />
    </div>
  );
}

export function Home() {
  const me = useStore((s) => s.me);
  const app = useStore((s) => s.app);
  const ver = useStore((s) => s.ver.tasks);
  const convs = useStore((s) => s.convs);
  const pending = useStore((s) => s.pending);
  const { data, error, loading, reload } = useAsync(() => api<Dash>('GET', '/api/dashboard'), [ver]);
  const unread = convs.reduce((a, c) => a + c.unread, 0);
  const users = useStore((s) => s.users);
  const [logFor, setLogFor] = useState<string | null>(null);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me?.user.displayName.split(' ')[0];
  return (
    <div className="page">
      <div className="hero">
        <div className="row between wrap">
          <div>
            <span className="mono">{data ? monthLabel(data.month) : ''}</span>
            <h1>{greet}, <span className="gr">{first}</span></h1>
            <p>{data ? `${data.mine.length} open task${data.mine.length === 1 ? '' : 's'}, ${data.review.length} waiting for your review, ${unread} unread message${unread === 1 ? '' : 's'}.` : 'Loading your day...'}</p>
          </div>
          <div className="row">
            <Btn icon="chat" onClick={() => navigate('chat')}>Open chat</Btn>
            <Btn kind="primary" icon="plus" onClick={() => navigate('tasks', 'new')}>New task</Btn>
          </div>
        </div>
      </div>
      {pending > 0 && (
        <div className="notice warn" style={{ marginBottom: 16, alignItems: 'center' }}>
          <Icon name="users" size={16} /><span className="grow">{pending} person{pending > 1 ? 's are' : ' is'} waiting to join the workspace.</span>
          <Btn small kind="primary" onClick={() => navigate('admin', 'members')}>Review</Btn>
        </div>
      )}
      {app?.mode === 'host' && app.host && me?.perms.includes('workspace.settings') && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row between wrap">
            <div><span className="mono">This computer is the host</span><h3 style={{ marginTop: 6 }}>Invite your team</h3><p className="muted">Teammates on this Wi-Fi install the app, choose "Join a team" and enter this code.</p></div>
            <div className="row">
              <span className="code" style={{ fontSize: 17 }}>{app.host.joinCode}</span>
              <Btn icon="copy" onClick={() => { navigator.clipboard.writeText(inviteText(me?.workspace.name || '', app.host!.joinCode, app.host!.addresses, app.host!.port)); toast('Invite copied (code + address). Send it to your teammate.', 'ok'); }}>Copy invite</Btn>
            </div>
          </div>
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>Host address: {app.host.addresses.join(', ') || 'no network'} · port {app.host.port}</p>
        </div>
      )}
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Spinner />}
      {data && <>
        <div className="kpis">
          <div className="kpi hl"><span>Your score this month</span><b>{data.myStats.score ?? '-'}</b><span className="dim">{data.myStats.onTime}/{data.myStats.completed} on time</span></div>
          <div className="kpi"><span>Open tasks</span><b>{data.myStats.open}</b></div>
          <div className="kpi"><span>Completed this month</span><b>{data.myStats.completed}</b></div>
          <div className="kpi"><span>Overdue</span><b style={{ color: data.myStats.overdue ? '#FF6B8E' : undefined }}>{data.myStats.overdue}</b></div>
          {data.teamStats && <div className="kpi"><span>Team open / overdue</span><b>{data.teamStats.open}<span className="dim" style={{ fontSize: 18 }}> / {data.teamStats.overdue}</span></b><span className="dim">{data.teamStats.members} people under you</span></div>}
        </div>
        {data.remote.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row between"><div><h3>Remote teammates you keep updated</h3><p className="dim" style={{ fontSize: 12.5 }}>They are not on this Wi-Fi. Add their daily updates and move their tasks forward on their behalf.</p></div></div>
            <div className="list" style={{ marginTop: 8 }}>
              {data.remote.map((r) => {
                const stale = !r.lastUpdate || Date.now() - new Date(r.lastUpdate + 'T23:59:59').getTime() > 2 * 86400000;
                return (
                  <div key={r.userId} className="list-row" style={{ cursor: 'default' }}>
                    <Avatar user={users[r.userId]} size={30} />
                    <span className="grow"><b>{userName(r.userId)}</b><br /><small className="dim">{r.open.length} open task{r.open.length === 1 ? '' : 's'} · last update {r.lastUpdate ? fmtDate(new Date(r.lastUpdate + 'T12:00:00').getTime()) : 'never'}</small></span>
                    {stale && <span className="pill warn">Needs update</span>}
                    {r.open[0] && <Btn small kind="soft" onClick={() => navigate('tasks', r.open[0].id)}>Next task</Btn>}
                    <Btn small kind="primary" icon="plus" onClick={() => setLogFor(r.userId)}>Add update</Btn>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {logFor && <WorkLogModal userId={logFor} onClose={() => setLogFor(null)} />}
        <div className="grid2">
          <div className="card">
            <div className="row between"><h3>My tasks</h3><Btn small kind="soft" onClick={() => navigate('tasks')}>View board</Btn></div>
            <div className="list" style={{ marginTop: 8 }}>
              {data.mine.length ? data.mine.slice(0, 8).map((t) => <TaskRow key={t.id} t={t} who="assigner" />) : <Empty icon="check" title="You're all caught up" text="New tasks assigned to you show up here." />}
            </div>
          </div>
          <div className="card">
            <div className="row between"><h3>Waiting for your review</h3>{data.review.length > 0 && <span className="pill warn">{data.review.length}</span>}</div>
            <div className="list" style={{ marginTop: 8 }}>
              {data.review.length ? data.review.slice(0, 8).map((t) => <TaskRow key={t.id} t={t} who="assignee" />) : <Empty icon="eye" title="Nothing to review" text="When your team submits work, it lands here." />}
            </div>
          </div>
        </div>
      </>}
      <p className="dim" style={{ fontSize: 12, marginTop: 24, textAlign: 'center' }}>Made by Bunnys Framelab · <a onClick={() => bunny.openExternal('https://framelabmedia.odoo.com/')}>framelabmedia.odoo.com</a></p>
    </div>
  );
}
