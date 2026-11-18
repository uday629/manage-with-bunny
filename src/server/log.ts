// Structured JSON-lines logger with size-based rotation. Never pass secrets, tokens or message bodies here.
import fs from 'node:fs';
import path from 'node:path';

let file = '';
const MAX = 5 * 1024 * 1024;

export function initLog(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'server.log');
}

function write(level: string, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }) + '\n';
  if (!file) { process.stderr.write(line); return; }
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX) {
      const old = file + '.1';
      if (fs.existsSync(old)) fs.rmSync(old);
      fs.renameSync(file, old);
    }
    fs.appendFileSync(file, line);
  } catch { /* logging must never crash the server */ }
}

export const log = {
  info: (m: string, e?: Record<string, unknown>) => write('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => write('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => write('error', m, e),
};
