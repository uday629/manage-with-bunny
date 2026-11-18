// Join code = 60 bits of the host TLS certificate fingerprint + 40 bits of invite secret,
// Crockford base32 encoded as XXXXX-XXXXX-XXXXX-XXXXX. The fingerprint part lets a member
// verify the host certificate on first contact (prevents LAN man-in-the-middle); the secret
// part proves the member got the code from an admin.

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const JOIN_FP_HEX = 15; // 60 bits
export const JOIN_SECRET_HEX = 10; // 40 bits

function hexToBits(hex: string): string {
  return hex.split('').map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

export function encodeJoinCode(fpHex: string, secretHex: string): string {
  const bits = hexToBits(fpHex.slice(0, JOIN_FP_HEX) + secretHex.slice(0, JOIN_SECRET_HEX));
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHA[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,5}/g)!.join('-');
}

export function normalizeJoinCode(code: string): string | null {
  const s = String(code || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return null;
  return s;
}

export function decodeJoinCode(code: string): { fpPrefix: string; secret: string } | null {
  const s = normalizeJoinCode(code);
  if (!s) return null;
  const bits = s.split('').map((c) => ALPHA.indexOf(c).toString(2).padStart(5, '0')).join('');
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return { fpPrefix: hex.slice(0, JOIN_FP_HEX), secret: hex.slice(JOIN_FP_HEX, JOIN_FP_HEX + JOIN_SECRET_HEX) };
}

export function normFp(fp: string): string {
  return String(fp || '').replace(/:/g, '').toLowerCase();
}

export const APP_ORIGIN = 'app://bunny';
export const DEFAULT_PORT = 47821;
export const BEACON_PORT = 47820;
export const BEACON_MAGIC = 'MWB1';
// Multicast copy of the beacon: some routers drop broadcast but pass multicast (or the other way round).
export const BEACON_GROUP = '239.255.77.21';
