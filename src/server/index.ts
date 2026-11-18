// Host server entry. Runs inside an Electron utilityProcess (isolated from the UI) or plain Node for tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { Db, newId } from './db';
import { loadOrCreateCert } from './tls';
import { initLog, log } from './log';
import { Router } from './http';
import { S, authenticate, token, settings } from './core';
import { createHub } from './realtime';
import { registerAuth, setSetupToken } from './api-auth';
import { registerUsers } from './api-users';
import { registerChat } from './api-chat';
import { registerFiles, serveFile } from './api-files';
import { registerTasks } from './api-tasks';
import { registerRecords } from './api-records';
import { registerAdmin, backupNow, joinCode } from './api-admin';
import { BEACON_MAGIC, BEACON_PORT, BEACON_GROUP } from '../shared/joincode';

interface StartCfg { dataDir: string; port: number }
type Out = (m: Record<string, unknown>) => void;

const parentPort: any = (process as any).parentPort;
const emit: Out = parentPort ? (m) => parentPort.postMessage(m) : (m) => process.stdout.write(JSON.stringify(m) + '\n');

let server: https.Server | null = null;
let hub: ReturnType<typeof createHub> | null = null;
let beacon: dgram.Socket | null = null;
let timers: NodeJS.Timeout[] = [];
let moving = false;

function setFilesDir(dir: string) {
  S.filesDir = dir;
  S.tmpDir = path.join(dir, '.tmp');
  fs.mkdirSync(S.tmpDir, { recursive: true });
}

async function start(cfg: StartCfg) {
  const dataDir = path.resolve(cfg.dataDir);
  for (const d of ['db', 'tls', 'logs', 'backups']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  initLog(path.join(dataDir, 'logs'));
  S.dataDir = dataDir;
  S.backupDir = path.join(dataDir, 'backups');
  S.db = new Db(path.join(dataDir, 'db', 'bunny.db'));
  if (!S.db.meta('wid')) S.db.setMeta('wid', newId());
  if (!S.db.meta('server_secret')) S.db.setMeta('server_secret', crypto.randomBytes(32).toString('hex'));
  if (!S.db.meta('invite_secret')) S.db.setMeta('invite_secret', crypto.randomBytes(5).toString('hex'));
  S.wid = S.db.meta('wid')!;
  S.secret = Buffer.from(S.db.meta('server_secret')!, 'hex');
  setFilesDir(S.db.meta('files_dir') || path.join(dataDir, 'files'));
  // stale partial uploads from a previous run are resumable; their in-memory hash state is not, which is handled at finish.

  const { cert, key, fp } = loadOrCreateCert(path.join(dataDir, 'tls'));
  S.fp = fp;
  S.port = cfg.port;

  const router = new Router();
  router.authenticate = (req) => authenticate(req);
  registerAuth(router); registerUsers(router); registerChat(router); registerFiles(router);
  registerTasks(router); registerRecords(router); registerAdmin(router);

  server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    if (moving && req.url?.startsWith('/api/uploads')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"busy","message":"The host is moving storage. Try again in a minute."}'); return; }
    const u = req.url || '';
    if ((req.method === 'GET' || req.method === 'HEAD') && u.startsWith('/f/')) {
      const q = u.indexOf('?');
      const tok = u.slice(3, q < 0 ? undefined : q);
      if (!/^[A-Za-z0-9_.-]{1,300}$/.test(tok)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad link'); return; }
      return void serveFile(req, res, tok, q >= 0 && /(^|&)dl=1(&|$)/.test(u.slice(q + 1)));
    }
    void router.handle(req, res);
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 15 * 60000;
  server.keepAliveTimeout = 65000;
  server.maxHeadersCount = 50;
  hub = createHub(server);
  S.hub = hub;

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(cfg.port, '0.0.0.0', () => { server!.off('error', reject); resolve(); });
  });

  startBeacon();
  // daily automatic backup
  timers.push(setInterval(() => {
    try { if (Date.now() - Number(S.db.meta('last_backup') || 0) > 24 * 3600000) backupNow('auto'); } catch (e) { log.error('auto backup failed', { err: (e as Error).message }); }
  }, 30 * 60000));
  setTimeout(() => { try { if (!S.db.meta('last_backup')) backupNow('first'); } catch { /* */ } }, 60000).unref();

  let setup: string | undefined;
  if (!S.db.get('SELECT 1 FROM users WHERE is_owner=1')) { setup = token(); setSetupToken(setup); }
  log.info('started', { port: cfg.port });
  emit({ type: 'ready', port: cfg.port, fp, wid: S.wid, name: settings().name, setupToken: setup, filesDir: S.filesDir, joinCode: joinCode(), addresses: lanAddresses() });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function broadcastAddrs(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
  }
  return [...out];
}

function startBeacon() {
  beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  beacon.on('error', (e) => log.warn('beacon error', { err: e.message }));
  beacon.bind(() => {
    beacon!.setBroadcast(true);
    try { beacon!.setMulticastTTL(1); } catch { /* */ }
    const tick = () => {
      const msg = Buffer.from(JSON.stringify({ m: BEACON_MAGIC, wid: S.wid, name: settings().name, port: S.port, fp: S.fp }));
      for (const addr of broadcastAddrs()) beacon!.send(msg, BEACON_PORT, addr, () => { /* ignore per-interface errors */ });
      for (const a of lanAddresses()) { try { beacon!.setMulticastInterface(a); beacon!.send(msg, BEACON_PORT, BEACON_GROUP, () => { /* */ }); } catch { /* interface without multicast */ } }
    };
    tick();
    timers.push(setInterval(tick, 2000));
  });
}

async function moveStorage(newDir: string) {
  if (moving) throw new Error('Already moving');
  const from = S.filesDir;
  const to = path.resolve(newDir);
  if (to === from) return;
  if (to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) throw new Error('Pick a folder that is not inside the current storage folder.');
  moving = true;
  try {
    fs.mkdirSync(to, { recursive: true });
    const blobs = S.db.all<{ sha: string; size: number }>('SELECT sha, size FROM blobs');
    const total = blobs.reduce((a, b) => a + b.size, 0) || 1;
    let done = 0;
    for (const b of blobs) {
      const src = path.join(from, b.sha.slice(0, 2), b.sha.slice(2, 4), b.sha);
      const dst = path.join(to, b.sha.slice(0, 2), b.sha.slice(2, 4), b.sha);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
      }
      done += b.size;
      emit({ type: 'move-progress', pct: Math.round((done / total) * 100) });
    }
    S.db.setMeta('files_dir', to);
    setFilesDir(to);
    // only delete originals after the new location is recorded
    for (const b of blobs) fs.rmSync(path.join(from, b.sha.slice(0, 2), b.sha.slice(2, 4), b.sha), { force: true });
    log.info('storage moved');
  } finally { moving = false; }
}

async function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  try { beacon?.close(); } catch { /* */ }
  hub?.close();
  await new Promise<void>((r) => { if (!server) return r(); server.close(() => r()); server.closeAllConnections?.(); });
  try { S.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); S.db.close(); } catch { /* */ }
}

process.on('uncaughtException', (e) => { log.error('uncaught', { err: e.message, stack: e.stack?.split('\n').slice(0, 5).join(' | ') }); });
process.on('unhandledRejection', (e) => { log.error('unhandledRejection', { err: String(e) }); });

if (parentPort) {
  parentPort.on('message', async (ev: any) => {
    const m = ev?.data ?? ev;
    try {
      if (m.type === 'start') await start(m.cfg);
      else if (m.type === 'move-storage') { await moveStorage(String(m.dir)); emit({ type: 'moved', filesDir: S.filesDir }); }
      else if (m.type === 'stop') { await stop(); emit({ type: 'stopped' }); process.exit(0); }
    } catch (e) {
      emit({ type: 'error', op: m.type, message: (e as Error).message, code: (e as any).code });
    }
  });
} else {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  start({ dataDir: get('--data') || './data', port: Number(get('--port') || 47821) }).catch((e) => { emit({ type: 'error', message: e.message }); process.exit(1); });
  process.on('SIGINT', async () => { await stop(); process.exit(0); });
}
