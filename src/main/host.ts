// Supervises the host server in an isolated utilityProcess and restarts it if it ever crashes.
import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';

export interface HostStatus {
  running: boolean; port: number; fp: string; wid: string; name: string; filesDir: string; joinCode: string;
  addresses: string[]; error: string | null; setupToken?: string; movePct?: number;
}

type Listener = (s: HostStatus) => void;

export class HostCtl {
  private proc: UtilityProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private cfg: { dataDir: string; port: number } | null = null;
  private waiters: { resolve: (s: HostStatus) => void; reject: (e: Error) => void }[] = [];
  private moveWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  status: HostStatus = { running: false, port: 0, fp: '', wid: '', name: '', filesDir: '', joinCode: '', addresses: [], error: null };
  listener: Listener = () => {};

  constructor(private serverPath: string) {}

  start(dataDir: string, port: number): Promise<HostStatus> {
    this.cfg = { dataDir, port };
    this.stopping = false;
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (!this.proc) this.spawn();
    });
  }

  private spawn() {
    if (!this.cfg) return;
    const p = utilityProcess.fork(this.serverPath, [], { serviceName: 'Manage with Bunny Host', stdio: 'ignore' });
    this.proc = p;
    p.on('spawn', () => p.postMessage({ type: 'start', cfg: this.cfg }));
    p.on('message', (m: any) => {
      if (m?.type === 'ready') {
        this.restarts = 0;
        this.status = { running: true, port: m.port, fp: m.fp, wid: m.wid, name: m.name, filesDir: m.filesDir, joinCode: m.joinCode, addresses: m.addresses, error: null, setupToken: m.setupToken };
        this.emit();
        for (const w of this.waiters.splice(0)) w.resolve(this.status);
      } else if (m?.type === 'error') {
        const msg = m.code === 'EADDRINUSE' ? `Port ${this.cfg?.port} is already in use on this computer. Choose another port.` : String(m.message || 'Host error');
        if (m.op === 'move-storage') { this.moveWaiter?.reject(new Error(msg)); this.moveWaiter = null; return; }
        this.status = { ...this.status, running: false, error: msg };
        this.emit();
        for (const w of this.waiters.splice(0)) w.reject(new Error(msg));
        if (m.op === 'start') { this.stopping = true; p.kill(); }
      } else if (m?.type === 'move-progress') {
        this.status = { ...this.status, movePct: m.pct }; this.emit();
      } else if (m?.type === 'moved') {
        this.status = { ...this.status, filesDir: m.filesDir, movePct: undefined }; this.emit();
        this.moveWaiter?.resolve(); this.moveWaiter = null;
      }
    });
    p.on('exit', () => {
      this.proc = null;
      this.status = { ...this.status, running: false };
      this.emit();
      if (!this.stopping && this.cfg) {
        const delay = Math.min(10000, 1000 * 2 ** this.restarts++);
        setTimeout(() => { if (!this.stopping && !this.proc) this.spawn(); }, delay);
      }
    });
  }

  moveStorage(dir: string): Promise<void> {
    if (!this.proc) return Promise.reject(new Error('Host is not running.'));
    return new Promise((resolve, reject) => { this.moveWaiter = { resolve, reject }; this.proc!.postMessage({ type: 'move-storage', dir }); });
  }

  async stop() {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    await new Promise<void>((r) => {
      const t = setTimeout(() => { p.kill(); r(); }, 4000);
      p.once('exit', () => { clearTimeout(t); r(); });
      p.postMessage({ type: 'stop' });
    });
    this.proc = null;
  }

  clearSetupToken() { delete this.status.setupToken; }
  private emit() { this.listener({ ...this.status, setupToken: undefined }); }
}

export const serverPath = () => path.join(__dirname, 'server.cjs');
