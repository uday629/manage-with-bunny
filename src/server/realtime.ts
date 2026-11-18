// WebSocket hub: authenticated by first message (token never in URL), heartbeat, presence, fan-out.
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { APP_ORIGIN } from '../shared/joincode';
import { S, authenticateToken, requireMember, type Hub } from './core';
import { rateHit } from './http';
import { now } from './db';

interface Client { ws: WebSocket; userId: string; sessionId: string; alive: boolean }

export function createHub(server: HttpsServer): Hub & { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const byUser = new Map<string, Set<Client>>();

  const send = (ids: Iterable<string>, ev: object) => {
    const data = JSON.stringify(ev);
    for (const id of new Set(ids)) for (const c of byUser.get(id) || []) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  };
  const presence = (userId: string, online: boolean) => {
    // Notify everyone who can see this user (cheap enough for LAN-sized teams).
    const targets: string[] = [];
    for (const uid of byUser.keys()) targets.push(uid);
    send(targets, { t: 'presence', userId, online });
  };

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if ((origin && origin !== APP_ORIGIN) || req.url !== '/ws' || !rateHit('ws:' + ip, 60, 60000)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let client: Client | null = null;
      const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return ws.close(4002, 'binary');
        let m: any;
        try { m = JSON.parse(raw.toString()); } catch { return ws.close(4002, 'bad json'); }
        if (!client) {
          if (m?.t !== 'auth' || typeof m.token !== 'string') return ws.close(4001, 'auth');
          const u = authenticateToken(m.token);
          if (!u) return ws.close(4003, 'unauthorized');
          clearTimeout(authTimer);
          client = { ws, userId: u.id, sessionId: u.sessionId, alive: true };
          let set = byUser.get(u.id);
          const wasOnline = !!set?.size;
          if (!set) { set = new Set(); byUser.set(u.id, set); }
          set.add(client);
          ws.send(JSON.stringify({ t: 'ready', userId: u.id, at: now() }));
          if (!wasOnline) presence(u.id, true);
          return;
        }
        if (!rateHit('wsm:' + client.userId, 300, 60000)) return;
        if (m?.t === 'ping') { ws.send('{"t":"pong"}'); return; }
        if (m?.t === 'typing' && typeof m.convId === 'string' && m.convId.length < 65) {
          try {
            requireMember(m.convId, client.userId);
            const members = S.db.all<{ user_id: string }>('SELECT user_id FROM conv_members WHERE conv_id=? AND user_id<>?', m.convId, client.userId).map((r) => r.user_id);
            send(members, { t: 'typing', convId: m.convId, userId: client.userId });
          } catch { /* not a member: ignore */ }
        }
      });
      ws.on('pong', () => { if (client) client.alive = true; });
      ws.on('close', () => {
        clearTimeout(authTimer);
        if (!client) return;
        const set = byUser.get(client.userId);
        set?.delete(client);
        if (set && set.size === 0) {
          byUser.delete(client.userId);
          S.db.run('UPDATE users SET last_seen=? WHERE id=?', now(), client.userId);
          presence(client.userId, false);
        }
      });
      ws.on('error', () => ws.terminate());
    });
  });

  const beat = setInterval(() => {
    for (const set of byUser.values()) for (const c of set) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { c.ws.terminate(); }
    }
  }, 20000);
  beat.unref();

  return {
    send,
    isOnline: (id) => !!byUser.get(id)?.size,
    kick(userId, sessionId) {
      for (const c of byUser.get(userId) || []) if (!sessionId || c.sessionId === sessionId) { try { c.ws.send('{"t":"kicked"}'); } catch { /* */ } c.ws.close(4003, 'revoked'); }
    },
    close() { clearInterval(beat); for (const set of byUser.values()) for (const c of set) c.ws.terminate(); wss.close(); },
  };
}

