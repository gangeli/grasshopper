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
