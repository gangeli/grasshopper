import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoomHuman } from '../src/sim/scan';
import { NavGrid, DEFAULT_NAV } from '../src/world/NavGrid';
import { WorldModel } from '../src/world/WorldModel';
import { DepthConsistency } from '../src/world/DepthFrame';
import { Rng } from '../src/core/rng';
import { pathPenetration } from '../src/sim/MapMetrics';
import { whyNotWalkable } from './nav-why';
// Why isn't truly free floor walkable? Classifies every floor column whose pet-sized
// neighbourhood is really empty by the first nav requirement it fails.
// Usage: CAMERA=1 npx tsx scripts/nav-diag.ts <room> [seconds]
const name = process.argv[2] ?? 'living';
const secs = Number(process.argv[3] ?? 45);
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const idx = CANON.indexOf(name);
const room = dressRoom(roomFromName(name), idx + 1);
const w0 = new WorldModel();
Object.assign(w0, JSON.parse(process.env.WORLD ?? '{}'));
if (process.env.MULTIVIEW) w0.multiView = new DepthConsistency(JSON.parse(process.env.MULTIVIEW === '1' ? '{}' : process.env.MULTIVIEW));
const { world, camera } = scanRoomHuman(room, { seed: idx + 3, noise: 'real', seconds: secs, world: w0, cameraDepth: !!process.env.CAMERA, cameraEvery: Number(process.env.CAMERA_EVERY ?? 2), stereo: JSON.parse(process.env.STEREO ?? '{}') });
if (camera) console.log(`camera: ${camera.frames} frames, ${camera.depthFrames} with depth; floorY ${world.floorY.toFixed(3)} refined ${world.floorRefinements}x, recoveries ${JSON.stringify(world.recoveries)}`);
room.time = 1e6;
const P = { ...DEFAULT_NAV, ...JSON.parse(process.env.NAV ?? '{}') };
const nav = new NavGrid(world, P);
const g = world.grid!, r = g.res;
const counts: Record<string, number> = {};
let truthFree = 0;
for (let k = 0; k < g.nz; k++)
  for (let i = 0; i < g.nx; i++) {
    const x = g.centerX(i), z = g.centerZ(k);
    if (Math.abs(x) > room.halfW - 0.05 || Math.abs(z) > room.halfD - 0.05) continue;
    let free = true;
    for (let dy = 0.03; dy < P.standHeight && free; dy += 0.05) if (room.solidAt({ x, y: dy, z }, P.radius + 0.02)) free = false;
    if (!free) continue;
    truthFree++;
    const why = whyNotWalkable(world, nav, i, k);
    counts[why] = (counts[why] ?? 0) + 1;
  }
let raised = 0;
for (let a = 0; a < nav.count; a++) if (nav.ny[a] > world.floorY + 0.1) raised++;
console.log(`${name}: truly free floor ${(truthFree * r * r).toFixed(1)} m², walkable ${(nav.count * r * r).toFixed(1)} m² (raised ${(raised * r * r).toFixed(1)} m²)`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${(v * r * r).toFixed(2)} m² (${((v / truthFree) * 100).toFixed(0)}%)`);
// False-free shell samples by piece (same sampling as MapMetrics.falseFree).
const ff: Record<string, number[]> = {};
for (const b of room.boxes) {
  const pc = room.pieces[b.piece];
  if (pc.label === 'wall') continue;
  const w = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
  const key = `${pc.label}#${b.piece}(${b.material ?? 'matte'}, y ${b.min.y.toFixed(2)}-${b.max.y.toFixed(2)})`;
  for (let y = Math.max(b.min.y, 0.03) + 0.02; y < Math.min(b.max.y, 0.25); y += 0.04)
    for (let x = b.min.x; x <= b.max.x + 1e-6; x += 0.04)
      for (let z = b.min.z; z <= b.max.z + 1e-6; z += 0.04) {
        const edge = Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z);
        if (!g.isObserved(g.cellX(x), g.cellZ(z)) && !g.isObserved(g.cellX(x + 0.1), g.cellZ(z)) && !g.isObserved(g.cellX(x - 0.1), g.cellZ(z))) continue;
        if (!(w >= 0.16 && edge > 0.06 && edge < 0.11)) continue;
        ff[key] ??= [0, 0, 0];
        ff[key][0]++;
        const v = g.data[g.idx(g.cellX(x), g.cellY(y), g.cellZ(z))];
        if (v < -2) {
          ff[key][1]++;
          if (y < 0.1) ff[key][2]++;
        }
      }
}
let S = 0, B = 0;
for (const [k, v] of Object.entries(ff)) {
  S += v[0];
  B += v[1];
  if (v[1]) console.log(`  falseFree ${k}: ${v[1]}/${v[0]} (below 10cm: ${v[2]})`);
}
console.log(`  falseFree total ${B}/${S} = ${((B / Math.max(1, S)) * 100).toFixed(1)}%`);
{
  // Nav nodes where the pet's body would be inside real furniture, by object.
  const byObj: Record<string, number> = {};
  let bad = 0;
  for (let a = 0; a < nav.count; a++) {
    const p = nav.pos(a);
    const w = { ...p, jump: false, node: a };
    if (pathPenetration(room, [w, w]) <= 0.02) continue;
    bad++;
    let best = '?', bp = 0;
    for (const bx of room.boxes) {
      const pen = pathPenetration({ ...room, boxes: [bx] } as typeof room, [w, w]);
      if (pen > bp) {
        bp = pen;
        best = room.pieces[bx.piece].label;
      }
    }
    byObj[best] = (byObj[best] ?? 0) + 1;
  }
  console.log(`  nodes colliding ${bad}/${nav.count}: ${JSON.stringify(byObj)}`);
}
if (process.env.PATHDIAG) {
  // Which real objects do sampled paths collide with, and where do bad landings land?
  const rng = new Rng(3);
  const hits: Record<string, number> = {};
  const what = (p: { x: number; y: number; z: number }) => {
    for (const b of room.boxes) if (p.x > b.min.x - 0.12 && p.x < b.max.x + 0.12 && p.z > b.min.z - 0.12 && p.z < b.max.z + 0.12 && p.y < b.max.y + 0.05) return `${room.pieces[b.piece].label}(${b.material ?? 'matte'}) y${b.min.y.toFixed(2)}-${b.max.y.toFixed(2)}`;
    return 'nothing';
  };
  for (let q = 0, tested = 0; q < 1200 && tested < 400; q++) {
    const a = rng.int(0, nav.count - 1), b = rng.int(0, nav.count - 1);
    const path = nav.pathBetween(a, b);
    if (!path || path.length < 2) continue;
    tested++;
    for (let s = 1; s < path.length; s++) {
      if (pathPenetration(room, [path[s - 1], path[s]]) > 0.02) {
        // The box penetrated most along the segment.
        let best = 'nothing', bp = 0;
        for (const bx of room.boxes) {
          const solo = { ...room, boxes: [bx] } as typeof room;
          const pen = pathPenetration(solo, [path[s - 1], path[s]]);
          if (pen > bp) {
            bp = pen;
            best = `${room.pieces[bx.piece].label}(${bx.material ?? 'matte'}) y${bx.min.y.toFixed(2)}-${bx.max.y.toFixed(2)}`;
          }
        }
        const k = `collide ${path[s].jump ? 'jump' : 'walk'} with ${best} at ${path[s].x.toFixed(1)},${path[s].z.toFixed(1)}`;
        hits[k] = (hits[k] ?? 0) + 1;
        break;
      }
    }
    for (const w of path)
      if (w.jump) {
        const sup = room.boxes.filter((b) => w.x > b.min.x - 0.03 && w.x < b.max.x + 0.03 && w.z > b.min.z - 0.03 && w.z < b.max.z + 0.03).map((b) => b.max.y);
        if (Math.abs(w.y) < 0.2) sup.push(0);
        if (!sup.some((y) => Math.abs(y - w.y) <= 0.06)) {
          const k = `bad landing y=${w.y.toFixed(2)} at ${w.x.toFixed(2)},${w.z.toFixed(2)} near ${what(w)}`;
          hits[k] = (hits[k] ?? 0) + 1;
        }
      }
  }
  for (const [k, v] of Object.entries(hits).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)} ${k}`);
}
