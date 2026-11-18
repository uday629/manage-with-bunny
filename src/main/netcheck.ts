// Network self-diagnosis: explains in plain words why a member cannot reach the host, and repairs the
// Windows Firewall rule (with the user's UAC approval) when it is missing.
import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const run = (file: string, args: string[], timeout = 8000) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: String(stdout || '') }));
});

function tcp(addr: string, port: number, ms = 2500): Promise<boolean> {
  return new Promise((r) => { const s = net.connect({ host: addr, port }); const t = setTimeout(() => { s.destroy(); r(false); }, ms); s.once('connect', () => { clearTimeout(t); s.destroy(); r(true); }); s.once('error', () => { clearTimeout(t); r(false); }); });
}
const toNum = (ip: string) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
export function lanInterfaces() {
  const out: { name: string; address: string; netmask: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
  return out;
}
export function sameSubnet(ip: string) {
  return lanInterfaces().some((i) => (toNum(i.address) & toNum(i.netmask)) === (toNum(ip) & toNum(i.netmask)));
}

export interface Diagnosis {
  platform: string; mode: string | null; interfaces: { name: string; address: string }[];
  profiles: { alias: string; category: string }[]; firewall: 'ok' | 'missing' | 'limited' | 'blocked' | 'unknown';
  host: { addr: string; port: number; reachable: boolean; sameSubnet: boolean } | null; beaconsSeen: number;
  findings: { level: 'ok' | 'warn' | 'bad'; text: string; fix?: 'firewall' }[];
}

export async function diagnose(o: { mode: string | null; hostAddr: string | null; port: number; beaconsSeen: number; hosting: boolean }): Promise<Diagnosis> {
  const d: Diagnosis = { platform: process.platform, mode: o.mode, interfaces: lanInterfaces().map((i) => ({ name: i.name, address: i.address })), profiles: [], firewall: 'unknown', host: null, beaconsSeen: o.beaconsSeen, findings: [] };
  if (!d.interfaces.length) d.findings.push({ level: 'bad', text: 'This computer is not connected to any network. Connect to the office Wi-Fi or cable.' });
  if (process.platform === 'win32') {
    const p = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress']);
    try {
      const j = JSON.parse(p.out || '[]');
      const cats = ['Public', 'Private', 'Domain'];
      d.profiles = (Array.isArray(j) ? j : [j]).filter(Boolean).map((x: any) => ({ alias: String(x.InterfaceAlias), category: typeof x.NetworkCategory === 'number' ? cats[x.NetworkCategory] || String(x.NetworkCategory) : String(x.NetworkCategory) }));
    } catch { /* ignore */ }
    if (app.isPackaged) {
      const fw = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Manage with Bunny', 'verbose']);
      if (/Action:\s+Block/i.test(fw.out)) d.firewall = 'blocked';
      else if (fw.code !== 0 || !/Enabled:\s+Yes/i.test(fw.out)) d.firewall = 'missing';
      else d.firewall = /Profiles:\s+.*Public/i.test(fw.out) || /Profiles:\s+Any/i.test(fw.out) ? 'ok' : 'limited';
    }
    if (d.firewall === 'blocked') d.findings.push({ level: 'bad', text: 'Windows Firewall has a rule that BLOCKS Manage with Bunny (usually created when its permission pop-up was dismissed).', fix: 'firewall' });
    else if (d.firewall === 'missing') d.findings.push({ level: 'bad', text: 'Windows Firewall has no rule for Manage with Bunny, so other computers cannot connect.', fix: 'firewall' });
    else if (d.firewall === 'limited' && d.profiles.some((x) => x.category === 'Public')) d.findings.push({ level: 'bad', text: 'This Wi-Fi is marked "Public" and the firewall rule only covers private networks.', fix: 'firewall' });
    else if (d.firewall === 'ok') d.findings.push({ level: 'ok', text: 'Windows Firewall allows Manage with Bunny on this local network.' });
  }
  if (o.hostAddr && !o.hosting) {
    const reachable = await tcp(o.hostAddr, o.port);
    d.host = { addr: o.hostAddr, port: o.port, reachable, sameSubnet: sameSubnet(o.hostAddr) };
    if (reachable) d.findings.push({ level: 'ok', text: `The host at ${o.hostAddr} answers.` });
    else if (!d.host.sameSubnet) d.findings.push({ level: 'bad', text: `The host (${o.hostAddr}) is on a different network than this computer. Connect both to the same Wi-Fi (not a guest network).` });
    else d.findings.push({ level: 'bad', text: `The host (${o.hostAddr}) does not answer. Check that the host computer is on and the app is running. If it is, the router may block devices from talking to each other ("AP isolation" / "client isolation", common on guest Wi-Fi): use the main Wi-Fi or turn that option off in the router settings.` });
  }
  if (!o.hosting && o.mode) d.findings.push(o.beaconsSeen ? { level: 'ok', text: `This computer hears the host's network announcements (${o.beaconsSeen}).` } : { level: 'warn', text: 'No host announcements received. That is fine if you are connected; otherwise the router may block broadcast traffic. The app falls back to scanning the network and to the address saved in your invite.' });
  if (o.hosting) d.findings.push({ level: 'ok', text: `This computer is the host. Teammates connect to ${d.interfaces.map((i) => i.address).join(' or ')} on port ${o.port}. Tip: reserve this IP address in the router (DHCP reservation) so it never changes.` });
  return d;
}

// Re-creates the firewall rule (all profiles, local subnet only). Shows the Windows UAC prompt; nothing happens without the user's approval.
export async function repairFirewall(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const exe = app.getPath('exe');
  if (/["'%^&|<>]/.test(exe)) throw new Error('Unexpected install path.');
  const script = path.join(app.getPath('temp'), `mwb-fw-${crypto.randomBytes(6).toString('hex')}.cmd`);
  if (/['"]/.test(script)) throw new Error('Unexpected temp path.');
  fs.writeFileSync(script, `@echo off\r\nnetsh advfirewall firewall delete rule name="Manage with Bunny" >nul\r\nnetsh advfirewall firewall add rule name="Manage with Bunny" dir=in action=allow program="${exe}" enable=yes profile=any remoteip=localsubnet >nul\r\n`);
  try {
    const code = await new Promise<number>((resolve) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${script}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 5 }`], { windowsHide: true });
      p.on('exit', (c) => resolve(c ?? 1));
      p.on('error', () => resolve(1));
    });
    return code === 0;
  } finally { fs.rmSync(script, { force: true }); }
}
