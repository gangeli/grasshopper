# Large-area mapping, round 2: results log

Continuation of `docs/large-area-mapping.md` (round 1, "rounds 1–8" there).
Same harness (`scripts/large-area*.ts`), same homes. Unless noted, numbers
are means over the six "quick" homes (`10x12 s1, 12x15 s2, 15x20 s3, 8x12
s4, 10x12 s5, 14x16 s6`):

- **hard**: `house-hard` profile, 600 s walks, fast pans (`WALK={"panSpeed":[2,5],"glanceRate":0.15}`);
- **easy**: `house` profile, 300 s walks, default walk;
- **cam**: as hard, camera-only depth (`CAMERA=1`, motion stereo instead of a depth API);
- **jumps**: as hard, plus `house-jumps`: 20% of tracking losses end with the
  tracker's frame persistently moved by up to 70 cm / ±0.2 rad (new this round).

CPU columns are from parallel batches on a loaded 4-core box (other agents
running): only comparable within one table, not with round 1's numbers.

Run a table: `npx tsx scripts/large-area-batch.ts spec.json <out> 4` then
`python3 scripts/la-table.py <out>`. To keep a batch's code fixed while
editing, run it from a snapshot: `cd "$(scripts/la-snap.sh name)" && npx tsx scripts/large-area-batch.ts …`.

## Baseline (round 1 as merged, 0be7f4c)

| run | n | cover% | prec% | local% | ghost m² | falseFree% | frameErr cm (max) | pathColl% | resets | detach/reattach | loops | memMB | cpu mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| easy | 6 | 70.1 | 91.2 | 94.4 | 3.1 | 2.9 | 8 (16) | 13.5 | 0.2 | – | 0.0 | 66 | 8.5/32.1/530 |
| hard | 6 | 75.2 | 73.3 | 75.2 | 6.1 | 18.2 | 20 (64) | 24.8 | 1.2 | – | 0.0 | 67 | 8.0/30.1/647 |

## Log

(continued below as changes land)

### 1. Window/archive race (fixed first, own commit c3aacae)

Found by the persistence agent: an archived chunk that re-entered the
window (queued for merging back) and left again before it was merged was
archived from the window, where it was still blank: its data was deleted.
Two window moves within a few frames (fast walking, a tracking jump and its
undo) trigger it. Fixed by merging such a chunk before archiving it.
Auditing the rest of the window/archive path found the same class of race
after a realignment that restores a snapshot taken before a window move
(chunks merged back since are blank in the snapshot): archived window chunks
are re-queued for merging after a restore. `hardReset` forgets pending
chunks explicitly. Regression tests: `test/window.test.ts` (rapid
back-and-forth moves with and without merges in between). The harness got
`CHURN=<rate/s>` (window jerked a chunk away and back, no merge in between),
on in all harder specs from here on.

### 2. Why loop closure never fired

- **The round-8 diagnostic was wrong.** `la-loop-truth` put the "true"
  correction at the room origin instead of at the camera (it read `.x` of the
  depth *image*), so with yaw drift the true translation was off by
  yaw × distance from the origin (tens of cm). Fixed; with the fix the
  voxel-map ("aged structure") estimator still has a median error of 17 cm
  on the 15×20 home (28 candidates, 9 within 10 cm): matching against every
  generation of the old structure at once is the real problem, as round 8
  suspected.
- **Place memory** (`src/world/PlaceMemory.ts`): settled depth frames (10 s
  old, after holds/realigns have corrected them) are kept as small submaps
  (cells hit by ≥2 frames of ≤3 s / ≤1.5 m of camera motion, with the view
  headings): one generation each. Loop closure aligns the last ~3 s of frames
  with the submaps of *one earlier visit* (runs of submaps close in time,
  seen from within ~2 m, looking the same way): coarse 10 cm / 0.05 rad
  lattice → local maxima → point-to-plane ICP on the best peaks. Warps and
  realignments move submaps with the map.
- Two bugs found on the way with the simulator's ground truth: submaps were
  starved (a cell had to be *occupied* in the voxel map when settled; most
  wall voxels seen from 2 m never reach the threshold: 500 cells for 30 s of
  scanning) — now only cells the map has since seen *through* are dropped;
  and the soft count used to compare corrections is flat over a voxel or two
  (walls come out two voxels thick), so the coarse peak sat up to 5 cm /
  0.06 rad off: ICP refines it (the unit test's 25 cm / 0.06 rad drift is
  recovered to < 1 cm / 0.001 rad).
- **And the reason loop closure never fired at all:** `loopPendingSeconds`
  was 0 ("no candidate persistence", round 6), but the same option is the
  window in which a first estimate waits for a second, agreeing one, so the
  pending candidate was dropped at the next check and two estimates could
  never agree (unless both checks fell on the same depth frame, which is why
  camera-only runs, with their sparse depth frames, did close a loop now and
  then — and badly: 3 → 37 cm frame error in the 10×12 baseline). Now 8 s.

### 3. Tracking resets that move the frame for good

New sim pieces: `house-jumps` profile (20% of tracking losses end with the
tracker's frame persistently moved by up to 70 cm / ±0.2 rad, as when ARCore
relocalises wrongly or restarts its map), and scripted jumps for directed
tests (`JUMPS=[{"t":200,"dx":0.6,"dz":-0.4,"dyaw":0.15}]`).

What a 72 cm / 0.15 rad jump did (12×15 home, before the fixes below): the
post-loss check compares new frames with a copy of the map taken at the
loss, but that copy is dropped whenever the window moves (every 1–2 m of
walking), so 60 of 70 post-loss checks said "no estimate"; holds found
nothing to match; no verdict, no reset: the map absorbed the jumped frame
(frame error 1.8 m — a yaw jump turns the world about where it happened —
local precision 22%, falseFree 38%).

- Post-loss checks fall back to place memory (frames since the loss vs.
  visits from before it, ±1 m / ±0.3 rad).
- **Detach instead of clear** (W2): when the health monitor gives up on the
  map (unresolved jump, contradictions that persist after ageing), the whole
  map — window and archive — and its place memory are put aside
  (`WorldModel.detachMap`) and mapping restarts fresh. Every 4 s the drift
  monitor relocalises the recent frames (8 s since the detach) against the
  dormant place memory (±1 m / ±0.3 rad, ICP-refined, two agreeing
  estimates); on success `reattach` makes the old map the map again
  (registration corrected, archive back, the frames since the detach
  re-integrated a few per frame, place memories merged) and the pet is
  re-anchored. `test/reattach.test.ts`: a 57 cm / 0.12 rad jump in a scanned
  room → reattached within 10 s, frame error < 8 cm, no second copy.

### 4. Loop closure that fires — and why it is off again

With `loopPendingSeconds` fixed and place memory, loop closures fire (1–3
per 10-minute walk). They make the map worse. Bisect, house-hard, fast
pans, four homes (10×12 s1, 12×15 s2, 14×16 s6, 8×12 s4) × 600 s:

| arm | cover% | prec% | local% | ghost m² | falseFree% | frameErr cm (max) | pathColl% | resets | loops |
|---|---|---|---|---|---|---|---|---|---|
| off (all round-2 loop changes off) | 75.9 | 69.3 | 73.4 | 7.1 | 15.6 | 23 (74) | 33.4 | 2.0 | 0 |
| place loops + warp | 70.0 | 55.5 | 69.1 | 9.9 | 18.0 | 43 (94) | 48.4 | 2.8 | 2.5 |
| place loops, no warp | 70.2 | 52.7 | 65.4 | 11.0 | 18.4 | 33 (84) | 41.6 | 3.0 | 2.2 |
| place loops, warp last 30 s only | 64.9 | 52.1 | 66.4 | 12.5 | 21.6 | 56 (101) | 32.5 | 3.2 | 2.8 |

(Six homes, same story: with the post-loss place fallback and detach, prec
59.5%; with a wider search, 62.0%; baseline 73.3%.)

What the ground truth says (`la-loop-truth`, now trustworthy: truth at the
camera, per-frame truth through realignments and re-attaches, submaps
bookkept from creation, and each matched visit's cells checked against the
real geometry — 66–82% of them land on it, so the bookkeeping is right):

- of 51 realignments in these runs, 30 reduced the frame error (often a lot:
  −46, −55, −130 cm), 17 increased it, four by 54–96 cm;
- when the estimator finds the right correction it is accurate (2–9 cm,
  e.g. a 57 cm / 0.1 rad drift recovered to 4 cm);
- but there are confident wrong ones that no single-look test separates:
  e.g. 89% of the readings land on the visit after a correction that is
  1.5 m off the truth, unique (no other peak), well constrained, with the
  right yaw. The visit was picked by where the camera *thinks* it is; with
  1.1 m of real drift the right place was outside it and a look-alike (walls,
  a doorway, furniture of the same kind) was inside. Support, uniqueness,
  ICP constraint, a drift bound on the search range and a free-space check
  (the visit's structure must not land where the camera sees empty space)
  were all tried against the labelled estimates; none separates them.
- Even right closures cost local precision when the drift built up unevenly:
  the warp spreads the correction linearly over the walk since the visit and
  moves structure that was mapped right (8×12 s4: a closure that cut the
  frame error 43 → 16 cm took precision 95% → 50%); without the warp, the
  recent map near the player is left offset and holds fight the corrected
  frame.

So the defaults keep loop closure off (`placeLoop: false`,
`loopPendingSeconds: 0`), as in round 1, but now knowingly; all of it is
there as options (`DRIFT={"placeLoop":true,"loopPendingSeconds":8,...}`).
What it needs next: a real pose graph (per-submap poses with odometry edges
between consecutive submaps and loop edges, solved, then the voxel map
re-rendered or warped per submap instead of linearly), and aliasing
protection from more than one look (two different earlier visits, or a
look from a clearly different view, must agree).

### 5. Shielded carving (falseFree, resets) — on by default

A ray that passes through a confidently occupied voxel now erodes that
voxel but carves nothing behind it (`VoxelGrid.shieldedCarving`): a reading
behind a surface the map is sure of is more often wrong (interpolated depth
across a dark sofa, a flying pixel, a drifted frame) than proof that the
space behind is empty; if the surface really is gone, it erodes first and
then the space behind clears.

| house-hard, 4 homes × 600 s | cover% | prec% | local% | ghost m² | falseFree% | frameErr cm (max) | pathColl% | resets |
|---|---|---|---|---|---|---|---|---|
| before | 75.9 | 69.3 | 73.4 | 7.1 | 15.6 | 23 (74) | 33.4 | 2.0 |
| shielded carving | 80.1 | 72.3 | 74.8 | 6.6 | 17.5 | 10 (70) | 40.9 | 0.0 |

The big effect is indirect: drifted frames no longer carve through the old
map, so contradictions never build up to a "map contradictory → evidence
aged / cleared" reset (2.0 → 0 per run), and the map keeps its coverage and
its frame. falseFree did not improve (15.6 → 17.5%; per piece it is mostly
crates, plants and the dark couch, see `scripts/la-falsefree.ts`), nor did
the share of sampled pet paths touching furniture (more of the map is
walkable, so more paths are tested in hard places).

### 6. The jump sim breaks the system

`house-jumps` (6 persistent jumps of 0.2–0.7 m / up to ±0.2 rad in 10 min)
on the four homes:

| arm | cover% | prec% | local% | falseFree% | frameErr cm (max) | pathColl% |
|---|---|---|---|---|---|---|
| clear on unresolved jumps (round 1 behaviour) | 63.0 | 63.1 | 40.5 | 32.7 | 151 (244) | 62.6 |
| detach instead of clear | 62.4 | 61.2 | 41.0 | 36.3 | 151 (244) | 63.0 |
| + post-loss place check (unrestricted) | 68.3 | 51.7 | 40.5 | 38.8 | 159 (258) | 78.4 |

Local precision 40% and frame errors of 1.5 m: jumps pile up and nothing
undoes them in the homes, although the directed tests do (`test/jump.test.ts`:
a 54 cm / 0.15 rad and a 42 cm / 0.25 rad jump in a scanned room, corrected
to < 8 / < 10 cm by the post-loss place check; `test/reattach.test.ts` for
detach → re-attach). Detaches happen rarely (0.5 per run) and did not
re-attach in the homes. The unrestricted post-loss place check also fired
on ordinary losses (drift, no jump) and then behaved like the loop closure
of §4 (house-hard precision 69.3 → 66.1%); it is now trusted only when it
undoes a position jump the pose gate saw at the loss.

### 7. Camera-only depth

`scripts/la-coverage-why.ts` (10×12, camera-only, 300 s): of the truly
walkable floor, 50% covered, 4% floor never observed, **42% floor observed
but the space just above it never seen empty** (motion stereo rarely
measures the floor itself, so rays don't carve the first 25 cm above it),
2% blocked by a mapped obstacle. Allowing one seen-empty voxel instead of
two (`WorldModel.navParams`, `CameraDepthSource.sparseNav`) changed nothing
(26.6 vs 26.5% on 10×12 + 12×15, 400 s): those columns have none. Off.
Separately, camera-only never establishes walkable floor in the 12×15 home
(0 m² for 90 s, 2% after 400 s — same in the baseline): a floor/plane
problem there, not a density one. Camera-only stays at the baseline's 23%
(six homes, 600 s: 23.2% coverage, 68.8% precision).

### 8. CPU

Same two runs (12×15 s2 and 10×12 s1, 300 s, house-hard) of the baseline and
the final code, side by side on the same loaded machine (ms per frame, main
thread, wall clock): 4.93/16.7/495 → 5.59/18.9/377 and 4.20/15.7/196 →
4.26/15.5/513 (mean/p95/max). Place memory adds ~0.2 ms per depth frame
(settling) and the post-loss place check is spread over frames (each step
under ~10 ms CPU on this box; `scripts/perf-warp.ts` measures in CPU time).
Loop warps, when enabled, are now spread over frames (a warp over a 12×15
home was 260 ms in one go). The large spikes in both columns are pre-existing
(blocked-path replans, floor re-levelling, realignment replays —
`WorldModel.sliceReplays` spreads the latter but is off pending an A/B).

## Where it stands (round 2)

| house-hard, fast pans, 600 s | cover% | prec% | local% | ghost m² | falseFree% | frameErr cm (max) | pathColl% | resets |
|---|---|---|---|---|---|---|---|---|
| baseline, six homes | 75.2 | 73.3 | 75.2 | 6.1 | 18.2 | 20 (64) | 24.8 | 1.2 |
| baseline, the four A/B homes | 75.9 | 69.3 | 73.4 | 7.1 | 15.6 | 23 (74) | 33.4 | 2.0 |
| round 2, the four A/B homes | 80.1 | 72.3 | 74.8 | 6.6 | 17.5 | 10 (70) | 40.9 | 0.0 |
| house-jumps (new), round-1 behaviour | 63.0 | 63.1 | 40.5 | 8.9 | 32.7 | 151 (244) | 62.6 | 2.8 |
| house-jumps, round 2 | 71.9 | 56.6 | 39.2 | 14.1 | 24.4 | 192 (263) | 55.3 | 0.0 |

Remaining, in order of how much they hurt:
1. Persistent tracking jumps in a real walk (house-jumps) still wreck the
   map: corrected in directed tests, but in the homes the post-loss checks
   rarely find a clear, unique match, jumps pile up beyond the ±1 m search,
   and a detached map has not re-attached once.
2. Loop closure: estimator accurate when right, but perceptual aliasing
   gives confident wrong matches, and the linear warp damages a map whose
   drift built up unevenly. Needs a pose graph over submaps and multi-look
   verification (§4). Off.
3. falseFree ~17% (crates, plants, the dark couch) and ~40% of sampled pet
   paths touching furniture in the hard profile.
4. Camera-only depth: 23% coverage; the floor isn't carved (§7).
