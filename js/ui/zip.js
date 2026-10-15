// ZIP writer/reader for self-contained budget exports. makeCompressedZipBlob
// uses native DEFLATE streams; makeZipBlob remains the synchronous store-only
// writer for callers that need it. No ZIP64, encryption, or multi-disk archives.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS time/date for a fixed timestamp — content, not metadata, is what
// matters here. Using 2020-01-01 00:00:00 keeps output deterministic.
const DOS_TIME = 0;                           // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function makeZipBlob(files) {
  return zipBlob(files);
}

/** DEFLATE when supported; readable stored ZIPs remain the fallback. */
export async function makeCompressedZipBlob(files) {
  const encoded = [];
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.data);
    let compressed;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* Older browsers can still export a valid stored ZIP. */ }
    encoded.push({ ...file, bytes, compressed: compressed?.length < bytes.length ? compressed : null });
  }
  return zipBlob(encoded);
}

function zipBlob(files) {
  const enc = new TextEncoder();
  const parts = [];      // raw bytes going into the final blob
  const central = [];    // central directory records
  let localOffset = 0;   // running offset of the next local header

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = f.bytes || enc.encode(f.data);
    const payload = f.compressed || dataBytes;
    const method = f.compressed ? 8 : 0;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes fixed + name + data)
    const lfh = concat([
      u32(0x04034b50),       // signature
      u16(20),               // version needed
      u16(0),                // general purpose bit flag
      u16(method),           // compression method
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(payload.length),   // compressed size
      u32(size),             // uncompressed size
      u16(nameBytes.length),
      u16(0),                // extra field length
      nameBytes,
      payload,
    ]);
    parts.push(lfh);

    // Central directory record (46 bytes fixed + name)
    const cd = concat([
      u32(0x02014b50),       // signature
      u16(20),               // version made by
      u16(20),               // version needed
      u16(0),                // flags
      u16(method),           // compression method
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(payload.length),
      u32(size),
      u16(nameBytes.length),
      u16(0),                // extra length
      u16(0),                // comment length
      u16(0),                // disk number start
      u16(0),                // internal attrs
      u32(0),                // external attrs
      u32(localOffset),      // local header offset
      nameBytes,
    ]);
    central.push(cd);

    localOffset += lfh.length;
  }

  const cdBytes = concat(central);
  const cdOffset = localOffset;

  const eocd = concat([
    u32(0x06054b50),     // signature
    u16(0),              // this disk
    u16(0),              // disk with CD
    u16(files.length),   // entries on this disk
    u16(files.length),   // total entries
    u32(cdBytes.length),
    u32(cdOffset),
    u16(0),              // comment length
  ]);

  const all = concat([...parts, cdBytes, eocd]);
  return new Blob([all], { type: 'application/zip' });
}

// ── Reading ──────────────────────────────────────────────────────────────────
// readZipEntries(bytes) → Promise<Array<{ name, data }>>, the inverse of
// makeZipBlob: every file entry, its contents decoded as UTF-8. Reads the
// central directory (so a data descriptor or an archive comment does not
// confuse it) and checks each entry's CRC. Stored entries are what the
// Settings export writes; deflated ones (the same files re-zipped by an OS
// archiver) are inflated with DecompressionStream where the runtime has it.
// No ZIP64, no encryption, no multi-disk archives: those are refused.

/** A ZIP that cannot be read; `message` says why, in English (for the log). */
export class ZipError extends Error {}

/**
 * Whether the bytes start like a ZIP (a local file header or an empty archive).
 * @param {Uint8Array} bytes
 */
export function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('compressed entries are not supported here');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{ name: string, data: string }>>}
 */
export async function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a ZIP archive');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) throw new ZipError('ZIP64 archives are not supported');
  if (cdOffset + cdSize > eocd) throw new ZipError('the archive is damaged');

  const dec = new TextDecoder('utf-8', { fatal: true });
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipError('the archive is damaged');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').at(-1).startsWith('._')) continue; // a folder entry
    if (flags & 1) throw new ZipError(`${name} is encrypted`);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new ZipError('the archive is damaged');
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(start, start + compSize);
    if (raw.length !== compSize) throw new ZipError('the archive is damaged');
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipError(`${name} uses an unsupported compression method`);
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`${name} is damaged`);
    // Finder resource forks are binary, not budget text. Still verify their
    // integrity above, but ignore them before the strict UTF-8 decoder.
    const pathParts = name.split('/');
    if (pathParts.includes('__MACOSX') || pathParts.at(-1).startsWith('._') || pathParts.at(-1) === '.DS_Store') continue;
    let text;
    try { text = dec.decode(data); } catch { throw new ZipError(`${name} is not text`); }
    out.push({ name, data: text });
  }
  return out;
}
