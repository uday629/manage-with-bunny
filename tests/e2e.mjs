// UI end-to-end test: runs a real host app and a real member app side by side (dev build), drives
// them through the Chrome DevTools Protocol, and saves screenshots of every screen.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const root = path.resolve('.');
const tmp = path.join(root, 'tests', '.tmp', 'e2e');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'shots'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'exports'), { recursive: true });
const docs = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(docs, { recursive: true });
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const results = [];
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else fail++; results.push(`${c ? 'PASS' : 'FAIL'} ${n}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(name, port) {
  const p = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], { cwd: root, env: { ...process.env, MWB_USER_DATA: path.join(tmp, name + '-profile'), MWB_EXPORT_DIR: path.join(tmp, 'exports'), ELECTRON_ENABLE_LOGGING: '0' }, stdio: 'ignore' });
  return p;
}

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://bunny'));
      if (page) { const pg = new Page(page.webSocketDebuggerUrl); pages.push(pg); return pg; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('devtools not reachable on ' + port);
}

class Page {
  constructor(url) { this.id = 0; this.pending = new Map(); this.ws = new WebSocket(url, { perMessageDeflate: false }); this.ready = new Promise((r) => this.ws.on('open', r)); this.ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((r) => { this.pending.set(id, r); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  async shot(name, doc) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(tmp, 'shots', name + '.png'), Buffer.from(r.result.data, 'base64'));
    if (doc) fs.writeFileSync(path.join(docs, doc + '.png'), Buffer.from(r.result.data, 'base64'));
  }
  async waitFor(expr, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await this.eval(`return !!(${expr})`)) return true; } catch { /* */ } await sleep(250); }
    return false;
  }
  async click(text, sel = 'button') { return this.eval(`const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim().includes(${JSON.stringify(text)})); if(!el) throw new Error('no ${sel} with text ${text}'); el.click(); return true;`); }
  async type(selector, value) {
    return this.eval(`const el=document.querySelector(${JSON.stringify(selector)}); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  }
  async nav(label) { await this.click(label, '.nav'); await sleep(900); }
  async resize(w, h) { await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
}

const procs = [];
const pages = [];
const _connect = connect;
try {
  procs.push(launch('host', 9333));
  const host = await connect(9333);
  await host.resize(1440, 900);
  await host.waitFor(`document.querySelector('.choice')`);
  await sleep(600);
  await host.shot('01-welcome', 'welcome');
  ok(await host.eval(`return document.body.innerText.includes('Host a workspace') && document.body.innerText.includes('Join a team')`), 'welcome screen');

  // Host setup through the real form
  await host.click('Host a workspace');
  await host.waitFor(`document.querySelector('input[placeholder="Bunnys Framelab Studio"]')`);
  await host.type('input[placeholder="Bunnys Framelab Studio"]', 'Bunny Video Agency');
  await host.type('input[placeholder="Full name"]', 'Bunny Owner');
  await host.type('input[placeholder="e.g. bunny"]', 'owner');
  const pw = await host.eval(`return [...document.querySelectorAll('input[type=password]')].length`);
  ok(pw === 2, 'password + confirm fields');
  await host.eval(`const [a,b]=document.querySelectorAll('input[type=password]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(a,'REDACTED'); a.dispatchEvent(new Event('input',{bubbles:true})); set.call(b,'REDACTED'); b.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  await host.click('Advanced');
  await sleep(200);
  await host.eval(`const inputs=[...document.querySelectorAll('.field input')]; const dir=inputs.find(i=>i.value.includes('Manage with Bunny Data')); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(dir, ${JSON.stringify(path.join(tmp, 'host-data'))}); dir.dispatchEvent(new Event('input',{bubbles:true})); const port=inputs.at(-1); set.call(port,'47931'); port.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  await host.shot('02-host-setup', 'host-setup');
  await host.click('Create workspace');
  ok(await host.waitFor(`document.querySelector('.shell')`, 60000), 'workspace created and owner signed in');
  await sleep(1500);
  await host.shot('03-home-host');
  const joinCode = await host.eval(`return (await window.bunny.state()).host.joinCode`);
  ok(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(joinCode), 'join code shown: ' + joinCode);
  ok(await host.eval(`return document.querySelector('.conn').textContent.includes('Connected')`), 'host realtime connected');

  // Member app joins with the code
  procs.push(launch('member', 9334));
  const mem = await connect(9334);
  await mem.resize(1440, 900);
  await mem.waitFor(`document.querySelector('.choice')`);
  await mem.click('Join a team');
  await mem.waitFor(`document.querySelector('input.code')`);
  await mem.type('input.code', joinCode);
  await mem.click('Find workspace');
  ok(await mem.waitFor(`document.body.innerText.includes('Verified secure identity')`, 30000), 'member found host via LAN discovery + fingerprint check');
  await mem.shot('04-join-found', 'join-found');
  await mem.eval(`const f=[...document.querySelectorAll('.form-row input')]; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(f[0],'Rafi Editor'); f[0].dispatchEvent(new Event('input',{bubbles:true})); set.call(f[1],'rafi'); f[1].dispatchEvent(new Event('input',{bubbles:true})); const [a,b]=document.querySelectorAll('input[type=password]'); set.call(a,'REDACTED'); a.dispatchEvent(new Event('input',{bubbles:true})); set.call(b,'REDACTED'); b.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  await mem.click('Request to join');
  ok(await mem.waitFor(`document.body.innerText.includes('Waiting for')`, 30000), 'member waiting for approval');
  await mem.shot('05-pending', 'pending');

  // Host approves via Admin UI
  ok(await host.waitFor(`document.querySelector('.nav .badge')`, 15000), 'host sees pending badge in realtime');
  await host.nav('Admin');
  await host.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve')`);
  await host.shot('06-admin-pending');
  await host.click('Approve');
  await host.waitFor(`document.querySelector('.modal')`);
  await host.eval(`const s=document.querySelector('.modal select'); const opt=[...s.options].find(o=>o.text==='Employee'); s.value=opt.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Approve')).click(); return true;`);
  ok(await mem.waitFor(`document.querySelector('.shell')`, 30000), 'member auto-signed-in after approval');
  await sleep(1500);
  await host.shot('07-admin-members');
  await mem.shot('08-home-member');

  // Member DMs the owner (end-to-end encrypted)
  await mem.nav('Chat');
  await mem.click('New');
  await mem.waitFor(`document.querySelector('.picker-row')`);
  await mem.eval(`document.querySelector('.picker-row').click(); return true;`);
  await mem.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Open chat')).click(); return true;`);
  await mem.waitFor(`document.querySelector('.composer textarea')`);
  await mem.type('.composer textarea', 'Hi boss, the XYZ reel is ready for review. https://example.com/reel');
  await mem.eval(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true;`);
  ok(await mem.waitFor(`document.querySelector('.msgs').innerText.includes('XYZ reel is ready')`, 10000), 'member sees own DM');
  await host.nav('Chat');
  await host.waitFor(`document.querySelector('.conv')`);
  await host.eval(`document.querySelector('.conv').click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.msgs') && document.querySelector('.msgs').innerText.includes('XYZ reel is ready')`, 10000), 'owner receives + decrypts DM in realtime');
  ok(await host.eval(`return document.body.innerText.includes('End-to-end encrypted')`), 'DM marked end-to-end encrypted');
  await host.type('.composer textarea', 'Great work Rafi! Approving now.');
  await host.eval(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true;`);
  ok(await mem.waitFor(`document.querySelector('.msgs').innerText.includes('Approving now')`, 10000), 'reply delivered realtime');
  ok(await host.waitFor(`document.querySelector('.seen-line') && document.querySelector('.seen-line').textContent.includes('Seen')`, 10000), 'seen indicator shows when the other person read it');
  ok(await host.eval(`return document.querySelectorAll('.tick.seen').length >= 1`), 'blue double tick on seen messages');
  // voice message with a simulated microphone
  await mem.eval(`document.querySelector('[aria-label="Record voice message"]').click(); return true;`);
  ok(await mem.waitFor(`document.querySelector('.recording')`, 8000), 'voice recorder opens');
  await sleep(2600);
  await mem.eval(`[...document.querySelectorAll('.recording button')].find(b=>b.textContent.includes('Send voice')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.msgs .voice')`, 20000), 'voice message delivered and playable');
  await sleep(600);
  await host.shot('09b-voice', 'voice');
  ok(await host.eval(`const a=document.querySelector('.msgs .voice audio'); return !!a && a.src.startsWith('https://')`), 'voice audio streams from host');
  // search: find the first DM and jump to it
  await host.type('.conv-col input', 'XYZ reel');
  ok(await host.waitFor(`document.querySelector('.search-results .conv.hit')`, 15000), 'message search finds encrypted DM (on-device)');
  await sleep(300);
  await host.shot('09c-search', 'search');
  await host.eval(`document.querySelector('.search-results .conv.hit').click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.msg.flash')`, 8000), 'search result jumps to the message');

  // File transfer: member sends a 30 MB "video" over the LAN
  const big = path.join(tmp, 'reel-final.mp4');
  const buf = Buffer.alloc(30 * 1024 * 1024 + 7);
  buf.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
  for (let i = 32; i < buf.length; i += 4096) buf[i] = i % 251;
  fs.writeFileSync(big, buf);
  const doc = await mem.send('DOM.getDocument', { depth: -1 });
  const q = await mem.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.composer input[type=file]' });
  const t0 = Date.now();
  await mem.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [big] });
  ok(await mem.waitFor(`document.querySelectorAll('.msgs .media video, .msgs .fcard').length > 0`, 60000), 'video uploaded and posted in chat');
  const secs = (Date.now() - t0) / 1000;
  results.push(`INFO 30 MB upload + post took ${secs.toFixed(1)} s (${(30 / secs).toFixed(0)} MB/s)`);
  ok(await host.waitFor(`document.querySelectorAll('.msgs .media video, .msgs .fcard').length > 0`, 15000), 'owner sees the file in realtime');
  await sleep(1500);
  await mem.shot('09-chat-member');
  await host.shot('10-chat-host', 'chat');

  // Tasks: owner assigns, member submits, owner approves
  await host.nav('Tasks');
  await host.click('New task');
  await host.waitFor(`document.querySelector('.modal input')`);
  await host.type('.modal input', 'Edit XYZ client reel, 60s vertical');
  await host.type('.modal textarea', 'Use the brand colours. Deliver 1080x1920.');
  await host.eval(`const s=[...document.querySelectorAll('.modal select')][0]; const opt=[...s.options].find(o=>o.text.startsWith('Rafi')); s.value=opt.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Assign task')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.drawer')`, 10000), 'task created, drawer open');
  await host.eval(`document.querySelector('.drawer-back').click(); return true;`);
  await sleep(500);
  await mem.nav('Tasks');
  ok(await mem.waitFor(`document.querySelector('.tcard')`, 10000), 'member sees assigned task');
  await mem.eval(`document.querySelector('.tcard').click(); return true;`);
  await mem.waitFor(`document.querySelector('.drawer textarea')`);
  await mem.type('.drawer textarea', 'Done, final export attached.');
  await mem.click('Submit for review');
  await sleep(1200);
  await mem.shot('11-task-member');
  await host.nav('Home');
  ok(await host.waitFor(`document.body.innerText.includes('Edit XYZ client reel')`, 10000), 'owner sees submission in review queue');
  await host.nav('Tasks');
  await host.click('Assigned by me');
  await host.waitFor(`document.querySelector('.tcard')`);
  await sleep(400);
  await host.shot('11b-tasks', 'tasks');
  await host.click('Excel', '.toolbar button');
  await host.click('PDF', '.toolbar button');
  const exp = path.join(tmp, 'exports');
  for (let i = 0; i < 40 && fs.readdirSync(exp).length < 2; i++) await sleep(250);
  const xlsx = fs.readdirSync(exp).find((f) => f.endsWith('.xlsx'));
  const pdf = fs.readdirSync(exp).find((f) => f.endsWith('.pdf'));
  ok(xlsx && fs.readFileSync(path.join(exp, xlsx)).subarray(0, 2).toString() === 'PK', 'Excel export written (' + xlsx + ')');
  ok(pdf && fs.readFileSync(path.join(exp, pdf)).subarray(0, 5).toString() === '%PDF-', 'PDF export written (' + pdf + ')');
  await host.nav('Tasks');
  await host.click('Assigned by me');
  await host.waitFor(`document.querySelector('.tcard')`);
  await host.eval(`document.querySelector('.tcard').click(); return true;`);
  await host.waitFor(`[...document.querySelectorAll('.drawer button')].some(b=>b.textContent.includes('Approve'))`);
  await host.click('Approve', '.drawer button');
  ok(await host.waitFor(`document.querySelector('.drawer .pill') && document.querySelector('.drawer .pill').textContent.includes('Done')`, 10000), 'owner approves task');
  await host.shot('12-task-host', 'task');
  await host.eval(`document.querySelector('.drawer-back').click(); return true;`);

  // Other screens
  await host.nav('Team chart'); await host.waitFor(`document.querySelector('.node')`); await sleep(500); await host.shot('13-team');
  ok(await host.eval(`return document.querySelectorAll('.node').length === 2`), 'org chart shows owner -> employee');
  await host.nav('Files'); await host.waitFor(`document.querySelector('.ftile')`); await sleep(500); await host.shot('14-files', 'files');
  ok(await host.eval(`return document.querySelectorAll('.ftile').length >= 1`), 'files page lists uploads');
  await host.nav('Records'); await host.click('New sheet'); await host.waitFor(`document.querySelector('.modal')`);
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Create')).click(); return true;`);
  await host.waitFor(`document.querySelector('table.t')`);
  await host.click('Add row'); await sleep(800); await host.shot('15-records', 'records');
  ok(await host.eval(`return document.querySelectorAll('table.t tbody tr').length >= 1`), 'record sheet with row');
  await host.nav('Performance'); await sleep(1200); await host.shot('16-analytics');
  ok(await host.eval(`return document.body.innerText.includes('Rafi Editor')`), 'analytics lists member');
  await host.nav('Admin'); await host.click('Roles'); await sleep(800); await host.shot('17-roles', 'roles');
  await host.click('Storage'); await sleep(1200); await host.shot('18-storage', 'storage');
  ok(await host.eval(`return document.body.innerText.includes('Saved by de-duplication')`), 'storage admin page');
  await host.click('Security log'); await sleep(800); await host.shot('19-audit');
  await host.click('Workspace'); await sleep(800); await host.shot('20-workspace');
  await host.eval(`document.querySelector('.me-btn').click(); return true;`); await sleep(800); await host.shot('21-settings', 'settings');

  // Remote profile: teammate off the Wi-Fi, kept up to date by a caretaker
  await host.nav('Admin');
  await host.click('Members', '.tab');
  await host.click('Add remote profile');
  await host.waitFor(`document.querySelector('input[placeholder="e.g. Sara Ahmed"]')`);
  await host.type('input[placeholder="e.g. Sara Ahmed"]', 'Sara Remote');
  await host.type('input[placeholder="e.g. Remote Video Editor"]', 'Remote Video Editor');
  await host.shot('23-add-remote');
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Add profile')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('table.t') && document.querySelector('table.t').innerText.includes('Sara Remote') && document.querySelector('table.t').innerText.includes('Remote')`, 10000), 'remote profile created from admin UI');
  await host.shot('24-members-remote', 'members');
  await host.nav('Tasks');
  await host.click('New task');
  await host.waitFor(`document.querySelector('.modal input')`);
  await host.type('.modal input', 'Color grade Sara\'s wedding film');
  await host.eval(`const s=[...document.querySelectorAll('.modal select')][0]; const opt=[...s.options].find(o=>o.text.includes('(remote)')); s.value=opt.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Assign task')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.drawer') && document.querySelector('.drawer').innerText.includes('works remotely')`, 10000), 'caretaker sees act-on-behalf notice');
  await host.type('.drawer textarea', 'Sara sent the graded file via Drive.');
  await host.eval(`[...document.querySelectorAll('.drawer button')].find(b=>b.textContent.includes('Mark done for Sara')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.drawer').innerText.includes('for Sara Remote')`, 10000), 'history shows work done on behalf of remote member');
  await host.shot('25-task-on-behalf', 'remote-task');
  await host.eval(`document.querySelector('.drawer-back').click(); return true;`);
  await host.nav('Home');
  ok(await host.waitFor(`document.body.innerText.includes('Remote teammates you keep updated')`, 10000), 'caretaker home card');
  await host.click('Add update');
  await host.waitFor(`document.querySelector('.modal textarea')`);
  await host.type('.modal textarea', 'Finished 2 reels and the wedding teaser. Shared drafts by email.');
  await host.type('.modal input[type=number]', '7');
  await host.eval(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.includes('Add update')).click(); return true;`);
  ok(await host.waitFor(`document.querySelector('.modal').innerText.includes('7 h logged')`, 10000), 'work log entry saved');
  await host.shot('26-worklog', 'worklog');
  await host.eval(`document.querySelector('.modal-head button').click(); return true;`);
  await host.nav('Team chart'); await host.waitFor(`document.querySelectorAll('.node').length === 3`); await sleep(400); await host.shot('27-team-remote', 'team');
  ok(await host.eval(`return document.querySelector('.org-wrap').innerText.includes('Remote')`), 'org chart marks remote profile');
  await host.nav('Performance'); await sleep(1200); await host.shot('28-analytics-remote', 'analytics');
  await host.nav('Home'); await sleep(1200); await host.shot('29-home', 'home');
  await host.eval(`document.querySelector('.me-btn').click(); return true;`);
  await host.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Check')`);
  await host.click('Check');
  ok(await host.waitFor(`document.querySelector('.finding')`, 20000), 'network check runs and explains the network');
  await sleep(300); await host.shot('30-netcheck', 'netcheck');
  await host.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.includes('Done')).click(); return true;`);
  await host.nav('Performance'); await sleep(1200);
  const perfRow = await host.eval(`const r=[...document.querySelectorAll('table.t tbody tr')].find(x=>x.innerText.includes('Sara Remote')); return r ? r.innerText.replace(/\s+/g,' ') : ''`);
  ok(/Sara Remote/.test(perfRow) && /7\s*h/.test(perfRow), 'remote work counted in performance (' + perfRow + ')');

  // Resilience: kill the member app, restart it, it must reconnect to the same workspace by itself.
  procs[1].kill(); await sleep(1500);
  procs[1] = launch('member', 9335);
  const mem2 = await connect(9335);
  ok(await mem2.waitFor(`document.querySelector('.conn') && document.querySelector('.conn').textContent.includes('Connected')`, 30000), 'member app restart reconnects automatically');
  // Host restart: stop host app and start again; member must come back online.
  procs[0].kill(); await sleep(2000);
  ok(await mem2.waitFor(`document.querySelector('.offline-bar')`, 30000), 'member shows reconnecting when host goes away');
  procs[0] = launch('host', 9336);
  const host2 = await connect(9336);
  ok(await host2.waitFor(`document.querySelector('.shell')`, 40000), 'host app restart: server back + owner session restored');
  ok(await mem2.waitFor(`!document.querySelector('.offline-bar') && document.querySelector('.conn').textContent.includes('Connected')`, 45000), 'member reconnects to restarted host automatically');
  await mem2.nav('Chat'); await mem2.waitFor(`document.querySelector('.conv')`); await mem2.eval(`document.querySelector('.conv').click(); return true;`);
  ok(await mem2.waitFor(`document.querySelector('.msgs').innerText.includes('Approving now')`, 10000), 'history intact + decryptable after restarts');
  await sleep(600);
  await mem2.shot('22-member-after-restart');
} catch (e) {
  results.push('ERROR ' + (e.stack || e.message));
  fail++;
  for (let i = 0; i < pages.length; i++) { try { await pages[i].shot('error-' + i); } catch { /* */ } }
} finally {
  for (const p of procs) { try { p.kill(); } catch { /* */ } }
}
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${path.join(tmp, 'shots')}`);
await sleep(1000);
process.exit(fail ? 1 : 0);
