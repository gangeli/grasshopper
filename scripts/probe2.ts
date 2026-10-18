import { livingRoom, bedroom, randomRoom } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { findHideSpots, describeSpot } from '../src/game/HideSpots';
import { segmentObjects } from '../src/world/Segmentation';
import { Rng } from '../src/core/rng';
for (const [name, room] of [['living', livingRoom()], ['bedroom', bedroom()], ['r3', randomRoom(3)]] as const) {
  const { world } = scanRoom(room);
  const nav = new NavGrid(world);
  let t = performance.now();
  const objects = segmentObjects(world);
  console.log(name, 'objects', objects.map(o => `${o.label}@${((o.min.x+o.max.x)/2).toFixed(1)},${((o.min.z+o.max.z)/2).toFixed(1)} h${(o.max.y).toFixed(2)}`).join(' | '), (performance.now()-t)|0, 'ms');
  console.log(' truth', room.pieces.filter(p=>p.label!=='wall').map(p=>`${p.label}@${((p.min.x+p.max.x)/2).toFixed(1)},${((p.min.z+p.max.z)/2).toFixed(1)}`).join(' | '));
  t = performance.now();
  const spots = findHideSpots(nav, {x:0.3,y:0,z:0.3}, {x:0,y:1.45,z:0}, {difficulty:0.5, maxPathCost: 12, previous: [], rng: new Rng(5), objects, eyeHeight: 1.45}, 0);
  console.log(' spots', (performance.now()-t)|0, 'ms');
  for (const s of spots) console.log('  ', s.kind, describeSpot(s), s.pos.x.toFixed(2), s.pos.y.toFixed(2), s.pos.z.toFixed(2), 'cov', s.coverage.toFixed(2), 'score', s.score.toFixed(2), 'truth:', room.pieceAt(s.pos)?.label);
}
