/**
 * A pure reader for ZIP archives (used for compressed MusicXML, `.mxl`). It reads the central
 * directory and hands out the stored bytes of each entry; DEFLATE decompression is supplied by
 * the caller through `InflateRaw` (the browser's `DecompressionStream('deflate-raw')`, Node's
 * `zlib.inflateRawSync`), so this package stays free of platform APIs. ZIP64 archives are
 * supported; encrypted entries and other compression methods are refused.
 */
import { encodeUtf8 } from './xml';

export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly encrypted: boolean;
  /** Offset of the entry's local file header. */
  readonly headerOffset: number;
}

/** Decompress raw DEFLATE data (no zlib or gzip header). */
export type InflateRaw = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

/** True if the bytes start like a ZIP archive ("PK\x03\x04" or an empty archive). */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
  );
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(v: DataView, at: number): number {
  const lo = v.getUint32(at, true);
  const hi = v.getUint32(at + 4, true);
  const value = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(value)) throw new ZipError('archive too large');
  return value;
}

function nameOf(bytes: Uint8Array): string {
  // Entry names are UTF-8 (flag bit 11) or CP437; MusicXML archives use ASCII names in practice.
  let ascii = true;
  for (const b of bytes) if (b >= 0x80) ascii = false;
  if (ascii) return String.fromCharCode(...bytes);
  let out = '';
  let k = 0;
  while (k < bytes.length) {
    const b = bytes[k]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      k++;
    } else if (b >= 0xc0 && b < 0xe0 && k + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[k + 1]! & 0x3f));
      k += 2;
    } else if (b >= 0xe0 && b < 0xf0 && k + 2 < bytes.length) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[k + 1]! & 0x3f) << 6) | (bytes[k + 2]! & 0x3f),
      );
      k += 3;
    } else {
      out += '�';
      k++;
    }
  }
  return out;
}

/** The entries listed in the archive's central directory. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const v = view(bytes);
  // End of central directory: 22 bytes plus a comment of up to 65535 bytes.
  let end = -1;
  for (let k = bytes.length - 22; k >= Math.max(0, bytes.length - 22 - 0xffff); k--) {
    if (v.getUint32(k, true) === SIG_END) {
      end = k;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a ZIP archive (no central directory)');
  let count = v.getUint16(end + 10, true);
  let size = v.getUint32(end + 12, true);
  let offset = v.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || v.getUint32(locator, true) !== SIG_LOCATOR64)
      throw new ZipError('damaged ZIP64 archive');
    const end64 = u64(v, locator + 8);
    if (end64 + 56 > bytes.length || v.getUint32(end64, true) !== SIG_END64)
      throw new ZipError('damaged ZIP64 archive');
    count = u64(v, end64 + 32);
    size = u64(v, end64 + 40);
    offset = u64(v, end64 + 48);
  }
  if (offset + size > bytes.length) throw new ZipError('truncated ZIP archive');
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== SIG_CENTRAL)
      throw new ZipError('damaged central directory');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    let compressedSize = v.getUint32(p + 20, true);
    let uncompressed = v.getUint32(p + 24, true);
    const nameLength = v.getUint16(p + 28, true);
    const extraLength = v.getUint16(p + 30, true);
    const commentLength = v.getUint16(p + 32, true);
    let headerOffset = v.getUint32(p + 42, true);
    const name = nameOf(bytes.subarray(p + 46, p + 46 + nameLength));
    // ZIP64 extra field: the 64-bit values replace the 32-bit ones that are 0xffffffff, in order.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff && q + 8 <= e + 4 + len) {
          uncompressed = u64(v, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) {
          compressedSize = u64(v, q);
          q += 8;
        }
        if (headerOffset === 0xffffffff && q + 8 <= e + 4 + len) headerOffset = u64(v, q);
      }
      e += 4 + len;
    }
    entries.push({
      name,
      method,
      compressedSize,
      size: uncompressed,
      crc32: crc,
      encrypted: (flags & 1) !== 0,
      headerOffset,
    });
    p = extraEnd + commentLength;
  }
  return entries;
}

/** The stored (possibly compressed) bytes of an entry. */
export function zipEntryRawData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const v = view(bytes);
  const h = entry.headerOffset;
  if (h + 30 > bytes.length || v.getUint32(h, true) !== SIG_LOCAL)
    throw new ZipError(`damaged entry ${entry.name}`);
  const start = h + 30 + v.getUint16(h + 26, true) + v.getUint16(h + 28, true);
  if (start + entry.compressedSize > bytes.length)
    throw new ZipError(`truncated entry ${entry.name}`);
  return bytes.subarray(start, start + entry.compressedSize);
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), as used by ZIP. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let k = 0; k < data.length; k++) crc = crcTable[(crc ^ data[k]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The uncompressed bytes of an entry, checked against its size and CRC. */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  inflateRaw: InflateRaw,
): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted`);
  const raw = zipEntryRawData(bytes, entry);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = await inflateRaw(raw);
  else throw new ZipError(`${entry.name}: unsupported compression method ${entry.method}`);
  if (data.length !== entry.size || crc32(data) !== entry.crc32)
    throw new ZipError(`${entry.name} is damaged (size or checksum mismatch)`);
  return data;
}

export interface ZipInput {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * Build a ZIP archive. Entries are stored, or compressed with `deflateRaw` when one is given
 * (the platform's DEFLATE, as for reading). Used by tests and for `.mxl` export.
 */
export function writeZip(
  entries: readonly ZipInput[],
  deflateRaw?: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encodeUtf8(entry.name);
    const data = deflateRaw ? deflateRaw(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const flags = name.some((b) => b >= 0x80) ? 0x800 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = view(local);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, deflateRaw ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = view(central);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, deflateRaw ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
