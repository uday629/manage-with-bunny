// Bundles main, preload, host server and renderer with esbuild. Usage: node build.mjs [--dev]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const dev = process.argv.includes('--dev');
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'renderer', 'fonts'), { recursive: true });

const common = { bundle: true, minify: !dev, sourcemap: dev ? 'inline' : false, legalComments: 'none', logLevel: 'warning', define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"', __DEV__: String(dev) } };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: `${out}/main.cjs`, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: `${out}/preload.cjs`, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/server/index.ts'], outfile: `${out}/server.cjs`, platform: 'node', format: 'cjs', target: 'node24' }),
  build({ ...common, entryPoints: ['src/renderer/main.tsx'], outfile: `${out}/renderer/app.js`, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic', loader: { '.ttf': 'file' } }),
]);

fs.copyFileSync('src/renderer/index.html', `${out}/renderer/index.html`);
fs.copyFileSync('src/renderer/styles.css', `${out}/renderer/styles.css`);
for (const f of fs.readdirSync('assets/fonts')) if (f.endsWith('.ttf')) fs.copyFileSync(`assets/fonts/${f}`, `${out}/renderer/fonts/${f}`);
fs.copyFileSync('assets/logo.png', `${out}/renderer/logo.png`);
fs.copyFileSync('assets/logo.png', `${out}/logo.png`);
fs.copyFileSync('build/tray.png', `${out}/tray.png`);
fs.copyFileSync('build/icon.ico', `${out}/icon.ico`);
fs.copyFileSync('build/tray@2x.png', `${out}/tray@2x.png`);
console.log(`built ${dev ? 'dev' : 'prod'} bundle`);
