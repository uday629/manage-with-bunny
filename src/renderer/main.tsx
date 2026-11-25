import { StrictMode, useEffect, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { bunny, type AppState, initSession, connectRealtime, loadMe, loadUsers, loadConvs, loadPending, useStore, setState, getState, navigate, onRealtime, addMessage, decryptMsgs, textOf, userName, bump, clearSession, onSignedOut, can, toast, type Msg } from './api';
import { Avatar, Icon, Logo, Spinner, Toasts } from './ui';
import { Welcome, HostSetup, JoinFlow, Pending, Login, HostError } from './views/Onboarding';
import { Home } from './views/Home';
import { NetCheckModal } from './views/NetCheck';

const Chat = lazy(() => import('./views/Chat').then((m) => ({ default: m.Chat })));
const Tasks = lazy(() => import('./views/Tasks').then((m) => ({ default: m.Tasks })));
const Team = lazy(() => import('./views/Team').then((m) => ({ default: m.Team })));
const Files = lazy(() => import('./views/Files').then((m) => ({ default: m.Files })));
const Attendance = lazy(() => import('./views/Attendance').then((m) => ({ default: m.Attendance })));
const Report = lazy(() => import('./views/Report').then((m) => ({ default: m.Report })));
const Records = lazy(() => import('./views/Records').then((m) => ({ default: m.Records })));
const Analytics = lazy(() => import('./views/Analytics').then((m) => ({ default: m.Analytics })));
const Admin = lazy(() => import('./views/Admin').then((m) => ({ default: m.Admin })));
const Settings = lazy(() => import('./views/Settings').then((m) => ({ default: m.Settings })));

document.documentElement.classList.toggle('mac', navigator.userAgent.includes('Mac'));

function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [screen, setScreen] = useState<'welcome' | 'host' | 'join' | null>(null);
  const refresh = async () => { const s = await bunny.state(); setApp(s); setState({ app: s }); return s; };
  useEffect(() => {
    refresh();
    onSignedOut(() => { refresh(); });
    return bunny.onEvent((ch, p) => {
      if (ch === 'auth' || ch === 'rejected') { refresh(); if (ch === 'rejected') toast('Your join request was declined.', 'err'); }
      if (ch === 'host' || ch === 'conn') refresh();
      if (ch === 'nav' && p?.route) navigate(p.route, p.arg || null);
      if (ch === 'resume') connectRealtime();
      if (ch === 'download') {
        if (p.state === 'completed') toast(`Saved ${p.name}`, 'ok');
        else if (p.state === 'interrupted') toast(`Download of ${p.name} was interrupted.`, 'err');
      }
    });
  }, []);

  if (!app) return <div className="onb"><Spinner size={28} /></div>;
  if (!app.mode) {
    if (screen === 'host') return <HostSetup onBack={() => setScreen('welcome')} onDone={refresh} />;
    if (screen === 'join') return <JoinFlow onBack={() => setScreen('welcome')} onPending={refresh} />;
    return <Welcome onPick={(v) => setScreen(v)} />;
  }
  if (app.pending) return <Pending app={app} onCancel={() => { setScreen('welcome'); refresh(); }} />;
  if (app.mode === 'host' && app.host && !app.host.running && app.host.error) return <HostError app={app} retry={async () => { await bunny.reconnect(); refresh(); }} />;
  if (!app.signedIn) return <Login app={app} onDone={refresh} onLeave={() => { setScreen('welcome'); refresh(); }} />;
  return <Workspace key={app.workspace?.userId || 'ws'} onExit={() => { clearSession(); setScreen('welcome'); refresh(); }} />;
}

function Workspace({ onExit }: { onExit: () => void }) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; alive; i++) {
        try {
          if (!(await initSession())) { onExit(); return; }
          await loadMe(); await loadUsers(); await loadConvs(); await loadPending();
          if (!alive) return;
          setReady(true); setErr(null);
          connectRealtime();
          return;
        } catch (e) {
          if ((e as any).status === 401) return;
          setErr((e as Error).message);
          await new Promise((r) => setTimeout(r, Math.min(8000, 1500 * (i + 1))));
        }
      }
    })();
    const off = onRealtime(handleEvent);
    return () => { alive = false; off(); clearSession(); };
  }, []);
  if (!ready) return <div className="onb"><div className="onb-head"><Logo size={72} /><Spinner size={24} /><p className="muted">{err ? `${err}` : 'Connecting to your workspace...'}</p></div></div>;
  return <Shell />;
}

// ---------------------------------------------------------------- realtime events
const typingTimers: Record<string, number> = {};
async function handleEvent(ev: any) {
  const s = getState();
  const me = s.me?.user.id;
  switch (ev.t) {
    case 'msg': {
      const m: Msg = ev.msg;
      if (!s.convs.some((c) => c.id === m.convId)) { await loadConvs(); }
      await decryptMsgs([m]);
      addMessage(m);
      const viewing = s.route === 'chat' && s.routeArg === m.convId && document.hasFocus();
      if (m.senderId !== me) {
        setState((st) => ({ convs: st.convs.map((c) => (c.id === m.convId && !viewing ? { ...c, unread: c.unread + 1 } : c)) }));
        const conv = getState().convs.find((c) => c.id === m.convId);
        if (!viewing && conv && !conv.muted && m.kind !== 'system') {
          const who = userName(m.senderId);
          const title = conv.type === 'dm' ? who : `${who} in ${conv.name}`;
          const body = m.kind === 'file' ? `Sent a file: ${m.file?.name || ''}` : textOf(m).slice(0, 140);
          bunny.notify({ title, body, nav: { route: 'chat', arg: m.convId } }).catch(() => {});
        }
        const n = getState().convs.reduce((a, c) => a + (c.muted ? 0 : c.unread), 0);
        bunny.setBadge(n).catch(() => {});
      }
      break;
    }
    case 'msg_edit': {
      const m: Msg = ev.msg;
      await decryptMsgs([m]);
      setState((st) => ({ msgs: { ...st.msgs, [m.convId]: (st.msgs[m.convId] || []).map((x) => (x.id === m.id ? m : x)) } }));
      break;
    }
    case 'msg_del':
      setState((st) => ({ msgs: { ...st.msgs, [ev.convId]: (st.msgs[ev.convId] || []).map((x) => (x.id === ev.id ? { ...x, deleted: true, body: '', plain: '', file: null } : x)) } }));
      break;
    case 'read':
      setState((st) => ({ convs: st.convs.map((c) => (c.id === ev.convId && ev.userId === me ? { ...c, unread: 0 } : c)), ver: { ...st.ver, files: st.ver.files } }));
      window.dispatchEvent(new CustomEvent('bunny-read', { detail: ev }));
      break;
    case 'typing': {
      const key = ev.convId;
      setState((st) => ({ typing: { ...st.typing, [key]: { userId: ev.userId, until: Date.now() + 4000 } } }));
      window.clearTimeout(typingTimers[key]);
      typingTimers[key] = window.setTimeout(() => setState((st) => { const t = { ...st.typing }; delete t[key]; return { typing: t }; }), 4000);
      break;
    }
    case 'presence':
      setState((st) => (st.users[ev.userId] ? { users: { ...st.users, [ev.userId]: { ...st.users[ev.userId], online: ev.online, lastSeen: ev.online ? st.users[ev.userId].lastSeen : Date.now() } } } : {}));
      break;
    case 'conv': await loadConvs(); break;
    case 'users': await loadUsers(); await loadPending(); break;
    case 'me': await loadMe(); break;
    case 'pending': await loadPending(); break;
    case 'task': bump('tasks'); break;
    case 'sheet': bump('sheets'); break;
    case 'attendance': bump('attendance'); break;
    case 'incoming':
      setState((st) => ({ incoming: { ...st.incoming, [ev.id]: { id: ev.id, convId: ev.convId, userId: ev.userId, name: ev.name, size: ev.size, received: ev.received, at: Date.now() } } }));
      break;
    case 'incoming_done':
      setState((st) => { const inc = { ...st.incoming }; delete inc[ev.id]; return { incoming: inc }; });
      break;
    case 'worklog': bump('worklog'); break;
    case 'notify':
      bunny.notify({ title: ev.title, body: ev.body, nav: ev.kind === 'task' ? { route: 'tasks', arg: ev.id } : ev.kind === 'review' ? { route: 'analytics' } : { route: 'admin', arg: 'members' } }).catch(() => {});
      toast(`${ev.title}: ${ev.body}`);
      break;
  }
}

// ---------------------------------------------------------------- shell
const NAV: { id: string; label: string; icon: string; show?: () => boolean }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'team', label: 'Team chart', icon: 'team' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'attendance', label: 'Attendance', icon: 'clock' },
  { id: 'report', label: 'Work report', icon: 'layers' },
  { id: 'records', label: 'Records', icon: 'records' },
  { id: 'analytics', label: 'Performance', icon: 'chart' },
  { id: 'admin', label: 'Admin', icon: 'shield', show: () => ['users.approve', 'users.manage', 'roles.manage', 'storage.manage', 'audit.view', 'workspace.settings'].some((p) => can(p as any)) },
];

function Shell() {
  const [netCheck, setNetCheck] = useState(false);
  const route = useStore((s) => s.route);
  const me = useStore((s) => s.me);
  const conn = useStore((s) => s.conn);
  const unread = useStore((s) => s.convs.reduce((a, c) => a + (c.muted ? 0 : c.unread), 0));
  const pending = useStore((s) => s.pending);
  const meUser = useStore((s) => (s.me ? s.users[s.me.user.id] || s.me.user : null));
  const role = me?.roles.find((r) => r.id === me.user.roleId);
  const View = { home: Home, chat: Chat, tasks: Tasks, team: Team, files: Files, report: Report, attendance: Attendance, records: Records, analytics: Analytics, admin: Admin, settings: Settings }[route] || Home;
  return (
    <div className="shell">
      <div className="titlebar" />
      {conn !== 'online' && <div className="offline-bar"><Spinner size={12} /> {conn === 'offline' ? 'Host unreachable. Searching this Wi-Fi...' : 'Reconnecting...'}{conn === 'offline' && <button className="link-btn" onClick={() => setNetCheck(true)}>Check network</button>}</div>}
      {netCheck && <NetCheckModal onClose={() => setNetCheck(false)} />}
      <aside className="side">
        <div className="brand"><Logo size={34} /><div><b>Manage with Bunny</b><small>{me?.workspace.name}</small></div></div>
        {NAV.filter((n) => !n.show || n.show()).map((n) => (
          <button key={n.id} className={'nav' + (route === n.id ? ' on' : '')} onClick={() => navigate(n.id)} aria-current={route === n.id}>
            <Icon name={n.icon} />{n.label}
            {n.id === 'chat' && unread > 0 && <b className="badge">{unread > 99 ? '99+' : unread}</b>}
            {n.id === 'admin' && pending > 0 && <b className="badge">{pending}</b>}
          </button>
        ))}
        <div className="side-foot">
          <div className={'conn ' + conn}><i />{conn === 'online' ? 'Connected securely' : conn === 'connecting' ? 'Connecting...' : 'Offline'}</div>
          <button className="me-btn" onClick={() => navigate('settings')}>
            <Avatar user={meUser} size={34} />
            <span className="grow"><b className="ellipsis">{meUser?.displayName}</b><small className="ellipsis">{role?.name || meUser?.title}</small></span>
            <Icon name="settings" size={16} />
          </button>
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="page"><Spinner /></div>}><View /></Suspense>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /><Toasts /></StrictMode>);
