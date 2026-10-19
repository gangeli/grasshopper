import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoomHuman } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { evaluateMap } from '../src/sim/MapMetrics';
import { NOISE_PROFILES, type NoiseProfile } from '../src/sim/SimSensor';
const base = NOISE_PROFILES.real as NoiseProfile;
const variants: [string, Partial<NoiseProfile>][] = [
  ['real (all)', {}],
  ['- persistent bias', { persistentBias: 0 }],
  ['- reloc jumps', { relocRate: 0, lossRate: 0 }],
  ['- drift/jitter', { driftPos: 0, driftRot: 0, jitterPos: 0, jitterRot: 0 }],
  ['- materials', { materials: false }],
  ['- pixel noise', { sigmaA: 0.002, sigmaB: 0.002, flyingPixels: 0, outliers: 0 }],
];
const rooms = (process.argv[2] ?? 'r3,r7,r19').split(',');
const idxOf: Record<string, number> = { living: 0, bedroom: 1, r3: 2, r7: 3, r11: 4, r19: 5 };
for (const [label, over] of variants) {
  let ff = 0, coll = 0, pen = 0, bad = 0, jumps = 0;
  for (const name of rooms) {
    const idx = idxOf[name] ?? 0;
    const room = dressRoom(roomFromName(name), idx + 1);
    const { world, eyes } = scanRoomHuman(room, { seed: idx + 3, noise: { ...base, ...over }, seconds: 45 });
    room.time = 1e6;
    const nav = new NavGrid(world);
    const m = evaluateMap(world, nav, room, { paths: 100, eyes });
    ff += m.falseFree / rooms.length;
    coll += m.pathsColliding / m.pathsTested / rooms.length;
    pen = Math.max(pen, m.pathMaxPenetration);
    bad += m.jumpsBadLanding;
    jumps += m.jumpsTested;
  }
  console.log(`${label.padEnd(20)} falseFree ${(ff * 100).toFixed(1)}%  pathsColliding ${(coll * 100).toFixed(1)}%  maxPen ${(pen * 100).toFixed(0)}cm  badLandings ${bad}/${jumps}`);
}
