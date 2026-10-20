import type { SerializedChunk, SerializedMap } from '../MapFormat';
import { CS, CS2, chunkKey, emptyMap, getOrCreateChunk, type ChunkedMap } from './ChunkedMap';

/**
 * Conversion between the world model's exchange format (MapFormat.ts:
 * 32×32-column tiles, all layers including the solid sub-floor, absolute
 * origin) and the persistence layer's ChunkedMap (16×16-column chunks,
 * floor-relative layers, origin y = floor height). Lossless both ways for
 * the layers above the floor; the lattices coincide (a 32-tile is four
 * 16-chunks), so nothing is resampled.
 */
export function fromSerialized(m: SerializedMap): ChunkedMap {
  if (m.chunkSize % CS !== 0) throw new Error(`chunk size ${m.chunkSize} is not a multiple of ${CS}`);
  const ny = m.ny - m.floorLayer;
  const out = emptyMap(m.res, ny, { x: m.originX, y: m.floorY, z: m.originZ });
  const C = m.chunkSize, sub = C / CS;
  for (const ch of m.chunks)
    for (let sz = 0; sz < sub; sz++)
      for (let sx = 0; sx < sub; sx++) {
        let any = false;
        for (let lz = 0; lz < CS && !any; lz++)
          for (let lx = 0; lx < CS; lx++)
            if (ch.observed[(sz * CS + lz) * C + sx * CS + lx]) {
              any = true;
              break;
            }
        for (let j = 0; j < ny && !any; j++) {
          const base = (j + m.floorLayer) * C * C;
          for (let lz = 0; lz < CS && !any; lz++) {
            const row = base + (sz * CS + lz) * C + sx * CS;
            for (let lx = 0; lx < CS; lx++)
              if (ch.occ[row + lx] !== 0) {
                any = true;
                break;
              }
          }
        }
        if (!any) continue;
        const c = getOrCreateChunk(out, ch.cx * sub + sx, ch.cz * sub + sz);
        for (let j = 0; j < ny; j++) {
          const sj = j + m.floorLayer;
          for (let lz = 0; lz < CS; lz++) {
            const src = (sj * C + sz * CS + lz) * C + sx * CS, dst = (j * CS + lz) * CS;
            c.occ.set(ch.occ.subarray(src, src + CS), dst);
            if (ch.underside) (c.underside ??= new Uint8Array(CS2 * ny)).set(ch.underside.subarray(src, src + CS), dst);
            if (ch.topFrac) (c.topFrac ??= new Uint8Array(CS2 * ny).fill(255)).set(ch.topFrac.subarray(src, src + CS), dst);
          }
        }
        for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) c.observed[lz * CS + lx] = ch.observed[(sz * CS + lz) * C + sx * CS + lx];
        // Keep "all default" layers absent (as the persistence layer expects).
        if (c.underside && c.underside.every((v) => v === 0)) c.underside = null;
        if (c.topFrac && c.topFrac.every((v) => v === 255)) c.topFrac = null;
      }
  return out;
}

/**
 * A ChunkedMap as SerializedMap (32-column tiles), with `floorLayer` solid
 * sub-floor layers (127) below the floor.
 */
export function toSerialized(cm: ChunkedMap, floorLayer = 2, C = 32): SerializedMap {
  const sub = C / CS, ny = cm.ny + floorLayer;
  const tiles = new Map<number, SerializedChunk>();
  for (const c of cm.chunks.values()) {
    const tx = Math.floor(c.cx / sub), tz = Math.floor(c.cz / sub);
    const key = chunkKey(tx, tz);
    let t = tiles.get(key);
    if (!t) {
      t = { cx: tx, cz: tz, occ: new Int8Array(C * C * ny), observed: new Uint8Array(C * C) };
      t.occ.fill(127, 0, floorLayer * C * C);
      tiles.set(key, t);
    }
    const sx = c.cx - tx * sub, sz = c.cz - tz * sub;
    for (let j = 0; j < cm.ny; j++)
      for (let lz = 0; lz < CS; lz++) {
        const dst = ((j + floorLayer) * C + sz * CS + lz) * C + sx * CS, src = (j * CS + lz) * CS;
        t.occ.set(c.occ.subarray(src, src + CS), dst);
        if (c.underside) (t.underside ??= new Uint8Array(C * C * ny)).set(c.underside.subarray(src, src + CS), dst);
        if (c.topFrac) (t.topFrac ??= new Uint8Array(C * C * ny).fill(255)).set(c.topFrac.subarray(src, src + CS), dst);
      }
    for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) t.observed[(sz * CS + lz) * C + sx * CS + lx] = c.observed[lz * CS + lx];
  }
  return {
    version: 1,
    res: cm.res,
    chunkSize: C,
    ny,
    originX: cm.origin.x,
    originY: cm.origin.y - floorLayer * cm.res,
    originZ: cm.origin.z,
    floorY: cm.origin.y,
    floorLayer,
    chunks: [...tiles.values()],
  };
}
