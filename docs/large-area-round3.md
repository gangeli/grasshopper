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
- Spec helper for batches: `artifacts/` is not committed; the spec format is
  the one `scripts/large-area-batch.ts` documents.

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
