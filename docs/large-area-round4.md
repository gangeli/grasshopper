# Large-area mapping, round 4: keeping the map in the current frame

Continuation of `docs/large-area-round3.md`. Round 3 ended with: with
perfect tracking the mapper is nearly clean; with drift and tracking jumps
the old map stops lining up with the world, and single-look matching and
loop-closure warps against the drifted map make it worse. This round:

1. the tracker's own corrections through WebXR anchors: the map cut into
   submaps, each glued to an anchor, moved when its anchor moves;
2. recency near the player: free space seen empty long ago is not trusted
   for hide spots (on) or walking (option);
3. harder simulations for both (anchors that fail, jitter, jump, get lost
   or never correct; tracking jumps; long and narrow homes; dark furniture
   that moves).

## Harness

- Same ten homes as round 3 (`10x12 s1 … 13x15 s10`), 600 s, fast pans,
  `house-hard` unless noted; `"ten": true` in a batch spec
  (`scripts/large-area-batch.ts`). Paired differences per home, mean ±
  standard error: `scripts/la-table3.py <dirs> --ref <arm>`.
- New columns: `win%` — obstacle precision of the live window within 6 m
  of the player *through the current frame* (every 10 s): is the wider map
  consistent with what the camera sees now? (`prec%` is scored in the
  truth frame; a map that follows the tracker's corrections can be
  consistent with the camera and off the truth, so `prec%` drops when
  submaps move — read `local%`/`win%` instead.) `nav3m` — walkable area
  (m²) the live nav graph has within 3 m of the player: what the pet can
  use.
- `scripts/snap.sh <name>` freezes src/scripts for a batch (no git).
- Diagnostics: `scripts/la-anchor-diag.ts` (wrong obstacle voxels near the
  player by submap, anchor state and age), `scripts/la-recency-diag.ts`
  (nav nodes near the player inside furniture, by how long ago their
  column was seen empty), `scripts/la-events.py` (tracker loop closures,
  losses, jumps and anchor statistics per run), `scripts/perf-anchors.ts`
  (CPU of anchor reads and submap warps).

## What the error is: odometry drift, nothing else

Ten homes, house-hard, each source of tracking error switched off alone:

| arm | cover% | prec% | local% | win% | localFF% | locPath% | locNode% | hideBad% |
|---|---|---|---|---|---|---|---|---|
| house-hard (round 3 defaults) | 76.3 | 77.6 | 78.6 | 76.5 | 11.4 | 5.9 | 0.9 | 2.6 |
| no odometry drift (relocalisation jumps, losses, jitter kept) | 77.8 | 95.2 | 95.9 | 96.7 | 0.6 | 1.5 | 0.1 | 0.2 |
| perfect tracking | 79.3 | 95.6 | 96.3 | 96.9 | 0.7 | 1.3 | 0.1 | 0.0 |

Paired, no-drift − house-hard: local +17.3 ± 2.3, localFF −10.8 ± 2.4,
locPath −4.3 ± 1.2, hide spots inside furniture −2.4 ± 0.7. The
short-lived errors (8 cm relocalisation jumps every ~10 s, tracking
losses, frame jitter) cost almost nothing; the slow drift of the frame over
a walk is the whole problem. `la-anchor-diag`: around the player,
structure laid down in the last minute is 95% right in either case;
structure older than three minutes is 3% wrong without drift and 67% wrong
with it.

## 1. Submaps glued to anchors

### How it works

- `WorldModel.anchorSource` (platform anchors: create at a pose, read the
  pose, release). With a source, the map is cut into time-bounded submaps
  (`submapSeconds` 10 s and `submapWalk` 0.75 m apart, at most
  `maxAnchors` 60), each with an anchor created upright at the camera when
  it began. Every depth frame up to 12 anchors are read (round-robin).
- When an anchor's pose moves (≥ 3 cm or 0.7°), what its submap laid down
  (occupied voxels by birth time, window and archive, plus buffered frames
  and place memory) moves rigidly with it: a sliced warp
  (`WorldModel.warpPass`, generalised from the loop-closure warp to one
  affine per time code), a few window layers / archive chunks per frame.
  The correction is the anchor's motion in tracking coordinates taken
  through the registration the submap was laid down with to the current
  one (`SubmapAnchor.reg`), so realignments of the frame and anchor moves
  compose correctly.
- Moved voxels keep where in the voxel they really are (`VoxelGrid.subX/Z`,
  1/128 voxel, window only): without that, repeated small moves added up
  their rounding (a 0.25 rad turn applied in 20 steps put a 3 m wall 20 cm
  off on average; now 1.2 cm, as in one step). The anchor's translation is
  applied in whole voxels and the rest carried to the next move.
- One correction per submap in flight (the next is measured from where
  that one leaves it); a submap whose anchor failed or was lost follows the
  nearest anchored submap in time (`anchorProxy`).
- A map put aside after a jump (`detachMap`) comes back when two or more of
  its submaps' anchors report moves that agree (within 10 cm at each
  other's anchor points) and outnumber the others two to one
  (`reattachByAnchors`): the tracker found its old map again.
- `anchorForgetFree` (option): low-band free space in columns last seen
  empty during a moved submap goes back to unknown (free voxels carry no
  time, so they can't move with the structure).

Device: `ArMode` installs an XR anchor source after the first placement
when `?submaps=1` (default off, see below): `frame.createAnchor` at the
camera, `frame.getPose(anchor.anchorSpace)` while the anchor is in
`frame.trackedAnchors` (otherwise "not tracked", it may come back),
`anchor.delete()` on release. Unsupported (`createAnchor` missing), failed
or rejected creations, poses that are emulated or not finite, exceptions
from a dead session: the submap simply doesn't move (unit tests). Session
end releases every anchor and drops the source. With submaps on, the
placement anchor no longer corrects the whole map frame (it would fight
the submaps). The IWER emulator supports anchors: `e2e/ar-recovery`
checks that the first submap gets one and that the emulator's anchor
drift fault moves the submaps.

### Simulated anchors

`src/sim/SimAnchors.ts` on top of the simulated tracker. An anchor keeps
the tracker's frame at its creation and reports through it, so while the
tracker drifts unaware, the anchor drifts with it. When the tracker closes
a loop (back near a place seen ≥ 30 s ago it snaps its frame to how it was
then; house-hard: 5–19 times in 600 s), the correction is spread over the
anchors created since the recognised place like a pose graph would
(share by distance walked), applied **0.2–3 s late, at 60–100%, and not at
all 25% of the time**. What is left wrong is the drift's deviation from a
straight line (a random walk), plus those. A persistent frame jump pauses
all anchors; half the time the tracker later (5–60 s) merges its old map
and they come back moved by the jump (± 5 cm, 0.02 rad), otherwise they
are lost. Creation fails 5% of the time, anchors are lost for good at
0.0005/s each (a quarter of them over 10 minutes), reported poses wobble
(4 mm, 0.002 rad, ~1 s correlation). `oracle`: anchors report through the
tracking frame as it is now (the tracker always knows its drift) — the
ceiling of the approach. The anchors' random numbers are their own, so
every arm sees the same walk and depth noise.

### Results

House-hard, ten homes (`sub` = simulated anchors as above):

| arm | cover% | nav3m | prec% | local% | win% | localFF% | locPath% | locNode% | hideBad% | cpu mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|---|
| no anchors | 76.3 | | 77.6 | 78.6 | 76.5 | 11.4 | 5.9 | 0.9 | 2.6 | 3.4/10.9/196 |
| submaps, oracle anchors | 74.4 | 8.3 | 67.3 | 88.1 | 88.7 | 8.4 | 3.5 | 0.5 | 0.9 | 3.5/15.7/331 |
| submaps, simulated anchors | 74.6 | 8.5 | 78.5 | 80.3 | 79.1 | 9.3 | 4.9 | 0.7 | 3.0 | 2.6/9.7/209 |
| (no drift, for reference) | 77.8 | | 95.2 | 95.9 | 96.7 | 0.6 | 1.5 | 0.1 | 0.2 | 3.9/13.3/230 |

Paired against no anchors:
- oracle: local **+9.5 ± 2.2**, win **+12.2 ± 2.7**, localFF −3.0 ± 2.0,
  locPath −2.4 ± 0.7, locNode −0.4 ± 0.1, hideBad −1.7 ± 0.9, coverage
  −1.9 ± 1.0;
- simulated: local +1.7 ± 1.8, win +2.6 ± 2.1, localFF −2.1 ± 2.1,
  locPath −1.0 ± 0.7, hideBad +0.4 ± 0.4, coverage −1.7 ± 0.7.

The approach works as far as the tracker knows its own drift (oracle: half
of the gap to the no-drift map closed in local precision). With the
house-hard tracker it knows little — it closes its own loops rarely (the
profile is built that way) and the simulated anchors miss a quarter of
those — and the gain is within the noise. The remaining gap in the oracle
is mostly free space: obstacles move with their anchors, free space
(carried by no time) does not, so localFF stays at 8% against 0.6%
without drift.

Earlier versions, kept as a record of what mattered: correcting through
the current registration instead of the submap's own (realignments were
applied twice), sub-voxel moves dropped, several corrections of a submap
queued at once, and the rounding of repeated turns: the oracle was at
local −2.2 ± 2.0 (worse than nothing), then +2.8 ± 2.2, then +9.5.

House profile (`house`: a tracker that closes its own loops 5× as often,
1.5%/m drift; 37–43 loop closures per run): simulated anchors, paired:
local +2.1 ± 2.0, win +2.8 ± 2.4, localFF −3.1 ± 2.5 (4.9 → 1.8%), hide
spots inside furniture −0.5 ± 0.4 (0.5 → 0.0%), coverage −0.6 ± 0.9,
nav3m −0.7 ± 0.2 m².

House-jumps (tracking losses that end in a persistently moved frame, up to
70 cm / 0.2 rad, 3–10 per run):

| arm | cover% | local% | win% | localFF% | locPath% | locNode% | hideBad% |
|---|---|---|---|---|---|---|---|
| no anchors | 69.9 | 37.6 | 35.8 | 50.0 | 21.4 | 4.8 | 8.0 |
| simulated anchors (merge after half the jumps) | 68.5 | 43.0 | 41.3 | 50.6 | 16.6 | 4.5 | 6.5 |
| simulated anchors, every jump merged | 67.5 | 49.6 | 48.4 | 50.3 | 14.9 | 4.1 | 9.5 |
| oracle anchors | 63.7 | 67.4 | 67.6 | 46.8 | 10.4 | 2.5 | 7.1 |

Paired: simulated local **+5.5 ± 2.4**, locPath **−4.8 ± 1.3**; oracle
local +29.8 ± 3.4, locPath −11.0 ± 1.3, locNode −2.3 ± 0.4. (The
every-jump-merged arm ran on the build before sub-voxel moves; +12.1 ±
1.4 local there.) Jumps are where anchors help most: a merged jump moves
every old submap back into the current frame at once, which is exactly
what single-look place matching could not do reliably (round 3: 17 of 28
estimates wrong).

CPU (perf-anchors, 12×15 home, wall clock on a loaded 4-core box): anchor
reads 0.03 ms per depth frame (p99 0.1); a submap warp is spread over ~30
frames, 1–2 ms per frame (p99 10–17 ms with oracle anchors moving
constantly, rare with simulated anchors). The worst single step (~50–70 ms
wall) is the start of a warp; the same order as the existing worst frames
without anchors (ingestDepthImage max 77 ms).

### Longer walks, long and narrow homes

Six runs (6×20, 8×24, 20×7 and 24×10 homes for 15 minutes — the 24×10 one
has six look-alike studies — and the 15×20 and 14×16 homes for 20
minutes), house-hard, simulated anchors (before the consensus rule):

| arm | cover% | nav3m | local% | win% | localFF% | locPath% | locNode% | hideBad% | cpu mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|
| no anchors | 76.8 | 9.9 | 70.1 | 69.3 | 16.0 | 8.7 | 1.7 | 0.8 | 5.9/20.5/931 |
| submaps | 75.0 | 8.0 | 74.7 | 74.4 | 13.6 | 6.5 | 1.2 | 0.9 | 2.5/9.4/290 |

Paired: local +4.6 ± 2.3, win +5.1 ± 2.3, locPath −2.2 ± 1.4, locNode
−0.5 ± 0.3, coverage −1.8 ± 0.8, nav3m −2.0 ± 0.2 m². Anchors don't
match anything, so look-alike rooms can't fool them. A third of the
anchors are lost over 20 minutes at the simulated loss rate; their submaps
follow their neighbours. (In the 20×7 home without anchors a bad
realignment left the frame 1.6 m off with a 0.9 s frame; with anchors it
didn't happen — one home, not a result.)

### Harder anchors: what broke

Anchors that misbehave more (`sub5hard`): corrections missing half the
time, 1–10 s late, at 30–100%; 1 cm / 0.3° wobble; spurious jumps of up
to 15 cm (each anchor about every 8 minutes); a fifth of creations failing
and anchors lost at 0.002/s. House-hard, paired against no anchors: local
**−5.9 ± 1.6**, win −4.7 ± 2.1 — worse than no anchors: each spurious jump
moved its submap 15 cm off. House-jumps (and only 30% of jumps merged):
local +1.6 ± 1.0, locFF +3.8 ± 2.3.

Fix (`anchorConsensus`, on with submaps): a tracker correction moves the
anchors around a place together (a loop closure moves every anchor since
the recognised place, a merge moves them all), so a move is followed only
when a neighbouring submap's anchor (±2 in time) moved alike, now or in
the last 4 s; an anchor that stays alone for 4 s is dropped and its
submap follows its neighbours. Results below (§ "consensus").

Also tried: forgetting the free space of moved submaps
(`anchorForgetFree`): localFF 8.4 → 0.5% with oracle anchors, but
coverage 74 → 5% (everything carved during a moved submap must be seen
again, and most of the house never is). Off.

### Consensus (on with submaps), and where submaps end up

With the consensus rule, and on top of this round's recency defaults
(below), ten homes each, paired against the same defaults without
submaps:

| sim | local% | win% | localFF% | locPath% | locNode% | hideBad% | cover% | nav3m |
|---|---|---|---|---|---|---|---|---|
| house-hard | +2.3 ± 1.7 | +3.1 ± 2.1 | −2.3 ± 2.0 | +0.1 ± 0.2 | −0.1 ± 0.1 | +0.3 ± 0.3 | −1.9 ± 0.8 | −0.5 ± 0.1 |
| house-hard, harder anchors | −1.2 ± 1.9 | −0.8 ± 1.7 | −1.4 ± 1.7 | +0.6 ± 0.7 | −0.0 ± 0.1 | +0.2 ± 0.3 | −0.9 ± 1.5 | −0.5 ± 0.3 |
| house | +2.1 ± 2.0 | +2.9 ± 2.4 | −3.1 ± 2.5 | −0.1 ± 0.2 | −0.0 ± 0.1 | −0.3 ± 0.2 | −1.0 ± 0.9 | −0.5 ± 0.2 |
| house-jumps | **+4.4 ± 2.1** | **+4.1 ± 2.0** | +1.1 ± 2.5 | **−2.1 ± 0.9** | −0.2 ± 0.3 | −0.9 ± 0.9 | −1.6 ± 0.7 | −0.6 ± 0.2 |

(Harder anchors before consensus: local −5.9 ± 1.6; with it −1.2 ± 1.9 —
spurious jumps are now mostly ignored, but missing and late corrections
leave little to gain.)

**Submaps stay off by default** (`?submaps=1` turns them on, `SUBMAP_ANCHORS`
in ArMode): with the recency rules on, they add a few points of local
precision and, under tracking jumps, a further cut in pet paths into
furniture; but in the profiles without jumps they don't change pet safety
measurably, they cost 1–2 points of coverage, and the result depends
entirely on how a real tracker moves its anchors, which the simulation
only guesses (with the harsher guess the gain is gone). The oracle says the
approach is worth having when the tracker knows its drift (local +9.5 on
house-hard, +29.8 under jumps); a recorded session (below) decides.

### The app's single placement anchor (before this round)

Since round 1 the device corrects the whole map frame by the anchor
placed with Hopper (`ArMode.updateAnchor`, never simulated before). With
simulated anchors: coverage −4.0 ± 1.2, localFF −6.1 ± 1.9, locPath −1.6 ±
0.4, CPU p95 22 ms. Not because it corrects anything (the placement anchor
is created at the start of the walk and no loop closure ever moves it) but
because its 4 mm wobble crosses the 1 cm threshold now and then, and each
frame correction resets the multi-view depth filter (no history → no depth
kept until it refills): less depth, less coverage, less carving. On a
phone whose anchors wobble by a centimetre, the current app thins its own
depth the same way. With submaps on, the placement anchor no longer
corrects the frame.

## 2. Recency near the player

### Where the pet ends up inside furniture

`la-recency-diag` (12×15 home, 400 s, every 5 s): nav nodes within 3 m of
the player, through the current frame, by how long ago the low band
(0–45 cm) of their column was last carved by a depth ray
(`VoxelGrid.colFree`, a time code per window column, written in the ray
walk; columns coming back from the archive count as old):

| last seen empty | share of nodes | inside furniture |
|---|---|---|
| < 5 s | 27% | 0.23% |
| 5–15 s | 28% | 0.36% |
| 15–60 s | 23% | 0.33% |
| 1–3 min | 7% | 3.46% |
| > 3 min | 2% | 2.39% |
| not since the column came back into the window | 14% | 0.91% |

By distance walked since: < 15 m 0.2–0.4%, 15–40 m 1.6%, > 40 m 3.6%.
Free space seen in the last minute is right; older free space sits where
an older, drifted frame put it — the inside of a sofa "seen empty" from
across the room. Ten times the rate, in a tenth of the nodes.

### Hide spots: the body's space seen empty in the last minute (on)

`HideSpots.spotSafety` reports `freeAge` (the oldest low-band free time
under the crouched body); `DEFAULT_SPOT_SAFETY.maxFreeAge` = 60 s
(`RELAXED_SPOT_SAFETY`, the fallback when nothing qualifies, has none).
`la-hide-batch`, the game's hide-spot search on the same walks (every 15 s,
seeker at the camera), scored in reality through the current frame, ten
homes × 600 s:

| sim | policy | no spot % | spots inside furniture % | paired, inside | paired, no spot |
|---|---|---|---|---|---|
| house-hard | round 3 | 6.0 | 2.2 | | |
| house-hard | ≤ 30 s | 6.3 | 0.2 | −2.0 ± 0.4 | +0.3 ± 0.3 |
| house-hard | **≤ 60 s (default)** | 6.3 | **0.4** | **−1.9 ± 0.4** | +0.3 ± 0.3 |
| house-hard | ≤ 120 s | 6.3 | 0.7 | −1.6 ± 0.4 | +0.3 ± 0.3 |
| house-jumps | round 3 | 5.5 | 8.2 | | |
| house-jumps | default | 6.1 | **3.2** | **−4.9 ± 0.7** | +0.7 ± 0.5 |
| house-hard, 70% dark furniture, 2 pieces moved a minute | round 3 | 4.3 | 2.1 | | |
| same | default | 4.8 | **0.5** | **−1.6 ± 0.6** | +0.5 ± 0.4 |
| house | round 3 | 4.1 | 0.4 | | |
| house | default | 4.1 | 0.2 | −0.1 ± 0.1 | 0.0 |

All game tests pass unchanged (single-room games: the player looks around
before a round, so spots there are fresh). Commit c866ba3 (with its
column times from 69eaa74).

### Walking: old free space near structure (option, see below)

`NavParams.freeMaxAge` (s): floor whose column was last seen empty longer
ago isn't walkable (the client sends the stale columns to the nav worker,
as for `staleMargin`); `freeMaxAgeNear` (m) limits it to floor that close
to structure at body height (open floor can't put the pet inside
furniture). House-hard, ten homes, paired against the same walks (mapping
identical):

| rule | nav3m m² (walkable within 3 m) | locPath% | locNode% | deep% |
|---|---|---|---|---|
| none | 9.1 | 5.9 | 0.9 | 0.54 |
| ≤ 30 s everywhere | 5.7 (−3.4 ± 0.4) | 2.5 (−3.3 ± 1.2) | 0.5 (−0.4 ± 0.1) | 0.21 |
| ≤ 60 s everywhere | 6.6 (−2.5 ± 0.3) | 2.8 (−3.1 ± 1.0) | 0.5 (−0.4 ± 0.1) | 0.23 |
| ≤ 120 s everywhere | 7.4 (−1.7 ± 0.2) | 3.4 (−2.4 ± 0.8) | 0.5 (−0.4 ± 0.1) | 0.26 |
| ≤ 60 s within 30 cm of structure | 7.6 (−1.5 ± 0.2) | 3.2 (−2.7 ± 1.1) | 0.6 (−0.3 ± 0.1) | 0.32 |
| **≤ 120 s within 30 cm of structure (default)** | **8.1 (−1.0 ± 0.1)** | **3.3 (−2.6 ± 0.7)** | **0.6 (−0.3 ± 0.1)** | 0.37 |
| ≤ 60 s within 20 cm of structure | 8.3 (−0.9 ± 0.1) | 3.5 (−2.3 ± 0.7) | 0.5 (−0.3 ± 0.1) | 0.37 |

(perfect tracking: locPath 1.3%, locNode 0.1%.) Limiting the rule to
floor near structure keeps most of its gain for a third to half of the
floor; on by default at 120 s / 30 cm (commit 283bdc9): pet paths into
furniture near the player nearly halved for 11% less walkable floor next
to old structure. Mapping, coverage and every other metric are identical
(nav-only rule); health events in the ten walks unchanged (pet found
inside something 0 → 2 times, off the map 11 → 10). All game tests pass.

## Where it stands (round 4)

Ten homes, 600 s, fast pans. "round 3" = the defaults this round started
from; "round 4" = the new defaults (hide spots and walking near structure
need free space seen recently; submaps off). Mapping is unchanged by the
defaults (nav and hide-spot rules), so cover/prec/local are identical.

| sim | defaults | cover% | nav3m m² | local% | localFF% | locPath% | locNode% (deep) | hide spots inside furniture (in-run) | (la-hide) |
|---|---|---|---|---|---|---|---|---|---|
| house-hard | round 3 | 76.3 | 9.1 | 78.6 | 11.4 | 5.9 | 0.9 (0.54) | 2.6% | 2.2% |
| house-hard | **round 4** | 76.3 | 8.1 | 78.6 | 11.4 | **3.4** | **0.6 (0.39)** | **0.5%** | **0.4%** |
| house-hard | round 4 + submaps | 74.4 | 7.6 | 80.9 | 9.1 | 3.5 | 0.5 (0.32) | 0.9% | |
| house-jumps | round 3 | 69.9 | | 37.6 | 50.0 | 21.4 | 4.8 (3.70) | 8.0% | 8.2% |
| house-jumps | **round 4** | 70.1 | 7.4 | 37.8 | 49.6 | **14.0** | **3.7 (2.82)** | **3.2%** | **3.2%** |
| house-jumps | round 4 + submaps | 68.6 | 6.8 | 42.2 | 50.7 | 11.9 | 3.5 (2.69) | 2.3% | |
| house | round 3 | 77.3 | 9.5 | 90.3 | 4.9 | 1.9 | 0.3 (0.18) | 0.5% | 0.4% |
| house | **round 4** | 77.3 | 8.5 | 90.3 | 4.9 | 1.6 | 0.2 (0.14) | 0.3% | 0.2% |
| house-hard | perfect tracking (reference) | 79.3 | | 96.3 | 0.7 | 1.3 | 0.1 (0.04) | 0.0% | |

Paired, round 4 − round 3: house-hard locPath −2.5 ± 0.7, locNode −0.3 ±
0.1, in-run hide spots inside furniture −2.0 ± 0.9 (la-hide −1.9 ± 0.4);
house-jumps locPath −7.4 ± 0.7, locNode −1.2 ± 0.3, hide spots −4.8 ± 1.1;
house locPath −0.3 ± 0.2. Walkable floor within 3 m of the player −11%
(house-hard), all of it next to structure not seen empty for two minutes.
Harder: 70% dark furniture with two pieces moved a minute, hide spots
inside furniture 2.1 → 0.5% (−1.6 ± 0.6).

Main-thread cost of the new defaults: the hide-spot age check is inside
the existing per-round search; the nav rule's column mask is computed on
the main thread once per nav request (0.5 ms in node on a 256² window) and
the rest runs in the nav worker; the column free times are one store per
carved low-band voxel in the ray walk. With submaps on: anchor reads 0.03
ms per depth frame, warps spread at 1–2 ms per frame while one runs (p99
~10 ms; the worst single step, the start of a warp, 50–70 ms wall on this
loaded box, the same order as the worst existing frames). Memory: 128 KB
of column times; with submaps on, 6.8 MB of sub-voxel positions for the
window. MapFormat unchanged (nothing new is saved).

## Remaining weaknesses

1. **The frame itself.** The no-drift arm shows the map would be ~96%
   right around the player; it is 79% (house-hard) and 38% (house-jumps).
   This round made the pet *avoid* what is likely wrong (old free space
   near structure) rather than make it right. Free space carries no time
   in the voxels, so it can't follow corrections; per-voxel free times
   (2 bytes a voxel in the window) would let submaps move free space too,
   and the oracle's localFF (8.4% vs 0.6% without drift) says that is the
   next lever.
2. **What the tracker knows.** Submaps on anchors are only as good as the
   tracker's own loop closures. In the simulation they're rare
   (house-hard) and, as modelled, a quarter missing; how often ARCore
   corrects its anchors in a home walk, by how much, how late, and how
   much they wobble, is unknown. Spurious anchor jumps broke the first
   version (local −5.9); the consensus rule fixed most of it.
3. **Persistent tracking jumps.** Local precision stays at 38% without
   anchors; with every jump merged by the tracker it would be ~50%, with
   an all-knowing tracker 67%. Hide spots inside furniture 3.2%, paths
   into furniture 14% — still the worst case by far.
4. **Coverage near structure.** The walking rule takes 11% of the floor
   within 3 m of the player (next to old structure) until it is looked
   at again; the pet can't hug furniture the camera hasn't seen for two
   minutes.
5. Lost anchors: a third of them over 20 minutes at the simulated loss
   rate; their submaps follow neighbours, which only works while some
   neighbour survives.

## What real-phone data would settle

A `?record=1&submaps=1` session (the recording now has every submap
anchor's pose about twice a second next to the depth and camera poses,
`Recorder.addAnchor`), ideally a slow lap of a multi-room home that ends
back in the starting room, then a second lap, plus one deliberate tracking
loss (cover the camera for a few seconds in another room):

- how much anchors wobble frame to frame when nothing happens (the 1 cm /
  0.3° threshold of the old placement-anchor correction resets the
  multi-view depth filter on every crossing; submaps move at 3 cm / 0.7°);
- whether and when anchors move when the lap closes: all anchors since the
  start together and smoothly (a pose graph), only the recent ones, or
  not at all; how late after the camera's own jump;
- how often an anchor leaves `trackedAnchors`, and whether it comes back,
  moved, after a tracking loss (the merge this round's jump handling
  relies on); whether XRReferenceSpace `reset` fires;
- whether any anchor jumps alone (what the consensus rule assumes is
  wrong);
- from the depth: whether the old map near the start lines up again after
  the lap with submaps on (replayable offline with scripts/tum-replay.ts
  once it reads the anchor log).
