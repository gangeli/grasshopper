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

(continued below as rounds complete)
