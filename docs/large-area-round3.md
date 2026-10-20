# Large-area mapping, round 3: results log

Continuation of `docs/large-area-round2.md`. Same harness and homes; this
round's question first: **why does the pet walk (and hide) inside
furniture**, then persistent tracking jumps, then camera-only floor
coverage.

## What changed in the harness

- More homes per arm: ten homes (`10x12 s1, 12x15 s2, 15x20 s3, 8x12 s4,
  10x12 s5, 14x16 s6, 12x12 s7, 11x14 s8, 9x13 s9, 13x15 s10`), 600 s walks,
  fast pans (`WALK={"panSpeed":[2,5],"glanceRate":0.15}`), and **paired**
  comparisons: `scripts/la-table3.py <dir> --ref <arm>` prints each metric's
  per-home difference against the reference arm, mean ± standard error.
  Round 2's whole-map path metric is too noisy for one-sided calls: its
  paired standard error over ten homes is ±4 points.
- New pet-safety metrics, all measured **around the player through the
  current frame** (what the user sees, not the map frame):
  - `localFF`: falseFree of the furniture within 3.5 m (inside of real
    furniture the live map believes it saw empty), every 2 s;
  - `locNode`: nav nodes within 3 m where the pet's body would be inside real
    furniture (>2 cm), and `deep`: the crouched core inside (the pet *in* the
    furniture rather than brushing it), every 6 s;
  - `hideBad`: of the hide spots the game would pick right now (seeker at the
    camera, top 5, every 20 s), the share with the crouched pet inside real
    furniture.
- Diagnostics: `scripts/la-petcoll.ts` (what the map believes where the pet
  is inside furniture, which pieces, which hide spots, what open floor gets
  called), `scripts/la-carve-why.ts` (which rays carve the inside of real
  furniture, and why), `scripts/la-falsefree.ts` gained `LOCAL=1` (current
  frame) and `BOTTOM=1` (voxels straddling a piece's bottom face).
- `scripts/la-hide.ts` / `la-hide-batch.ts`: the game's hide-spot search
  under several policies on the *same* walks (every 15 s, seeker at the
  camera), scored in reality through the current frame — an exact paired
  comparison of hide-spot rules, several policies per run.
- `TRACE=place` / `TRACE=mis`: every place-memory / voxel-map estimate next
  to the frame error it would leave (ground truth), and loss jumps and
  re-attaches traced and scored.
- Harder sims: `DARK=share` (that share of the furniture in dark
  fabric/finish: 60% depth dropout, densified over), `MOVE` also in la-hide.
- `artifacts/` is not committed; batch specs are the format
  `scripts/large-area-batch.ts` documents.

## Baseline (round 2 as merged, aa95d23)

house-hard, ten homes, 600 s:

| run | n | cover% | prec% | local% | ghost m² | falseFree% | localFF% | frameErr cm (max) | pathColl% | locPath% | locNode% | hideBad% | resets | cpu mean/p95/max ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shielded carving on (default) | 10 | 76.3 | 77.6 | 78.6 | 5.7 | 14.8 | 11.4 | 19 (56) | 28.1 | 5.9 | 0.9 | 4.3 | 0.0 | 3.5/11.3/188 |
| shielded carving off | 10 | 74.1 | 76.3 | 78.1 | 5.8 | 14.2 | 11.6 | 24 (56) | 25.1 | 5.5 | 0.9 | 4.2 | 1.3 | 3.8/12.6/237 |

### 1. Shielded carving: keep it on

Paired, off − on over the ten homes: coverage −2.3 ± 1.2, precision
−1.2 ± 1.0, frame error +4.6 ± 4.5 cm, resets 0 → 1.3 per run; falseFree
−0.6 ± 1.8, localFF +0.2 ± 0.5, whole-map path collisions −3.0 ± 3.9, local
path collisions −0.4 ± 0.4, hide spots in furniture −0.1 ± 0.7. Round 2's
"falseFree 15.6 → 17.5%, paths 33 → 41%" was within the noise of four homes;
on ten homes shielded carving makes no measurable difference to pet safety
and keeps its gains in coverage, precision and resets. It stays on.

### 2. Pet-in-furniture is a frame problem, not a carving problem

The same ten-home walk with perfect tracking (house-hard sensor noise,
densified depth, dark couches, but no odometry drift, relocalisation jumps
or tracking loss; `NOISE={"odometry":null,"relocRate":0,"lossRate":0,"driftPos":0,"driftRot":0}`, the first six homes):

| run | n | cover% | prec% | local% | falseFree% | localFF% | pathColl% | locPath% | locNode% | hideBad% |
|---|---|---|---|---|---|---|---|---|---|---|
| house-hard (same six homes) | 6 | 76.3 | 74.0 | 74.8 | 17.7 | 14.3 | 31.5 | 7.5 | 1.1 | 5.5 |
| house-hard, perfect tracking | 6 | 78.6 | 96.2 | 97.1 | 0.9 | 0.7 | 3.5 | 1.5 | 0.2 | 0.0 |

With the frame right, the mapper hardly ever believes it saw the inside of
furniture empty (0.9%), and no hide spot is inside furniture. So the 15%
falseFree and the hide spots inside furniture of house-hard come from the
frame, not from the carving rules. `la-carve-why` confirms it from the
other side: over a 600 s walk of the 12×15 home only 40 rays carved into
the inside of real furniture at the time they were integrated (mostly
noisy floor readings behind a bookshelf), while the local falseFree of the
couches reached 30% — free space carved correctly in front of a couch
minutes earlier, in a frame that has drifted since, now lies inside the
real couch as the camera sees it. `la-petcoll`: where a nav node puts the
pet inside furniture, the map at that point is mostly *unknown* (65–80%:
low wall bases, toys never measured) or *confidently free* (20–35%: stale
free space).

### 3. Weakening stale free space behind surprising surfaces: no

If a precise reading lands where the map believes it saw empty space, the
map there is stale; the space just behind that surface can't have been seen
empty from here. `WorldModel.staleFreeDecay` weakens the free belief over
15–20 cm behind such readings (`VoxelGrid.decayBehind`). Paired against the
baseline over the ten homes:

| arm | cover | prec | localFF | locPath | locNode | hideBad |
|---|---|---|---|---|---|---|
| halve, 15 cm, trigger ≤ −8 | −0.9 ± 0.3 | −2.1 ± 1.7 | −1.2 ± 1.0 | −0.1 ± 0.3 | −0.1 ± 0.1 | +0.3 ± 0.6 |
| to unknown, 20 cm, trigger ≤ −3 | −2.7 ± 0.5 | −4.7 ± 2.2 | −1.6 ± 1.1 | −0.5 ± 0.5 | −0.1 ± 0.1 | −0.2 ± 0.8 |

It costs coverage and precision and buys nothing measurable for the pet.
Off (`staleFreeDecay = 0`).

### 4. Fading free space below a newborn surface: mixed, off

A surface that just became solid (a new one, or an old one seen again from
a drifted frame) makes the free space below it in its column suspect: it
was seen before this surface was known. `VoxelGrid.fadeBelowNew` scales
that free belief (0: back to unknown, so it must be seen empty again;
under an observed top unknown counts as solid). Paired, ten homes:

| arm | cover | prec | local | localFF | pathColl (whole map) | locPath | hideBad |
|---|---|---|---|---|---|---|---|
| to unknown | −1.3 ± 0.5 | −4.5 ± 1.8 | −1.4 ± 0.6 | −0.7 ± 1.0 | **−8.1 ± 2.3** | −0.5 ± 0.7 | −0.1 ± 1.0 |
| halve | −1.1 ± 0.4 | −4.7 ± 2.0 | −1.4 ± 0.6 | −0.9 ± 0.8 | **−7.5 ± 2.4** | −0.7 ± 0.4 | −0.9 ± 0.5 |

(Caveat: these two arms ran on a build that, by mistake, also probed for
holds during the post-release cooldown after any tracking loss; the
reference didn't. The precision cost may partly be that.) Whole-map pet
paths through furniture drop from 28% to 20% (the stale
free space under old copies of tables and sofas goes), but obstacle
precision drops 4.5 points (unknown voxels turn occupied on a noisy hit or
two where old free evidence used to absorb them) and nothing changes
around the player, where the pet actually walks. Off; worth revisiting
with a cleaner trigger.

### 5. Hide spots that keep clear of uncertain structure (commit fe9de04, on)

What makes a hide spot put the pet inside furniture (`la-petcoll`, two
homes, a spot every 10 s): mostly walls and bookshelves, 2–5 cm deep, with
the map either *unknown* at the penetrating point (the foot of a blank wall
never measured) or confidently free (an old, shifted copy). By the distance
from the spot to the nearest mapped obstacle at body height: < 12.5 cm 31%
bad, 12.5–17.5 cm 10%, 17.5–25 cm 4%; by the walk since the cover was last
seen: < 5 m 6%, 20–60 m 17%.

`scripts/la-hide-batch.ts` runs the game's hide-spot search under several
policies on the same walks (every 15 s, seeker at the camera, as the game
relaxes cover when nothing qualifies), scored in reality through the
current frame. Ten homes, house-hard, 600 s:

| policy | no spot at all % | spots with the pet inside furniture % | homes with any |
|---|---|---|---|
| none (round 2) | 5.4 | 4.4 | 10/10 |
| 15 cm from solid, 14 cm from the unmeasured foot of structure, body 80% seen empty | 6.9 | 3.0 | 10/10 |
| + 20 cm from structure not seen for 30 s (**default**) | 6.9 | 2.1 | 10/10 |
| + 25 cm from structure not seen for 30 s | 6.9 | 1.2 | 5/10 |
| (15 s instead of 30 s: same) | | | |
| 20 cm from all solid, 14 cm from any never-observed space (earlier variant) | 7.7 | 0.9 | 8/10 |

The stricter variants fail single-room game tests: a margin from
everything (or 25 cm from structure a single-room game already counts as
stale) pushes spots into the open, and Hopper is visibly less hidden
(`room r31`: core body 33% visible at seek start; the hard-mode sneak
scenario finds no nearby standing spot Hopper is hidden from). The default
keeps every game test unchanged and passing. When no spot passes at any
level of cover, the game falls back to `RELAXED_SPOT_SAFETY` before giving
up.

Harder: the same walks with 70% of the furniture in dark fabric/finish
(`DARK=0.7`: 60% depth dropout, filled by densification) and two pieces
moved every minute in rooms the walker isn't in (`MOVE={"every":60,"n":2}`):

| policy | no spot at all % | spots with the pet inside furniture % | homes with any |
|---|---|---|---|
| none | 3.5 | 3.8 | 10/10 |
| default | 5.0 | 2.4 | 6/10 |

### 6. Nav: unknown space at the foot of structure (off), stale-structure margin (off)

Where a nav node puts the pet inside furniture (`la-petcoll`), the map at
the penetrating point is mostly *unknown*: the bottom 25 cm of a blank wall,
a bookshelf, a sofa front or a table's legs that depth never measured, often
with a little seen-empty space between it and the part seen higher up, so
the shadow rule (unknown under an observed top is solid) doesn't apply. The
nav graph allows nodes with up to half the body unseen, so the pet walks
right up to (and a few cm into) them. `NavParams.footSolid`: such
never-observed space at body height counts as solid. Paired against the
round-2 nav on the same ten walks (mapping identical: nav-only rules):

| variant | cover | pathColl (whole map) | locPath | locNode | single-room game tests |
|---|---|---|---|---|---|
| under anything seen higher up (tables included) | −1.4 ± 0.3 | **−7.0 ± 2.0** | **−1.5 ± 0.6** | −0.2 ± 0.1 | fail: no walkable space under the dining table; Hopper less hidden (r5, living) |
| under tall faces starting ≤ 50 cm | −0.1 ± 0.0 | −0.8 ± 1.0 | −0.0 ± 0.4 | +0.0 ± 0.1 | pass |
| under tall faces starting ≤ 1 m (committed option, **off**) | −0.2 ± 0.0 | −1.6 ± 1.1 | −0.5 ± 0.4 | −0.0 ± 0.1 | pass |
| + the outer 10 cm under thin tops (legs) | not run | | | | fail (r5) |
| 70% of the body seen empty instead of 50% | −2.6 ± 0.5 | −3.9 ± 2.0 | −1.4 ± 0.6 | −0.3 ± 0.1 | not run |
| `staleMargin` 15 cm: extra clearance from structure not seen for 30 s (**off**) | −0.1 ± 0.1 | −1.1 ± 0.7 | **−1.0 ± 0.4** | −0.2 ± 0.1 | pass |

The benefit is almost all under tables and seats (their legs are thin and
rarely measured), and the space under tables is exactly where hiding and
walking should stay possible, which the single-room game tests check. The
stale-structure margin is the cleanest win for walking (local pet paths
into furniture 5.9 → 4.9% at no coverage cost) but it raised hide spots
inside furniture by 0.8 ± 0.4 points in the same runs, unexplained; both
stay off pending a better look. The margin needs the grid's hit times: the
client computes the stale columns and sends them to the nav worker.

### 7. Warping on the tracker's own loop closures: still worse

`DRIFT={"jumpWarp":true}` (round 5's "tracker-jump warp") with this
round's metrics, paired: coverage −0.9 ± 0.2, precision −2.1 ± 1.0, local
precision −1.3 ± 0.5, pet safety unchanged. Off.

### 8. "Tucked beside the box": phantom objects named at hide spots

The real-room report "it keeps saying lots of the floor is shelves" didn't
reproduce as shelves (0.1–0.3% of open floor), but as boxes: in the 14×16
home, 16% of the open floor near the player (no real furniture within
50 cm) was "near" an object, almost always a "box" — and every one of them
a phantom (`la-petcoll OBJ=1`): 10–15 cm high blobs, the leftover base of an
old, shifted copy of a sofa or bookshelf, floor bumps. `objectNear` (the
name in "I was tucked beside the …") now skips objects lower than 20 cm:
open floor near a named object 16.4% → 1.6% (0.9% "box", h ≥ 20 cm, still
mostly phantoms). The world test for "open floor is not near the shelf"
still passes.

## Persistent tracking jumps (house-jumps)

### What the post-loss checks see, labelled with the truth

`TRACE=place` (new) prints every place-memory estimate next to the frame
error it would leave (truth): `RIGHT` if it would cut it by 10 cm or more,
`WRONG` if it would add as much. On the 12×15 home under house-jumps
(seven jumps of 37–135 cm in 600 s), with post-loss holds detaching the map
and multi-look re-attachment (below): of 28 estimates, 8 RIGHT and 17
WRONG, and the WRONG ones are not separable by any single-look statistic —
wrong estimates with uniqueness 57–115 (no second peak at all), right ones
at 1.13–1.4. Support is low for both (10–20% of the readings). Matching
against visits from just before the loss (little drift since, so a
correction found there *is* the jump; `DriftMonitor.eventRecentVisits`)
was no better: 0 of 3 right.

### Detach after a post-loss hold, multi-look re-attachment: worse

- `WorldModel.detachAfterLossHold`: a hold (the view contradicts the map)
  that times out after a tracking loss nothing has verified since (a view
  landing on known structure and agreeing, or a realignment) puts the map
  aside instead of releasing the held frames into it.
- `DriftMonitor.relocVotes`: re-attach when several looks from different
  views (camera moved 0.5 m or turned 0.6 rad between two of them) agree
  and outnumber the others two to one, even if no single look is clearly
  unique.

On the 12×15 home this detached 9 times in 600 s (the first at 60 s, before
any jump: drift alone makes post-loss holds) and never re-attached: the
looks rarely agree because most are wrong in different ways. Coverage
collapsed (map put aside again and again). Both stay off.

### The platform's own signal: XRReferenceSpace `reset`

A tracker that relocalises or restarts its map moves the tracking origin;
WebXR reports that as a `reset` event on the reference space, with the
new origin's pose in the old coordinates when the runtime knows it. The app
didn't listen. Now `ArMode` passes it to `WorldModel.trackingOriginReset`:
with a transform, the map frame follows exactly (registration corrected
by `t2m · T · t2m⁻¹`, nothing to rediscover); without one it is a tracking
event like a loss. Unit test: a 70 cm / 0.3 rad origin move with its
transform leaves < 1 cm of frame error and no detach (`test/jump.test.ts`).
How often real runtimes fire it (and with a transform) is unknown; the sim
jumps are silent, so this changes nothing in the benchmark.

### Where house-jumps stands

Ten homes, 600 s, current defaults (reference: the same walks under
house-hard):

| profile | cover% | prec% | local% | falseFree% | localFF% | frameErr cm (max) | locPath% | locNode% | hideBad% |
|---|---|---|---|---|---|---|---|---|---|
| house-hard | 76.2 | 77.6 | 78.6 | 14.8 | 11.4 | 19 (56) | 5.9 | 0.9 | 2.4 |
| house-jumps | 69.6 | 55.5 | 37.6 | 29.1 | 50.0 | 164 (278) | 21.6 | 5.1 | 8.1 |

Half of the live map around the player is inside real furniture as the
camera sees it, a fifth of the pet's paths run into something. Unchanged
from round 2 (local 39%, frame error 1.9 m); nothing tried this round
fixed it in the sim.

## Loop closure without the warp, small search: worse

The voxel-map loop check (`closing`, structure born ≥ 15 s before the
frames) with a working two-estimate gate (`loopPendingSeconds: 8`), no
warp, and a search kept small so that look-alikes a metre away are out of
reach. Paired against the defaults, ten homes:

| arm | cover | prec | local | frameErr cm | locPath | hideBad |
|---|---|---|---|---|---|---|
| ±25 cm / ±0.06 rad | −2.8 ± 0.6 | −17.1 ± 1.7 | −6.4 ± 1.2 | +20 ± 7 | +0.5 ± 0.5 | +0.6 ± 0.5 |
| ±40 cm / ±0.12 rad | −2.4 ± 0.7 | −14.1 ± 3.5 | −6.5 ± 1.6 | +16 ± 6 | +1.8 ± 0.9 | +1.2 ± 0.6 |

`TRACE=mis` (new: every voxel-map estimate with the frame error it would
leave) shows why even a small search goes wrong: the "old structure" is
itself a drifted copy. Late in a walk the tracker often closes its own
loop and is right again (frame error 2–5 cm), and the old structure
around it is the copy laid down while it was 20–50 cm off; aligning the
frame to it is "right" locally and wrong for everything mapped since.
Without per-submap poses (a pose graph that can move the old copy instead
of the frame) loop closure stays off.

## Camera-only depth: inferring the layer above observed floor

Round 2's diagnosis: motion stereo rarely measures a blank floor itself, so
rays never carve the first 25 cm above it, and walkable floor needs two
seen-empty voxels there. `NavParams.inferLowFree` (m): in a floor-observed
column (floor planes or depth), never-measured voxels from the floor up to
the lowest seen-empty voxel count as seen empty if that voxel is at most
this high and nothing solid, guessed solid, shadowed or with any occupancy
evidence lies below it (rays passed over without meeting anything; a toy
that was ever measured blocks it). Six homes, camera-only (`CAMERA=1`),
house-hard, 300 s:

| arm | cover% | prec% | local% | pathColl% | locPath% | locNode% | hideBad% |
|---|---|---|---|---|---|---|---|
| camera-only | 17.8 | 74.4 | 88.8 | 1.2 | 2.0 | 0.6 | 0.0 |
| + inferLowFree 0.35 m | 24.7 | 74.6 | 89.0 | 5.7 | 4.4 | 1.6 | 0.0 |

Paired: coverage +6.9 ± 1.7 (+39% relative), but local pet paths into
furniture +2.5 ± 1.3 and nodes +1.1 ± 0.7: what is under the never-measured
layer is sometimes a low object nobody measured (a toy, the dark base of a
sofa). With a depth sensor (house-hard, ten homes) the same rule adds coverage
+1.8 ± 0.4 and local pet paths into furniture +0.6 ± 0.4, nodes +0.2 ± 0.1.
Off by default (pet safety first); a camera-only build could take the
trade. Unit tests: `test/inferfree.test.ts`.

## Where it stands (round 3)

Ten homes, house-hard, 600 s, fast pans; "round 3" is the final defaults
(the same walks: mapping is unchanged, so every map metric is identical):

| | cover% | prec% | local% | falseFree% | localFF% | frameErr cm (max) | pathColl% | locPath% | locNode% | hide spots inside furniture | open floor named after a phantom |
|---|---|---|---|---|---|---|---|---|---|---|---|
| round 2 (aa95d23) | 76.3 | 77.6 | 78.6 | 14.8 | 11.4 | 19 (56) | 28.1 | 5.9 | 0.9 | 4.4% (la-hide) / 4.3% (in-run) | 16.4% (14×16 home) |
| round 3 | 76.3 | 77.6 | 78.6 | 14.8 | 11.4 | 19 (56) | 28.1 | 5.9 | 0.9 | **2.1% / 2.6%** | **1.6%** |
| perfect tracking (reference) | 78.6 | 96.2 | 97.1 | 0.9 | 0.7 | 0 | 3.5 | 1.5 | 0.2 | 0.0% | |

Harder (70% dark furniture, two pieces moved every minute): hide spots
inside furniture 3.8 → 2.4%. house-jumps: unchanged (local 37.6%, frame
error 164 cm, local paths into furniture 21.6%). Camera-only: unchanged by
default (17.8% coverage at 300 s; 24.7% with `inferLowFree`, at a cost in
pet safety).

What changed by default: hide spots keep clear of uncertain structure
(§5), low objects aren't named at hide spots (§8), the app follows
XRReferenceSpace `reset` events. Main-thread cost: the hide-spot checks run
once per round inside the existing search (game tests' `planMs` within its
1.5 s bound); nothing per frame.

Remaining, in order of how much they hurt:
1. The frame. With perfect tracking the mapper is nearly clean (falseFree
   0.9%, no hide spot inside furniture); with house-hard drift the live map
   around the player is 21% wrong and 6% of the pet's paths touch real
   furniture; with persistent jumps, 62% and 22%. Every map-side rule tried
   this round (decay, fading, margins, foot rules) trades coverage or
   hiding quality for a point or two; the leverage is in keeping the old
   map consistent with the current frame, which needs per-submap poses (a
   pose graph that moves old copies, not the frame) and match verification
   that survives look-alikes: single looks are confidently wrong (uniqueness
   57–115 on wrong place matches).
2. Unmeasured low structure (blank wall bases, table and chair legs): the
   nav rule that blocks it under anything seen higher up cuts pet paths into
   furniture by a quarter but closes the space under tables; a rule that
   tells legs from open space under a table is the next step.
3. Camera-only coverage: inference of the layer above observed floor works
   (+39%) but walks the pet into low unmeasured things; it needs a check
   that the inferred floor is clear (plane polygons from the platform, or
   image texture) before it can be on.

