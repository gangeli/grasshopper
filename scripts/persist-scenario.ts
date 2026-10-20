/**
 * Run a scripted sequence of sessions in one home with the memory's log on.
 *   npx tsx scripts/persist-scenario.ts <homeSeed> "0:50,2:50,0+2:120" [noise] [layout]
 * Each item: rooms (joined by +) and seconds.
 */
import { makeHome } from '../src/sim/Home';
import { SimSession, storedMapQuality } from '../src/sim/MultiSession';
import { MapMemory } from '../src/world/persist/MapMemory';
import { MapStore, MemoryKV } from '../src/world/persist/MapStore';
import { composePose, invertPose, poseDelta, type Pose2 } from '../src/world/persist/pose';
import type { NoiseName } from '../src/sim/SimSensor';

const [seedS, plan, noise = 'arcore', layout = '2x2'] = process.argv.slice(2);
const [cols, rows] = layout.split('x').map(Number);
const home = makeHome(Number(seedS), { cols, rows });
const kv = new MemoryKV();
const truths = new Map<string, Pose2>();
let n = 0;
for (const item of plan.split(',')) {
  const [roomsS, secS] = item.split(':');
  const rooms = roomsS.split('+').map(Number);
  const s = new SimSession({ home, rooms, seconds: Number(secS), seed: Number(seedS) * 100 + n++, noise: noise as NoiseName });
  const mem = new MapMemory(await MapStore.open(kv), {
    log: (m) => console.log(`  [${s.t.toFixed(1)}s] ${m}`),
    onRestored: (i) => {
      const ft = truths.get(i.fragment);
      if (!ft) return;
      const truth = composePose(ft, invertPose(s.truth));
      const g = s.world.grid!;
      const d = poseDelta(i.pose, truth, { x: g.origin.x + g.nx * g.res * 0.5, z: g.origin.z + g.nz * g.res * 0.5 });
      console.log(`  >>> restored ${i.fragment} err ${(d.dist * 100).toFixed(1)}cm ${((d.dyaw * 180) / Math.PI).toFixed(2)}°`);
    },
  }, { confirmAfter: 15 });
  await mem.load();
  mem.attach(s.world);
  let lastRoom = -1;
  while (s.step()) {
    mem.tick(s.t, Infinity);
    const p = s.path[Math.min(s.path.length - 1, Math.round(s.t * 10))].cam.pos;
    const r = home.rooms.find((q) => p.x >= q.x0 && p.x <= q.x1 && p.z >= q.z0 && p.z <= q.z1)?.id ?? -1;
    if (r !== lastRoom && r >= 0) {
      console.log(`  [${s.t.toFixed(1)}s] camera in room ${r}`);
      lastRoom = r;
    }
  }
  await mem.flush();
  truths.set(mem.sessionId, s.truth);
  const store = await MapStore.open(kv);
  console.log(`session ${n - 1} rooms ${rooms.join('+')}: links ${mem.links.map((l) => `${l.fragment}${l.confirmed ? '✓' : ''}`).join(' ')} → store ${store.list().map((f) => `${f.id}(${f.area.toFixed(0)}m², ${f.sessions}s)`).join(' ')} last: ${mem.status.lastReason}`);
}
const store = await MapStore.open(kv);
for (const f of store.list()) {
  const m = await store.load(f.id);
  const t = truths.get(f.id);
  if (m && t) console.log(f.id, storedMapQuality(m, home.room, t));
}
