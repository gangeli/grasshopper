import { livingRoom } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
const room = livingRoom();
const { world } = scanRoom(room);
const nav = new NavGrid(world);
const g = world.grid!;
let bad = 0, samples: string[] = [];
for (let a = 0; a < nav.count; a++) {
  const p = nav.pos(a);
  if (room.solidAt({ x: p.x, y: p.y + 0.1, z: p.z }, 0.02)) { bad++; if (samples.length < 10) samples.push(`${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} ${room.pieceAt(p)?.label}`); }
}
console.log('nodes', nav.count, 'inside solid', bad, samples);
const i = g.cellX(2.83), k = g.cellZ(0.83);
const col = []; for (let j = 0; j < 45; j++) col.push(g.get(i, j, k));
console.log('column', col.join(' '));
