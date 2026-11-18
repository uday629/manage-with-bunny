// Generates a self-signed ECDSA P-256 certificate without external dependencies (minimal DER encoder).
// Members pin this certificate by SHA-256 fingerprint, so no public CA is involved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
function int(buf: Buffer): Buffer {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(s: string): Buffer {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const tmp: number[] = [];
    let x = v;
    tmp.unshift(x & 0x7f);
    while ((x >>= 7) > 0) tmp.unshift((x & 0x7f) | 0x80);
    out.push(...tmp);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const octet = (b: Buffer) => tlv(0x04, b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const ctx = (n: number, b: Buffer) => tlv(0xa0 + n, b);
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

export function generateCert(commonName: string): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const now = Date.now();
  const validity = seq(time(new Date(now - 86400000)), time(new Date(now + 20 * 365 * 86400000)));
  const exts = seq(
    seq(oid('2.5.29.19'), bool(true), octet(seq(bool(true)))),
    seq(oid('2.5.29.15'), bool(true), octet(bits(Buffer.from([0x84]), 2))),
    seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1')))),
    seq(oid('2.5.29.17'), octet(seq(tlv(0x82, Buffer.from('localhost'))))),
  );
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), sigAlg, name, validity, name, spki, ctx(3, exts));
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, sigAlg, bits(sig));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  new crypto.X509Certificate(certPem); // throws if malformed
  return { certPem, keyPem };
}

export function loadOrCreateCert(dir: string): { cert: string; key: string; fp: string } {
  fs.mkdirSync(dir, { recursive: true });
  const cf = path.join(dir, 'host.crt');
  const kf = path.join(dir, 'host.key');
  if (!fs.existsSync(cf) || !fs.existsSync(kf)) {
    const { certPem, keyPem } = generateCert('Manage with Bunny Host');
    fs.writeFileSync(kf, keyPem, { mode: 0o600 });
    fs.writeFileSync(cf, certPem, { mode: 0o644 });
  }
  const cert = fs.readFileSync(cf, 'utf8');
  const key = fs.readFileSync(kf, 'utf8');
  const fp = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
  return { cert, key, fp };
}
