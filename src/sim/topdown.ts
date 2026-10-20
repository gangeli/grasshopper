import { deflateSync } from 'node:zlib';
import { OCC_THRESHOLD } from '../world/VoxelGrid';
import type { NavGrid } from '../world/NavGrid';
import type { WorldModel } from '../world/WorldModel';
import type { SimRoom } from './SimRoom';

/**
 * Top-down picture of a map against the truth (node only; for debugging the
 * large-area benchmark). 5cm per pixel:
 *   dark grey  real obstacle footprint the map missed
 *   black      mapped obstacle on real geometry
 *   red        mapped obstacle where there is nothing (ghost / doubled wall)
 *   green      walkable nav node at floor level
 *   pale       real floor not covered by the nav graph
 *   blue       camera path
 */
export function renderTopDown(world: WorldModel, nav: NavGrid | null, room: SimRoom, path: { x: number; z: number }[], cell = 0.05): Buffer {
  const W = Math.ceil(room.width / cell) + 8, H = Math.ceil(room.depth / cell) + 8;
  const x0 = -room.halfW - 4 * cell, z0 = -room.halfD - 4 * cell;
  const px = new Uint8Array(W * H * 3).fill(255);
  const set = (i: number, k: number, r: number, g: number, b: number) => {
    if (i < 0 || k < 0 || i >= W || k >= H) return;
    const q = (k * W + i) * 3;
    px[q] = r;
    px[q + 1] = g;
    px[q + 2] = b;
  };
  const grid = world.grid!;
  const solidCol = (x: number, z: number, pad: number) => {
    for (const b of room.boxes) if (b.max.y > 0.05 && b.min.y < 1.2 && x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
    return false;
  };
  const j0 = world.floorLayer + 1, j1 = Math.min(grid.ny - 1, grid.cellY(world.floorY + 1.2));
  for (let k = 0; k < H; k++)
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * cell, z = z0 + (k + 0.5) * cell;
      const real = solidCol(x, z, 0);
      let mapped = false;
      const gi = grid.cellX(x), gk = grid.cellZ(z);
      if (gi >= 0 && gk >= 0 && gi < grid.nx && gk < grid.nz) for (let j = j0; j <= j1 && !mapped; j++) if (grid.data[grid.idx(gi, j, gk)] > OCC_THRESHOLD) mapped = true;
      if (mapped) {
        if (solidCol(x, z, 0.08)) set(i, k, 0, 0, 0);
        else set(i, k, 230, 30, 30);
      } else if (real) set(i, k, 110, 110, 110);
      else set(i, k, 235, 228, 210);
    }
  if (nav)
    for (let a = 0; a < nav.count; a++) {
      const p = nav.pos(a);
      if (Math.abs(p.y - world.floorY) > 0.05) continue;
      const i = Math.floor((p.x - x0) / cell), k = Math.floor((p.z - z0) / cell);
      const q = (k * W + i) * 3;
      if (i >= 0 && k >= 0 && i < W && k < H && px[q] !== 0 && px[q] !== 230) set(i, k, 90, 190, 90);
    }
  for (const p of path) set(Math.floor((p.x - x0) / cell), Math.floor((p.z - z0) / cell), 40, 80, 230);
  // Scale up 3x for viewing.
  const S = 3, out = new Uint8Array(W * S * H * S * 3);
  for (let k = 0; k < H * S; k++)
    for (let i = 0; i < W * S; i++) {
      const q = ((k / S | 0) * W + (i / S | 0)) * 3, d = (k * W * S + i) * 3;
      out[d] = px[q];
      out[d + 1] = px[q + 1];
      out[d + 2] = px[q + 2];
    }
  return encodePNG(W * S, H * S, out);
}

/** Minimal RGB PNG encoder. */
export function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let table: Int32Array | null = null;
function crc32(b: Buffer): number {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
