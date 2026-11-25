// Packs a folder into an uncompressed ("stored") ZIP Blob without loading the files into memory:
// the Blob references the original File objects, only small headers are created here. CRC-32 is computed
// by streaming each file once. ZIP64 is used automatically for files or archives larger than 4 GB.
// Works in the browser (renderer) and in Node 18+ (tests).

export interface ZipEntry { path: string; file: Blob; mtime?: number; dir?: boolean; /** size when the user picked it */ pickedSize?: number }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

async function crc32(blob: Blob, name: string, onBytes: (n: number) => void): Promise<number> {
  let c = 0xffffffff;
  let read = 0;
  try {
    const reader = (blob.stream() as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]) & 0xff] ^ (c >>> 8);
      read += value.length;
      onBytes(value.length);
    }
  } catch { throw new Error(`"${name}" could not be read. It may have been moved, deleted or is still being written.`); }
  if (read !== blob.size) throw new Error(`"${name}" changed or was removed while packing. Send the folder again.`);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(ms: number) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

class W {
  buf: Uint8Array; v: DataView; o = 0;
  constructor(n: number) { this.buf = new Uint8Array(n); this.v = new DataView(this.buf.buffer); }
  u16(x: number) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u32(x: number) { this.v.setUint32(this.o, x >>> 0, true); this.o += 4; return this; }
  u64(x: number) { this.v.setUint32(this.o, x % 0x100000000, true); this.v.setUint32(this.o + 4, Math.floor(x / 0x100000000), true); this.o += 8; return this; }
  bytes(b: Uint8Array) { this.buf.set(b, this.o); this.o += b.length; return this; }
}

const MAX32 = 0xffffffff;

/** Safe, portable entry name: forward slashes, no drive letters, no "..", no leading slash. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function cleanZipPath(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..')
    .map((s) => { let x = s.replace(/[\u0000-\u001F<>:"|?*]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length)); if (RESERVED.test(x)) x = '_' + x; return x; })
    .join('/');
}

export async function buildStoredZip(entries: ZipEntry[], onProgress?: (done: number, total: number) => void, forceZip64 = false): Promise<Blob> {
  const enc = new TextEncoder();
  const total = entries.reduce((a, e) => a + (e.dir ? 0 : e.file.size), 0);
  let hashed = 0;
  const parts: (Blob | Uint8Array)[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    let name = cleanZipPath(e.path);
    if (!name) continue;
    if (e.dir && !name.endsWith('/')) name += '/';
    const nameBytes = enc.encode(name);
    const size = e.dir ? 0 : e.file.size;
    if (!e.dir && e.pickedSize !== undefined && e.pickedSize !== size) throw new Error(`"${name}" changed or was removed after you picked the folder. Send the folder again.`);
    const crc = e.dir || size === 0 ? 0 : await crc32(e.file, name, (n) => { hashed += n; onProgress?.(hashed, total); });
    const { time, date } = dosTime(e.mtime || Date.now());
    const big = forceZip64 || size >= MAX32 || offset >= MAX32;
    // local file header
    const lx = big ? 20 : 0;
    const local = new W(30 + nameBytes.length + lx)
      .u32(0x04034b50).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(crc)
      .u32(big ? MAX32 : size).u32(big ? MAX32 : size).u16(nameBytes.length).u16(lx).bytes(nameBytes);
    if (big) local.u16(0x0001).u16(16).u64(size).u64(size);
    parts.push(local.buf);
    if (!e.dir && size) parts.push(e.file);
    // central directory record
    const cx = big ? 28 : 0;
    const cd = new W(46 + nameBytes.length + cx)
      .u32(0x02014b50).u16(big ? 45 : 20).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(crc)
      .u32(big ? MAX32 : size).u32(big ? MAX32 : size).u16(nameBytes.length).u16(cx).u16(0).u16(0).u16(0)
      .u32(e.dir ? 0x10 : 0).u32(big ? MAX32 : offset).bytes(nameBytes);
    if (big) cd.u16(0x0001).u16(24).u64(size).u64(size).u64(offset);
    central.push(cd.buf);
    offset += local.buf.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const cdOffset = offset;
  const n = central.length;
  const need64 = forceZip64 || n >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  parts.push(...central);
  if (need64) {
    const z64 = new W(56).u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdOffset);
    const loc = new W(20).u32(0x07064b50).u32(0).u64(cdOffset + cdSize).u32(1);
    parts.push(z64.buf, loc.buf);
  }
  const end = new W(22).u32(0x06054b50).u16(0).u16(0).u16(need64 ? 0xffff : n).u16(need64 ? 0xffff : n)
    .u32(need64 ? MAX32 : cdSize).u32(need64 ? MAX32 : cdOffset).u16(0);
  parts.push(end.buf);
  onProgress?.(total, total);
  return new Blob(parts as BlobPart[], { type: 'application/zip' });
}
