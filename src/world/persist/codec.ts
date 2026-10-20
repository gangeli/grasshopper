import { CS, CS2, chunkKey, emptyMap, type ChunkedMap, type MapChunk } from './ChunkedMap';

/**
 * Compact binary encoding of a ChunkedMap:
 *
 *   header (16 bytes, never compressed)
 *     'H' 'P' 'M' version | flags (bit0: body gzip) | 3 reserved
 *     body length (u32, uncompressed) | CRC-32 of the uncompressed body (u32)
 *   body
 *     res (f32) | ny (u16) | chunk size (u16) | origin x, y, z (f64)
 *     chunk count (u32), then per chunk:
 *       cx, cz (i16) | flags (u8: 1 underside, 2 topFrac) | observed bitmask (32 bytes)
 *       occupancy as run-length pairs (value byte, varint run) | [underside RLE] | [topFrac RLE]
 *
 * Log-odds are kept exactly (no quantization): voxel maps are long runs of
 * "unknown" and "free", which RLE + gzip shrink ~20–50×. Decoding validates
 * everything (CRC, sizes, run totals) and throws on any inconsistency, so a
 * corrupted record is detected rather than half-loaded.
 */
export const CODEC_VERSION = 1;

class Writer {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private dv = new DataView(this.buf.buffer);
  private ensure(k: number) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.n++] = v;
  }
  u16(v: number) {
    this.ensure(2);
    this.dv.setUint16(this.n, v, true);
    this.n += 2;
  }
  i16(v: number) {
    this.ensure(2);
    this.dv.setInt16(this.n, v, true);
    this.n += 2;
  }
  u32(v: number) {
    this.ensure(4);
    this.dv.setUint32(this.n, v >>> 0, true);
    this.n += 4;
  }
  f32(v: number) {
    this.ensure(4);
    this.dv.setFloat32(this.n, v, true);
    this.n += 4;
  }
  f64(v: number) {
    this.ensure(8);
    this.dv.setFloat64(this.n, v, true);
    this.n += 8;
  }
  varint(v: number) {
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.n++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.n++] = v;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  rle(a: Uint8Array | Int8Array) {
    const u = a instanceof Int8Array ? new Uint8Array(a.buffer, a.byteOffset, a.length) : a;
    let q = 0;
    while (q < u.length) {
      const v = u[q];
      let e = q + 1;
      while (e < u.length && u[e] === v) e++;
      this.u8(v);
      this.varint(e - q);
      q = e;
    }
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class Reader {
  private dv: DataView;
  n = 0;
  constructor(readonly buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(k: number) {
    if (this.n + k > this.buf.length) throw new Error('map data truncated');
  }
  u8() {
    this.need(1);
    return this.buf[this.n++];
  }
  u16() {
    this.need(2);
    const v = this.dv.getUint16(this.n, true);
    this.n += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.dv.getInt16(this.n, true);
    this.n += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.n, true);
    this.n += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.n, true);
    this.n += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.dv.getFloat64(this.n, true);
    this.n += 8;
    return v;
  }
  varint() {
    let v = 0, shift = 0;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
      shift += 7;
      if (shift > 35) throw new Error('bad varint');
    }
  }
  bytes(k: number) {
    this.need(k);
    const b = this.buf.subarray(this.n, this.n + k);
    this.n += k;
    return b;
  }
  rle(out: Uint8Array) {
    let q = 0;
    while (q < out.length) {
      const v = this.u8(), run = this.varint();
      if (run <= 0 || q + run > out.length) throw new Error('bad run length');
      out.fill(v, q, q + run);
      q += run;
    }
  }
}

let crcTable: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let q = 0; q < b.length; q++) c = crcTable[(c ^ b[q]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Serialize the map body (uncompressed). Yields between chunks if driven as a generator. */
export function* encodeBody(m: ChunkedMap, chunksPerYield = 32): Generator<void, Uint8Array, void> {
  const w = new Writer();
  w.f32(m.res);
  w.u16(m.ny);
  w.u16(CS);
  w.f64(m.origin.x);
  w.f64(m.origin.y);
  w.f64(m.origin.z);
  w.u32(m.chunks.size);
  const bits = new Uint8Array(CS2 / 8);
  let k = 0;
  for (const c of m.chunks.values()) {
    w.i16(c.cx);
    w.i16(c.cz);
    w.u8((c.underside ? 1 : 0) | (c.topFrac ? 2 : 0));
    bits.fill(0);
    for (let q = 0; q < CS2; q++) if (c.observed[q]) bits[q >> 3] |= 1 << (q & 7);
    w.bytes(bits);
    w.rle(c.occ);
    if (c.underside) w.rle(c.underside);
    if (c.topFrac) w.rle(c.topFrac);
    if (++k % chunksPerYield === 0) yield;
  }
  return w.result();
}

export function decodeBody(body: Uint8Array): ChunkedMap {
  const r = new Reader(body);
  const res = r.f32(), ny = r.u16(), cs = r.u16();
  if (cs !== CS) throw new Error(`chunk size ${cs} unsupported`);
  if (!(res > 0.005 && res < 1) || ny < 1 || ny > 512) throw new Error('bad map header');
  const origin = { x: r.f64(), y: r.f64(), z: r.f64() };
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) throw new Error('bad origin');
  const m = emptyMap(Math.round(res * 1e6) / 1e6, ny, origin);
  const n = r.u32();
  if (n > 1 << 20) throw new Error('too many chunks');
  for (let q = 0; q < n; q++) {
    const cx = r.i16(), cz = r.i16(), flags = r.u8();
    const bits = r.bytes(CS2 / 8);
    const c: MapChunk = { cx, cz, occ: new Int8Array(CS2 * ny), observed: new Uint8Array(CS2), underside: null, topFrac: null };
    for (let b = 0; b < CS2; b++) c.observed[b] = (bits[b >> 3] >> (b & 7)) & 1;
    r.rle(new Uint8Array(c.occ.buffer));
    if (flags & 1) r.rle((c.underside = new Uint8Array(CS2 * ny)));
    if (flags & 2) r.rle((c.topFrac = new Uint8Array(CS2 * ny)));
    m.chunks.set(chunkKey(cx, cz), c);
  }
  if (r.n !== body.length) throw new Error('trailing bytes');
  return m;
}

const gzipOk = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Wrap a body: header + (gzip) body. */
export async function packBody(body: Uint8Array, compress = true): Promise<Uint8Array> {
  let payload = body, flags = 0;
  if (compress && gzipOk()) {
    try {
      payload = await pipe(body, new CompressionStream('gzip'));
      flags |= 1;
    } catch {
      payload = body;
    }
  }
  const out = new Uint8Array(16 + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x48; // H
  out[1] = 0x50; // P
  out[2] = 0x4d; // M
  out[3] = CODEC_VERSION;
  out[4] = flags;
  dv.setUint32(8, body.length, true);
  dv.setUint32(12, crc32(body), true);
  out.set(payload, 16);
  return out;
}

export async function unpackBody(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 16 || data[0] !== 0x48 || data[1] !== 0x50 || data[2] !== 0x4d) throw new Error('not a map');
  if (data[3] !== CODEC_VERSION) throw new Error(`map version ${data[3]} unsupported`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(8, true), crc = dv.getUint32(12, true);
  let body = data.subarray(16);
  if (data[4] & 1) {
    if (!gzipOk()) throw new Error('gzip unavailable');
    body = await pipe(body, new DecompressionStream('gzip'));
  }
  if (body.length !== len) throw new Error('length mismatch');
  if (crc32(body) !== crc) throw new Error('checksum mismatch');
  return body;
}

export async function encodeMap(m: ChunkedMap, compress = true): Promise<Uint8Array> {
  const g = encodeBody(m);
  let r = g.next();
  while (!r.done) r = g.next();
  return packBody(r.value, compress);
}

export async function decodeMap(data: Uint8Array): Promise<ChunkedMap> {
  return decodeBody(await unpackBody(data));
}
