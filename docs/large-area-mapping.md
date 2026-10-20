# Large-area mapping: benchmark and hill-climb log

Goal: map whole homes (8×12 m … 15×20 m, several rooms) in one session with
realistic hand-held motion — walking 0.5–1.2 m/s, whip pans of 1.5–4 rad/s,
looking up/down, glancing back, coming back to rooms minutes later — with
odometry drift, relocalisation jumps, tracking loss and blur, and keep the map
right (no ghosts, nothing forgotten) at phone-sized CPU and memory.

## Coordination notes (persistence)

- Map export/import interface: `WorldModel.exportMap(): SerializedMap | null`
  and `WorldModel.importMap(map, transform?, { mode, weight })`, format
  documented in `src/world/MapFormat.ts` (chunked plain typed arrays).
  First committed in **891ecb9**; kept working through the storage change
  (the export now includes the archive outside the live window; import writes
  into the window and the archive). `chunkSize` is a field of the format
  (currently 32); readers should use it rather than assume a value.

## The harness

- `src/sim/House.ts` — multi-room homes: an outer shell split recursively into
  rooms (sometimes with a 1.2 m corridor), interior walls with doorways
  (lintels above), every room furnished by kind (living, kitchen, bedroom,
  study, bath, hall), then dressed (`dressHouse`: blank walls, dark sofas,
  glass tables, clutter, a rug, mirrors and people pacing in some rooms).
  Each room's floor is its own plane, interior walls get vertical planes.
- `src/sim/HouseWalk.ts` — a person touring the home at 30 Hz: nearest-room
  tour, back to the start room, then random revisits; walking 0.5–1.2 m/s on
  A* paths with smoothed heading; look-arounds at each stop with pans of
  1.5–4 rad/s, quick glances back over the shoulder, looking down at the floor
  and up at shelves, crouching. (≈20% of frames turn faster than 1.5 rad/s;
  p95 ≈ 3.2 rad/s.)
- `SimSensor` additions: odometry drift that grows with the path walked
  (`odometry`: ~1%/m position drift with a slowly wandering direction, yaw
  random walk per √m and per √rad turned, applied about the camera), the
  tracker's own loop closures (back within 1 m of a place seen ≥30 s ago it
  snaps its frame back to how it was then), planes detected in the drifted
  frame, and ARCore-style densified depth (`densify`: every hole interpolated,
  no confidence). Profile `house` = `real` + odometry + densify.
- `src/sim/largeArea.ts` (`runLargeArea`) — runs the full game stack (pet
  following the player, health monitor, drift checks with the app's 3 ms
  budget, nav rebuilds) along the walk and scores the map against the truth:
  coverage of truly walkable floor in visited rooms (nav node within 10 cm,
  scored on the *whole* map: window + archive), obstacle precision and ghost
  footprint (map frame = truth frame), falseFree (inside of furniture believed
  seen empty), local precision (obstacle voxels within 3.5 m of the player,
  taken to reality through the *current* frame: what the player sees), frame
  error at the camera, retention (each room's coverage/precision when first
  left vs at the end), memory, and per-frame main-thread CPU (nav builds,
  which run in a worker on the device, reported separately).
- Scripts: `scripts/large-area.ts` (one run; `PNG=` writes a top-down picture,
  `TRACE=1` prints drift/loop decisions and realign before→after errors,
  `PROF=1` per-method timings), `scripts/large-area-batch.ts` (variants in
  parallel + comparison table), `scripts/large-area-suite.sh` (the three
  standard homes).

### How to run

```
npx tsx scripts/large-area.ts 15x20 3 600 house-hard          # one home, 10 min walk
PNG=/tmp/h.png TRACE=1 npx tsx scripts/large-area.ts 10x12 1 300   # picture + drift decisions
PROF=1 QUIET=1 npx tsx scripts/large-area.ts 8x12 4 300        # main-thread hot spots
npx tsx scripts/large-area-batch.ts spec.json /tmp/out 4       # variants in parallel
python3 scripts/large-area-runs.py /tmp/out                    # one line per run
npx tsx scripts/la-local-diag.ts 10x12 1 300                   # what's wrong around the player
npx tsx scripts/perf-window.ts                                 # cost of a window move
```

A batch spec is a JSON list of runs (`house`, `seed`, `seconds`, `profile`,
`env`) or `{ "name": …, "quick": true, "scale": 2, "profile": "house-hard",
"env": {…} }` for the six standard homes (`scale` multiplies the 5-minute
walks). `env` passes options straight to the system under test: `WORLD`
(WorldModel fields, e.g. `{"holdOnConflict":true}`), `DRIFT` (DriftMonitor
options), `HEALTH`, `GATE` (PoseGate), `NOISE` (sensor profile overrides),
`WALK` (walker), `EVERY` (metric interval, s). CPU numbers from parallel
batches are inflated by contention; measure CPU with one run at a time.

## Baseline (the system as found)

Standard suite (house profile at the time: real + odometry, no densify),
three homes, 600/600/900 s walks:

| home | coverage | precision | ghost m² | falseFree | frame err (max) | worst room coverage drop | paths colliding | map MB | CPU mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|
| 10×12 | 23.6% | 58.5% | 1.6 | 0.9% | 23 (79) cm | 57% | 7.5% | 41 | 2.4 / 9.3 / 1364 |
| 12×15 | 21.4% | 70.2% | 2.4 | 3.6% | 29 (45) cm | 36% | 11% | 42 | 2.2 / 7.9 / 1242 |
| 15×20 | 9.1% | 41.6% | 4.4 | 19.7% | 16 (94) cm | 16% | 6.2% | 35 | 2.2 / 7.9 / 1423 |

What the pictures and traces showed:
- everything beyond ±6 m of the start point is dropped (the 15×20 home is
  mostly empty);
- a map reset after a tracking loss wipes the whole home;
- odometry drift doubles walls (red in the pictures) and puts walkable floor
  into walls;
- main-thread spikes of 1–2 s: an unbounded path search when a walk is
  blocked (`guardPath` → A* over the whole graph with jump links).

## Round log

### Round 1 — unbounded map (window + archive), harness fidelity

- Map storage: the dense grid became a *window* of 8×8 chunks (12.8 m) on a
  lattice fixed at session start that follows the camera; chunks leaving it go
  to a `ChunkStore` archive (only chunks with information; underside/topFrac
  stored only when non-trivial), entering ones are restored from it.
  Recovery snapshots are shifted in place (no allocation), the nav graph for
  the new window is built in the background while the old one stays in use.
- Sim fidelity: densified depth (the multi-view gate now has hallucinated
  depth to reject, as on a phone); per-room floor planes; planes in the
  drifted frame.
- Bounded the blocked-path replan (`findPath(…, maxCost, maxExpand)`).
- Measured (10×12, 300 s, house profile with densify): coverage 51% (fixed
  grid) → 68–77% (window); the 15×20 home goes from ~10% to ~39%.

### Round 2 — making the benchmark honest, then fast moves

- The first walker turned instantly at path corners: to the pose gate that
  looked like tracking jumps (28% of depth frames held back). People round
  corners: the walker now accelerates at ≤1.5 m/s². With that fixed, holds
  dropped to ~12% (relocalisation jumps of the `real` profile).
- The first drift model drifted with every metre walked, even pacing inside
  a room the tracker knows well; VIO stays locked onto features it has in
  its local map. Drift now grows at the full rate only through new
  territory (10% near places seen in the last 30 s, 50% near older ones).
- Drift checks were paced by wall-clock ms in the benchmark, which made runs
  depend on machine load; they are now paced by search steps (deterministic).
- Window moves cost ~45 ms (node) per move: archived chunks are now written a
  few per frame from the old (immutable) grid, re-entering chunks are merged
  back a few per frame (newer observations win), next-window arrays are
  allocated ahead, layers are copied in one piece, and only the newest
  recovery snapshot moves along → ~14 ms per move.
- Blocked-path replans could still take ~2 s on a large, detailed map
  (jump links are computed lazily): jumps only when the walk needed them,
  bounded expansions.

Quick suite (six homes, 5 min each, `house` profile) after round 2:
coverage 69%, precision 91%, local precision 94% (noise floor without
odometry drift: 97%), ghosts 3.1 m², falseFree 2.7%, frame error 8 cm
(max 16 cm), map memory 65 MB, main-thread CPU 2.3 ms/frame mean.
A first loop-closure attempt (match the recent frames against structure
not re-observed for 15 s) made things *worse* (frame error 8 → 42 cm): the
moment the camera sees the right copy of a wall again it becomes "recent"
and drops out, leaving only stale ghost copies as "old structure" — so the
check aligned the frame to the ghosts. Fix in round 3: date structure by
when it *became* occupied (`born`), not when it was last seen.

### Round 3 — a harder simulation; dating structure by birth

Made the simulation harder (profile `house-hard`, 10-minute walks): 2.5%/m
odometry drift through new territory with a larger yaw random walk, the
tracker closing its own loops 5× less often, more tracking losses, pans of
2–5 rad/s and more glances back. That breaks the system:

| hard sim, 6 homes × 10 min | coverage | precision | local prec. | ghost m² | falseFree | frame err (max) | resets |
|---|---|---|---|---|---|---|---|
| round-2 system | 65% | 64% | 75% | 6.1 | 18% | 29 (69) cm | 2.2 |

The local imprecision is almost all *old* structure: around the player,
structure observed in the last 15 s is ~90% right, structure from earlier
visits only 50–70% — the frame has drifted against it. Resets (2.2 per
run) are the health monitor reacting to that contradiction by ageing or
clearing the whole window.

- Per voxel the map now keeps two time codes (packed in one Uint32): when
  it last got occupancy evidence (`last`) and when it last *became*
  occupied (`born`); archived sparsely (only voxels with evidence).
- The loop check matches recent frames against structure *born* before them
  (a wall seen again keeps its birth date; a doubled copy laid down by the
  drifted frame is newborn and ignored). With that, loop-closure
  realignments improve the frame error (e.g. 33→6, 23→9, 30→16 cm) instead
  of worsening it — but they fire rarely (0–3 per 10 minutes).
- Loop warp (pose graph lite): after a loop closure, structure last observed
  between the old structure's birth and the closure moves by its share of
  the correction (linear in distance walked), window and archive.
- The tracker's own loop closures (a pose jump after which the view lines up
  with older structure) warp what was mapped in between the same way
  (`jumpWarp`).
- Local recoveries: health resets forget only ~4 m around the player and
  weaken the rest of the window (`localResetRadius`).

### Round 4 — don't write what you can't place (hold on conflict)

The loop check races the mapper: by the time two agreeing estimates exist
(a few seconds), the drifted frames have already laid a second copy of the
room over the first and eroded the original walls they look through. So the
mapper now probes every depth frame before integrating it (~300 sampled
precise readings: does the reading lie in space the map is sure is empty, or
does its ray pass through an occupied voxel well before it?). In normal
operation 0–15% of readings contradict the map; after a 30 cm frame shift
30–100% do. A frame with ≥25% contradicting readings (and ≥40 probed) starts a
*hold*: frames are kept in the replay buffer but not integrated until

- the drift monitor finds the correction (matching the held frames against
  structure born before the hold; a pose jump just before the hold that the
  correction undoes is accepted on weaker support) → the frame is realigned,
  the held frames are replayed corrected, what was mapped since the matched
  structure's birth is warped;
- or a view clearly agrees with the map again, or 3 s pass → the held frames
  go in as they are (then no new hold for 8 s: the map may simply be out of
  date — furniture moved).

Unit test (`test/hold.test.ts`): a silent 30 cm frame shift in a scanned
room is held, resolved (frame error < 8 cm) and leaves no second copy.

(continued below as rounds complete)
