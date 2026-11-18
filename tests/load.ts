// Load + data-volume tests against a real host process.
//   node load.cjs users    -> 15 people using the app at the same time (each from its own loopback IP)
//   node load.cjs months   -> 12 months of seeded team data, then API latency measurements
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { deriveKeys, newKeyPair, newSalt, wrapKeyPair, dmKey, encryptText } from '../src/main/keys';
import { decodeJoinCode } from '../src/shared/joincode';
import { Db, newId } from '../src/server/db';
import { argon2id } from 'hash-wasm';

const MODE = process.argv[2] || 'users';
const PORT = 47961;
const root = process.env.MWB_TEST_TMP || os.tmpdir();
const dataDir = fs.mkdtempSync(path.join(root, `mwb-load-${MODE}-`));
let CA = '';
const agentFor = new Map<string, https.Agent>();
function agent(local: string) { let a = agentFor.get(local); if (!a) { a = new https.Agent({ keepAlive: true, maxSockets: 6, ca: [CA], checkServerIdentity: () => undefined, localAddress: local } as any); agentFor.set(local, a); } return a; }

function req(method: string, p: string, body?: unknown, token?: string, local = '127.0.0.1', raw?: Buffer): Promise<{ status: number; json: any; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let data: Buffer | undefined = raw;
    if (raw) headers['Content-Type'] = 'application/octet-stream';
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; }
    if (data) headers['Content-Length'] = String(data.length);
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = https.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, agent: agent(local) }, (res) => {
      const ch: Buffer[] = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { let json: any = null; try { json = JSON.parse(Buffer.concat(ch).toString()); } catch { /* */ } resolve({ status: res.statusCode!, json, ms: performance.now() - t0 }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (a: number[]) => `n=${a.length} p50=${pct(a, 50).toFixed(1)}ms p95=${pct(a, 95).toFixed(1)}ms p99=${pct(a, 99).toFixed(1)}ms max=${Math.max(0, ...a).toFixed(1)}ms`;
function rssMB(pid: number) {
  try { const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }); const m = /"([\d,.]+) K"/.exec(out); return m ? Math.round(Number(m[1].replace(/[,.]/g, '')) / 1024) : 0; } catch { return 0; }
}
function startServer(): Promise<{ proc: ChildProcess; ready: any; startMs: number }> {
  const t0 = performance.now();
  const proc = spawn(process.execPath, [path.resolve('dist/server.cjs'), '--data', dataDir, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => { let b = ''; proc.stdout!.on('data', (d) => { b += d; const l = b.split('\n').find((x) => x.includes('"ready"')); if (l) res({ proc, ready: JSON.parse(l), startMs: performance.now() - t0 }); }); });
}

async function setupOwner(ready: any) {
  CA = fs.readFileSync(path.join(dataDir, 'tls', 'host.crt'), 'utf8');
  const salt = newSalt(); const k = await deriveKeys('Owner-Password-1', salt); const kp = newKeyPair();
  const s = await req('POST', '/api/setup/owner', { setupToken: ready.setupToken, workspaceName: 'Load', username: 'owner', displayName: 'Owner', salt, authKey: k.authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, k.wrapKey) });
  return { token: s.json.token as string, id: s.json.user.id as string, kp, roles: s.json.roles as any[] };
}

// ------------------------------------------------------------------ 15 concurrent users
async function users() {
  const { proc, ready } = await startServer();
  const owner = await setupOwner(ready);
  const secret = decodeJoinCode(ready.joinCode)!.secret;
  const N = 15;
  const people: { id: string; token: string; kp: ReturnType<typeof newKeyPair>; ip: string; ws?: WebSocket }[] = [];
  const emp = owner.roles.find((r) => r.name === 'Manager').id;
  for (let i = 0; i < N; i++) {
    const ip = `127.0.0.${10 + i}`;
    const salt = newSalt(); const k = await deriveKeys('Member-Password-1', salt); const kp = newKeyPair();
    const j = await req('POST', '/api/join', { secret, username: 'user' + i, displayName: 'User ' + i, salt, authKey: k.authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, k.wrapKey) }, undefined, ip);
    await req('POST', `/api/users/${j.json.userId}/approve`, { roleId: emp, managerId: owner.id }, owner.token);
    const st = await req('POST', '/api/join/status', { pendingToken: j.json.pendingToken }, undefined, ip);
    people.push({ id: j.json.userId, token: st.json.token, kp, ip });
  }
  const group = await req('POST', '/api/convs/group', { name: 'Whole team', memberIds: people.map((p) => p.id) }, owner.token);
  const gid = group.json.id;
  // realtime sockets
  const sentAt = new Map<string, number>();
  const deliveries: number[] = [];
  let received = 0;
  await Promise.all(people.map((p) => new Promise<void>((res) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { ca: [CA], checkServerIdentity: () => undefined, localAddress: p.ip } as any);
    p.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: p.token })));
    ws.on('message', (d) => {
      const ev = JSON.parse(d.toString());
      if (ev.t === 'ready') res();
      if (ev.t === 'msg' && ev.msg.senderId !== p.id && ev.msg.clientId && sentAt.has(ev.msg.clientId)) { received++; deliveries.push(Date.now() - sentAt.get(ev.msg.clientId)!); }
    });
  })));
  const lat: Record<string, number[]> = {};
  let errors = 0, total = 0;
  const call = async (label: string, method: string, p: string, body: unknown, who: (typeof people)[number], raw?: Buffer) => {
    total++;
    try { const r = await req(method, p, body, who.token, who.ip, raw); (lat[label] ||= []).push(r.ms); if (r.status >= 400) { errors++; if (errors < 5) console.log('ERR', label, r.status, r.json?.message); } return r; } catch (e) { errors++; return null; }
  };
  const DURATION = 60000;
  const tEnd = Date.now() + DURATION;
  const rss: number[] = [];
  const memTimer = setInterval(() => rss.push(rssMB(proc.pid!)), 2000);
  // 5 people upload a 40 MB video each while everyone chats
  const uploadTimes: number[] = [];
  const uploads = people.slice(0, 5).map(async (p, i) => {
    const data = crypto.randomBytes(40 * 1024 * 1024);
    const t0 = performance.now();
    const init = await call('upload init', 'POST', '/api/uploads', { name: `video-${i}.mp4`, size: data.length, scope: 'conv', scopeId: gid }, p);
    let off = 0;
    while (off < data.length) { const r = await call('upload chunk 16MB', 'PUT', `/api/uploads/${init!.json.id}?offset=${off}`, undefined, p, data.subarray(off, off + init!.json.chunk)); off = r!.json.received; }
    await call('upload finish', 'POST', `/api/uploads/${init!.json.id}/finish`, {}, p);
    uploadTimes.push(performance.now() - t0);
  });
  const workers = people.map(async (p, i) => {
    let n = 0;
    while (Date.now() < tEnd) {
      n++;
      const clientId = crypto.randomBytes(9).toString('base64url');
      sentAt.set(clientId, Date.now());
      await call('send group message', 'POST', `/api/convs/${gid}/messages`, { body: `hello from ${i} #${n} ${'x'.repeat(40)}`, clientId }, p);
      if (n % 3 === 0) {
        const other = people[(i + 1) % N];
        const dm = await call('open DM', 'POST', '/api/convs/dm', { userId: other.id }, p);
        if (dm?.json?.id) await call('send DM (encrypted)', 'POST', `/api/convs/${dm.json.id}/messages`, { body: encryptText(dmKey(p.kp, other.kp.pub, dm.json.id), 'private hi ' + n, dm.json.id), e2e: true }, p);
      }
      if (n % 4 === 0) await call('list conversations', 'GET', '/api/convs', undefined, p);
      if (n % 4 === 1) await call('load 60 messages', 'GET', `/api/convs/${gid}/messages?limit=60`, undefined, p);
      if (n % 5 === 0) await call('dashboard', 'GET', '/api/dashboard', undefined, p);
      if (n % 6 === 0) await call('tasks list', 'GET', '/api/tasks?view=mine', undefined, p);
      if (n % 6 === 3) { const t = await call('create task', 'POST', '/api/tasks', { title: 'task ' + n, assigneeId: p.id }, p); if (t?.json?.id) await call('task action', 'POST', `/api/tasks/${t.json.id}/action`, { action: 'submit' }, p); }
      if (n % 7 === 0) await call('search', 'GET', '/api/search?q=hello', undefined, p);
      if (n % 8 === 0) p.ws!.send(JSON.stringify({ t: 'typing', convId: gid }));
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 1300));
    }
  });
  await Promise.all([...workers, ...uploads]);
  await new Promise((r) => setTimeout(r, 1500));
  clearInterval(memTimer);
  const expected = [...sentAt.keys()].length * (N - 1); // each group message must reach the 14 other members (DMs not counted)
  console.log(`\n=== ${N} concurrent users, ${DURATION / 1000}s, plus 5 x 40 MB uploads at the same time ===`);
  console.log(`requests: ${total}, errors: ${errors} (${((errors / total) * 100).toFixed(2)}%)`);
  for (const [k, v] of Object.entries(lat).sort()) console.log(`${k.padEnd(22)} ${fmt(v)}`);
  console.log(`${'realtime delivery'.padEnd(22)} ${fmt(deliveries)}  (${received}/${expected} group deliveries)`);
  console.log(`uploads (40 MB each, 5 at once while chatting): ${uploadTimes.map((t) => (t / 1000).toFixed(1) + 's').join(', ')}`);
  console.log(`host memory: start ${rss[0]} MB, peak ${Math.max(...rss)} MB, end ${rss.at(-1)} MB`);
  people.forEach((p) => p.ws?.close());
  proc.kill();
  return errors === 0 && received >= expected * 0.999;
}

// ------------------------------------------------------------------ 12 months of data
async function months() {
  let { proc, ready } = await startServer();
  const owner = await setupOwner(ready);
  proc.kill(); await new Promise((r) => setTimeout(r, 800));
  console.log('seeding 12 months of data...');
  const t0 = performance.now();
  const db = new Db(path.join(dataDir, 'db', 'bunny.db'));
  const now = Date.now(), YEAR = 365 * 86400000;
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const authHash = await argon2id({ password: Buffer.alloc(32, 1), salt: crypto.randomBytes(16), parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
  const roleEmp = owner.roles.find((r) => r.name === 'Employee').id, roleMgr = owner.roles.find((r) => r.name === 'Manager').id;
  const U = 40;
  const ids: string[] = [owner.id];
  db.tx(() => {
    for (let i = 0; i < U; i++) {
      const id = newId(); const mgr = i < 5 ? owner.id : ids[1 + rnd(5)];
      db.run(`INSERT INTO users(id,username,display_name,title,role_id,manager_id,status,is_owner,kdf_salt,auth_hash,pubkey,enc_priv,color,created_at,approved_at) VALUES(?,?,?,?,?,?,'active',0,?,?,?,?,?,?,?)`,
        id, 'user' + i, 'Person ' + i, i < 5 ? 'Manager' : 'Editor', i < 5 ? roleMgr : roleEmp, mgr, newSalt(), authHash, newKeyPair().pub, 'x'.repeat(80), '#1F6BFF', now - YEAR, now - YEAR);
      ids.push(id);
    }
  });
  const convs: { id: string; members: string[]; dm: boolean }[] = [];
  db.tx(() => {
    for (let g = 0; g < 30; g++) {
      const id = newId(); const members = [owner.id, ...ids.slice(1).filter(() => Math.random() < 0.4)];
      db.run(`INSERT INTO conversations(id,type,name,created_by,created_at,last_msg_at) VALUES(?,'group',?,?,?,?)`, id, 'Group ' + g, owner.id, now - YEAR, now);
      for (const m of members) db.run('INSERT INTO conv_members(conv_id,user_id,joined_at) VALUES(?,?,?)', id, m, now - YEAR);
      convs.push({ id, members, dm: false });
    }
    for (let d = 0; d < 200; d++) {
      const a = ids[rnd(ids.length)], b = ids[rnd(ids.length)]; if (a === b) continue;
      const key = [a, b].sort().join(':'); if (db.get('SELECT 1 FROM conversations WHERE dm_key=?', key)) continue;
      const id = newId();
      db.run(`INSERT INTO conversations(id,type,dm_key,created_by,created_at,last_msg_at) VALUES(?,'dm',?,?,?,?)`, id, key, a, now - YEAR, now);
      for (const m of [a, b]) db.run('INSERT INTO conv_members(conv_id,user_id,joined_at) VALUES(?,?,?)', id, m, now - YEAR);
      convs.push({ id, members: [a, b], dm: true });
    }
  });
  const words = 'video edit client reel final draft color grade export render thumbnail script voiceover approved revision deadline brand logo ভিডিও এডিট ক্লায়েন্ট রিল ফাইনাল'.split(' ');
  const MSG = 300000;
  db.tx(() => {
    for (let i = 0; i < MSG; i++) {
      const c = convs[rnd(convs.length)]; const t = now - YEAR + Math.floor((i / MSG) * YEAR);
      const body = c.dm ? 'e1:' + crypto.randomBytes(48).toString('base64') : Array.from({ length: 4 + rnd(12) }, () => words[rnd(words.length)]).join(' ');
      db.run('INSERT INTO messages(conv_id,sender_id,kind,body,e2e,created_at) VALUES(?,?,?,?,?,?)', c.id, c.members[rnd(c.members.length)], 'text', body, c.dm ? 1 : 0, t);
    }
    for (const c of convs) db.run('UPDATE conv_members SET last_read_id=(SELECT IFNULL(MAX(id),0)-5 FROM messages WHERE conv_id=?) WHERE conv_id=?', c.id, c.id);
  });
  const statuses = ['done', 'done', 'done', 'done', 'in_progress', 'todo', 'submitted', 'changes', 'cancelled'];
  db.tx(() => {
    for (let i = 0; i < 25000; i++) {
      const id = newId(); const created = now - rnd(YEAR); const st = statuses[rnd(statuses.length)];
      const assignee = ids[1 + rnd(U)]; const done = st === 'done' ? created + rnd(10 * 86400000) : null;
      db.run(`INSERT INTO tasks(id,title,description,links,assigner_id,assignee_id,status,priority,due_at,created_at,updated_at,completed_at,revisions) VALUES(?,?,?,'[]',?,?,?,'normal',?,?,?,?,?)`,
        id, 'Task ' + i + ' ' + words[rnd(words.length)], 'details '.repeat(10), ids[rnd(6)], assignee, st, created + 5 * 86400000, created, done || created, done, rnd(3));
      for (let e = 0; e < 4; e++) db.run('INSERT INTO task_events(task_id,user_id,type,note,created_at) VALUES(?,?,?,?,?)', id, assignee, e === 0 ? 'created' : 'comment', 'note ' + e, created + e * 3600000);
    }
    for (let i = 0; i < 15000; i++) { const d = new Date(now - rnd(YEAR)); db.run('INSERT INTO worklog(id,user_id,author_id,day,hours,note,links,created_at) VALUES(?,?,?,?,?,?,\'[]\',?)', newId(), ids[1 + rnd(U)], owner.id, d.toISOString().slice(0, 10), 1 + rnd(8), 'did things', d.getTime()); }
    db.run('INSERT OR IGNORE INTO blobs(sha,size,created_at) VALUES(?,?,?)', 'f'.repeat(64), 1000, now);
    for (let i = 0; i < 20000; i++) { const c = convs[rnd(convs.length)]; const id = newId(); db.run(`INSERT INTO files(id,sha,name,ext,size,mime,uploader_id,scope,scope_id,group_id,version,created_at) VALUES(?,?,?,'mp4',?,'video/mp4',?,'conv',?,?,1,?)`, id, 'f'.repeat(64), `clip-${i}.mp4`, 1000 + rnd(1e9), c.members[0], c.id, id, now - rnd(YEAR)); }
    for (let i = 0; i < 50000; i++) db.run('INSERT INTO audit(at,actor_id,action,target,detail,ip) VALUES(?,?,?,?,?,?)', now - rnd(YEAR), ids[rnd(ids.length)], 'login.ok', '', '', '192.168.0.' + rnd(255));
  });
  db.raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
  db.close();
  const dbSize = fs.statSync(path.join(dataDir, 'db', 'bunny.db')).size;
  console.log(`seeded in ${((performance.now() - t0) / 1000).toFixed(0)}s: ${U + 1} people, ${convs.length} chats, ${MSG} messages, 25,000 tasks (100,000 events), 15,000 work-log entries, 20,000 files, 50,000 audit rows. DB ${(dbSize / 1048576).toFixed(0)} MB`);
  ({ proc, ready } = await startServer().then((r) => { console.log(`host start time with this data: ${r.startMs.toFixed(0)} ms`); return r; }));
  const emp = { token: '', id: ids[10] };
  // sign in a regular employee too (password hash seeded from a fixed authKey)
  const s = await req('POST', '/api/auth/login', { username: 'user9', authKey: Buffer.alloc(32, 1).toString('base64') });
  emp.token = s.json?.token;
  if (s.status !== 200) console.log('employee login failed:', s.status, s.json);
  const busiest = convs.filter((c) => !c.dm)[0].id;
  const month = new Date(now - 60 * 86400000).toISOString().slice(0, 7);
  const eps: [string, string, string][] = [
    ['me', '/api/me', owner.token], ['users', '/api/users', owner.token], ['org chart', '/api/org', owner.token],
    ['conversation list', '/api/convs', owner.token], ['60 messages', `/api/convs/${busiest}/messages?limit=60`, owner.token],
    ['older page', `/api/convs/${busiest}/messages?limit=60&before=150000`, owner.token], ['search 3+ chars', '/api/search?q=thumbnail', owner.token],
    ['search Bengali', '/api/search?q=' + encodeURIComponent('ক্লায়েন্ট'), owner.token], ['search 2 chars', '/api/search?q=re', owner.token],
    ['tasks: everything', '/api/tasks?view=all', owner.token], ['tasks: one month', `/api/tasks?view=all&month=${month}`, owner.token],
    ['tasks: mine (employee)', '/api/tasks?view=mine', emp.token], ['dashboard', '/api/dashboard', owner.token],
    ['analytics month (41 ppl)', `/api/analytics?month=${month}`, owner.token], ['analytics 12-month person', `/api/analytics/user/${ids[12]}?months=12`, owner.token],
    ['work log month', `/api/users/${ids[12]}/worklog?month=${month}`, owner.token], ['files browse', '/api/files/browse', owner.token],
    ['storage report', '/api/admin/storage', owner.token], ['audit log', '/api/admin/audit', owner.token], ['conv list (employee)', '/api/convs', emp.token],
  ];
  const rows: { name: string; ms: number[]; status: number }[] = [];
  for (const [name, p, tok] of eps) {
    const ms: number[] = []; let status = 0;
    for (let i = 0; i < 6; i++) { const r = await req('GET', p, undefined, tok); ms.push(r.ms); status = r.status; }
    rows.push({ name, ms: ms.slice(1), status });
  }
  console.log('\n=== API latency with 12 months of data (median of 5 warm calls) ===');
  for (const r of rows) console.log(`${r.name.padEnd(28)} ${String(r.status).padEnd(4)} ${pct(r.ms, 50).toFixed(1).padStart(8)} ms`);
  proc.kill();
  return rows.every((r) => r.status === 200);
}

(async () => {
  let ok = false;
  try { ok = MODE === 'months' ? await months() : await users(); } catch (e) { console.error(e); }
  await new Promise((r) => setTimeout(r, 600));
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
