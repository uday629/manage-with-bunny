// Persistent local settings. Secrets (session token, private key, pending token) are encrypted with
// the OS keychain via safeStorage (DPAPI on Windows, Keychain on macOS) and never written in plain text.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { KeyPair } from './keys';

export interface WorkspaceCfg {
  wid: string; name: string; fp: string; certPem: string; port: number; lastAddr: string;
  username?: string; userId?: string; knownAddrs?: string[];
}
export interface Config {
  mode: 'host' | 'member' | null;
  host?: { dataDir: string; port: number };
  ws?: WorkspaceCfg;
  secrets: { token?: string; keys?: string; pending?: string };
  knownKeys: Record<string, string>;
  autoStart: boolean;
  closeToTray: boolean;
}

const file = () => path.join(app.getPath('userData'), 'config.json');
let cache: Config | null = null;

export function load(): Config {
  if (cache) return cache;
  const def: Config = { mode: null, secrets: {}, knownKeys: {}, autoStart: true, closeToTray: true };
  try { cache = { ...def, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { cache = def; }
  return cache!;
}
export function save() {
  if (!cache) return;
  const tmp = file() + '.tmp';
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
export function update(fn: (c: Config) => void) { fn(load()); save(); }

function enc(s: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer.');
  return safeStorage.encryptString(s).toString('base64');
}
function dec(s?: string): string | null {
  if (!s) return null;
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return null; }
}

export const secrets = {
  getToken: () => dec(load().secrets.token),
  setToken: (t: string | null) => update((c) => { if (t) c.secrets.token = enc(t); else delete c.secrets.token; }),
  getKeys: (): KeyPair | null => { const v = dec(load().secrets.keys); if (!v) return null; try { return JSON.parse(v); } catch { return null; } },
  setKeys: (k: KeyPair | null) => update((c) => { if (k) c.secrets.keys = enc(JSON.stringify(k)); else delete c.secrets.keys; }),
  getPending: () => dec(load().secrets.pending),
  setPending: (t: string | null) => update((c) => { if (t) c.secrets.pending = enc(t); else delete c.secrets.pending; }),
};
