// Builds the all-in-one download: installers + offline README.html + UI.html + screenshots + security report.
// Usage: node scripts/package.mjs <folder with the .exe/.dmg files> <version>
//   -> <folder>/Manage-with-Bunny-<version>-Complete.zip
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [srcDir, versionArg] = process.argv.slice(2);
if (!srcDir || !versionArg) { console.error('usage: node scripts/package.mjs <dir> <version>'); process.exit(2); }
const v = versionArg.replace(/^v/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = `Manage-with-Bunny-${v}`;
const work = path.resolve(srcDir, 'pkg');
const out = path.join(work, name);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = fs.readdirSync(srcDir);
const place = [
  [(f) => f.endsWith('.exe') && f.includes(v), 'Windows'],
  [(f) => f.endsWith('-arm64.dmg') && f.includes(v), 'Mac (Apple Silicon)'],
  [(f) => f.endsWith('-x64.dmg') && f.includes(v), 'Mac (Intel)'],
];
const sums = [];
for (const [match, folder] of place) {
  const f = files.find(match);
  if (!f) { console.warn(`warning: no installer for ${folder}`); continue; }
  fs.mkdirSync(path.join(out, folder), { recursive: true });
  const dest = path.join(out, folder, f);
  fs.copyFileSync(path.join(srcDir, f), dest);
  sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')}  ${folder}/${f}`);
  console.log(`added ${folder}/${f}`);
}
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

const fixVersion = (s) => s.replace(/Version \d+\.\d+\.\d+/g, `Version ${v}`).replace(/Setup-\d+\.\d+\.\d+\.exe/g, `Setup-${v}.exe`).replace(/Manage-with-Bunny-\d+\.\d+\.\d+-Complete/g, `${name}-Complete`);
let readme = fixVersion(fs.readFileSync(path.join(root, 'README.html'), 'utf8'));
// Inside the ZIP the installers are right next to the guide.
readme = readme.replace(/<a class="btn primary" href="[^"]*">Download everything <small>\.zip<\/small><\/a>/, '<a class="btn primary" href="#download">Install now</a>');
fs.writeFileSync(path.join(out, 'README.html'), readme);
fs.writeFileSync(path.join(out, 'UI.html'), fixVersion(fs.readFileSync(path.join(root, 'UI.html'), 'utf8')).replace(/href="https:\/\/github\.com\/[^"]*releases\/latest"/g, 'href="README.html#download"'));
fs.copyFileSync(path.join(root, 'SECURITY_REPORT.md'), path.join(out, 'SECURITY_REPORT.md'));
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
fs.cpSync(path.join(root, 'docs', 'screenshots'), path.join(out, 'docs', 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(out, 'START HERE.txt'), [
  `Manage with Bunny ${v} - Made by Bunnys Framelab`,
  '',
  '1. Open README.html in your browser: install, uninstall, how every feature works, limitations.',
  '2. Windows: run Windows\\Manage-with-Bunny-Setup-' + v + '.exe',
  '   Mac (M1-M4): open "Mac (Apple Silicon)\\*.dmg"   Mac (Intel): open "Mac (Intel)\\*.dmg"',
  '3. UI.html shows every screen.',
  '',
  'Website: https://framelabmedia.odoo.com/   Instagram: https://www.instagram.com/bunnysframelab/',
  '',
].join('\r\n'));

const zip = path.resolve(srcDir, `${name}-Complete.zip`);
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', path.relative(work, zip), name], { cwd: work, stdio: 'inherit' });
else execFileSync('zip', ['-r', '-q', '-X', zip, name], { cwd: work, stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });
console.log(`created ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
