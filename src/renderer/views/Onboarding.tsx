import { useEffect, useState, type ReactNode } from 'react';
import { bunny, type AppState } from '../api';
import { Btn, Field, Icon, Logo, ErrorBox, Spinner } from '../ui';
import { NetCheckModal, parseInvite } from './NetCheck';

const WEBSITE = 'https://framelabmedia.odoo.com/';
const INSTA = 'https://www.instagram.com/bunnysframelab/';

export function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="onb">
      <div className="onb-bg"><div className="g1" /><div className="g2" /><div className="dots" /></div>
      <div className={'onb-card' + (wide ? ' wide' : '')}>{children}</div>
    </div>
  );
}

export function BrandFooter() {
  return (
    <div className="footer-brand">
      <span>Made by Bunnys Framelab</span>·
      <a onClick={() => bunny.openExternal(WEBSITE)}>Website</a>·
      <a onClick={() => bunny.openExternal(INSTA)}>Instagram</a>
    </div>
  );
}

function strength(p: string) {
  let s = 0;
  if (p.length >= 10) s++; if (p.length >= 14) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}
function PasswordFields({ pw, setPw, pw2, setPw2 }: { pw: string; setPw: (v: string) => void; pw2: string; setPw2: (v: string) => void }) {
  const s = strength(pw);
  return (
    <>
      <Field label="Password" hint={<span className="row"><span className="strength grow">{[0, 1, 2, 3].map((i) => <i key={i} className={i < s ? 'on' : ''} />)}</span><span>{['Too weak', 'Weak', 'Okay', 'Good', 'Strong'][s]}</span></span>}>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="At least 10 characters" />
      </Field>
      <Field label="Confirm password" error={pw2 && pw !== pw2 ? 'Passwords do not match.' : null}>
        <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </Field>
      <div className="notice warn"><Icon name="lock" size={16} /><span>Your password protects your private messages with end-to-end encryption. Nobody, not even the admin, can recover them without it. Keep it safe.</span></div>
    </>
  );
}

const cleanUser = (v: string) => v.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);

export function Welcome({ onPick }: { onPick: (v: 'host' | 'join') => void }) {
  return (
    <Frame wide>
      <div className="onb-head">
        <Logo size={96} />
        <h1>Manage with <span className="gr">Bunny</span></h1>
        <p>Private team chat, tasks, files and performance tracking that live on your own Wi-Fi. Nothing leaves your network.</p>
      </div>
      <div className="choice-grid">
        <button className="choice" onClick={() => onPick('host')}>
          <span className="ci"><Icon name="server" size={22} /></span>
          <h3>Host a workspace</h3>
          <p>This computer becomes the team server. All messages and files are stored on a drive you choose. Best for the owner or an always-on PC.</p>
        </button>
        <button className="choice" onClick={() => onPick('join')}>
          <span className="ci"><Icon name="wifi" size={22} /></span>
          <h3>Join a team</h3>
          <p>Connect to your team's host on this Wi-Fi with the join code from your admin. Your request is approved before you get in.</p>
        </button>
      </div>
      <BrandFooter />
    </Frame>
  );
}

export function HostSetup({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'new' | 'open'>('new');
  const [ws, setWs] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [dir, setDir] = useState('');
  const [port, setPort] = useState('47821');
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { bunny.suggestDataDir().then(setDir).catch(() => {}); }, []);
  const pick = async () => { const d = await bunny.pickFolder(); if (d) setDir(mode === 'new' ? d.replace(/[\\/]$/, '') + (d.toLowerCase().includes('bunny') ? '' : (d.includes('\\') ? '\\' : '/') + 'Manage with Bunny Data') : d); };
  const valid = mode === 'open' ? !!dir : ws.trim() && name.trim() && user.length >= 3 && pw.length >= 10 && pw === pw2 && dir;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'new') await bunny.createWorkspace({ workspaceName: ws, displayName: name, username: user, password: pw, dataDir: dir, port: Number(port) });
      else await bunny.openWorkspace({ dataDir: dir, port: Number(port) });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <Btn kind="soft" icon="left" className="back-link" onClick={onBack}>Back</Btn>
      <div className="onb-head"><Logo size={56} /><h1>Host a <span className="gr">workspace</span></h1><p>This computer will run the team server. Keep it on and connected to the office Wi-Fi.</p></div>
      <div className="panel">
        <div className="tabs" style={{ alignSelf: 'center' }}>
          <button className={'tab' + (mode === 'new' ? ' on' : '')} onClick={() => setMode('new')}>New workspace</button>
          <button className={'tab' + (mode === 'open' ? ' on' : '')} onClick={() => setMode('open')}>Open existing data folder</button>
        </div>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
          {mode === 'new' && <>
            <Field label="Workspace name"><input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="Bunnys Framelab Studio" maxLength={60} autoFocus /></Field>
            <div className="form-row">
              <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" maxLength={60} /></Field>
              <Field label="Username"><input value={user} onChange={(e) => setUser(cleanUser(e.target.value))} placeholder="e.g. bunny" /></Field>
            </div>
            <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
          </>}
          <Field label={mode === 'new' ? 'Storage folder (database + all files)' : 'Existing data folder'} hint={mode === 'new' ? 'Pick a drive with plenty of free space. Videos and large files are stored here.' : 'The folder that contains the "db" and "tls" folders. Members reconnect automatically.'}>
            <div className="row"><input value={dir} onChange={(e) => setDir(e.target.value)} className="grow" /><Btn icon="files" onClick={pick}>Browse</Btn></div>
          </Field>
          <button type="button" className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdv(!adv)}><Icon name={adv ? 'down' : 'right'} size={14} /> Advanced</button>
          {adv && <Field label="Network port" hint="Change only if another app uses 47821."><input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} /></Field>}
          {err && <ErrorBox text={err} />}
          <Btn kind="primary" loading={busy} disabled={!valid} onClick={submit}>{mode === 'new' ? 'Create workspace' : 'Start hosting'}</Btn>
          {busy && mode === 'new' && <p className="dim" style={{ textAlign: 'center', fontSize: 12 }}>Generating encryption keys and a secure certificate...</p>}
        </form>
      </div>
      <BrandFooter />
    </Frame>
  );
}

export function JoinFlow({ onBack, onPending }: { onBack: () => void; onPending: () => void }) {
  const [code, setCode] = useState('');
  const [addr, setAddr] = useState('');
  const [manual, setManual] = useState(false);
  const [found, setFound] = useState<{ name: string; addr: string; fingerprint: string } | null>(null);
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState(false);
  const fmtCode = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20).match(/.{1,5}/g)?.join('-') || '';
  const probe = async () => {
    setBusy(true); setErr(null);
    try { setFound(await bunny.probeCode({ code, addr: manual ? addr : undefined })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const join = async () => {
    setBusy(true); setErr(null);
    try { await bunny.join({ displayName: name, username: user, password: pw }); onPending(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <Btn kind="soft" icon="left" className="back-link" onClick={found ? () => setFound(null) : onBack}>Back</Btn>
      <div className="onb-head"><Logo size={56} /><h1>Join your <span className="gr">team</span></h1><p>{found ? 'Create your account. The admin approves it before you can enter.' : 'Ask your admin for the join code. You must be on the same Wi-Fi as the host.'}</p></div>
      <div className="panel">
        {!found ? (
          <form className="form" onSubmit={(e) => { e.preventDefault(); probe(); }}>
            <Field label="Join code"><input className="code" style={{ fontSize: 18 }} value={code} onChange={(e) => setCode(fmtCode(e.target.value))} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autoFocus spellCheck={false}
              onPaste={(e) => { const inv = parseInvite(e.clipboardData.getData('text')); if (inv.code) { e.preventDefault(); setCode(fmtCode(inv.code)); if (inv.addr) { setAddr(inv.addr); setManual(true); } } }} /></Field>
            <button type="button" className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setManual(!manual)}><Icon name={manual ? 'down' : 'right'} size={14} /> Host not found automatically?</button>
            {manual && <Field label="Host address" hint="Shown in the host's Settings. Example: 192.168.1.20"><input value={addr} onChange={(e) => setAddr(e.target.value.trim())} placeholder="192.168.1.20" /></Field>}
            {err && <><ErrorBox text={err} /><Btn small kind="soft" icon="wifi" onClick={() => setCheck(true)} style={{ alignSelf: 'flex-start' }}>Run network check</Btn></>}
            <Btn kind="primary" loading={busy} disabled={code.replace(/-/g, '').length !== 20} onClick={probe}>{busy ? 'Searching this Wi-Fi...' : 'Find workspace'}</Btn>
          </form>
        ) : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); join(); }}>
            <div className="notice"><Icon name="lock" size={16} /><span>Found <b>{found.name}</b> at {found.addr}. Verified secure identity <span className="mono" style={{ letterSpacing: '.05em' }}>{found.fingerprint}</span></span></div>
            <div className="form-row">
              <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></Field>
              <Field label="Username"><input value={user} onChange={(e) => setUser(cleanUser(e.target.value))} /></Field>
            </div>
            <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
            {err && <ErrorBox text={err} />}
            <Btn kind="primary" loading={busy} disabled={!name.trim() || user.length < 3 || pw.length < 10 || pw !== pw2} onClick={join}>Request to join</Btn>
            <Btn kind="soft" small style={{ alignSelf: 'center' }} onClick={async () => { try { await bunny.useExistingAccount(); onPending(); } catch (e) { setErr((e as Error).message); } }}>I already have an account (or a reset code)</Btn>
          </form>
        )}
      </div>
      {check && <NetCheckModal onClose={() => setCheck(false)} />}
      <BrandFooter />
    </Frame>
  );
}

export function Pending({ app, onCancel }: { app: AppState; onCancel: () => void }) {
  return (
    <Frame>
      <div className="onb-head">
        <Logo size={80} />
        <h1>Waiting for <span className="gr">approval</span></h1>
        <p>Your request to join <b>{app.workspace?.name}</b> was sent as <b>@{app.workspace?.username}</b>. An admin needs to approve it and set your role. This screen continues automatically.</p>
        <div className="row" style={{ marginTop: 10 }}><Spinner /><span className="muted">{app.online ? 'Connected to host, waiting...' : 'Looking for the host on this Wi-Fi...'}</span></div>
      </div>
      <Btn kind="soft" onClick={async () => { await bunny.cancelJoin(); onCancel(); }} style={{ alignSelf: 'center' }}>Cancel request</Btn>
      <BrandFooter />
    </Frame>
  );
}

export function Login({ app, onDone, onLeave }: { app: AppState; onDone: () => void; onLeave: () => void }) {
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [user, setUser] = useState(app.workspace?.username || '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'login') await bunny.login({ username: user, password: pw });
      else await bunny.resetWithCode({ username: user, code, password: pw });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <div className="onb-head"><Logo size={72} /><h1>{mode === 'login' ? <>Welcome <span className="gr">back</span></> : <>Reset <span className="gr">password</span></>}</h1><p>{app.workspace?.name}{app.mode === 'host' ? ' · hosted on this computer' : ''}</p></div>
      {app.sessionLost && mode === 'login' && <div className="notice"><Icon name="key" size={16} /><span>The saved sign-in could not be restored (the app was closed unexpectedly). Enter your password once and you stay signed in again.</span></div>}
      <div className="panel">
        <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Username"><input value={user} onChange={(e) => setUser(cleanUser(e.target.value))} autoFocus={!user} /></Field>
          {mode === 'reset' && <Field label="Reset code from your admin"><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" spellCheck={false} /></Field>}
          {mode === 'login'
            ? <Field label="Password"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={!!user} autoComplete="current-password" /></Field>
            : <>
                <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
                <div className="notice warn"><Icon name="key" size={16} /><span>Resetting creates a new encryption key. Your old private messages can no longer be read.</span></div>
              </>}
          {err && <ErrorBox text={err} />}
          <Btn kind="primary" loading={busy} disabled={!user || !pw || (mode === 'reset' && (pw !== pw2 || pw.length < 10 || code.length < 8))} onClick={submit}>{mode === 'login' ? 'Sign in' : 'Reset and sign in'}</Btn>
          <div className="row between">
            <Btn kind="soft" small onClick={() => { setMode(mode === 'login' ? 'reset' : 'login'); setErr(null); }}>{mode === 'login' ? 'Forgot password? Use a reset code' : 'Back to sign in'}</Btn>
            {app.mode === 'member' && <Btn kind="soft" small onClick={async () => { await bunny.leaveWorkspace(); onLeave(); }}>Use another workspace</Btn>}
          </div>
        </form>
      </div>
      <BrandFooter />
    </Frame>
  );
}

export function HostError({ app, retry }: { app: AppState; retry: () => void }) {
  return (
    <Frame>
      <div className="onb-head"><Logo size={72} /><h1>Host <span className="gr">stopped</span></h1><p>{app.host?.error || 'The host server is starting...'}</p></div>
      <Btn kind="primary" icon="refresh" onClick={retry} style={{ alignSelf: 'center' }}>Try again</Btn>
    </Frame>
  );
}
