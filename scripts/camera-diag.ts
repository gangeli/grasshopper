import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoomHuman } from '../src/sim/scan';
import { CameraSim } from '../src/sim/CameraSim';
import { NavGrid } from '../src/world/NavGrid';
import { writeFileSync } from 'node:fs';
// Per-piece false-free breakdown for camera-depth mapping in one room.
// Usage: npx tsx scripts/camera-diag.ts r37 [secs]
const rooms = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const name = process.argv[2] ?? 'r37';
const idx = rooms.indexOf(name);
const room = dressRoom(roomFromName(name), idx + 1);
console.log('floor', room.floorMaterial);
const { world } = scanRoomHuman(room, { seed: idx + 3, noise: 'real', seconds: Number(process.argv[3] ?? 45), cameraDepth: true, stereo: JSON.parse(process.env.STEREO ?? '{}') });
const g = world.grid!;
for (const pc of room.pieces) {
  if (pc.label === 'wall') continue;
  let shell = 0, free = 0;
  for (const b of pc.boxes)
    for (let y = Math.max(b.min.y, 0.03) + 0.02; y < Math.min(b.max.y, 0.25); y += 0.04)
      for (let x = b.min.x; x <= b.max.x; x += 0.04)
        for (let z = b.min.z; z <= b.max.z; z += 0.04) {
          const edge = Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z, b.max.y - y);
          if (Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.16 || edge < 0.06 || edge > 0.11) continue;
          if (!g.isObserved(g.cellX(x), g.cellZ(z))) continue;
          shell++;
          if (g.data[g.idx(g.cellX(x), g.cellY(y), g.cellZ(z))] < -2) free++;
        }
  if (shell) console.log(pc.label.padEnd(10), pc.boxes.map((b) => b.material ?? 'matte').join(','), `shell ${shell} falseFree ${((free / shell) * 100).toFixed(0)}%`, JSON.stringify(pc.min), JSON.stringify(pc.max));
}
void CameraSim;
const nav = new NavGrid(world);
console.log('floorY', world.floorY.toFixed(3), 'nav nodes', nav.count);
// Top-down: observed (grey), occupied (orange by height), nav nodes (green), true furniture outlines (blue).
const S = 4, nx = g.nx, nz = g.nz, img = Buffer.alloc(nx * nz * S * S * 3, 30);
const put = (i: number, k: number, c: number[]) => { if (i < 0 || k < 0 || i >= nx || k >= nz) return; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(c, ((k * S + y) * nx * S + i * S + x) * 3); };
for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
  if (g.isObserved(i, k)) put(i, k, [70, 70, 70]);
  let top = -1;
  for (let j = world.floorLayer + 1; j < g.ny; j++) if (g.occ(i, j, k)) top = j;
  if (top > 0) { const h = Math.min(1, ((top - world.floorLayer) * g.res) / 1.5); put(i, k, [120 + 135 * h, 110 + 60 * (1 - h), 60]); }
}
for (let a = 0; a < nav.count; a++) put(nav.ni[a], nav.nk[a], [40, 220, 80]);
for (const b of room.boxes) for (let x = b.min.x; x <= b.max.x; x += g.res / 2) for (const z of [b.min.z, b.max.z]) put(g.cellX(x), g.cellZ(z), [80, 140, 255]);
for (const b of room.boxes) for (let z = b.min.z; z <= b.max.z; z += g.res / 2) for (const x of [b.min.x, b.max.x]) put(g.cellX(x), g.cellZ(z), [80, 140, 255]);
writeFileSync(`artifacts/cam/${name}-top.ppm`, Buffer.concat([Buffer.from(`P6 ${nx * S} ${nz * S} 255\n`), img]));
