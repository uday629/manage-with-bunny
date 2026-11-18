// End-to-end tests against a real host server process: auth, RBAC, IDOR, E2E DMs, uploads, tasks, abuse cases.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { deriveKeys, newKeyPair, newSalt, wrapKeyPair, unwrapKeyPair, dmKey, encryptText, decryptText, type KeyPair } from '../src/main/keys';
import { decodeJoinCode } from '../src/shared/joincode';

const PORT = 47901;
const dataDir = fs.mkdtempSync(path.join(process.env.MWB_TEST_TMP || os.tmpdir(), 'mwb-test-'));
let pass = 0, fail = 0;
const results: string[] = [];
function ok(cond: unknown, name: string) { if (cond) { pass++; results.push('PASS ' + name); } else { fail++; results.push('FAIL ' + name); } }

let CA = '';
function req(method: string, p: string, body?: unknown, tokenOrHeaders?: string | Record<string, string>, raw?: Buffer): Promise<{ status: number; json: any; buf: Buffer; headers: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = typeof tokenOrHeaders === 'object' ? { ...tokenOrHeaders } : {};
    if (typeof tokenOrHeaders === 'string') headers.Authorization = 'Bearer ' + tokenOrHeaders;
    let data: Buffer | undefined;
    if (raw) { data = raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; }
    if (data) headers['Content-Length'] = String(data.length);
    const r = https.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, ca: [CA], checkServerIdentity: () => undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json: any = null; try { json = JSON.parse(buf.toString()); } catch { /* */ } resolve({ status: res.statusCode!, json, buf, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

interface Acct { token: string; id: string; kp: KeyPair; username: string }
async function creds(password: string) {
  const salt = newSalt();
  const { authKey, wrapKey } = await deriveKeys(password, salt);
  const kp = newKeyPair();
  return { salt, authKey, pubkey: kp.pub, encPriv: wrapKeyPair(kp, wrapKey), kp };
}
async function join(secret: string, username: string, displayName: string, password: string) {
  const c = await creds(password);
  const r = await req('POST', '/api/join', { secret, username, displayName, salt: c.salt, authKey: c.authKey, pubkey: c.pubkey, encPriv: c.encPriv, device: 'test' });
  return { r, kp: c.kp };
}
async function login(username: string, password: string) {
  const s = await req('GET', '/api/auth/salt?u=' + username);
  const { authKey, wrapKey } = await deriveKeys(password, s.json.salt, s.json.kdf);
  const r = await req('POST', '/api/auth/login', { username, authKey, device: 'test' });
  return { r, wrapKey };
}

async function main() {
  const proc = spawn(process.execPath, [path.resolve('dist/server.cjs'), '--data', dataDir, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready: any = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; const line = buf.split('\n').find((l) => l.includes('"ready"')); if (line) resolve(JSON.parse(line)); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
  CA = fs.readFileSync(path.join(dataDir, 'tls', 'host.crt'), 'utf8');
  const hostFp = new crypto.X509Certificate(CA).fingerprint256.replace(/:/g, '').toLowerCase();
  ok(ready.fp === hostFp, 'ready reports real cert fingerprint');
  const jc = decodeJoinCode(ready.joinCode)!;
  ok(hostFp.startsWith(jc.fpPrefix), 'join code embeds certificate fingerprint prefix');

  try {
    const hello = await req('GET', '/api/hello');
    ok(hello.status === 200 && hello.json.setup === true, 'hello before setup');
    ok(hello.headers['x-content-type-options'] === 'nosniff' && hello.headers['x-frame-options'] === 'DENY', 'security headers present');

    // ---- owner setup ----
    const oc = await creds('owner-password-123');
    const badSetup = await req('POST', '/api/setup/owner', { setupToken: 'nope', workspaceName: 'Agency', username: 'boss', displayName: 'Boss', salt: oc.salt, authKey: oc.authKey, pubkey: oc.pubkey, encPriv: oc.encPriv });
    ok(badSetup.status === 403, 'setup rejects wrong setup token');
    const setup = await req('POST', '/api/setup/owner', { setupToken: ready.setupToken, workspaceName: 'Agency', username: 'boss', displayName: 'Boss', salt: oc.salt, authKey: oc.authKey, pubkey: oc.pubkey, encPriv: oc.encPriv, device: 'host' });
    ok(setup.status === 200 && setup.json.token, 'owner setup succeeds');
    const owner: Acct = { token: setup.json.token, id: setup.json.user.id, kp: oc.kp, username: 'boss' };
    const again = await req('POST', '/api/setup/owner', { setupToken: ready.setupToken, workspaceName: 'X', username: 'evil', displayName: 'E', salt: oc.salt, authKey: oc.authKey, pubkey: oc.pubkey, encPriv: oc.encPriv });
    ok(again.status === 403, 'setup token is single-use');
    const roles = setup.json.roles as any[];
    const roleId = (n: string) => roles.find((r) => r.name === n).id;

    // ---- origin / auth checks ----
    ok((await req('GET', '/api/me', undefined, { Origin: 'https://evil.example', Authorization: 'Bearer ' + owner.token })).status === 403, 'foreign Origin rejected');
    ok((await req('GET', '/api/me', undefined, { Origin: 'app://bunny', Authorization: 'Bearer ' + owner.token })).status === 200, 'app Origin accepted');
    ok((await req('GET', '/api/me')).status === 401, 'no token -> 401');
    ok((await req('GET', '/api/me', undefined, 'x'.repeat(43))).status === 401, 'forged token -> 401');
    const unk = await req('GET', '/api/auth/salt?u=nobody');
    const unk2 = await req('GET', '/api/auth/salt?u=nobody');
    ok(unk.status === 200 && unk.json.salt === unk2.json.salt, 'unknown user gets stable fake salt (no enumeration)');

    // ---- join flow ----
    const wrong = await join('0000000000', 'mia', 'Mia', 'mia-password-123');
    ok(wrong.r.status === 403, 'join with wrong secret rejected');
    const jm = await join(jc.secret, 'mia', 'Mia Manager', 'mia-password-123');
    const je = await join(jc.secret, 'eli', 'Eli Editor', 'eli-password-123');
    const jz = await join(jc.secret, 'zed', 'Zed Sales', 'zed-password-123');
    const jh = await join(jc.secret, 'hana', 'Hana HR', 'hana-password-123');
    ok(jm.r.status === 200 && je.r.status === 200, 'join requests accepted');
    ok((await join(jc.secret, 'mia', 'Dup', 'whatever-123456')).r.status === 409, 'duplicate username rejected');
    const pendLogin = await login('eli', 'eli-password-123');
    ok(pendLogin.r.status === 403 && pendLogin.r.json.error === 'pending', 'pending user cannot log in');
    ok((await req('POST', '/api/join/status', { pendingToken: jm.r.json.pendingToken })).json.status === 'pending', 'status pending');

    const approve = (uid: string, role: string, mgr: string | null, tok = owner.token) => req('POST', `/api/users/${uid}/approve`, { roleId: roleId(role), managerId: mgr, title: role }, tok);
    ok((await approve(jm.r.json.userId, 'Manager', owner.id)).status === 200, 'owner approves manager');
    const st = await req('POST', '/api/join/status', { pendingToken: jm.r.json.pendingToken });
    ok(st.json.status === 'approved' && st.json.token, 'approved status returns session');
    ok((await req('POST', '/api/join/status', { pendingToken: jm.r.json.pendingToken })).status === 404, 'pending token is one-time');
    const mia: Acct = { token: st.json.token, id: jm.r.json.userId, kp: jm.kp, username: 'mia' };
    await approve(je.r.json.userId, 'Employee', mia.id, mia.token);
    await approve(jz.r.json.userId, 'Employee', owner.id);
    await approve(jh.r.json.userId, 'HR', owner.id);
    const eli: Acct = { token: (await req('POST', '/api/join/status', { pendingToken: je.r.json.pendingToken })).json.token, id: je.r.json.userId, kp: je.kp, username: 'eli' };
    const zed: Acct = { token: (await req('POST', '/api/join/status', { pendingToken: jz.r.json.pendingToken })).json.token, id: jz.r.json.userId, kp: jz.kp, username: 'zed' };
    const hana: Acct = { token: (await req('POST', '/api/join/status', { pendingToken: jh.r.json.pendingToken })).json.token, id: jh.r.json.userId, kp: jh.kp, username: 'hana' };
    ok(eli.token && zed.token && hana.token, 'all members approved');

    // login and key unwrap on a "new device"
    const li = await login('eli', 'eli-password-123');
    ok(li.r.status === 200 && unwrapKeyPair(li.r.json.encPriv, li.wrapKey).pub === eli.kp.pub, 'login + private key unwrap with password-derived key');
    ok((await login('eli', 'wrong-password-xx')).r.status === 401, 'wrong password rejected');

    // ---- RBAC / privilege escalation ----
    ok((await req('GET', '/api/users/pending', undefined, eli.token)).status === 403, 'employee cannot list join requests');
    ok((await req('PATCH', `/api/users/${eli.id}`, { roleId: roleId('Owner') }, eli.token)).status === 403, 'employee cannot change own role');
    ok((await req('POST', '/api/roles', { name: 'God', perms: ['users.manage'] }, eli.token)).status === 403, 'employee cannot create roles');
    ok((await req('PATCH', `/api/users/${zed.id}`, { roleId: roleId('Manager') }, hana.token)).status === 403, 'HR cannot grant Manager role with perms HR lacks');
    ok((await req('PATCH', `/api/users/${owner.id}`, { status: 'disabled' }, hana.token)).status === 403, 'HR cannot disable owner');
    ok((await req('PATCH', `/api/users/${hana.id}`, { roleId: roleId('Manager') }, hana.token)).status === 403, 'HR cannot change own role');
    ok((await req('PATCH', `/api/users/${zed.id}`, { title: 'Sales Lead' }, hana.token)).status === 200, 'HR can edit employee title');
    ok((await req('PATCH', `/api/users/${mia.id}`, { managerId: eli.id }, owner.token)).status === 400, 'reporting-chain cycle prevented');
    ok((await req('PATCH', `/api/roles/${roleId('Owner')}`, { name: 'Owner', perms: [] }, owner.token)).status === 403, 'owner role immutable');
    const lr = await req('POST', '/api/roles', { name: 'Lead Generator', rank: 30, perms: ['chat.create_groups', 'not.a.perm'] }, owner.token);
    ok(lr.status === 200, 'owner creates custom role (unknown perms dropped)');

    // ---- directory scoping ----
    const eliDir = (await req('GET', '/api/users', undefined, eli.token)).json.map((u: any) => u.id);
    ok(eliDir.includes(mia.id) && !eliDir.includes(zed.id), 'employee directory limited to own chain');

    // ---- DMs (end-to-end encrypted) ----
    ok((await req('POST', '/api/convs/dm', { userId: zed.id }, eli.token)).status === 403, 'employee cannot DM outside team chain');
    const dm = await req('POST', '/api/convs/dm', { userId: mia.id }, eli.token);
    ok(dm.status === 200, 'employee can DM own manager');
    const convId = dm.json.id;
    ok((await req('POST', `/api/convs/${convId}/messages`, { body: 'plain secret', e2e: false }, eli.token)).status === 400, 'plaintext DM rejected');
    const k1 = dmKey(eli.kp, mia.kp.pub, convId);
    const sent = await req('POST', `/api/convs/${convId}/messages`, { body: encryptText(k1, 'hello boss, confidential', convId), e2e: true, clientId: 'abcdefgh1234' }, eli.token);
    ok(sent.status === 200, 'encrypted DM sent');
    const dupSend = await req('POST', `/api/convs/${convId}/messages`, { body: encryptText(k1, 'hello boss, confidential', convId), e2e: true, clientId: 'abcdefgh1234' }, eli.token);
    ok(dupSend.json.id === sent.json.id, 'retry with same clientId is idempotent');
    const got = await req('GET', `/api/convs/${convId}/messages`, undefined, mia.token);
    const k2 = dmKey(mia.kp, eli.kp.pub, convId);
    ok(got.json.messages.length === 1 && decryptText(k2, got.json.messages[0].body, convId) === 'hello boss, confidential', 'recipient decrypts DM');
    const dbText = fs.readFileSync(path.join(dataDir, 'db', 'bunny.db-wal')).toString('latin1') + fs.readFileSync(path.join(dataDir, 'db', 'bunny.db')).toString('latin1');
    ok(!dbText.includes('hello boss, confidential'), 'DM plaintext never stored on host disk');
    ok((await req('GET', `/api/convs/${convId}/messages`, undefined, owner.token)).status === 404, 'owner cannot read others\' DMs (IDOR)');
    ok((await req('GET', `/api/convs/${convId}/messages`, undefined, zed.token)).status === 404, 'outsider cannot read DM');
    ok((await req('PATCH', `/api/messages/${sent.json.id}`, { body: encryptText(k2, 'forged', convId) }, mia.token)).status === 404, 'cannot edit someone else\'s message');

    // ---- groups ----
    const grp = await req('POST', '/api/convs/group', { name: 'Edit Team', memberIds: [eli.id] }, mia.token);
    ok(grp.status === 200, 'manager creates group');
    ok((await req('POST', '/api/convs/group', { name: 'x', memberIds: [] }, zed.token)).status === 403, 'employee without perm cannot create group');
    const gid = grp.json.id;
    const inj = "'; DROP TABLE users; -- <img src=x onerror=alert(1)>";
    const gm = await req('POST', `/api/convs/${gid}/messages`, { body: inj }, eli.token);
    ok(gm.status === 200 && gm.json.body === inj, 'SQL/HTML payload stored verbatim (parameterised, rendered as text)');
    ok((await req('GET', '/api/users', undefined, owner.token)).status === 200, 'users table intact after injection attempt');
    ok((await req('GET', `/api/convs/${gid}/messages`, undefined, zed.token)).status === 404, 'non-member cannot read group');
    ok((await req('PATCH', `/api/convs/${gid}`, { addIds: [zed.id] }, eli.token)).status === 403, 'non-admin member cannot add people');

    // ---- websocket ----
    const wsEvents: any[] = [];
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { ca: [CA], checkServerIdentity: () => undefined } as any);
    await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
    ws.on('message', (d) => wsEvents.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: 'auth', token: mia.token }));
    await new Promise((r) => setTimeout(r, 300));
    await req('POST', `/api/convs/${gid}/messages`, { body: 'live update' }, eli.token);
    await new Promise((r) => setTimeout(r, 300));
    ok(wsEvents.some((e) => e.t === 'ready') && wsEvents.some((e) => e.t === 'msg' && e.msg.body === 'live update'), 'websocket auth + realtime delivery');
    const badWs = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { ca: [CA], checkServerIdentity: () => undefined, origin: 'https://evil.example' } as any);
    const badRes = await new Promise((r) => { badWs.on('open', () => r('open')); badWs.on('error', () => r('rejected')); badWs.on('unexpected-response', () => r('rejected')); });
    ok(badRes === 'rejected', 'websocket rejects foreign Origin');
    ws.close();

    // ---- search ----
    const sr = await req('GET', '/api/search?q=' + encodeURIComponent('live upd'), undefined, mia.token);
    ok(sr.status === 200 && sr.json.messages.some((m: any) => m.body === 'live update'), 'full-text search finds group message');
    ok((await req('GET', '/api/search?q=li', undefined, mia.token)).json.messages.length >= 1, 'short (2 char) search works');
    ok((await req('GET', '/api/search?q=' + encodeURIComponent('live upd'), undefined, zed.token)).json.messages.length === 0, 'search never returns chats you are not in');
    ok((await req('GET', '/api/search?q=' + encodeURIComponent('hello boss'), undefined, eli.token)).json.messages.length === 0, 'encrypted DMs are not searchable on the host');
    ok((await req('GET', '/api/search?q=' + encodeURIComponent('"* OR NEAR( %_' + String.fromCharCode(92)), undefined, mia.token)).status === 200, 'search input with FTS/LIKE operators is safe');
    const ar = await req('GET', `/api/convs/${gid}/messages?around=${gm.json.id}&limit=10`, undefined, mia.token);
    ok(ar.status === 200 && ar.json.messages.some((m: any) => m.id === gm.json.id), 'jump-to-message (around) works');
    ok((await req('GET', `/api/convs/${gid}/messages?around=${gm.json.id}`, undefined, zed.token)).status === 404, 'around respects membership');

    // ---- uploads ----
    const big = crypto.randomBytes(20 * 1024 * 1024 + 123);
    async function upload(tok: string, name: string, data: Buffer, scope = 'conv', scopeId = gid) {
      const init = await req('POST', '/api/uploads', { name, size: data.length, scope, scopeId }, tok);
      if (init.status !== 200) return init;
      let off = 0;
      while (off < data.length) {
        const part = data.subarray(off, off + init.json.chunk);
        const put = await req('PUT', `/api/uploads/${init.json.id}?offset=${off}`, undefined, tok, part);
        if (put.status !== 200) return put;
        off = put.json.received;
      }
      return req('POST', `/api/uploads/${init.json.id}/finish`, {}, tok);
    }
    const up1 = await upload(eli.token, 'cut v1.mp4', big);
    ok(up1.status === 200 && up1.json.size === big.length, 'chunked upload of 20 MB');
    const up2 = await upload(eli.token, 'copy.mp4', big);
    const up3 = await upload(eli.token, 'cut v1.mp4', Buffer.concat([big.subarray(0, 1000), Buffer.from('changed')]));
    ok(up3.json.version === 2 && up3.json.groupId === up1.json.groupId, 'same name -> new version');
    const blobDirs = fs.readdirSync(path.join(dataDir, 'files')).filter((d) => d !== '.tmp');
    const blobCount = blobDirs.reduce((a, d) => a + fs.readdirSync(path.join(dataDir, 'files', d)).reduce((b, e) => b + fs.readdirSync(path.join(dataDir, 'files', d, e)).length, 0), 0);
    ok(up2.status === 200 && blobCount === 2, 'identical content stored once (dedup)');
    const voice = Buffer.concat([Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d', 'hex'), crypto.randomBytes(3000)]);
    const vu = await upload(eli.token, 'voice-1700000000000-4s.weba', voice);
    ok(vu.status === 200 && vu.json.mime === 'audio/webm', 'voice message stored as audio/webm');
    const vlink = await req('POST', `/api/files/${vu.json.id}/link`, {}, eli.token);
    const vget = await req('GET', vlink.json.path, undefined, { Range: 'bytes=0-99' });
    ok(vget.status === 206 && vget.headers['content-type'] === 'audio/webm', 'voice message streams inline');
    const exe = await req('POST', '/api/uploads', { name: 'tool.exe', size: 10, scope: 'conv', scopeId: gid }, eli.token);
    ok(exe.status === 403, 'executable upload blocked');
    const trav = await upload(eli.token, '../../..\\evil.txt', Buffer.from('x'));
    ok(trav.status === 200 && !trav.json.name.includes('/') && !trav.json.name.includes('\\') && !trav.json.name.startsWith('.'), 'path traversal in filename neutralised');
    ok((await req('POST', '/api/uploads', { name: 'a.txt', size: 1, scope: 'conv', scopeId: convId }, zed.token)).status === 404, 'cannot upload into a chat you are not in');
    // resumable: wrong offset is rejected with current position
    const ri = await req('POST', '/api/uploads', { name: 'r.bin', size: 100, scope: 'conv', scopeId: gid }, eli.token);
    const wrongOff = await req('PUT', `/api/uploads/${ri.json.id}?offset=50`, undefined, eli.token, Buffer.alloc(50));
    ok(wrongOff.status === 409 && wrongOff.json.received === 0, 'resume protocol reports server offset');
    ok((await req('PUT', `/api/uploads/${ri.json.id}?offset=0`, undefined, zed.token, Buffer.alloc(10))).status === 404, 'cannot write into another user\'s upload');

    const link = await req('POST', `/api/files/${up1.json.id}/link`, {}, eli.token);
    const rng = await req('GET', link.json.path, undefined, { Range: 'bytes=100-199' });
    ok(rng.status === 206 && rng.buf.equals(big.subarray(100, 200)), 'range streaming via signed URL');
    const full = await req('GET', link.json.path + '?dl=1');
    ok(full.status === 200 && crypto.createHash('sha256').update(full.buf).digest('hex') === crypto.createHash('sha256').update(big).digest('hex'), 'full download integrity');
    ok(full.headers['content-type'] === 'application/octet-stream' && String(full.headers['content-disposition']).startsWith('attachment'), 'download forces attachment');
    ok((await req('POST', `/api/files/${up1.json.id}/link`, {}, zed.token)).status === 404, 'outsider cannot get file link (IDOR)');
    const tampered = link.json.path.slice(0, -3) + (link.json.path.endsWith('AAA') ? 'BBB' : 'AAA');
    ok((await req('GET', tampered)).status === 403, 'tampered signed URL rejected');

    // ---- tasks ----
    const t1 = await req('POST', '/api/tasks', { title: 'Edit client XYZ video', assigneeId: eli.id, dueAt: Date.now() + 86400000, links: ['https://example.com/brief'] }, mia.token);
    ok(t1.status === 200, 'manager assigns task to report');
    ok((await req('POST', '/api/tasks', { title: 'x', assigneeId: zed.id }, eli.token)).status === 403, 'employee cannot assign outside subtree');
    ok((await req('POST', '/api/tasks', { title: 'x', assigneeId: eli.id, links: ['javascript:alert(1)'] }, mia.token)).status === 400, 'javascript: links rejected');
    ok((await req('GET', `/api/tasks/${t1.json.id}`, undefined, zed.token)).status === 404, 'unrelated employee cannot see task');
    ok((await req('GET', `/api/tasks/${t1.json.id}`, undefined, owner.token)).status === 200, 'owner (ancestor) sees task');
    ok((await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'approve' }, eli.token)).status === 403, 'assignee cannot approve own work');
    await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'start' }, eli.token);
    const tf = await upload(eli.token, 'final.mp4', crypto.randomBytes(5000), 'task', t1.json.id);
    const sub = await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'submit', note: 'done', fileIds: [tf.json.id] }, eli.token);
    ok(sub.json.status === 'submitted', 'assignee submits with file');
    ok((await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'request_changes' }, mia.token)).status === 400, 'request changes requires a note');
    await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'request_changes', note: 'fix colour' }, mia.token);
    await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'submit', note: 'v2' }, eli.token);
    const ap = await req('POST', `/api/tasks/${t1.json.id}/action`, { action: 'approve' }, mia.token);
    ok(ap.json.status === 'done' && ap.json.revisions === 1, 'review cycle + approval tracked');
    const sub2 = await req('POST', '/api/tasks', { title: 'Sub', assigneeId: eli.id, parentId: t1.json.id }, mia.token);
    ok(sub2.status === 200 && sub2.json.parentId === t1.json.id, 'delegated subtask linked to parent');

    // ---- analytics / reviews ----
    const an = await req('GET', '/api/analytics', undefined, mia.token);
    const eliStats = an.json.people.find((p: any) => p.userId === eli.id);
    ok(eliStats && eliStats.completed === 1 && eliStats.onTime === 1, 'analytics counts completed on-time task');
    const ea = await req('GET', '/api/analytics', undefined, eli.token);
    ok(ea.json.people.length === 1 && ea.json.people[0].userId === eli.id, 'employee analytics scoped to self');
    ok((await req('GET', `/api/analytics/user/${mia.id}`, undefined, eli.token)).status === 404, 'employee cannot see manager analytics');
    const month = an.json.month;
    ok((await req('PUT', `/api/reviews/${eli.id}/${month}`, { rating: 5, note: 'great' }, mia.token)).status === 200, 'manager reviews report');
    ok((await req('PUT', `/api/reviews/${mia.id}/${month}`, { rating: 1 }, eli.token)).status === 403, 'employee cannot review manager');

    // ---- records ----
    const sh = await req('POST', '/api/sheets', { title: 'Who got what', columns: [{ name: 'Person', type: 'text' }, { name: 'Link', type: 'link' }] }, mia.token);
    ok(sh.status === 200, 'private sheet created');
    ok((await req('GET', `/api/sheets/${sh.json.id}`, undefined, owner.token)).status === 404, 'owner cannot open manager\'s private sheet');
    const col = sh.json.columns[1].id;
    ok((await req('POST', `/api/sheets/${sh.json.id}/rows`, { data: { [col]: 'javascript:alert(1)' } }, mia.token)).status === 400, 'sheet link column rejects javascript:');
    await req('PUT', `/api/sheets/${sh.json.id}/shares`, { shares: [{ userId: eli.id, canEdit: false }] }, mia.token);
    ok((await req('GET', `/api/sheets/${sh.json.id}`, undefined, eli.token)).status === 200, 'shared sheet readable');
    ok((await req('POST', `/api/sheets/${sh.json.id}/rows`, { data: {} }, eli.token)).status === 403, 'view-only share cannot edit');

    // ---- remote profiles (off-Wi-Fi members kept up to date by a caretaker) ----
    ok((await req('POST', '/api/users/remote', { displayName: 'Sara Remote', roleId: roleId('Employee') }, eli.token)).status === 403, 'employee cannot create remote profiles');
    const rp = await req('POST', '/api/users/remote', { displayName: 'Sara Remote', title: 'Remote Editor', roleId: roleId('Employee'), managerId: mia.id, caretakerId: mia.id, remoteNote: 'Works from Sylhet' }, owner.token);
    ok(rp.status === 200 && rp.json.isRemote && rp.json.caretakerId === mia.id, 'owner creates remote profile with caretaker');
    const sara = rp.json;
    ok((await req('POST', '/api/users/remote', { displayName: 'X', roleId: roleId('Owner') }, owner.token)).status === 403, 'remote profile cannot get Owner role');
    ok((await req('POST', '/api/users/remote', { displayName: 'X', roleId: roleId('Employee'), caretakerId: sara.id }, owner.token)).status === 400, 'remote profile cannot be a caretaker');
    const sl = await login(sara.username, 'anything-at-all-1');
    ok(sl.r.status === 401 || sl.r.status === 403, 'remote profile cannot sign in');
    ok((await req('POST', '/api/convs/dm', { userId: sara.id }, mia.token)).status === 403, 'cannot DM a remote profile');
    ok((await req('PATCH', `/api/convs/${gid}`, { addIds: [sara.id] }, mia.token)).status === 400, 'cannot add remote profile to a group');
    const rt = await req('POST', '/api/tasks', { title: 'Remote edit job', assigneeId: sara.id }, owner.token);
    ok(rt.status === 200, 'task assigned to remote profile');
    ok((await req('GET', `/api/tasks/${rt.json.id}`, undefined, mia.token)).json.actingFor === sara.id, 'caretaker can act for remote profile');
    ok((await req('POST', `/api/tasks/${rt.json.id}/action`, { action: 'submit', note: 'Sara sent it by email' }, zed.token)).status === 404, 'unrelated member cannot touch remote task');
    const rs1 = await req('POST', `/api/tasks/${rt.json.id}/action`, { action: 'submit', note: 'Sara sent it by email' }, mia.token);
    ok(rs1.status === 200 && rs1.json.status === 'submitted', 'caretaker submits on behalf');
    const rdet = await req('GET', `/api/tasks/${rt.json.id}`, undefined, owner.token);
    ok(rdet.json.events.some((e: any) => e.type === 'submit' && e.userId === mia.id && e.onBehalfOf === sara.id), 'history records who acted on whose behalf');
    ok((await req('POST', `/api/tasks/${rt.json.id}/action`, { action: 'approve' }, owner.token)).json.status === 'done', 'assigner approves remote work');
    ok((await req('POST', `/api/users/${sara.id}/worklog`, { day: '2026-11-17', hours: 6, note: 'Cut 3 reels' }, zed.token)).status === 403, 'outsider cannot write work log');
    ok((await req('POST', `/api/users/${sara.id}/worklog`, { day: '2026-11-17', hours: 6.5, note: 'Cut 3 reels', links: ['javascript:alert(1)'] }, mia.token)).status === 400, 'work log rejects bad links');
    ok((await req('POST', `/api/users/${sara.id}/worklog`, { day: '2026-13-01', note: 'x' }, mia.token)).status === 400, 'work log rejects bad date');
    const today = new Date(); const dstr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ok((await req('POST', `/api/users/${sara.id}/worklog`, { day: dstr, hours: 6.5, note: 'Cut 3 reels', links: ['https://drive.example.com/x'] }, mia.token)).status === 200, 'caretaker adds work log');
    ok((await req('GET', `/api/users/${sara.id}/worklog`, undefined, eli.token)).status === 404, 'peer cannot read remote work log');
    const wl = await req('GET', `/api/users/${sara.id}/worklog`, undefined, owner.token);
    ok(wl.status === 200 && wl.json.entries.length === 1 && wl.json.entries[0].hours === 6.5, 'owner reads work log');
    const an2 = await req('GET', '/api/analytics', undefined, owner.token);
    const sp = an2.json.people.find((p: any) => p.userId === sara.id);
    ok(sp && sp.completed === 1 && sp.loggedHours === 6.5, 'remote work counts in team analytics');
    const dash = await req('GET', '/api/dashboard', undefined, mia.token);
    ok(dash.json.remote.some((r: any) => r.userId === sara.id), 'caretaker dashboard lists remote profile');
    ok((await req('PATCH', `/api/users/${sara.id}`, { caretakerId: zed.id }, hana.token)).status === 200, 'HR can reassign caretaker');
    ok((await req('GET', `/api/tasks/${rt.json.id}`, undefined, mia.token)).status === 200, 'manager (ancestor) still sees remote tasks');
    const src = await req('POST', `/api/users/${sara.id}/reset-code`, {}, owner.token);
    const sc = await creds('sara-real-password-1');
    const act = await req('POST', '/api/auth/reset', { username: sara.username, code: src.json.code, salt: sc.salt, authKey: sc.authKey, pubkey: sc.pubkey, encPriv: sc.encPriv });
    ok(act.status === 200 && act.json.user.isRemote === false, 'remote profile activated into a real account with a reset code');
    ok((await login(sara.username, 'sara-real-password-1')).r.status === 200, 'activated account signs in');

    // ---- admin / storage ----
    ok((await req('GET', '/api/admin/storage', undefined, eli.token)).status === 403, 'employee blocked from storage admin');
    const stg = await req('GET', '/api/admin/storage', undefined, owner.token);
    ok(stg.status === 200 && stg.json.duplicates.length >= 1 && stg.json.savedByDedup >= big.length, 'storage report shows duplicates + dedup savings');
    const cl = await req('POST', '/api/admin/cleanup', { action: 'old_versions' }, owner.token);
    ok(cl.status === 200 && cl.json.marked >= 1, 'cleanup old versions');
    const bk = await req('POST', '/api/admin/backup', {}, owner.token);
    ok(bk.status === 200 && fs.existsSync(path.join(dataDir, 'backups', bk.json.name)), 'database backup written');
    ok((await req('GET', '/api/admin/audit', undefined, owner.token)).json.some((a: any) => a.action === 'join.approved'), 'audit log records approvals');

    // ---- reset code + sessions ----
    const rc = await req('POST', `/api/users/${zed.id}/reset-code`, {}, owner.token);
    ok(rc.status === 200 && rc.json.code, 'admin issues reset code');
    const nc = await creds('zed-new-password-1');
    const rs = await req('POST', '/api/auth/reset', { username: 'zed', code: rc.json.code, salt: nc.salt, authKey: nc.authKey, pubkey: nc.pubkey, encPriv: nc.encPriv }, undefined);
    ok(rs.status === 200, 'reset with code works');
    ok((await req('GET', '/api/me', undefined, zed.token)).status === 401, 'old sessions revoked after reset');
    ok((await req('POST', '/api/auth/reset', { username: 'zed', code: rc.json.code, salt: nc.salt, authKey: nc.authKey, pubkey: nc.pubkey, encPriv: nc.encPriv })).status === 403, 'reset code single-use');
    await req('PATCH', `/api/users/${eli.id}`, { status: 'disabled' }, owner.token);
    ok((await req('GET', '/api/me', undefined, eli.token)).status === 401, 'disabled user locked out immediately');

    // ---- brute force ----
    let locked = false;
    for (let i = 0; i < 10; i++) { const r = await login('mia', 'bad-password-' + i); if (r.r.status === 429) { locked = true; break; } }
    ok(locked, 'account lockout after repeated failures');
    ok((await req('POST', '/api/me', Buffer.alloc(0) as any, owner.token)).status === 404, 'unknown method/route 404');
    const huge = await req('POST', '/api/tasks', { title: 'x'.repeat(300000) }, owner.token);
    ok(huge.status === 413, 'oversized JSON body rejected');
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
