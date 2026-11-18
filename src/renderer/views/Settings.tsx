import { useState } from 'react';
import { api, bunny, useStore, toast, fmtAgo, loadUsers, loadMe, setState, clearSession } from '../api';
import { Avatar, Btn, Field, Icon, Logo, Spinner, confirmDialog, useAsync } from '../ui';
import { NetCheckModal } from './NetCheck';

const WEBSITE = 'https://framelabmedia.odoo.com/';
const INSTA = 'https://www.instagram.com/bunnysframelab/';

export function Settings() {
  const me = useStore((s) => s.me!);
  const app = useStore((s) => s.app!);
  const user = useStore((s) => s.users[s.me!.user.id] || s.me!.user);
  const [name, setName] = useState(user.displayName);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [net, setNet] = useState(false);
  const sessions = useAsync(() => api<any[]>('GET', '/api/auth/sessions'), []);
  const refreshApp = async () => setState({ app: await bunny.state() });

  const saveName = async () => {
    setBusy('name');
    try { await api('PATCH', `/api/users/${me.user.id}`, { displayName: name }); await Promise.all([loadUsers(), loadMe()]); toast('Name updated', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
  };
  const changePw = async () => {
    setBusy('pw');
    try { await bunny.changePassword({ current: cur, next }); setCur(''); setNext(''); setNext2(''); toast('Password changed. Other devices were signed out.', 'ok'); sessions.reload(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
  };
  const revoke = async (id: string) => { await api('DELETE', `/api/auth/sessions/${id}`); sessions.reload(); };
  const logout = async () => { clearSession(); await bunny.logout(); };
  const leave = async () => {
    const host = app.mode === 'host';
    const ok = await confirmDialog({
      title: host ? 'Stop hosting on this computer?' : 'Leave this workspace on this computer?',
      text: host ? 'The server stops and your team can no longer connect. The data folder is NOT deleted; you can open it again later with "Host a workspace > Open existing data folder".' : 'You are signed out and this computer forgets the workspace. Your account stays; you can sign in again with the join code.',
      ok: host ? 'Stop hosting' : 'Leave', danger: true, input: host ? 'STOP' : undefined,
    });
    if (!ok) return;
    clearSession();
    if (host) await bunny.stopHosting(); else await bunny.leaveWorkspace();
  };
  return (
    <div className="page">
      {net && <NetCheckModal onClose={() => setNet(false)} />}
      <div className="page-head"><div><h1>Settings</h1><p>Your profile, security and this app.</p></div><Btn icon="logout" onClick={logout}>Sign out</Btn></div>
      <div className="settings-grid">
        <div className="card col">
          <div className="row"><Avatar user={user} size={52} ring /><div><h3>{user.displayName}</h3><p className="dim">@{user.username} · {me.roles.find((r) => r.id === user.roleId)?.name}</p></div></div>
          <Field label="Display name"><div className="row"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /><Btn loading={busy === 'name'} disabled={!name.trim() || name === user.displayName} onClick={saveName}>Save</Btn></div></Field>
        </div>

        <div className="card col">
          <h3>Change password</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); changePw(); }}>
            <Field label="Current password"><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
            <Field label="New password" hint="At least 10 characters."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Confirm new password" error={next2 && next !== next2 ? 'Passwords do not match.' : null}><input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" /></Field>
            <Btn kind="primary" loading={busy === 'pw'} disabled={!cur || next.length < 10 || next !== next2} onClick={changePw} style={{ alignSelf: 'flex-start' }}>Change password</Btn>
          </form>
        </div>

        <div className="card col">
          <h3>Signed-in devices</h3>
          {sessions.loading && !sessions.data ? <Spinner /> : sessions.data?.map((s) => (
            <div key={s.id} className="setting-row">
              <span><b>{s.device_name || 'Unknown device'} {s.current && <span className="pill ok">This device</span>}</b><small>Active {fmtAgo(s.last_used)} · {s.ip}</small></span>
              {!s.current && <Btn small kind="soft" onClick={() => revoke(s.id)}>Sign out</Btn>}
            </div>
          ))}
        </div>

        <div className="card col">
          <h3>This app</h3>
          <div className="setting-row"><span><b>Network check</b><small>Find out why someone cannot connect and fix the firewall in one click.</small></span><Btn small icon="wifi" onClick={() => setNet(true)}>Check</Btn></div>
          <div className="setting-row"><span><b>Start with the computer</b><small>{app.mode === 'host' ? 'Keeps the team server running after restarts. Strongly recommended for the host.' : 'Stay connected to your team automatically.'}</small></span>
            <button className={'toggle' + (app.autoStart ? ' on' : '')} aria-pressed={app.autoStart} onClick={async () => { await bunny.setAutoStart(!app.autoStart); refreshApp(); }} /></div>
          <div className="setting-row"><span><b>Keep running when the window is closed</b><small>Stays in the {app.platform === 'darwin' ? 'menu bar' : 'system tray'} so you never miss a message{app.mode === 'host' ? ' and the server stays online' : ''}.</small></span>
            <button className={'toggle' + (app.closeToTray ? ' on' : '')} aria-pressed={app.closeToTray} onClick={async () => { await bunny.setCloseToTray(!app.closeToTray); refreshApp(); }} /></div>
          {app.mode === 'host' && app.host && (
            <div className="notice"><Icon name="server" size={16} /><span>This computer is the host. Address {app.host.addresses.join(', ') || 'unknown'} · port {app.host.port}. Keep it on and connected to the same Wi-Fi as your team.</span></div>
          )}
          <div className="row wrap">
            <Btn kind="danger" icon="logout" onClick={leave}>{app.mode === 'host' ? 'Stop hosting' : 'Leave workspace on this computer'}</Btn>
            <Btn kind="soft" onClick={() => bunny.quit()}>Quit app</Btn>
          </div>
        </div>

        <div className="card">
          <div className="about">
            <Logo size={84} />
            <h2>Manage with <span className="gr">Bunny</span></h2>
            <p className="muted">Version {app.version}</p>
            <p className="muted" style={{ maxWidth: 360 }}>Private team communication, file transfer, task tracking and performance analytics for your local network.</p>
            <span className="mono">Made by Bunnys Framelab</span>
            <div className="links">
              <Btn icon="globe" onClick={() => bunny.openExternal(WEBSITE)}>framelabmedia.odoo.com</Btn>
              <Btn icon="insta" onClick={() => bunny.openExternal(INSTA)}>@bunnysframelab</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
