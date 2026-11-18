import { app, BrowserWindow, ipcMain, protocol, session, net as enet, shell, dialog, Tray, Menu, nativeImage, Notification, powerSaveBlocker, powerMonitor, systemPreferences, safeStorage, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { load, save, update, secrets, type WorkspaceCfg } from './config';
import { HostCtl, serverPath } from './host';
import { startDiscovery, listBeacons, probeTls, scanSubnets, pinnedRequest, type Pin } from './net';
import { deriveKeys, newKeyPair, newSalt, wrapKeyPair, unwrapKeyPair, dmKey, encryptText, decryptText, safetyNumber, type KeyPair } from './keys';
import { decodeJoinCode, normFp, DEFAULT_PORT, APP_ORIGIN } from '../shared/joincode';
import { LIMITS, USERNAME_RE } from '../shared/kdf';
import { validateTable, toXlsx, toPdf } from './export';
import { diagnose, repairFirewall } from './netcheck';

declare const __DEV__: boolean;
const RENDERER = path.join(__dirname, 'renderer');
const startHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

// Development only: isolated profiles let a host and a member run side by side on one machine for testing.
if (!app.isPackaged && process.env.MWB_USER_DATA) app.setPath('userData', path.resolve(process.env.MWB_USER_DATA));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pin: Pin | null = null;
let keys: KeyPair | null = null;
let blocker: number | null = null;
let candidate: { pin: Pin; wid: string; name: string; secret: string } | null = null;
let candidateAddrs: string[] = [];
let pendingTimer: NodeJS.Timeout | null = null;
const host = new HostCtl(serverPath());

// ---------------------------------------------------------------- helpers
function send(ch: string, payload?: unknown) { if (win && !win.isDestroyed()) win.webContents.send('bunny:event', ch, payload); }
const deviceName = () => `${os.hostname().slice(0, 40)} (${process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'})`;
class UserError extends Error {}
const fail = (m: string): never => { throw new UserError(m); };
function errMsg(json: any, fallback: string) { return typeof json?.message === 'string' ? json.message.slice(0, 300) : fallback; }
function checkUsername(u: unknown) { const s = String(u || '').trim().toLowerCase(); if (!USERNAME_RE.test(s)) fail('Username may use a-z, 0-9, dot, dash and underscore (3-32 characters).'); return s; }
function checkPassword(p: unknown) { const s = String(p || ''); if (s.length < LIMITS.password.min) fail(`Password must be at least ${LIMITS.password.min} characters.`); if (s.length > LIMITS.password.max) fail('Password is too long.'); return s; }
function checkName(n: unknown, what = 'Name') { const s = String(n || '').replace(/[\u0000-\u001F\u007F]/g, '').trim(); if (!s || s.length > 60) fail(`${what} must be 1-60 characters.`); return s; }
const baseUrl = (p: Pin) => `https://${p.addr.includes(':') ? `[${p.addr}]` : p.addr}:${p.port}`;

function getKeys(): KeyPair | null { if (!keys) keys = secrets.getKeys(); return keys; }
function setKeys(k: KeyPair | null) { keys = k; secrets.setKeys(k); }

// ---------------------------------------------------------------- host resolution / reconnect
let resolving: Promise<Pin | null> | null = null;
async function resolvePin(force = false): Promise<Pin | null> {
  const c = load();
  const ws = c.ws;
  if (!ws) return null;
  if (pin && !force) return pin;
  if (resolving) return resolving;
  resolving = (async () => {
    const mk = (addr: string, certPem = ws.certPem): Pin => ({ addr, port: ws.port, fp: ws.fp, certPem });
    if (c.mode === 'host') {
      if (!host.status.running) { try { await host.start(c.host!.dataDir, c.host!.port); } catch { return null; } }
      return mk('127.0.0.1');
    }
    const tryAddr = async (addr: string, port = ws.port) => { const p = await probeTls(addr, port, 2500); return p && p.fp === ws.fp ? { ...mk(addr), port } : null; };
    const remembered = [...new Set([ws.lastAddr, ...(ws.knownAddrs || [])].filter(Boolean))];
    if (remembered.length) { const p = await Promise.any(remembered.map(async (a) => { const r = await tryAddr(a); if (!r) throw new Error('no'); return r; })).catch(() => null); if (p) return p; }
    for (let i = 0; i < 6; i++) {
      for (const b of listBeacons()) if (b.wid === ws.wid && b.fp === ws.fp) { const p = await tryAddr(b.addr, b.port); if (p) return p; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const found = await scanSubnets(ws.port, (fp) => fp === ws.fp);
    return found ? mk(found.addr) : null;
  })();
  try {
    const p = await resolving;
    if (p) {
      pin = p;
      if (load().ws && load().ws!.lastAddr !== p.addr) update((cfg) => { cfg.ws!.lastAddr = p.addr; cfg.ws!.port = p.port; });
      if (load().mode === 'member') void rememberHostAddrs(p);
    }
    send('conn', { online: !!p, base: p ? baseUrl(p) : null });
    return p;
  } finally { resolving = null; }
}

// Ask the host for all its LAN addresses (Wi-Fi + cable) so reconnects are instant even if one changes.
async function rememberHostAddrs(p: Pin) {
  try {
    const r = await pinnedRequest(p, 'GET', '/api/hello', undefined, undefined, 5000);
    const list = Array.isArray(r.json?.addresses) ? r.json.addresses.filter((a: unknown) => typeof a === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)).slice(0, 8) : [];
    if (list.length && load().ws) update((c) => { c.ws!.knownAddrs = list; });
  } catch { /* offline */ }
}

// Pin the host certificate for Chromium (renderer fetch/WebSocket/<video>): accept ONLY the pinned fingerprint.
function installCertPinning() {
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    const ws = load().ws;
    if (ws?.fp) {
      try {
        const fp = normFp(new crypto.X509Certificate(req.certificate.data).fingerprint256);
        if (fp === ws.fp) return cb(0);
      } catch { /* fall through */ }
    }
    cb(-3); // default Chromium verification (self-signed => rejected)
  });
}

// ---------------------------------------------------------------- app:// protocol (renderer files)
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'";
function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'bunny') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(RENDERER, rel));
    if (!full.startsWith(RENDERER + path.sep) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
    const res = await enet.fetch(pathToFileURL(full).toString());
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (full.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

// ---------------------------------------------------------------- window, tray
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#08080A', title: 'Manage with Bunny',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'logo.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#08080A', symbolColor: '#F4F3F1', height: 38 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools: __DEV__, spellcheck: true, backgroundThrottling: false,
    },
  });
  win.loadURL('app://bunny/index.html');
  win.once('ready-to-show', () => { if (!startHidden) win?.show(); });
  win.on('close', (e) => {
    if (!quitting && load().closeToTray) { e.preventDefault(); win?.hide(); if (process.platform === 'darwin') app.dock?.hide(); }
  });
  win.on('focus', () => win?.flashFrame(false));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  win!.show(); win!.focus();
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img);
  tray.setToolTip('Manage with Bunny');
  tray.on('click', showWindow);
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  const c = load();
  const hostLine = c.mode === 'host' ? (host.status.running ? `Hosting on port ${host.status.port}` : 'Host stopped') : (pin ? 'Connected' : 'Offline');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Manage with Bunny', click: showWindow },
    { label: hostLine, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- IPC
function handle(ch: string, fn: (...a: any[]) => unknown) {
  ipcMain.handle(ch, async (e: IpcMainInvokeEvent, ...args) => {
    if (!e.senderFrame || !e.senderFrame.url.startsWith(APP_ORIGIN + '/')) throw new Error('blocked');
    try { return { ok: true, data: await fn(...args) }; } catch (err) {
      const m = err instanceof UserError ? err.message : (err as any)?.code === 'ECONNREFUSED' || (err as any)?.code === 'ETIMEDOUT' ? 'Could not reach the host. Make sure you are on the same Wi-Fi.' : (err as Error)?.message?.slice(0, 300) || 'Unexpected error';
      return { ok: false, error: m };
    }
  });
}

function appState() {
  const c = load();
  return {
    mode: c.mode, version: app.getVersion(), platform: process.platform,
    workspace: c.ws ? { wid: c.ws.wid, name: c.ws.name, username: c.ws.username, userId: c.ws.userId, port: c.ws.port, lastAddr: c.ws.lastAddr } : null,
    signedIn: !!secrets.getToken(), pending: !!secrets.getPending(), sessionLost: !!c.secrets.token && !secrets.getToken(),
    host: c.mode === 'host' ? { ...host.status, setupToken: undefined, dataDir: c.host?.dataDir } : null,
    autoStart: c.autoStart, closeToTray: c.closeToTray, online: !!pin,
  };
}

async function finishLogin(data: any, kp: KeyPair) {
  secrets.setToken(data.token);
  setKeys(kp);
  update((c) => { c.ws!.username = data.user.username; c.ws!.userId = data.user.id; c.ws!.name = data.workspace?.name || c.ws!.name; });
  send('auth', { signedIn: true });
}

function registerIpc() {
  handle('state', () => appState());
  handle('hosts', () => listBeacons().map((b) => ({ name: b.name, addr: b.addr, port: b.port, wid: b.wid })));

  handle('suggestDataDir', () => {
    // Prefer a non-system drive on Windows so large videos do not fill C:.
    if (process.platform === 'win32') {
      for (const d of 'DEFGHIJ') { try { if (fs.existsSync(`${d}:\\`)) { fs.accessSync(`${d}:\\`, fs.constants.W_OK); return `${d}:\\Manage with Bunny Data`; } } catch { /* */ } }
    }
    return path.join(app.getPath('documents'), 'Manage with Bunny Data');
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('createWorkspace', async (o: any) => {
    const workspaceName = checkName(o?.workspaceName, 'Workspace name');
    const displayName = checkName(o?.displayName, 'Your name');
    const username = checkUsername(o?.username);
    const password = checkPassword(o?.password);
    const port = Number(o?.port) || DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Port must be between 1024 and 65535.');
    const dataDir = path.resolve(String(o?.dataDir || ''));
    if (!o?.dataDir) fail('Choose a storage folder.');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(path.join(dataDir, 'db', 'bunny.db'))) fail('This folder already contains a workspace. Use "Open existing data folder" instead.');
    await host.stop();
    const st = await host.start(dataDir, port);
    if (!st.setupToken) fail('Setup is not available for this folder.');
    const certPem = fs.readFileSync(path.join(dataDir, 'tls', 'host.crt'), 'utf8');
    const p: Pin = { addr: '127.0.0.1', port, fp: st.fp, certPem };
    const salt = newSalt();
    const { authKey, wrapKey } = await deriveKeys(password, salt);
    const kp = newKeyPair();
    const r = await pinnedRequest(p, 'POST', '/api/setup/owner', { setupToken: st.setupToken, workspaceName, username, displayName, salt, authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, wrapKey), device: deviceName() });
    wrapKey.fill(0);
    if (r.status !== 200) fail(errMsg(r.json, 'Could not create the workspace.'));
    host.clearSetupToken();
    update((c) => { c.mode = 'host'; c.host = { dataDir, port }; c.ws = { wid: st.wid, name: workspaceName, fp: st.fp, certPem, port, lastAddr: '127.0.0.1' }; c.knownKeys = {}; });
    pin = p;
    await finishLogin(r.json, kp);
    setAutoStart(true);
    startHostingExtras();
    return { joinCode: st.joinCode };
  });

  handle('openWorkspace', async (o: any) => {
    const dataDir = path.resolve(String(o?.dataDir || ''));
    const port = Number(o?.port) || DEFAULT_PORT;
    if (!fs.existsSync(path.join(dataDir, 'db', 'bunny.db'))) fail('No workspace found in that folder. Pick the folder that contains "db" and "tls".');
    await host.stop();
    const st = await host.start(dataDir, port);
    if (st.setupToken) { await host.stop(); fail('This workspace was never finished. Create a new workspace instead.'); }
    const certPem = fs.readFileSync(path.join(dataDir, 'tls', 'host.crt'), 'utf8');
    update((c) => { c.mode = 'host'; c.host = { dataDir, port }; c.ws = { wid: st.wid, name: st.name, fp: st.fp, certPem, port, lastAddr: '127.0.0.1' }; c.secrets = {}; });
    pin = { addr: '127.0.0.1', port, fp: st.fp, certPem };
    startHostingExtras();
    return { name: st.name };
  });

  handle('probeCode', async (o: any) => {
    const code = decodeJoinCode(String(o?.code || ''));
    if (!code) fail('That code does not look right. It has 20 letters/numbers, like ABCDE-FGHJK-MNPQR-STVWX.');
    let manual: { addr: string; port: number } | null = null;
    if (o?.addr) {
      const m = /^\s*([0-9.]{7,15})(?::(\d{2,5}))?\s*$/.exec(String(o.addr));
      if (!m || m[1].split('.').some((x) => Number(x) > 255)) fail('Enter the host address like 192.168.1.20 or 192.168.1.20:47821');
      manual = { addr: m![1], port: m![2] ? Number(m![2]) : DEFAULT_PORT };
    }
    const match = (fp: string) => fp.startsWith(code!.fpPrefix);
    let found: { addr: string; port: number; fp: string; certPem: string } | null = null;
    if (manual) { const p = await probeTls(manual.addr, manual.port, 4000); if (p && match(p.fp)) found = { ...manual, ...p }; }
    if (!found) {
      for (let i = 0; i < 8 && !found; i++) {
        for (const b of listBeacons()) if (match(b.fp)) { const p = await probeTls(b.addr, b.port); if (p && match(p.fp)) { found = { addr: b.addr, port: b.port, ...p }; break; } }
        if (!found) await new Promise((r) => setTimeout(r, 500));
      }
      if (!found) { const s = await scanSubnets(DEFAULT_PORT, match); if (s) found = { ...s, port: DEFAULT_PORT }; }
    }
    if (!found) fail('No matching host found on this Wi-Fi. Check that the host computer is on, on the same network, and allowed through its firewall. You can also type its address.');
    const p: Pin = { addr: found!.addr, port: found!.port, fp: found!.fp, certPem: found!.certPem };
    const hello = await pinnedRequest(p, 'GET', '/api/hello');
    if (hello.status !== 200 || hello.json?.app !== 'manage-with-bunny') fail('That computer is not a Manage with Bunny host.');
    candidate = { pin: p, wid: hello.json.wid, name: String(hello.json.name).slice(0, 60), secret: code!.secret };
    candidateAddrs = Array.isArray(hello.json.addresses) ? hello.json.addresses.filter((a: unknown) => typeof a === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)).slice(0, 8) : [];
    return { name: candidate.name, addr: p.addr, fingerprint: p.fp.slice(0, 32).match(/.{4}/g)!.join(' ').toUpperCase() };
  });

  handle('join', async (o: any) => {
    if (!candidate) fail('Enter the join code first.');
    const displayName = checkName(o?.displayName, 'Your name');
    const username = checkUsername(o?.username);
    const password = checkPassword(o?.password);
    const salt = newSalt();
    const { authKey, wrapKey } = await deriveKeys(password, salt);
    const kp = newKeyPair();
    const r = await pinnedRequest(candidate!.pin, 'POST', '/api/join', { secret: candidate!.secret, username, displayName, salt, authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, wrapKey), device: deviceName() });
    wrapKey.fill(0);
    if (r.status !== 200) fail(errMsg(r.json, 'Could not send the join request.'));
    const cp = candidate!;
    update((c) => { c.mode = 'member'; c.ws = { wid: cp.wid, name: cp.name, fp: cp.pin.fp, certPem: cp.pin.certPem, port: cp.pin.port, lastAddr: cp.pin.addr, username, knownAddrs: candidateAddrs }; c.knownKeys = {}; c.secrets = {}; });
    secrets.setPending(r.json.pendingToken);
    setKeys(kp);
    pin = cp.pin;
    candidate = null;
    startPendingPoll();
    return { pending: true };
  });

  // Existing account on a new computer (or a remote profile activated with a reset code): remember the verified host, then sign in.
  handle('useExistingAccount', () => {
    if (!candidate) fail('Enter the join code first.');
    const cp = candidate!;
    update((c) => { c.mode = 'member'; c.ws = { wid: cp.wid, name: cp.name, fp: cp.pin.fp, certPem: cp.pin.certPem, port: cp.pin.port, lastAddr: cp.pin.addr, knownAddrs: candidateAddrs }; c.knownKeys = {}; c.secrets = {}; });
    pin = cp.pin;
    candidate = null;
    return true;
  });

  handle('cancelJoin', () => { stopPendingPoll(); forgetWorkspace(); return true; });

  handle('login', async (o: any) => {
    const username = checkUsername(o?.username);
    const password = String(o?.password || '');
    if (!password) fail('Enter your password.');
    const p = await resolvePin(true);
    if (!p) fail('Could not reach the host. Make sure you are on the same Wi-Fi and the host computer is on.');
    const s = await pinnedRequest(p!, 'GET', '/api/auth/salt?u=' + encodeURIComponent(username));
    if (s.status !== 200) fail(errMsg(s.json, 'Could not start sign-in.'));
    const { authKey, wrapKey } = await deriveKeys(password, s.json.salt, s.json.kdf);
    const r = await pinnedRequest(p!, 'POST', '/api/auth/login', { username, authKey, device: deviceName() });
    if (r.status !== 200) { wrapKey.fill(0); fail(errMsg(r.json, 'Sign-in failed.')); }
    let kp: KeyPair;
    try { kp = unwrapKeyPair(r.json.encPriv, wrapKey); } catch { fail('Your encryption key could not be unlocked. Ask an admin for a reset code.'); }
    wrapKey.fill(0);
    if (load().ws?.userId && load().ws!.userId !== r.json.user.id) update((c) => { c.knownKeys = {}; });
    await finishLogin(r.json, kp!);
    return true;
  });

  handle('resetWithCode', async (o: any) => {
    const username = checkUsername(o?.username);
    const password = checkPassword(o?.password);
    const code = String(o?.code || '').trim();
    const p = await resolvePin(true);
    if (!p) fail('Could not reach the host.');
    const salt = newSalt();
    const { authKey, wrapKey } = await deriveKeys(password, salt);
    const kp = newKeyPair();
    const r = await pinnedRequest(p!, 'POST', '/api/auth/reset', { username, code, salt, authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, wrapKey), device: deviceName() });
    wrapKey.fill(0);
    if (r.status !== 200) fail(errMsg(r.json, 'Reset failed.'));
    update((c) => { c.knownKeys = {}; });
    await finishLogin(r.json, kp);
    return true;
  });

  handle('changePassword', async (o: any) => {
    const ws = load().ws; const token = secrets.getToken(); const kp = getKeys();
    if (!ws?.username || !token || !kp) fail('Please sign in again.');
    const next = checkPassword(o?.next);
    const p = await resolvePin();
    if (!p) fail('Could not reach the host.');
    const s = await pinnedRequest(p!, 'GET', '/api/auth/salt?u=' + encodeURIComponent(ws!.username!));
    const old = await deriveKeys(String(o?.current || ''), s.json.salt, s.json.kdf);
    old.wrapKey.fill(0);
    const salt = newSalt();
    const nk = await deriveKeys(next, salt);
    const r = await pinnedRequest(p!, 'POST', '/api/auth/password', { oldAuthKey: old.authKey, salt, authKey: nk.authKey, pubkey: kp!.pub, encPriv: wrapKeyPair(kp!, nk.wrapKey) }, token!);
    nk.wrapKey.fill(0);
    if (r.status !== 200) fail(errMsg(r.json, 'Could not change password.'));
    return true;
  });

  handle('session', async () => {
    const token = secrets.getToken();
    if (!token) return null;
    const p = await resolvePin();
    return { base: p ? baseUrl(p) : null, token, userId: load().ws?.userId || null };
  });
  handle('reconnect', async () => { const p = await resolvePin(true); return p ? baseUrl(p) : null; });

  handle('signedOut', () => { secrets.setToken(null); setKeys(null); send('auth', { signedIn: false }); return true; });
  handle('logout', async () => {
    const t = secrets.getToken();
    if (t && pin) { try { await pinnedRequest(pin, 'POST', '/api/auth/logout', {}, t, 4000); } catch { /* offline: local sign-out still happens */ } }
    secrets.setToken(null); setKeys(null);
    send('auth', { signedIn: false });
    return true;
  });
  handle('leaveWorkspace', async () => {
    if (load().mode === 'host') fail('This computer is the host. Stop hosting from Host settings instead.');
    forgetWorkspace();
    return true;
  });
  handle('stopHosting', async () => {
    if (load().mode !== 'host') return true;
    await host.stop();
    if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    forgetWorkspace();
    return true;
  });

  // ---- end-to-end encryption for direct messages (keys never reach the renderer) ----
  handle('encrypt', (o: any) => {
    const kp = getKeys(); if (!kp) fail('Encryption key missing. Sign in again.');
    const text = String(o?.text ?? '');
    if (text.length > LIMITS.message) fail('Message is too long.');
    return encryptText(dmKey(kp!, String(o.peerPub), String(o.convId)), text, String(o.convId));
  });
  handle('decryptMany', (items: any[]) => {
    const kp = getKeys(); if (!kp || !Array.isArray(items)) return [];
    return items.slice(0, 500).map((it) => { try { return decryptText(dmKey(kp, String(it.peerPub), String(it.convId)), String(it.body || ''), String(it.convId)); } catch { return null; } });
  });
  handle('checkPeer', (o: any) => {
    const c = load(); const kp = getKeys();
    const known = c.knownKeys[String(o.userId)];
    const pub = String(o.pub);
    if (!known) { update((cfg) => { cfg.knownKeys[String(o.userId)] = pub; }); return { status: 'new', safety: kp ? safetyNumber(kp.pub, pub) : '' }; }
    return { status: known === pub ? 'same' : 'changed', safety: kp ? safetyNumber(kp.pub, pub) : '' };
  });
  handle('trustPeer', (o: any) => { update((c) => { c.knownKeys[String(o.userId)] = String(o.pub); }); return true; });

  // ---- host admin (only on the host machine) ----
  handle('moveStorage', async () => {
    if (load().mode !== 'host') fail('Storage can only be changed on the host computer.');
    const r = await dialog.showOpenDialog(win!, { title: 'Choose the new storage folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    await host.moveStorage(r.filePaths[0]);
    return host.status.filesDir;
  });
  handle('openDataFolder', () => { const c = load(); if (c.mode === 'host' && c.host) shell.openPath(host.status.filesDir || c.host.dataDir); return true; });

  // ---- misc ----
  handle('openExternal', (url: string) => {
    let u: URL;
    try { u = new URL(String(url)); } catch { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    shell.openExternal(u.toString());
    return true;
  });
  handle('download', (o: any) => {
    if (!pin) fail('Not connected.');
    const p = String(o?.path || '');
    if (!/^\/f\/[A-Za-z0-9_.-]+$/.test(p)) fail('Invalid download.');
    pendingDownloadNames.set(p.split('/').pop()!, String(o?.name || 'download').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 180));
    win?.webContents.downloadURL(baseUrl(pin!) + p + '?dl=1');
    return true;
  });
  handle('exportTable', async (o: any) => {
    const format = o?.format === 'pdf' ? 'pdf' : 'xlsx';
    const t = validateTable(o?.table);
    const base = t.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 80) || 'export';
    let target: string | undefined;
    if (!app.isPackaged && process.env.MWB_EXPORT_DIR) target = path.join(path.resolve(process.env.MWB_EXPORT_DIR), `${base}.${format}`); // automated tests only
    else {
      const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), `${base}.${format}`), filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Excel workbook', extensions: ['xlsx'] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    const data = format === 'pdf' ? await toPdf(t, path.join(__dirname, 'logo.png')) : toXlsx(t);
    fs.writeFileSync(target!, data);
    shell.showItemInFolder(target!);
    return { path: target, bytes: data.length };
  });
  handle('netDiagnose', async () => {
    const c = load();
    const beacons = listBeacons().filter((b) => !c.ws || b.wid === c.ws.wid).length;
    return diagnose({ mode: c.mode, hostAddr: c.mode === 'member' ? (pin?.addr || c.ws?.lastAddr || null) : null, port: c.ws?.port || c.host?.port || DEFAULT_PORT, beaconsSeen: beacons, hosting: c.mode === 'host' });
  });
  handle('repairFirewall', async () => {
    if (!app.isPackaged) fail('Firewall repair is only available in the installed app.');
    const ok = await repairFirewall();
    if (!ok) fail('Firewall was not changed (the Windows permission prompt was cancelled or failed).');
    return true;
  });
  handle('micAccess', async () => {
    if (process.platform !== 'darwin') return true;
    const st = systemPreferences.getMediaAccessStatus('microphone');
    if (st === 'granted') return true;
    if (st === 'denied' || st === 'restricted') return false;
    return systemPreferences.askForMediaAccess('microphone');
  });
  handle('notify', (o: any) => {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: String(o?.title || '').slice(0, 100), body: String(o?.body || '').slice(0, 200), icon: path.join(__dirname, 'logo.png'), silent: !!o?.silent });
    n.on('click', () => { showWindow(); send('nav', o?.nav || null); });
    n.show();
    if (win && !win.isFocused()) win.flashFrame(true);
    return true;
  });
  handle('setBadge', (n: number) => { app.setBadgeCount(Math.max(0, Math.min(999, Number(n) || 0))); return true; });
  handle('setAutoStart', (v: boolean) => { setAutoStart(!!v); return true; });
  handle('setCloseToTray', (v: boolean) => { update((c) => { c.closeToTray = !!v; }); return true; });
  handle('quit', () => { quitting = true; app.quit(); return true; });
}

const pendingDownloadNames = new Map<string, string>();

function setAutoStart(v: boolean) {
  update((c) => { c.autoStart = v; });
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: v, args: ['--hidden'] });
}

function forgetWorkspace() {
  secrets.setToken(null); secrets.setPending(null); setKeys(null);
  update((c) => { c.mode = null; delete c.ws; delete c.host; c.knownKeys = {}; c.secrets = {}; });
  pin = null;
  send('auth', { signedIn: false });
}

function startPendingPoll() {
  stopPendingPoll();
  const tick = async () => {
    const pt = secrets.getPending();
    if (!pt) return stopPendingPoll();
    const p = await resolvePin();
    if (!p) return;
    try {
      const r = await pinnedRequest(p, 'POST', '/api/join/status', { pendingToken: pt }, undefined, 8000);
      if (r.json?.status === 'approved') {
        secrets.setPending(null); stopPendingPoll();
        await finishLogin(r.json, getKeys()!);
      } else if (r.json?.status === 'rejected' || r.status === 404) {
        stopPendingPoll(); forgetWorkspace(); send('rejected');
      }
    } catch { /* host offline: keep polling */ }
  };
  pendingTimer = setInterval(tick, 4000);
  tick();
}
function stopPendingPoll() { if (pendingTimer) clearInterval(pendingTimer); pendingTimer = null; }

function startHostingExtras() {
  if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  refreshTray();
}

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', showWindow);

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => { if (!url.startsWith(APP_ORIGIN + '/')) ev.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString()); } catch { /* */ }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(async () => {
  // Development runs use a separate ID so Windows never caches the generic Electron icon for the real app.
  app.setAppUserModelId(app.isPackaged ? 'com.bunnysframelab.managewithbunny' : 'com.bunnysframelab.managewithbunny.dev');
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else Menu.setApplicationMenu(null);
  // Only notifications, clipboard writes and microphone audio (voice messages) are ever granted; never camera or screen.
  const fromApp = (url: string | undefined) => !!url && url.startsWith(APP_ORIGIN + '/');
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (!fromApp(wc.getURL())) return cb(false);
    if (permission === 'media') { const types = (details as { mediaTypes?: string[] }).mediaTypes || []; return cb(types.length > 0 && types.every((t) => t === 'audio')); }
    cb(permission === 'notifications' || permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (!fromApp(origin + '/')) return false;
    if (permission === 'media') return (details as { mediaType?: string }).mediaType === 'audio';
    return permission === 'notifications' || permission === 'clipboard-sanitized-write';
  });
  session.defaultSession.on('will-download', (_e, item) => {
    const key = item.getURL().split('/').pop()!.split('?')[0];
    const name = pendingDownloadNames.get(key) || item.getFilename();
    pendingDownloadNames.delete(key);
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) });
    item.on('updated', () => send('download', { name, received: item.getReceivedBytes(), total: item.getTotalBytes(), state: 'progress' }));
    item.once('done', (_ev, state) => {
      send('download', { name, state, path: state === 'completed' ? item.getSavePath() : null });
      if (state === 'completed') shell.showItemInFolder(item.getSavePath());
    });
  });
  // Create the OS-keychain key right at launch so it is persisted long before the first sign-in.
  try { if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString('mwb-init'); } catch { /* */ }
  installCertPinning();
  registerAppProtocol();
  registerIpc();
  host.listener = (s) => { send('host', s); refreshTray(); };
  startDiscovery(() => send('hosts'));
  buildTray();
  createWindow();

  const c = load();
  if (c.mode === 'host' && c.host) {
    host.start(c.host.dataDir, c.host.port).then(() => { startHostingExtras(); resolvePin(true); }).catch(() => refreshTray());
  } else if (c.mode === 'member') {
    resolvePin(true);
    if (secrets.getPending()) startPendingPoll();
  }
  powerMonitor.on('resume', () => { pin = null; resolvePin(true); send('resume'); });
  powerMonitor.on('unlock-screen', () => send('resume'));
});

app.on('will-quit', async (e) => {
  if (host.status.running) {
    e.preventDefault();
    await host.stop();
    host.status.running = false;
    app.quit();
  }
});

export type { WorkspaceCfg };
void save;
