import { useMemo, useState } from 'react';
import { api, useStore, navigate, loadConvs, can, toast, fmtAgo, type User } from '../api';
import { Avatar, Btn, Empty, ErrorBox, Icon, Modal, Spinner, useAsync } from '../ui';
import { WorkLog } from './WorkLog';
import { PhotoEditor } from './Photo';

interface Node extends User { reports: number; children: Node[] }

export function Team() {
  const ver = useStore((s) => s.ver.users);
  const me = useStore((s) => s.me!);
  const { data, error, loading, reload } = useAsync(() => api<(User & { reports: number })[]>('GET', '/api/org'), [ver]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<User | null>(null);
  const [q, setQ] = useState('');
  const roots = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, Node>(data.map((u) => [u.id, { ...u, children: [] }]));
    const out: Node[] = [];
    for (const n of map.values()) { const p = n.managerId ? map.get(n.managerId) : null; if (p) p.children.push(n); else out.push(n); }
    const sort = (l: Node[]) => { l.sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || b.reports - a.reports || a.displayName.localeCompare(b.displayName)); l.forEach((n) => sort(n.children)); };
    sort(out);
    return out;
  }, [data]);
  const role = (id: string | null) => me.roles.find((r) => r.id === id);
  const match = (u: User) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || (u.title || '').toLowerCase().includes(q.toLowerCase());
  const render = (n: Node) => {
    const r = role(n.roleId);
    const isCollapsed = collapsed.has(n.id);
    return (
      <li key={n.id}>
        <div className={'node' + (n.id === me.user.id ? ' me' : '')} onClick={() => setSel(n)} style={{ opacity: match(n) ? 1 : 0.35 }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(n)}>
          <span className="bar" style={{ background: r?.color || '#555' }} />
          <Avatar user={n} size={44} ring />
          <b>{n.displayName}</b>
          {n.title && n.title !== r?.name && n.title !== 'Owner' && <small>{n.title}</small>}
          <span className="role-chip"><i style={{ background: r?.color || '#555' }} />{n.isOwner ? 'Owner' : r?.name || 'No role'}</span>
          {n.isRemote && <span className="pill blue" style={{ height: 20 }}><Icon name="globe" size={11} />Remote</span>}
          {n.children.length > 0 && <span className="kids" onClick={(e) => { e.stopPropagation(); const s = new Set(collapsed); if (isCollapsed) s.delete(n.id); else s.add(n.id); setCollapsed(s); }}>{isCollapsed ? `Show ${n.reports} below` : `${n.reports} below`} </span>}
        </div>
        {n.children.length > 0 && !isCollapsed && <ul>{n.children.map(render)}</ul>}
      </li>
    );
  };
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Team chart</h1><p>{can('org.view_all') ? 'Your whole organisation. Who works under whom.' : 'Your part of the organisation: your managers, your teammates and everyone under you.'}</p></div>
        <div className="row">
          <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" /></div>
          {can('users.manage') && <Btn icon="settings" onClick={() => navigate('admin', 'members')}>Manage</Btn>}
        </div>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : roots.length ? (
        <div className="org-wrap"><ul className="tree">{roots.map(render)}</ul></div>
      ) : <Empty icon="team" title="No one here yet" text="Approve join requests and set managers to build the chart." />}
      {sel && <Profile user={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

export function Profile({ user, onClose }: { user: User; onClose: () => void }) {
  const me = useStore((s) => s.me!);
  const users = useStore((s) => s.users);
  const r = me.roles.find((x) => x.id === user.roleId);
  const reports = Object.values(users).filter((u) => u.managerId === user.id);
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(false);
  const canPhoto = user.id === me.user.id || (!!user.isRemote && (user.caretakerId === me.user.id || me.perms.includes('users.manage')));
  const dm = async () => {
    setBusy(true);
    try { const c = await api<{ id: string }>('POST', '/api/convs/dm', { userId: user.id }); await loadConvs(); navigate('chat', c.id); onClose(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Profile" onClose={onClose} wide={!!user.isRemote}>
      <div className="row" style={{ gap: 14 }}>
        <Avatar user={user} size={60} ring />
        {photo && <PhotoEditor user={user} onClose={() => setPhoto(false)} />}
        <div className="grow">
          <h2>{user.displayName}</h2>
          <p className="muted">{user.title || r?.name} · @{user.username}</p>
          {canPhoto && <Btn small kind="soft" icon="image" onClick={() => setPhoto(true)}>{user.avatarVer ? 'Change photo' : 'Add photo'}</Btn>}
          <p className="dim" style={{ fontSize: 12 }}>{user.isRemote ? 'Works remotely · profile kept up to date by a caretaker' : user.online ? 'Online now' : user.lastSeen ? `Last seen ${fmtAgo(user.lastSeen)}` : 'Offline'}</p>
        </div>
      </div>
      <dl className="kv">
        <dt>Role</dt><dd><span className="role-chip"><i style={{ background: r?.color || '#555' }} />{user.isOwner ? 'Owner' : r?.name || 'No role'}</span></dd>
        <dt>Reports to</dt><dd>{user.managerId ? users[user.managerId]?.displayName || 'Hidden' : 'No one (top level)'}</dd>
        <dt>Direct reports</dt><dd>{reports.length ? reports.map((u) => u.displayName).join(', ') : 'None'}</dd>
        {user.isRemote && <><dt>Caretaker</dt><dd>{user.caretakerId ? users[user.caretakerId]?.displayName || 'Hidden' : 'Not set'}</dd></>}
        {user.isRemote && user.remoteNote && <><dt>Note</dt><dd>{user.remoteNote}</dd></>}
      </dl>
      {user.id !== me.user.id && (
        <div className="row wrap">
          {!user.isRemote && <Btn kind="primary" icon="chat" loading={busy} onClick={dm}>Message</Btn>}
          <Btn icon="tasks" onClick={() => { navigate('tasks', 'new'); onClose(); }}>Assign task</Btn>
          <Btn icon="chart" onClick={() => { navigate('analytics', user.id); onClose(); }}>Performance</Btn>
        </div>
      )}
      {(user.isRemote || user.id === me.user.id || user.managerId === me.user.id) && <WorkLog userId={user.id} compact />}
    </Modal>
  );
}
