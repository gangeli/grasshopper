import { livingRoom } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
for (const caps of [{depth:true,planes:true,mesh:false},{depth:false,planes:false,mesh:true},{depth:false,planes:true,mesh:false}]) {
  const room = livingRoom();
  let t=performance.now();
  const { world } = scanRoom(room, caps);
  const t1=performance.now()-t; t=performance.now();
  const nav = new NavGrid(world);
  const t2=performance.now()-t;
  const hist: Record<string,number> = {};
  for (let a=0;a<nav.count;a++){ const h=(Math.round(nav.ny[a]*20)/20).toFixed(2); hist[h]=(hist[h]||0)+1; }
  console.log(JSON.stringify(caps), 'scan', t1.toFixed(0),'ms nav',t2.toFixed(0),'ms nodes',nav.count, 'occ', world.grid!.countOccupied(), hist);
  t=performance.now();
  const path = nav.findPath({x:0,y:0,z:0},{x:2.57,y:0.05,z:1.95});
  console.log(' basket path', performance.now()-t|0,'ms', path?.map(w=>`${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}${w.jump?'J':''}`).join(' '));
  const p2 = nav.findPath({x:0,y:0,z:0},{x:1.85,y:0.74,z:-1.7});
  console.log(' tabletop path', p2?.map(w=>`${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}${w.jump?'J':''}`).join(' '));
}
