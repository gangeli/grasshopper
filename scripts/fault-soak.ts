import { runSoak } from '../src/sim/soak';
import type { FaultKind } from '../src/sim/Faults';
// Usage: npx tsx scripts/fault-soak.ts <room> <seed> <seconds> [faults,comma,list]
const [room, seed, secs] = [process.argv[2] ?? 'living', Number(process.argv[3] ?? 1), Number(process.argv[4] ?? 300)];
const faults = process.argv[5] ? (process.argv[5].split(',') as FaultKind[]) : undefined;
const t0 = performance.now();
// CAMERA=1: depth from rendered camera images via motion stereo (no depth sensor).
const r = runSoak(room, seed, secs, { faults, faultEvery: process.env.EVERY ? (JSON.parse(process.env.EVERY) as [number, number]) : undefined, ...(process.env.CAMERA ? { depthFrom: 'camera' as const, stereo: JSON.parse(process.env.STEREO ?? '{}') } : {}) });
console.log(`${room} s${seed}: ${secs}s simulated in ${((performance.now() - t0) / 1000).toFixed(0)}s | rounds ${r.rounds} | longest stall ${r.longestStall.toFixed(0)}s | pet inside furniture ${r.insideTime.toFixed(1)}s (longest ${r.longestInside.toFixed(1)}s, in view ${r.insideVisibleTime.toFixed(1)}s) | NaN frames ${r.nanFrames} | map precision ${(r.mapPrecision * 100).toFixed(0)}% | abs frame err ${(r.finalFrameError * 100).toFixed(1)}cm floor err ${(r.finalFloorError * 100).toFixed(1)}cm | errors ${r.errors.length}`);
console.log('  precision timeline: ' + r.precisionTimeline.map((x) => `${x.t.toFixed(0)}s:${(x.p * 100).toFixed(0)}%`).join(' '));
for (const f of r.faults) console.log(`  FAULT ${f.t.toFixed(0)}s ${f.kind}: ${f.what}`);
for (const h of r.recoveries) console.log(`  RECOVER ${h.t.toFixed(0)}s ${h.issue}: ${h.detail}`);
for (const e of r.errors) console.log(`  ERROR ${e}`);
if (process.env.TRACE) for (const l of r.driftTrace) console.log('  DRIFT', l);
