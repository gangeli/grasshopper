# Large-area mapping, round 5: registering the old map to the current view

Continuation of `docs/large-area-round4.md`. Round 4 ended with: odometry
drift is essentially the whole remaining problem (with drift switched off,
local precision is 96% and local falseFree 0.6%); free space carries no
time, so it can't follow corrections. This round:

1. **continuous local re-registration**: the old map within 4 m of the
   player is matched to the latest depth (plan view, small search) and
   moved onto it, a little at a time;
2. **per-voxel free times**, so that old free space can move with the
   structure it was seen in front of (local registration and submap warps);
3. drift-aware rules: old free space by **distance walked** instead of
   time; weakening only *old* free space behind a surprising surface;
4. harder sims: a tracker that **never closes its own loops**; tracking
   jumps (house-jumps).

**Outcome in one line**: local registration measurably fixes the local map
each time it fires, and is a clear net win when the tracker doesn't close
its own loops (local precision +4.7 ± 1.3, pet paths into furniture −1.2 ±
0.3) — but with the house-hard tracker, which snaps its frame back on
revisits 5–19 times per walk, it is slightly negative (local −1.7 ± 1.0,
hide spots inside furniture +0.9 ± 0.4). Nothing in this round is turned on
by default. All of it is there as options, measured below.

## Harness

- Same ten homes as rounds 3–4 (`"ten": true`), 600 s, fast pans,
  `house-hard` unless noted; paired differences per home, mean ± standard
  error (`scripts/la-table3.py --ref`).
- `artifacts/r5/run.sh <spec>` (not committed) snapshots the tree
  (`scripts/snap.sh`) and runs a spec; ten homes × one arm ≈ 7 minutes on
  four cores.
- Every local registration is scored against the truth
  (`events.localReg.regs` in the report; `scripts/la-reg.py`,
  `scripts/la-reg-rules.py`):
  - `need` / `got` / `err`: where the matched old structure really belongs
    in the current frame (map → truth when it was laid down, truth → map
    now), how far the estimate moves it, and how far from where it belongs
    it ends up, 1.5 m around the camera;
  - `pre` / `post` ("on-real"): the share of the old structure's footprint
    (the registration's reference, within 3 m) on real structure through
    the current frame, before and after the move;
  - `lp0` / `lp1`, `ff0` / `ff1`: local precision and local falseFree just
    before the move and just after it has been applied.
- `TRACE=reg` prints every estimate with those scores; `LOOPDIAG=1` scores
  the local map at each of the tracker's own loop closures and 2 / 10 s
  after; `ORACLE_FOLLOW=1` hands the tracker's loop closures to local
  registration exactly (sim truth).

## Reference arms (this round's build, defaults = round 4)

| arm | n | cover% | nav3m m² | prec% | local% | win% | localFF% | frameErr cm (max) | locPath% | locNode% (deep) | hideBad% | cpu mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| house-hard (defaults) | 10 | 76.3 | 8.1 | 77.6 | 78.6 | 76.5 | 11.4 | 19 (56) | 3.4 | 0.6 (0.39) | 0.5 | 3.1/10.0/183 |
| perfect tracking | 10 | 79.3 | 8.8 | 95.6 | 96.3 | 96.9 | 0.7 | 0 (0) | 1.1 | 0.1 (0.06) | 0.0 | 3.0/9.9/117 |
| submaps, oracle anchors | 10 | 74.3 | 7.3 | 64.1 | 84.1 | 83.6 | 9.3 | 19 (56) | 3.0 | 0.4 (0.22) | 0.5 | 3.4/15.5/393 |
| submaps, simulated anchors | 10 | 74.4 | 7.6 | 79.6 | 80.9 | 79.6 | 9.1 | 19 (56) | 3.5 | 0.5 (0.32) | 0.9 | 2.5/9.3/170 |
| house-jumps (defaults) | 10 | 70.1 | 7.4 | 55.5 | 37.8 | 36.1 | 49.6 | 158 (265) | 14.0 | 3.7 (2.82) | 3.2 | 3.7/13.1/198 |
| **harder**: house-hard, tracker never closes its loops | 10 | 74.0 | 8.1 | 60.0 | 67.5 | 65.7 | 18.1 | 50 (80) | 5.4 | 1.0 (0.65) | 1.0 | 3.1/10.1/116 |

The base arm reproduces round 4 exactly (local 78.6, localFF 11.4, locPath
3.4). Gap to perfect tracking, paired: local −17.7 ± 2.3, localFF +10.7 ±
2.4, locPath +2.3 ± 0.8, hide spots inside furniture +0.5 ± 0.3.

## 1. Continuous local re-registration (`WorldModel.localReg`, off)

### How it works

Every 2 s (`localRegEvery`), time-sliced over the following depth frames
(`localRegSteps` = 2 generator steps per frame):

- **Reference**: plan-view footprint (5 cm cells, 10 cm–1.9 m above the
  floor) of structure within 4 m of the camera that was *laid down* before
  the cutoff (born ≥ 4 s ago, `localRegMinAge`), re-seen since or not. (A
  first version used structure *not seen* for 4 s: when the old map is
  aligned the view re-hits it and it drops out of the reference, so the
  ICP slid the view onto whatever other old structure was near — the
  "need 2 cm, got 30 cm" estimates of the first traces.)
- **View**: the depth readings of the last second at the same heights,
  one averaged point per 5 cm cell (100–1000 points).
- **ICP** (`LocalReg.icp2d`): point-to-line in plan view (local lines fitted
  to the reference cells, point-to-point for blobs), Huber weights,
  correspondence reach shrinking 30 → 8 cm, about the camera; the update is
  solved only along directions the scene constrains (eigen-directions of
  the unweighted information above 40 inlier-equivalents: a plain wall
  pins the axis across it and not the one along it; unit test).
- **Acceptance**: the rays of the view must pass through old structure
  (share of ray samples inside it ≥ 0.4%: the old map is in the way of
  what the camera sees now) and the move must clear at least 10% of that;
  at least one constrained direction and 20 inliers; at most 30 cm / 0.1
  rad; at least 2 cm of movement 1.5 m from the camera. The see-through
  test is what made estimates useful at all (`la-reg-rules.py` on a dry
  run with everything accepted: without it as many estimates made the old
  structure worse as better, 130 worse / 158 better; with it 20 / 78).
- **Move** (`localWarpPass`, sliced, in the existing warp slot so window
  moves wait for it): old occupied voxels (last hit before the cutoff) and
  old free voxels (last carved before it, `VoxelGrid.freeTime`) within 4 m
  whose time lies within ±15 s of the matched old structure's
  (`localRegSpan`) move by the correction; what was seen since stays and
  wins where moved voxels land; occupied beats free among movers; free
  space never moves into never-seen space (the inside of furniture), and
  away from structure that moved, free space also stays where it was
  (moving patchwork free space leaves holes). Recovery snapshots are
  dropped (restoring one would undo the move). Low-band column free
  times are recomputed for the touched columns.
- A coarse exhaustive search (shift × yaws) before the ICP, with a
  uniqueness test, is there (`localRegCoarse`) and worse: the overlap
  landscape is flat (house-jumps, ±0.8 m / ±0.2 rad: 626 estimates
  rejected as ambiguous, 2 applied), and with a narrow range the best
  overlap sits at the edge of it.

### Does each move help? Yes

Scored at the moment each move is applied (ten homes, `lr4`):

| sim | moves / run | old footprint on real structure | local precision | local falseFree |
|---|---|---|---|---|
| house-hard | 19.6 | 68.8 → 72.3% | 68.5 → 71.2% | 15.4 → 14.0% |
| house-hard, tracker never closes its loops | 19.9 | 63.6 → 68.1% | 63.1 → 66.6% | 22.5 → 20.9% |
| house-jumps | 14.9 | 35.8 → 39.1% | 34.5 → 36.5% | 52.1 → 49.7% |

### Over a whole walk: only without the tracker's own loop closures

| arm | cover% | nav3m | local% | win% | localFF% | locPath% | locNode% (deep) | hideBad% |
|---|---|---|---|---|---|---|---|---|
| house-hard, defaults | 76.3 | 8.1 | 78.6 | 76.5 | 11.4 | 3.4 | 0.6 (0.39) | 0.5 |
| + localReg (final rules) | 74.9 | 7.9 | 77.0 | 74.5 | 10.8 | 3.3 | 0.5 (0.32) | 1.5 |
| + localReg, stricter (6 cm moves, 1% see-through) | 74.9 | 7.9 | 77.5 | 74.9 | 9.8 | 3.1 | 0.5 (0.26) | 1.1 |
| + localReg, moving only within 2.2 m | 75.9 | 8.0 | 77.4 | 75.3 | 11.9 | 3.0 | 0.6 (0.34) | 0.9 |
| tracker never closes its loops, defaults | 74.0 | 8.1 | 67.5 | 65.7 | 18.1 | 5.4 | 1.0 (0.65) | 1.0 |
| + localReg (free space stays) | 74.1 | 8.3 | **72.3** | 69.4 | 18.6 | **4.2** | 0.8 (0.52) | 0.6 |
| + localReg (final rules) | 67.8 | 7.9 | 71.4 | 68.9 | 16.1 | 4.1 | 0.7 (0.42) | 0.5 |
| twice the drift (5%/m), defaults | 74.7 | 8.0 | 70.1 | 67.1 | 16.1 | 4.7 | 1.0 (0.68) | 1.9 |
| + localReg | 73.1 | 7.7 | 70.6 | 66.9 | 14.1 | 4.7 | 0.8 (0.56) | 1.9 |
| house-jumps, defaults | 70.1 | 7.4 | 37.8 | 36.1 | 49.6 | 14.0 | 3.7 (2.82) | 3.2 |
| + localReg (earlier rules) | 66.0 | 7.2 | 39.1 | 37.0 | 49.9 | 11.8 | 3.3 (2.58) | 2.9 |

Paired against each sim's defaults:
- house-hard, final rules: local −1.7 ± 1.0, win −2.0 ± 0.8, localFF −0.6 ±
  0.6, locPath −0.1 ± 0.2, **hide spots inside furniture +0.9 ± 0.4**,
  coverage −1.5 ± 0.4; stricter: local −1.1 ± 0.8, localFF −1.6 ± 1.4,
  hideBad +0.6 ± 0.4; within 2.2 m: local −1.2 ± 0.6, hideBad +0.3 ± 0.3.
  (Earlier versions: −2.9 ± 1.1 with the first reference and no time span,
  −1.5 ± 1.0 with the span; forgetting old free space instead of moving
  it: localFF −5.3 ± 2.3 but coverage −22.)
- **no tracker loop closures**: local **+4.7 ± 1.3**, win **+3.7 ± 1.0**,
  locPath **−1.2 ± 0.3**, locNode −0.2 ± 0.1, hideBad −0.4 ± 0.3, coverage
  +0.1 ± 0.4 (free space stays); with free space moving: local +3.9 ± 1.7,
  localFF −2.1 ± 1.7, locPath −1.4 ± 0.6, hideBad −0.6 ± 0.3, coverage
  −6.2 ± 3.5.
- twice the drift (with loop closures): local +0.5 ± 2.5, localFF −2.1 ±
  2.1 — nothing measurable.
- house-jumps: local **+1.3 ± 0.3**, locPath **−2.2 ± 0.9**, coverage −4.1
  ± 1.4 (final rules: local +1.4 ± 0.4, locPath −0.7 ± 0.6, coverage −0.5
  ± 0.6).

Truth-frame precision (`prec%`) drops by 5–20 points in every arm: the map
now follows the current (drifted) frame, which is what the player sees;
`local%` / `win%` are the metrics that matter here.

### Why it doesn't add up with the house-hard tracker

Every accepted move improves the local map when it is applied (above),
yet over a walk the local map is no better and hide spots get slightly
worse. The difference between the profiles is the tracker's own loop
closures: house-hard's tracker snaps its frame back to how it was when it
recognises a place seen ≥ 30 s ago (5–19 times per walk), which makes the
*old* map right again — the structure local registration may just have
moved into the drifted frame. Without those snaps, local registration is
the only thing that ever brings the old map back, and it pays off. Tried
against the snaps:
- moving what was registered along with the tracker's pose jumps as the
  pose gate sees them (`localRegFollowJumps`): local −8.4 ± 1.8 — most
  pose jumps are short-lived relocalisation glitches, not frame snaps;
- the same with the exact snaps from the simulator (`ORACLE_FOLLOW=1`, the
  ceiling of that idea): local −3.1 ± 1.9;
- at the snaps themselves (`LOOPDIAG`, four homes, 46 snaps) the local map
  doesn't break: 75.3 → 76.8% in the 10 s after without local
  registration, 71.8 → 75.5% with it. It is lower going into the snaps;
  between them, the moves don't accumulate into a better map when the
  tracker keeps re-anchoring the old one, and the registration noise
  (estimates off by 5–10 cm, a voxel or two) is paid on every move.

Off by default. On a phone whose tracker rarely closes its own loops (long
corridors, a lot of new territory per visit) it would be worth turning on;
which kind ARCore is in a home walk is what a recorded session (round 4,
"What real-phone data would settle") answers.

## 2. Free space that moves (`VoxelGrid.freeTime`, `WorldModel.warpFree`, off)

`VoxelGrid.freeTime`: a 16-bit time code per voxel of the window, written
in the ray walk whenever a voxel is left free (7 MB for the 256×256×54
window; allocated only when an option needs it; not saved, not archived:
voxels back from the archive count as old). With it, submap warps
(`warpFree`) move free space by when it was last seen empty, with the same
sub-voxel positions as structure (`subX/subZ`), never into never-seen
space, one-voxel holes inside free space filled from their neighbours, and
— after the first version cost 40 points of coverage — free space away
from structure that moved stays where it was too.

| arm | cover% | nav3m | local% | localFF% | locPath% | locNode% (deep) | hideBad% |
|---|---|---|---|---|---|---|---|
| submaps, oracle anchors | 74.3 | 7.3 | 84.1 | 9.3 | 3.0 | 0.4 (0.22) | 0.5 |
| + free space moves | 63.9 | 5.4 | 82.3 | **4.2** | **1.4** | 0.3 (0.14) | 0.3 |
| submaps, simulated anchors | 74.4 | 7.6 | 80.9 | 9.1 | 3.5 | 0.5 (0.32) | 0.9 |
| + free space moves | 72.9 | 7.1 | 80.6 | 7.5 | 3.1 | 0.5 (0.31) | 0.6 |
| (perfect tracking) | 79.3 | 8.8 | 96.3 | 0.7 | 1.1 | 0.1 (0.06) | 0.0 |

Paired: oracle anchors, localFF **−5.1 ± 1.4**, locPath **−1.6 ± 0.6**
(1.4%, against 1.1% with perfect tracking), but coverage −10.4 ± 1.5;
simulated anchors, localFF −1.6 ± 0.6, locPath −0.4 ± 0.3, coverage −1.5 ±
0.4, nav3m −0.5 ± 0.1. Round 4's diagnosis was right — with free space
following the corrections the pet stops walking into furniture — but
moving a patchwork of free space by many slightly different corrections
still loses walkable floor. Off, as submaps are.

## 3. Drift-aware rules without moving anything

- **Old free space by distance walked** (`NavParams.freeMaxWalk`, off):
  drift grows with the path, not the clock, so round 4's walking rule
  ("floor next to structure not seen empty for 120 s isn't walkable") was
  tried by metres walked instead (time rule off). Paired against the time
  rule, nav-only: 15 m: nav3m −0.6 ± 0.1, locPath −0.4 ± 0.5; 25 m: nav3m
  −0.2 ± 0.1, locPath −0.0 ± 0.4; 40 m: nav3m +0.1 ± 0.1, locPath +0.4 ±
  0.2. No better trade than 120 s; the time rule stays, and round 4's
  defaults stay (nothing here makes them unnecessary).
- **Weakening only old free space behind a surprising surface**
  (`staleFreeDecay` with `staleFreeMinAge`; round 3 tried it on all free
  space): 25 cm behind, to unknown, free space older than 20 s: local −0.6
  ± 0.4, localFF −0.5 ± 0.2, coverage −0.9 ± 0.3, hideBad +0.3 ± 0.2. Off.

## What was made harder, and what broke

- **A tracker that never closes its own loops** (house-hard with
  `loopRate` 0): local precision 78.6 → 67.5%, localFF 11.4 → 18.1%, pet
  paths into furniture 3.4 → 5.4%, frame error 19 → 50 cm. Local
  registration recovers about half of the local precision lost (+4.7) and
  of the paths (−1.2).
- **Twice the drift** (5%/m, twice the yaw walk, loop closures kept):
  local 70.1%, localFF 16.1%, locPath 4.7%, hide spots inside furniture
  1.9%. Local registration: nothing measurable.
- **Tracking jumps** (house-jumps): unchanged at 38% local; local
  registration +1.3 local, −2.2 paths into furniture (first rules); a wide
  search that could undo whole jumps finds no unique answer.
- **What broke on the way**: matching the view against structure *not
  seen* recently (slides onto other old structure); a coarse overlap
  search (flat landscape); free space moving into the never-seen inside of
  furniture (local falseFree jumping by 30 points at single moves);
  overlapping moves followed more than once; free space moved by submaps
  leaving holes (coverage −40); following the pose gate's jumps (−8 local).

## Where it stands (round 5)

Defaults are unchanged from round 4 (every new mechanism is an option,
off), so the default numbers are round 4's:

| sim | cover% | local% | localFF% | locPath% | locNode% | hide spots inside furniture |
|---|---|---|---|---|---|---|
| house-hard | 76.3 | 78.6 | 11.4 | 3.4 | 0.6 | 0.5% |
| house-jumps | 70.1 | 37.8 | 49.6 | 14.0 | 3.7 | 3.2% |
| no tracker loop closures | 74.0 | 67.5 | 18.1 | 5.4 | 1.0 | 1.0% |
| … + localReg (option) | 74.1 | 72.3 | 18.6 | 4.2 | 0.8 | 0.6% |
| perfect tracking | 79.3 | 96.3 | 0.7 | 1.1 | 0.1 | 0.0% |

Gap to perfect tracking on house-hard, paired: local −17.7 ± 2.3, localFF
+10.7 ± 2.4, locPath +2.3 ± 0.8, coverage −3.0 ± 0.8.

CPU (wall clock on a loaded 4-core box, ten homes, not profiled on a
phone): local registration adds ~0.2–0.4 ms to the mean frame and 1–2 ms
to the p95; an estimate is spread over ~15 depth frames (reference 6
layers per step, a move 4 layers or 20,000 voxels per step); the worst
frames are unchanged. Memory: 7 MB of free times when an option needs
them. MapFormat unchanged (nothing new is saved).

## Remaining weaknesses

1. **The frame**, still: 18 points of local precision and 11 of local
   falseFree between house-hard and perfect tracking. Local registration
   fixes the old map locally each time it fires but, with a tracker that
   re-anchors the old map itself, doesn't add up over a walk.
2. **Free space**: moving it with corrections does what round 4 predicted
   for the pet (with oracle anchors, paths into furniture nearly as rare as
   with perfect tracking) but costs walkable floor; a better way to move a
   patchwork of free space, or to re-derive it from moved structure, is the
   next step.
3. **Registration noise**: plan-view ICP on 5 cm voxels is good to 5–10 cm
   per estimate; the see-through test keeps the bad ones out but small
   offsets (< ~8 cm) aren't worth correcting at that noise.
4. **Tracking jumps** remain the worst case (38% local precision).
5. Whether local registration should be on depends on how often the
   phone's tracker closes its own loops in a home; a recorded session
   decides it.
