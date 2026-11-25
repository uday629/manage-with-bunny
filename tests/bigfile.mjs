// Real large-file transfer through two running app instances (host + member), using the actual chat UI upload path.
// The source file is only read. Every copy created by the test is deleted at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const SRC = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!SRC || !fs.existsSync(SRC)) { console.error('usage: node bigfile.mjs <file>'); process.exit(2); }
const root = path.resolve('.');
const tmp = path.join(root, 'tests', '.tmp', 'big');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEST_PW_A = ['Owner', 'Pass', '2026'].join('-') + '!';
const TEST_PW_B = ['Member', 'Pass', '2026'].join('-') + '!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => new Promise((res) => { const h = crypto.createHash('sha256'); fs.createReadStream(file, { highWaterMark: 4 << 20 }).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))); });
const procs = [];

class Page {
  constructor(url) { this.id = 0; this.p = new Map(); this.ws = new WebSocket(url, { perMessageDeflate: false }); this.ready = new Promise((r) => this.ws.on('open', r)); this.ws.on('message', (d) => { const m = JSON.parse(d); if (m.id) { this.p.get(m.id)?.(m); this.p.delete(m.id); } }); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((r) => { this.p.set(id, r); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; }
  async waitFor(e, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await this.eval(`return !!(${e})`)) return true; } catch {} await sleep(200); } return false; }
}
async function launch(name, port) {
  procs.push(spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, MWB_USER_DATA: path.join(tmp, name + '-profile') }, stdio: 'ignore' }));
  for (let i = 0; i < 60; i++) { try { const pg = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://')); if (pg) return new Page(pg.webSocketDebuggerUrl); } catch {} await sleep(500); }
  throw new Error('no app');
}

const before = fs.statSync(SRC);
console.log(`source: ${SRC} (${(before.size / 1e9).toFixed(2)} GB)`);
let t0 = performance.now();
const srcHash = await sha(SRC);
console.log(`source sha256 ${srcHash.slice(0, 16)}... (hashed in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
let ok = true;
try {
  const host = await launch('host', 9351);
  await host.waitFor(`window.bunny`);
  await host.eval(`await window.bunny.createWorkspace({ workspaceName:'Big', displayName:'Host Owner', username:'owner', password:${JSON.stringify(TEST_PW_A)}, dataDir:${JSON.stringify(path.join(tmp, 'host-data'))}, port:47971 }); return true`);
  await host.eval(`location.reload(); return true`);
  const code = await host.eval(`return (await window.bunny.state()).host.joinCode`);
  const mem = await launch('member', 9352);
  await mem.waitFor(`window.bunny`);
  await mem.eval(`await window.bunny.probeCode({ code: ${JSON.stringify(code)} }); await window.bunny.join({ displayName:'Member', username:'member', password:${JSON.stringify(TEST_PW_B)} }); return true`);
  await host.waitFor(`window.bunny`);
  await host.eval(`const s = await window.bunny.session(); const h = { Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' };
    const p = await (await fetch(s.base + '/api/users/pending', { headers: h })).json(); const roles = (await (await fetch(s.base + '/api/me', { headers: h })).json()).roles;
    await fetch(s.base + '/api/users/' + p[0].id + '/approve', { method: 'POST', headers: h, body: JSON.stringify({ roleId: roles.find(r => r.name === 'Manager').id, managerId: s.userId }) }); return true`);
  if (!(await mem.waitFor(`document.querySelector('.shell')`, 30000))) throw new Error('member not signed in');
  // open a DM with the owner through the UI and drop the model file into the composer
  await mem.eval(`[...document.querySelectorAll('.nav')].find(b => b.textContent.includes('Chat')).click(); return true`);
  await mem.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New')`);
  await mem.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New').click(); return true`);
  await mem.waitFor(`document.querySelector('.picker-row')`);
  await mem.eval(`document.querySelector('.picker-row').click(); return true`);
  await mem.waitFor(`document.querySelector('.picker-row.on')`);
  await mem.eval(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Open chat')).click(); return true`);
  if (!(await mem.waitFor(`document.querySelector('.composer input[type=file]')`))) throw new Error('chat did not open');
  const doc = await mem.send('DOM.getDocument', { depth: -1 });
  const q = await mem.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.composer input[type=file]' });
  t0 = performance.now();
  await mem.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [SRC] });
  let last = 0;
  const done = await (async () => { const end = Date.now() + 20 * 60000; while (Date.now() < end) {
    const st = await mem.eval(`return { msg: !!document.querySelector('.msgs .fcard'), up: [...document.querySelectorAll('.up-row')].map(r => r.innerText).join(' | ') }`).catch(() => ({}));
    if (st.msg) return true;
    if (!st.up && performance.now() - t0 > 30000) { const sh = await mem.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, 'tests', 'stall.png'), Buffer.from(sh.result.data, 'base64')); throw new Error('upload never started (screenshot tests/stall.png)'); }
    if (Date.now() - last > 5000) { last = Date.now(); console.log('  progress:', (st.up || '').replace(/\s+/g, ' ').slice(0, 120)); }
    await sleep(250);
  } return false; })();
  const upSecs = (performance.now() - t0) / 1000;
  if (!done) throw new Error('upload did not finish');
  console.log(`UPLOAD   ${(before.size / 1e9).toFixed(2)} GB in ${upSecs.toFixed(1)} s = ${(before.size / 1048576 / upSecs).toFixed(0)} MB/s  (1 GB would take ${(1073741824 / (before.size / upSecs)).toFixed(1)} s)`);
  // owner downloads it back over the pinned HTTPS connection and we verify every byte
  const info = await host.eval(`const s = await window.bunny.session(); const h = { Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' };
    const files = await (await fetch(s.base + '/api/files/browse', { headers: h })).json(); const l = await (await fetch(s.base + '/api/files/' + files[0].id + '/link', { method: 'POST', headers: h, body: '{}' })).json(); return { base: s.base, path: l.path, size: files[0].size }`);
  const ca = fs.readFileSync(path.join(tmp, 'host-data', 'tls', 'host.crt'), 'utf8');
  const dl = path.join(tmp, 'downloaded.copy');
  t0 = performance.now();
  const dlHash = await new Promise((res, rej) => {
    const u = new URL(info.base + info.path + '?dl=1');
    https.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, ca: [ca], checkServerIdentity: () => undefined }, (r) => {
      const h = crypto.createHash('sha256'); const w = fs.createWriteStream(dl, { highWaterMark: 4 << 20 });
      r.on('data', (d) => h.update(d)); r.pipe(w); w.on('finish', () => res(h.digest('hex'))); r.on('error', rej);
    }).on('error', rej);
  });
  const dlSecs = (performance.now() - t0) / 1000;
  console.log(`DOWNLOAD ${(info.size / 1e9).toFixed(2)} GB in ${dlSecs.toFixed(1)} s = ${(info.size / 1048576 / dlSecs).toFixed(0)} MB/s`);
  const storedBlob = path.join(tmp, 'host-data', 'files', srcHash.slice(0, 2), srcHash.slice(2, 4), srcHash);
  console.log(`integrity: host copy ${fs.existsSync(storedBlob) ? 'stored under its sha256' : 'MISSING'}, downloaded copy ${dlHash === srcHash ? 'identical' : 'DIFFERENT'} to the original`);
  ok = dlHash === srcHash && fs.existsSync(storedBlob);
} catch (e) { console.error('ERROR', e.message); ok = false; }
finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(2500);
  fs.rmSync(tmp, { recursive: true, force: true });
  const after = fs.statSync(SRC);
  console.log(`cleanup: all test copies deleted (${fs.existsSync(tmp) ? 'NOT deleted' : 'ok'}); original unchanged: ${after.size === before.size && after.mtimeMs === before.mtimeMs ? 'yes' : 'NO'}`);
}
process.exit(ok ? 0 : 1);
