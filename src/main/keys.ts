// Client-side cryptography (runs in the Electron main process, never in the renderer):
// password -> Argon2id -> {authKey (sent to host), wrapKey (local only)}; X25519 key pair for
// end-to-end encrypted direct messages; AES-256-GCM for message payloads and key wrapping.
import crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { CLIENT_KDF } from '../shared/kdf';

export interface KeyPair { pub: string; priv: string } // base64 raw 32-byte X25519 keys

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export async function deriveKeys(password: string, saltB64: string, kdf: { memoryKiB: number; iterations: number; parallelism: number } = CLIENT_KDF) {
  // Clamp host-supplied parameters so a malicious host cannot make us use weak (or absurdly heavy) settings.
  const memorySize = Math.min(Math.max(kdf.memoryKiB | 0, CLIENT_KDF.memoryKiB), 1048576);
  const iterations = Math.min(Math.max(kdf.iterations | 0, CLIENT_KDF.iterations), 10);
  const parallelism = Math.min(Math.max(kdf.parallelism | 0, 1), 4);
  const master = Buffer.from(await argon2id({ password: password.normalize('NFKC'), salt: Buffer.from(saltB64, 'base64'), memorySize, iterations, parallelism, hashLength: 32, outputType: 'binary' }));
  const authKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'mwb-auth-v1', 32));
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'mwb-wrap-v1', 32));
  master.fill(0);
  return { authKey: b64(authKey), wrapKey };
}

export const newSalt = () => b64(crypto.randomBytes(16));

export function newKeyPair(): KeyPair {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { pub: b64(fromB64url(jwk.x)), priv: b64(fromB64url(jwk.d)) };
}

function aesSeal(key: Buffer, plain: Buffer, aad?: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
function aesOpen(key: Buffer, data: Buffer, aad?: Buffer): Buffer {
  if (data.length < 28) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12), { authTagLength: 16 });
  if (aad) d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]);
}

// encPriv = AES-GCM(wrapKey, priv||pub)
export function wrapKeyPair(kp: KeyPair, wrapKey: Buffer): string {
  return b64(aesSeal(wrapKey, Buffer.concat([Buffer.from(kp.priv, 'base64'), Buffer.from(kp.pub, 'base64')]), Buffer.from('mwb-key-v1')));
}
export function unwrapKeyPair(encB64: string, wrapKey: Buffer): KeyPair {
  const raw = aesOpen(wrapKey, Buffer.from(encB64, 'base64'), Buffer.from('mwb-key-v1'));
  if (raw.length !== 64) throw new Error('bad key blob');
  return { priv: b64(raw.subarray(0, 32)), pub: b64(raw.subarray(32)) };
}

const keyCache = new Map<string, Buffer>();
export function dmKey(me: KeyPair, theirPubB64: string, convId: string): Buffer {
  const ck = `${me.pub}|${theirPubB64}|${convId}`;
  const hit = keyCache.get(ck);
  if (hit) return hit;
  const pub = Buffer.from(theirPubB64, 'base64');
  if (pub.length !== 32) throw new Error('bad public key');
  const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(me.priv, 'base64').toString('base64url'), x: Buffer.from(me.pub, 'base64').toString('base64url') }, format: 'jwk' });
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub.toString('base64url') }, format: 'jwk' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(convId), 'mwb-dm-v1', 32));
  if (keyCache.size > 500) keyCache.clear();
  keyCache.set(ck, key);
  return key;
}

export function encryptText(key: Buffer, text: string, convId: string): string {
  return 'e1:' + b64(aesSeal(key, Buffer.from(text, 'utf8'), Buffer.from(convId)));
}
export function decryptText(key: Buffer, payload: string, convId: string): string | null {
  if (!payload.startsWith('e1:')) return null;
  try { return aesOpen(key, Buffer.from(payload.slice(3), 'base64'), Buffer.from(convId)).toString('utf8'); } catch { return null; }
}

// Human-comparable code for two public keys (same on both devices).
export function safetyNumber(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const h = crypto.createHash('sha256').update('mwb-safety|' + x + '|' + y).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += String(h.readUInt32BE(i * 4) % 100000).padStart(5, '0') + (i < 5 ? ' ' : '');
  return out;
}
