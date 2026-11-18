import { useEffect, useState } from 'react';
import { api, bunny, useStore, can, toast, fmtBytes, fmtDateTime, fmtAgo, loadUsers, loadPending, loadMe, type User, type Role } from '../api';
import { PERMS, type Perm } from '../../shared/perms';
import { inviteText } from './NetCheck';
import { Avatar, Btn, Empty, ErrorBox, ExportButtons, Field, Icon, Modal, Spinner, Tabs, confirmDialog, useAsync } from '../ui';

type Tab = 'members' | 'roles' | 'workspace' | 'storage' | 'audit';

export function Admin() {
  const arg = useStore((s) => s.routeArg);
  const pending = useStore((s) => s.pending);
  const first: Tab = can('users.approve') || can('users.manage') ? 'members' : can('roles.manage') ? 'roles' : can('workspace.settings') ? 'workspace' : can('storage.manage') ? 'storage' : 'audit';
  const [tab, setTab] = useState<Tab>((arg as Tab) || first);
  useEffect(() => { if (arg) setTab(arg as Tab); }, [arg]);
  return (
    <div className="page">
      <div className="page-head"><div><h1>Admin</h1><p>People, permissions, storage and security for this workspace.</p></div></div>
      <div className="toolbar">
        <Tabs value={tab} onChange={setTab} items={[
          { id: 'members', label: 'Members', badge: pending, hidden: !can('users.approve') && !can('users.manage') },
          { id: 'roles', label: 'Roles & permissions', hidden: !can('roles.manage') },
          { id: 'workspace', label: 'Workspace', hidden: !can('workspace.settings') },
          { id: 'storage', label: 'Storage', hidden: !can('storage.manage') },
          { id: 'audit', label: 'Security log', hidden: !can('audit.view') },
        ]} />
      </div>
      {tab === 'members' && <Members />}
      {tab === 'roles' && <Roles />}
      {tab === 'workspace' && <Workspace />}
      {tab === 'storage' && <Storage />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

// ------------------------------------------------------------- members
function Members() {
  const me = useStore((s) => s.me!);
  const users = useStore((s) => s.users);
  const verU = useStore((s) => s.ver.users);
  const pend = useAsync(() => (can('users.approve') ? api<any[]>('GET', '/api/users/pending') : Promise.resolve([])), [verU, useStore((s) => s.pending)]);
  const [approve, setApprove] = useState<any | null>(null);
  const [edit, setEdit] = useState<User | null>(null);
  const [addRemote, setAddRemote] = useState(false);
  const [q, setQ] = useState('');
  const list = Object.values(users).filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase()));
  const role = (id: string | null) => me.roles.find((r) => r.id === id);
  const reject = async (p: any) => {
    if (!(await confirmDialog({ title: `Decline ${p.display_name}?`, text: 'They will not be able to enter the workspace.', ok: 'Decline', danger: true }))) return;
    await api('POST', `/api/users/${p.id}/reject`, {}); pend.reload(); loadPending();
  };
  return (
    <div className="col" style={{ gap: 18 }}>
      {can('users.approve') && (
        <div className="card">
          <h3>Join requests</h3>
          {pend.loading && !pend.data ? <Spinner /> : pend.data?.length ? (
            <div className="list" style={{ marginTop: 8 }}>
              {pend.data.map((p) => (
                <div key={p.id} className="list-row" style={{ cursor: 'default' }}>
                  <span className="avatar" style={{ width: 34, height: 34, background: '#333', fontSize: 13 }}>{p.display_name.slice(0, 2).toUpperCase()}</span>
                  <span className="grow"><b>{p.display_name}</b> <span className="dim">@{p.username}</span><br /><small className="dim">{p.device_name || 'Unknown device'} · {fmtAgo(p.created_at)}</small></span>
                  <Btn small kind="soft" onClick={() => reject(p)}>Decline</Btn>
                  <Btn small kind="primary" icon="check" onClick={() => setApprove(p)}>Approve</Btn>
                </div>
              ))}
            </div>
          ) : <p className="dim" style={{ marginTop: 6 }}>No pending requests. Share the join code from the Workspace tab.</p>}
        </div>
      )}
      <div className="row between wrap"><h3>Members ({list.length})</h3><div className="row">
        {can('users.manage') && <Btn icon="globe" onClick={() => setAddRemote(true)}>Add remote profile</Btn>}
        <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" /></div>
      </div></div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Name</th><th>Role</th><th>Title</th><th>Reports to</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((u) => {
              const r = role(u.roleId);
              return (
                <tr key={u.id}>
                  <td><div className="row" style={{ gap: 8 }}><Avatar user={u} size={28} /><span><b>{u.displayName}</b><br /><small className="dim">@{u.username}</small></span></div></td>
                  <td><span className="role-chip"><i style={{ background: r?.color || '#555' }} />{u.isOwner ? 'Owner' : r?.name || 'None'}</span></td>
                  <td>{u.title}</td>
                  <td>{u.managerId ? users[u.managerId]?.displayName : <span className="dim">-</span>}</td>
                  <td>{u.status !== 'active' ? <span className="pill bad">Disabled</span> : u.isRemote ? <span className="pill blue" title={`Kept up to date by ${u.caretakerId ? users[u.caretakerId]?.displayName || '' : 'nobody'}`}><Icon name="globe" size={12} />Remote · {u.caretakerId ? users[u.caretakerId]?.displayName?.split(' ')[0] || 'caretaker' : 'no caretaker'}</span> : <span className={'pill' + (u.online ? ' ok' : '')}>{u.online ? 'Online' : 'Active'}</span>}</td>
                  <td style={{ textAlign: 'right' }}>{can('users.manage') && (!u.isOwner || me.user.isOwner) && <Btn small icon="edit" onClick={() => setEdit(u)}>Manage</Btn>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {approve && <ApproveModal p={approve} onClose={() => setApprove(null)} onDone={() => { setApprove(null); pend.reload(); loadPending(); loadUsers(); }} />}
      {edit && <EditMember u={edit} onClose={() => setEdit(null)} />}
      {addRemote && <AddRemote onClose={() => setAddRemote(false)} />}
    </div>
  );
}

function grantable(roles: Role[], myPerms: Perm[], isOwner: boolean) {
  return roles.filter((r) => !r.isOwner && (isOwner || r.perms.every((p) => myPerms.includes(p))));
}

function ApproveModal({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const me = useStore((s) => s.me!);
  const users = useStore((s) => s.users);
  const roles = grantable(me.roles, me.perms, me.user.isOwner);
  const [roleId, setRoleId] = useState(roles.find((r) => r.name === 'Employee')?.id || roles.at(-1)?.id || '');
  const [mgr, setMgr] = useState(me.user.id);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api('POST', `/api/users/${p.id}/approve`, { roleId, managerId: mgr || null, title: title || undefined }); toast(`${p.display_name} approved`, 'ok'); onDone(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Approve ${p.display_name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!roleId} onClick={go}>Approve</Btn></>}>
      <div className="notice"><Icon name="key" size={16} /><span>Only approve people you recognise. Confirm with {p.display_name.split(' ')[0]} that they requested to join from <b>{p.device_name || 'their device'}</b>.</span></div>
      <Field label="Role"><select value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="Reports to"><select value={mgr} onChange={(e) => setMgr(e.target.value)}><option value="">No one (top level)</option>{Object.values(users).filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
      <Field label="Job title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="e.g. Video Editor" /></Field>
    </Modal>
  );
}

// Remote profile: a teammate who is not on this Wi-Fi. A caretaker keeps their tasks and work log updated.
function AddRemote({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me!);
  const users = useStore((s) => s.users);
  const roles = grantable(me.roles, me.perms, me.user.isOwner);
  const signIn = Object.values(users).filter((u) => u.status === 'active' && !u.isRemote);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [roleId, setRoleId] = useState(roles.find((r) => r.name === 'Employee')?.id || roles.at(-1)?.id || '');
  const [mgr, setMgr] = useState(me.user.id);
  const [ct, setCt] = useState(me.user.id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const u = await api<User>('POST', '/api/users/remote', { displayName: name, title: title || undefined, roleId, managerId: mgr || null, caretakerId: ct, remoteNote: note });
      toast(`${u.displayName} added as a remote profile`, 'ok'); await loadUsers(); onClose();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add remote profile" onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!name.trim() || !roleId || !ct} onClick={go}>Add profile</Btn></>}>
      <div className="notice"><Icon name="globe" size={16} /><span>For teammates who work from home or another city and cannot join this Wi-Fi. They get a place in the team chart, tasks and performance, but no login. The caretaker you choose updates their tasks and daily work log, so all team data stays in one place. If they come to the office later, use "Activate login" to give them a real account with the same history.</span></div>
      <div className="form-row">
        <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Sara Ahmed" /></Field>
        <Field label="Job title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="e.g. Remote Video Editor" /></Field>
      </div>
      <div className="form-row">
        <Field label="Role"><select value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Reports to"><select value={mgr} onChange={(e) => setMgr(e.target.value)}><option value="">No one (top level)</option>{Object.values(users).filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
      </div>
      <Field label="Caretaker (keeps this profile updated)" hint="Usually their team leader or manager. They see the profile's tasks and can submit work for them.">
        <select value={ct} onChange={(e) => setCt(e.target.value)}>{signIn.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.id === me.user.id ? ' (me)' : ''}</option>)}</select>
      </Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Works from Sylhet, sends files via Google Drive" /></Field>
    </Modal>
  );
}

function EditMember({ u, onClose }: { u: User; onClose: () => void }) {
  const me = useStore((s) => s.me!);
  const users = useStore((s) => s.users);
  const roles = grantable(me.roles, me.perms, me.user.isOwner);
  const [roleId, setRoleId] = useState(u.roleId || '');
  const [mgr, setMgr] = useState(u.managerId || '');
  const [title, setTitle] = useState(u.title);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [ct, setCt] = useState(u.caretakerId || '');
  const [note, setNote] = useState(u.remoteNote || '');
  const save = async () => {
    setBusy(true);
    const body: any = { title };
    if (!u.isOwner && roleId !== u.roleId) body.roleId = roleId;
    if ((mgr || null) !== u.managerId) body.managerId = mgr || null;
    if (u.isRemote && (ct || null) !== (u.caretakerId || null)) body.caretakerId = ct || null;
    if (u.isRemote && note !== (u.remoteNote || '')) body.remoteNote = note;
    try { await api('PATCH', `/api/users/${u.id}`, body); toast('Member updated', 'ok'); await loadUsers(); onClose(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const status = async () => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !(await confirmDialog({ title: `Disable ${u.displayName}?`, text: 'They are signed out everywhere immediately and cannot sign in until re-enabled. Their data stays.', ok: 'Disable', danger: true }))) return;
    try { await api('PATCH', `/api/users/${u.id}`, { status: next }); await loadUsers(); onClose(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const reset = async () => {
    const text = u.isRemote
      ? `${u.displayName} installs the app on this Wi-Fi, chooses "Join a team", enters the join code, clicks "I already have an account", then "Use a reset code" with username @${u.username}, this code and a new password. Their tasks, work log and performance history stay.`
      : `${u.displayName} can use it once within 24 hours to set a new password. Their old private messages become unreadable because a new encryption key is created.`;
    if (!(await confirmDialog({ title: u.isRemote ? 'Activate a real login?' : 'Create a reset code?', text, ok: 'Create code' }))) return;
    try { const r = await api<{ code: string }>('POST', `/api/users/${u.id}/reset-code`, {}); setCode(r.code); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const revoke = async () => { await api('POST', `/api/users/${u.id}/revoke-sessions`, {}); toast('Signed out on all devices', 'ok'); };
  const transfer = async () => {
    const ok = await confirmDialog({ title: `Make ${u.displayName} the owner?`, text: 'They get full control of the workspace. You become a regular member with the highest non-owner role.', ok: 'Transfer ownership', danger: true, input: 'TRANSFER' });
    if (!ok) return;
    try { await api('POST', '/api/owner/transfer', { userId: u.id }); await Promise.all([loadMe(), loadUsers()]); onClose(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <Modal title={`Manage ${u.displayName}`} onClose={onClose} wide footer={<><Btn onClick={onClose}>Close</Btn><Btn kind="primary" loading={busy} onClick={save}>Save changes</Btn></>}>
      <div className="form-row">
        <Field label="Role">{u.isOwner ? <input value="Owner" disabled /> : <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}{!roles.some((r) => r.id === roleId) && <option value={roleId}>{me.roles.find((r) => r.id === roleId)?.name || 'None'}</option>}</select>}</Field>
        <Field label="Reports to"><select value={mgr} onChange={(e) => setMgr(e.target.value)}><option value="">No one (top level)</option>{Object.values(users).filter((x) => x.id !== u.id && x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</select></Field>
      </div>
      <Field label="Job title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} /></Field>
      {u.isRemote && <div className="form-row">
        <Field label="Caretaker"><select value={ct} onChange={(e) => setCt(e.target.value)}><option value="">Nobody</option>{Object.values(users).filter((x) => x.status === 'active' && !x.isRemote).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</select></Field>
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      </div>}
      {code && <div className="col"><span className="muted">Give this one-time code to {u.displayName} in person (valid 24 hours, shown only once).{u.isRemote ? ` Username: @${u.username}` : ''}</span><div className="code">{code}</div></div>}
      <div className="divider" />
      <div className="row wrap">
        {u.id !== me.user.id && <Btn icon="key" onClick={reset}>{u.isRemote ? 'Activate login' : 'Reset password'}</Btn>}
        {!u.isRemote && <Btn icon="logout" onClick={revoke}>Sign out everywhere</Btn>}
        {!u.isOwner && u.id !== me.user.id && <Btn kind="danger" onClick={status}>{u.status === 'active' ? 'Disable account' : 'Enable account'}</Btn>}
        {me.user.isOwner && !u.isOwner && u.status === 'active' && <Btn kind="danger" icon="shield" onClick={transfer}>Transfer ownership</Btn>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- roles
function Roles() {
  const ver = useStore((s) => s.ver.users);
  const me = useStore((s) => s.me!);
  const { data, loading, error, reload } = useAsync(() => api<Role[]>('GET', '/api/roles'), [ver]);
  const [edit, setEdit] = useState<Partial<Role> | null>(null);
  return (
    <div className="col">
      <div className="row between"><p className="muted">Create any position your team has (Lead Generator, Sales Manager, Production Manager...). A role can never grant more than you have yourself.</p><Btn kind="primary" icon="plus" onClick={() => setEdit({ name: '', rank: 30, color: '#1F6BFF', perms: [] })}>New role</Btn></div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Role</th><th>Members</th><th>Permissions</th><th /></tr></thead><tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td><span className="role-chip" style={{ color: 'var(--ink)', fontSize: 13.5 }}><i style={{ background: r.color }} />{r.name}</span></td>
              <td>{r.members}</td>
              <td className="dim" style={{ fontSize: 12 }}>{r.isOwner ? 'Everything' : r.perms.length ? r.perms.map((p) => PERMS[p]?.split(' ').slice(0, 3).join(' ')).join(' · ') : 'Basic member (own tasks, own team chat)'}</td>
              <td style={{ textAlign: 'right' }}>{!r.isOwner && (me.user.isOwner || r.perms.every((p) => me.perms.includes(p))) && <Btn small icon="edit" onClick={() => setEdit(r)}>Edit</Btn>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {edit && <RoleEditor role={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); loadMe(); }} />}
    </div>
  );
}

function RoleEditor({ role, onClose, onSaved }: { role: Partial<Role>; onClose: () => void; onSaved: () => void }) {
  const me = useStore((s) => s.me!);
  const [name, setName] = useState(role.name || '');
  const [color, setColor] = useState(role.color || '#1F6BFF');
  const [rank, setRank] = useState(role.rank ?? 30);
  const [perms, setPerms] = useState<Perm[]>(role.perms || []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, color, rank, perms };
      if (role.id) await api('PATCH', `/api/roles/${role.id}`, body); else await api('POST', '/api/roles', body);
      toast('Role saved', 'ok'); onSaved();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: `Delete role "${role.name}"?`, text: 'Members must be moved to another role first.', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/roles/${role.id}`); onSaved(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <Modal title={role.id ? `Edit ${role.name}` : 'New role'} onClose={onClose} wide footer={<>{role.id && <Btn kind="danger" icon="trash" onClick={del} style={{ marginRight: 'auto' }}>Delete</Btn>}<Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save role</Btn></>}>
      <div className="form-row">
        <Field label="Role name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Sales Team Manager" /></Field>
        <div className="form-row">
          <Field label="Colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ height: 42, padding: 4 }} /></Field>
          <Field label="Level (0-99)" hint="Higher shows first"><input type="number" min={0} max={99} value={rank} onChange={(e) => setRank(Math.max(0, Math.min(99, Number(e.target.value) || 0)))} /></Field>
        </div>
      </div>
      <h4>Permissions</h4>
      <p className="dim" style={{ fontSize: 12.5 }}>Everyone can always chat with their manager, teammates and reports, see tasks in their own chain, and keep private records.</p>
      <div className="perm-grid">
        {(Object.keys(PERMS) as Perm[]).map((p) => {
          const allowed = me.user.isOwner || me.perms.includes(p);
          const on = perms.includes(p);
          return (
            <label key={p} className={'perm' + (on ? ' on' : '')} style={{ opacity: allowed ? 1 : 0.4 }}>
              <input type="checkbox" checked={on} disabled={!allowed} onChange={() => setPerms(on ? perms.filter((x) => x !== p) : [...perms, p])} />
              <span><b style={{ fontSize: 13 }}>{PERMS[p]}</b><small>{p}</small></span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- workspace
function Workspace() {
  const app = useStore((s) => s.app);
  const { data, loading, error, reload } = useAsync(() => api<any>('GET', '/api/admin/settings'), []);
  const [name, setName] = useState('');
  const [maxGB, setMaxGB] = useState(50);
  const [exts, setExts] = useState('');
  useEffect(() => { if (data) { setName(data.name); setMaxGB(data.maxUploadGB); setExts(data.blockedExts.join(', ')); } }, [data]);
  const patch = async (body: any, msg = 'Saved') => { try { await api('PATCH', '/api/admin/settings', body); toast(msg, 'ok'); reload(); loadMe(); } catch (e) { toast((e as Error).message, 'err'); } };
  const rotate = async () => {
    if (!(await confirmDialog({ title: 'Create a new join code?', text: 'The old code stops working. People already in the workspace are not affected.', ok: 'New code' }))) return;
    await api('POST', '/api/admin/rotate-code', {}); reload(); toast('New join code created', 'ok');
  };
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} retry={reload} />;
  return (
    <div className="settings-grid">
      <div className="card col">
        <h3>Join code</h3>
        <p className="muted">Teammates enter this code in "Join a team". It also proves the host's identity so nobody on the Wi-Fi can impersonate it. Every new person still needs approval.</p>
        <div className="code">{data.joinCode}</div>
        <div className="row"><Btn icon="copy" onClick={() => { navigator.clipboard.writeText(inviteText(data.name, data.joinCode, app?.host?.addresses || [], data.port)); toast('Invite copied (code + address)', 'ok'); }}>Copy invite</Btn><Btn icon="copy" onClick={() => { navigator.clipboard.writeText(data.joinCode); toast('Copied', 'ok'); }}>Code only</Btn><Btn icon="refresh" onClick={rotate}>New code</Btn></div>
        <div className="setting-row"><span><b>Allow join requests</b><small>Turn off when your team is complete.</small></span><button className={'toggle' + (data.joinOpen ? ' on' : '')} aria-pressed={data.joinOpen} onClick={() => patch({ joinOpen: !data.joinOpen })} /></div>
        <p className="dim" style={{ fontSize: 12 }}>Host fingerprint: <span className="mono" style={{ letterSpacing: '.05em' }}>{data.fingerprint}</span>{app?.host?.addresses?.length ? ` · Address: ${app.host.addresses.join(', ')}:${data.port}` : ''}</p>
      </div>
      <div className="card col">
        <h3>General</h3>
        <Field label="Workspace name"><div className="row"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /><Btn disabled={!name.trim() || name === data.name} onClick={() => patch({ name })}>Save</Btn></div></Field>
        <Field label="Largest file allowed (GB)"><div className="row"><input type="number" min={1} max={1000} value={maxGB} onChange={(e) => setMaxGB(Number(e.target.value) || 1)} /><Btn disabled={maxGB === data.maxUploadGB} onClick={() => patch({ maxUploadGB: maxGB })}>Save</Btn></div></Field>
        <Field label="Blocked file types" hint="Executables are blocked by default to stop malware spreading. Comma separated."><textarea rows={3} value={exts} onChange={(e) => setExts(e.target.value)} /></Field>
        <Btn style={{ alignSelf: 'flex-start' }} onClick={() => patch({ blockedExts: exts.split(/[\s,]+/).filter(Boolean) })}>Save blocked types</Btn>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- storage
function Storage() {
  const app = useStore((s) => s.app);
  const { data, loading, error, reload } = useAsync(() => api<any>('GET', '/api/admin/storage'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState(180);
  const [msgDays, setMsgDays] = useState(365);
  const run = async (key: string, title: string, text: string, call: () => Promise<any>, danger = true) => {
    if (!(await confirmDialog({ title, text, ok: 'Continue', danger }))) return;
    setBusy(key);
    try { const r = await call(); toast(r?.freed !== undefined ? `Done. Freed ${fmtBytes(r.freed)}.` : 'Done', 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
  };
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} retry={reload} />;
  const used = data.disk.total ? ((data.disk.total - data.disk.free) / data.disk.total) * 100 : 0;
  const ours = data.disk.total ? (data.physical / data.disk.total) * 100 : 0;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="kpis">
        <div className="kpi hl"><span>Files on disk</span><b>{fmtBytes(data.physical)}</b><span className="dim">{data.files} files</span></div>
        <div className="kpi"><span>Saved by de-duplication</span><b>{fmtBytes(data.savedByDedup)}</b></div>
        <div className="kpi"><span>Old versions</span><b>{fmtBytes(data.oldVersions.bytes)}</b><span className="dim">{data.oldVersions.count} files</span></div>
        <div className="kpi"><span>Database</span><b>{fmtBytes(data.db)}</b><span className="dim">{data.messages} messages</span></div>
      </div>
      <div className="card col">
        <div className="row between"><h3>Storage drive</h3><span className="dim">{fmtBytes(data.disk.free)} free of {fmtBytes(data.disk.total)}</span></div>
        <div className="usage"><i style={{ width: `${ours}%`, background: 'var(--grad)' }} /><i style={{ width: `${Math.max(0, used - ours)}%`, background: 'rgba(255,255,255,.18)' }} /></div>
        <p className="dim sel" style={{ fontSize: 12 }}>{data.filesDir}</p>
        {app?.mode === 'host' ? (
          <div className="row wrap">
            <Btn icon="files" onClick={() => bunny.openDataFolder()}>Open folder</Btn>
            <Btn icon="server" loading={busy === 'move'} onClick={async () => { setBusy('move'); try { const d = await bunny.moveStorage(); if (d) toast('Storage moved to ' + d, 'ok'); reload(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); } }}>Move to another drive</Btn>
            {app.host?.movePct !== undefined && <span className="pill blue">Moving {app.host.movePct}%</span>}
          </div>
        ) : <p className="dim" style={{ fontSize: 12 }}>The storage folder can be changed on the host computer.</p>}
      </div>
      <div className="grid2">
        <div className="card col">
          <h3>Clean up</h3>
          <div className="setting-row"><span><b>Remove old versions</b><small>Keep only the latest version of every file. Frees {fmtBytes(data.oldVersions.bytes)}.</small></span><Btn small kind="danger" loading={busy === 'ov'} disabled={!data.oldVersions.count} onClick={() => run('ov', 'Remove all old versions?', 'Older versions of every file are deleted permanently. The latest version stays.', () => api('POST', '/api/admin/cleanup', { action: 'old_versions' }))}>Clean</Btn></div>
          <div className="setting-row"><span><b>Delete old files</b><small>Files uploaded more than <input type="number" value={days} min={7} max={3650} onChange={(e) => setDays(Number(e.target.value) || 7)} style={{ width: 80, padding: '2px 6px', display: 'inline-block' }} /> days ago.</small></span><Btn small kind="danger" loading={busy === 'old'} onClick={() => run('old', `Delete files older than ${days} days?`, 'They are removed from all chats and tasks permanently.', () => api('POST', '/api/admin/cleanup', { action: 'older_than', days }))}>Delete</Btn></div>
          <div className="setting-row"><span><b>Clear old group messages</b><small>Group chat history older than <input type="number" value={msgDays} min={30} max={3650} onChange={(e) => setMsgDays(Number(e.target.value) || 30)} style={{ width: 80, padding: '2px 6px', display: 'inline-block' }} /> days.</small></span><Btn small kind="danger" loading={busy === 'msg'} onClick={() => run('msg', `Clear group messages older than ${msgDays} days?`, 'This cannot be undone. Direct messages are not affected.', () => api('POST', '/api/admin/clear-messages', { days: msgDays, which: 'group' }))}>Clear</Btn></div>
          <div className="setting-row"><span><b>Optimise database</b><small>Compacts the database after large cleanups.</small></span><Btn small loading={busy === 'vac'} onClick={() => run('vac', 'Optimise database?', 'This may take a moment. Everything keeps working.', () => api('POST', '/api/admin/vacuum', {}), false)}>Optimise</Btn></div>
          <div className="setting-row"><span><b>Purge deleted files</b><small>{fmtBytes(data.reclaimable)} waiting to be removed from disk.</small></span><Btn small loading={busy === 'pd'} disabled={!data.reclaimable} onClick={() => run('pd', 'Purge deleted files?', 'Files already deleted in the app are removed from disk.', () => api('POST', '/api/admin/cleanup', { action: 'purge_deleted' }), false)}>Purge</Btn></div>
        </div>
        <div className="card col">
          <div className="row between"><h3>Backups</h3><Btn small icon="download" loading={busy === 'bk'} onClick={() => run('bk', 'Back up now?', 'A snapshot of the database is saved in the host data folder. Automatic backups also run every day (last 14 kept).', () => api('POST', '/api/admin/backup', {}), false)}>Back up now</Btn></div>
          <p className="dim" style={{ fontSize: 12 }}>Last backup: {data.lastBackup ? fmtDateTime(data.lastBackup) : 'never'}. Files are not duplicated in backups; copy the storage folder to another drive for a full backup.</p>
          {data.backups.map((b: any) => <div key={b.name} className="row between" style={{ fontSize: 12.5 }}><span className="mono" style={{ letterSpacing: '.02em', textTransform: 'none' }}>{b.name}</span><span className="dim">{fmtBytes(b.size)}</span></div>)}
        </div>
      </div>
      <div className="grid2">
        <div className="card col">
          <h3>Duplicate files</h3>
          <p className="dim" style={{ fontSize: 12 }}>The same content uploaded more than once. It is stored only once on disk automatically.</p>
          {data.duplicates.length ? data.duplicates.map((d: any) => (
            <div key={d.sha} className="row between" style={{ fontSize: 13 }}><span className="grow ellipsis" title={d.names.join(', ')}>{d.names.join(', ')}</span><span className="pill">{d.copies}x · {fmtBytes(d.size)}</span></div>
          )) : <p className="dim">No duplicates.</p>}
        </div>
        <div className="card col">
          <h3>Files with many versions</h3>
          {data.versioned.length ? data.versioned.map((v: any) => (
            <div key={v.groupId} className="row" style={{ fontSize: 13 }}>
              <span className="grow ellipsis">{v.name}</span><span className="pill">{v.versions} versions · {fmtBytes(v.bytes)}</span>
              <Btn small kind="soft" onClick={() => run('vg' + v.groupId, `Keep only the latest "${v.name}"?`, 'Older versions of this file are deleted.', () => api('POST', '/api/admin/cleanup', { action: 'version_group', groupId: v.groupId }))}>Keep latest</Btn>
            </div>
          )) : <p className="dim">No versioned files.</p>}
        </div>
      </div>
      <div className="card col">
        <h3>Storage by member</h3>
        {data.byUser.map((u: any, i: number) => <div key={i} className="row between" style={{ fontSize: 13 }}><span>{u.name || 'Former member'}</span><span className="dim">{u.files} files · {fmtBytes(u.bytes)}</span></div>)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- audit
function Audit() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [q, setQ] = useState('');
  const load = async (before?: number) => {
    setLoading(true);
    try { const r = await api<any[]>('GET', `/api/admin/audit${before ? '?before=' + before : ''}`); setRows((x) => (before ? [...x, ...r] : r)); if (r.length < 200) setDone(true); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const shown = rows.filter((r) => !q || `${r.action} ${r.actor} ${r.detail} ${r.ip}`.toLowerCase().includes(q.toLowerCase()));
  const bad = (a: string) => /failed|locked|bad_code|disabled|revoked|deleted|transferred/.test(a);
  return (
    <div className="col">
      <div className="row between"><p className="muted">Sign-ins, approvals, permission changes and admin actions. Message contents are never logged.</p><ExportButtons disabled={!rows.length} table={() => ({ title: 'Security log', columns: ['When', 'Who', 'Event', 'Details', 'Address'], rows: shown.map((r) => [fmtDateTime(r.at), r.actor, r.action, r.detail, r.ip]) })} /><div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" /></div></div>
      {!rows.length && !loading ? <Empty icon="shield" title="No events yet" /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Who</th><th>Event</th><th>Details</th><th>Address</th></tr></thead><tbody>
          {shown.map((r) => <tr key={r.id}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</td><td>{r.actor}</td><td><span className={'pill' + (bad(r.action) ? ' bad' : '')}>{r.action}</span></td><td className="dim" style={{ fontSize: 12 }}>{r.detail}</td><td className="dim" style={{ fontSize: 12 }}>{r.ip}</td></tr>)}
        </tbody></table></div>
      )}
      {loading && <Spinner />}
      {!done && !loading && rows.length > 0 && <Btn onClick={() => load(rows.at(-1).id)} style={{ alignSelf: 'center' }}>Load older</Btn>}
    </div>
  );
}
