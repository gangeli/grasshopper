# Remembering rooms across sessions

Hopper maps the room into a 5 cm voxel occupancy grid. This document describes how
that map is saved on the device, found again in a later session (whose WebXR frame is
arbitrary), checked, merged, and grown over many sessions — and the adversarial
simulation loop used to harden it.

## Design

```
src/world/persist/
  ChunkedMap   sparse, unbounded 16×16-column chunks of plain typed arrays (floor-relative layers)
  adapter      the only bridge to the live WorldModel grid (export / import)
  codec        binary format: header + CRC-32, run-length voxels, gzip (CompressionStream)
  MapStore     IndexedDB key/value store, crash-safe generations + backup, budget, failure-tolerant
  features     what the relocalizer looks at: height-band column counts, voxel samples, wall normals,
               per-voxel score classes of a stored map
  fft          radix-2 FFT (1D/2D, resumable)
  Relocalizer  global search (FFT correlation over yaw × translation), 3D refinement, verification, judging
  Stitcher     resampling between frames, restore rule, evidence fusion, live-evidence bookkeeping
  MapMemory    the session state machine: search → agree → restore → verify → confirm → save; undo
  gen          generator helpers (all heavy work is resumable and runs a few ms per frame)
src/app/Memory.ts   app glue: "I remember this room!", save on hide/exit, forget control
src/sim/Home.ts, MultiSession.ts, PersistBench.ts   multi-room homes, sessions in random frames, benchmark
```

### Frames

Every WebXR session starts with an arbitrary tracking frame. The floor height is known
from hit tests / floor planes, so two sessions' maps differ by a rigid transform about the
vertical axis: yaw + x/z translation (`Pose2`), plus at most a layer of floor error. Maps
are stored floor-relative (layer 0 = first layer above the floor), so heights line up.

Each stored map ("fragment") keeps the frame of the session that created it, forever.
Later sessions never re-anchor it: their *own* observations are resampled into the
fragment's frame and fused there. (Re-saving the merged live map in each new session's
frame would resample all the old data every session and blur it a little more each time.)

### Session flow (MapMemory)

1. **Load** every stored fragment (corrupt ones are skipped; the previous generation is
   tried as a backup).
2. **Search** every ~4 s once the live map has ≥ 1 m² of observed floor: the session's own
   observations (stored maps excluded, see below) are relocalized against up to 3
   fragments per attempt.
3. **Agree**: a placement must be accepted by two attempts with the live map grown in
   between. The second attempt is a cheap re-check of the placement and its rivals (no
   global search).
4. **Restore**: the fragment is resampled into the live grid's frame and lattice and
   combined with the live grid: voxels the session observed confidently (|log-odds| ≥ 12)
   keep the live value; elsewhere the stored value is used with its confidence capped
   (obstacles at 44 < STRONG_OCC so restored obstacles never count as "contradictions"
   for the drift/health checks, and ~12 rays clear them; free space at −30). Hopper says
   "I remember this room!", and navigation/occluders rebuild: the mapped area (and hide
   & seek) is available at once.
5. **Verify** every ~5 s against the session's *own* observations only. Two failed checks
   in a row **undo** the restore: the live grid returns to the session's own observations
   (plus other restores), and that placement is blocked for the session.
6. **Confirm** after ≥ 25 s and 3 good checks. Only then is anything written into the
   stored fragment.
7. **Save** every 30 s and when the page is hidden/left: confirmed → the fragment as
   loaded, plus the session's own observations resampled into its frame and fused
   (newer observation wins where they disagree); other confirmed fragments are
   **stitched** into it (Q → live → P) and deleted. Not confirmed → the session is saved as
   its own new fragment (if it covers ≥ 4 m²), which a later session can find or stitch.

Fragments in memory are never modified: every save re-derives the new version from the
loaded one, so an undo can always put the stored version back.

**The session's own observations** after a restore: the live grid then mixes stored and
live evidence. MapMemory keeps `liveOnly` (own evidence at restore time) and `base` (the grid
right after the restore); own evidence now = `liveOnly + (grid − base)` per voxel (log-odds
are additive; clamping loses little). When the world model rewrites the grid itself
(floor relevel, drift realignment, aging, rescan), the bookkeeping is re-based on the
last computed evidence (rescan drops restores).

### Relocalization

1. **Features** per map: per 5 cm column, counts of confidently occupied voxels in three
   height bands (15–60, 60–130, 130–240 cm) and of confidently free voxels; voxel samples
   (one per column and height band, so tall walls don't outweigh furniture), each marked
   *furniture* (column below 1.1 m) or *structure* (column reaching above 1.1 m), with the
   wall normal for structure samples; for the stored map, a per-voxel class lookup
   (confident obstacle / obstacle / next to an obstacle / confidently free / unknown).
2. **Coarse search**: 2D signature images (bands + free space) at 20–30 cm cells; for each
   yaw (3° steps) the live image is rotated and correlated with the stored one by FFT over
   all translations at once. Obstacle-on-obstacle scores +, obstacle-on-seen-empty (both
   ways) −, seen-empty-on-seen-empty a little + (rewards overlapping as an area rather than
   touching along one wall). The best distinct peaks become candidates.
3. **Refine** each candidate in 3D: coarse-to-fine over yaw, x/z and ±1 layer, scoring
   voxel samples against the stored classes.
4. **Verify** both ways: live obstacles in the stored map, stored obstacles in the live
   map, live free space against stored obstacles, area overlap of free space (relative to
   the smaller map), furniture agreement, and how well the agreeing walls pin the pose
   (smallest eigenvalue of Σ n·nᵀ over their normals).
5. **Judge**: enough overlap; inlier share ≥ 0.8; ≥ 50% of live obstacles explained; a real
   area overlap; no rival placement (another basin, > 75 cm or 15° away, not ruled out by
   clearly more contradictions) scoring ≥ 70% of the best; furniture not mostly
   contradicting (another room of the same shape); and if the walls don't pin the pose in
   every direction, at least 3 separate pieces of furniture must agree almost perfectly
   (one piece moved along a wall would otherwise drag the placement with it).

Symmetric rooms are therefore refused rather than guessed.

### Storage

IndexedDB `hopper-maps`, one object store: `index` (JSON: fragment metadata) and
`frag:<id>:<generation>` (binary). A save writes a new generation, then switches the index,
then deletes the generation before the previous one (the previous one is a backup). Budget
40 MB; the smallest fragments are dropped first. Quota errors, missing IndexedDB (private
windows) and corrupt records are reported and skipped. `navigator.storage.persist()` is
requested after the first successful save.

## Harness

* `src/sim/Home.ts`: homes of 2–6 rooms with interior walls and doorways, furnished;
  `rearrange()` moves/removes furniture between sessions; region-limited scan paths.
* `src/sim/MultiSession.ts`: `SimSession` — one session in a random WebXR-like frame
  (yaw ∈ ±180°, x/z ∈ ±4 m, floor at 0 or ~−1.5 m), 'real' sensor noise (drift,
  relocalization jumps, tracking loss, hard materials, people walking), the drift
  monitor running as in the app; `FramedSensor` reports depth poses and planes in that
  frame, planes clipped to the rooms visited. `storedMapQuality()` scores a stored map
  against the ground truth.
* `scripts/persist-trials.ts` + `scripts/rejudge.py`: relocalization attempts (SAME room /
  OTHER room / moved furniture) logged with every verification metric, to calibrate the
  acceptance rule offline.
* `scripts/persist-bench.ts` (`src/sim/PersistBench.ts`): N sessions in one home sharing a
  store, measuring relocalization rate, time, accuracy, wrong restores (kept / undone),
  fragments, storage, map quality, save/load time and per-frame cost.

## Round log

See below (newest last).

### Round 0 — first relocalizer (trials: A maps 1–2 rooms, B in a fresh frame maps the same or another room, attempts at 10/20/30/40 s; dressed homes, 'real' noise, furniture moved in half the trials)

* Harness bug found first: the simulated plane detector reported the floor and outer
  walls of the *whole home* as soon as any part was seen, so every session "knew" every
  room's outer walls. Planes are now clipped to the rooms the camera has been in.
* Accuracy was good from the start (typically 1–5 cm, < 0.3°), but **3 false accepts in
  84 attempts**: (1) two maps aligned along one shared wall with their floors not
  overlapping at all; (2) a wrong placement 53 cm off in a room whose only visible walls
  were parallel and whose dominant piece of furniture had moved ~50 cm along them;
  (3) a bare room placed into another room of the same size.
* Also: rivals were mostly the *same* placement nudged a few degrees (same basin), so the
  score-ratio "ambiguity" refused good matches.

### Round 1 — overlap and rivals

* Seen-empty space must overlap as an area (≥ 30% of the smaller map's free samples).
* Rivals only from other basins (> 75 cm or > 15° away), and a rival with clearly more
  contradictions (≥ 2× and +60 samples) doesn't count.
* Voxel samples one per column and height band (walls had outweighed furniture 10:1).
* First "walls must pin the pose" test (shift the pose ±15 cm, see how many wall hits are
  lost) — useless: thick, noisy walls keep their hits; it refused 85% of good matches.
* Result: 0 false accepts in 146 attempts, but only 17 of 75 correct answers accepted.

### Round 2–4 — what the walls constrain; furniture as evidence

* Structure = columns reaching above 1.1 m (the camera mostly looks down; walls are rarely
  seen above 1.3 m). Each structure sample gets the normal of its wall (PCA of the tall
  columns around it); the smallest eigenvalue of Σ n·nᵀ over agreeing walls says whether
  they pin the pose in every direction.
* A unit test then caught a new false accept: a same-shaped room where 95% of the
  furniture landed in seen-empty space → **furniture mostly contradicting → reject**
  (another room of the same shape, or so much moved that the stored map isn't worth it).
* When the walls don't pin the pose: furniture must agree almost perfectly *and* come from
  ≥ 3 separate pieces (clusters). With 2 pieces the 53 cm slide (round 0, case 2) comes back.
* 0 false accepts in 320 attempts; 22 of 171 correct answers accepted: still mostly refused
  for "walls don't pin it".

### Round 5 — harness realism: interior walls

* The simulated plane detector only ever produced planes for a home's *outer* walls;
  ARCore finds interior walls just the same (blank ones need a better look). Added
  interior wall planes (both faces, detected when seen, 8 samples for blank walls).
* 117 of 196 correct answers accepted per attempt; 1 single-attempt false accept (a bare
  room, 10 s in, placed into another room of the same size — furniture barely seen).
  Session level (two agreeing attempts, as the app does): 35 of 51 same-room sessions
  restored within 40 s, **0 wrong**.
* Response: walls-only matches (fewer than 2 pieces of furniture agreeing) need a third
  agreeing look.

### Round 6 — the multi-session benchmark, first run (B0)

8 homes (2×2 rooms, dressed: blank walls, dark sofas, glass, mirrors, clutter, a person
walking through), 8 sessions of 60 s each, 'real' noise, furniture moved before 30% of
sessions, 35% of sessions start in a room never mapped, 40% walk through two rooms. Each
session gets 8 ms of memory work per 100 ms (main-thread slicing).

| metric | B0 |
|---|---|
| sessions in a known room that relocalized | 4 / 44 (9%) |
| wrong restores | 0 |
| time to relocalize | 43 s mean |
| alignment error | 1.0 cm / 0.21° |
| fragments per home after 8 sessions | 7.9 |
| stored size | 1.8 MB |
| precision / wall precision of stored maps | 0.957 / 0.992 |

Safe but nearly useless. Two causes: CPU (a search took ~1 s of desktop CPU, i.e. more
than 10 s of sliced work; sessions ran out of time), and partial overlaps (the "explained"
share counted live observations outside the stored map as unexplained).

### Round 7 — cost, worker, partial overlaps

* MapMemory now runs in a **Web Worker** in the app (`MemoryWorkerCore` / `MemoryClient`):
  the page only copies the grid when asked (via `exportMap`) and applies results; the
  worker does everything else including IndexedDB. In-page slicing remains the fallback.
* Search cost 860 → 375 ms (desktop): 30 cm signature cells (same accuracy and ranking in
  320 trial attempts), the live map cropped to 4 m around its centre for the FFT (128² →
  64²), 5 candidates, leaner refinement (the layer search only at the end).
* Back-off: a fragment that keeps saying no is searched every 4, 8, … 32 s unless the live
  map grew by 30% (+1 m²) since.
* "Explained" counts only live observations that land where the stored map has seen
  something.
* Restored maps are re-applied (fill-only) after the world model rewrites its grid (floor
  relevel, drift realignment); not after it ages the map (that's its reaction to
  contradictions, and the verification decides).
* **Offline stitching**: when idle, two stored fragments (neither in use) are compared;
  they are merged only if the search agrees from both sides, the margin is clear
  (ambiguity ≤ 0.5) and walls (or ≥ 3 pieces of furniture) pin it.
* Re-pointed to the world model's `exportMap()` (MapFormat.ts, 32-column tiles) through a
  lossless bridge; imports still write the grid directly (see "Interface notes").

## Interface notes (WorldModel.exportMap / importMap, MapFormat.ts)

Persistence works on its own `ChunkedMap` (16-column chunks, floor-relative layers);
`persist/mapFormatBridge.ts` converts to and from `SerializedMap` losslessly (tested both
ways, including `importMap(…, {mode: 'replace'})` into a fresh world). What the
persistence layer still needs from the interface:

1. **Exact replace** (incl. "unknown"): an undo must turn restored voxels back into
   unknown (0); `importMap` 'replace' skips zero values, so imports still write the grid
   directly (`adapter.importLive`). Wanted: `mode: 'exact'` (chunks present are written
   verbatim, zeros included) or a `clearChunks(keys)` call.
2. **Cheap, sliceable snapshots**: MapMemory snapshots the live map every few seconds
   from the frame loop. `exportMap()` copies everything at once (~50 ms for a 12 m grid
   on a laptop). Wanted: `exportMap({ since: version })` returning only chunks changed
   since a version (dirty-chunk tracking), or an export that can be resumed over frames.
   Until then snapshots copy the window grid in slices (and so don't include archived
   chunks once the grid becomes a moving window).
3. **Per-chunk last-observed time / session count** would let stored evidence decay where
   it hasn't been seen for many sessions (stale furniture) instead of keeping it forever.
4. **Grid-rewrite notifications**: today MapMemory infers relevel / realign / aging /
   rescan from `epoch` and `recoveries` counters; an explicit event (with the kind) would
   be more robust.
5. Restored evidence is capped at log-odds 44 (below STRONG_OCC) so it never counts as a
   "contradiction" in the drift/health checks; `importMap`'s `weight` scales differently —
   fine to keep, but the cap should be preserved if imports move to `importMap`.

### Round 8 — B1–B3: worker budget, wrong restores found and closed

Bench with 25 ms of work per 100 ms (a worker on a phone ≈ one core at ~¼ of desktop
speed), later a deterministic 100 slices per step:

| | B1 (worker budget) | B2 (+ cross-check of restores) | B3 (+ inlier ≥ 0.9, rival ≤ 0.4) |
|---|---|---|---|
| known-room sessions relocalized | 29/44 (66%) | 31/44 (70%) | 29/44 (66%) |
| wrong restores (kept at session end) | 2 (1) | 2 (1) | **0** |
| offline stitches (wrong) | 5 (0) | 6 (0) | 6 (0) |
| time to relocalize | 34 s | 34 s | 32 s |
| error mean / p90 | 2.1 / 4.2 cm | 1.9 / 3.6 cm | 2.1 / 3.5 cm |
| fragments per home | 5.2 | 4.9 | 4.9 |

Wrong restores seen and what closed them:
* A second stored fragment (another room of the same shape) restored on top of the room
  already restored → **a new restore must agree with every restore already made** where
  the two stored maps overlap.
* A 180° flip in a nearly symmetric room with furniture moved (undone by verification
  after a few seconds) and a never-seen room placed onto a known room of the same size
  (inlier 0.90, rival at 0.42–0.57) → acceptance tightened to inlier ≥ 0.9 and rival
  ≤ 0.4. On the 320 recorded trial attempts this costs 2 of 34 session-level restores and
  removes the remaining single-attempt false accept.

### Round 9 — long histories (3×2-room homes, 20 sessions each, 4 homes)

First run (L1): 49% of known-room sessions relocalized, 0 wrong restores, but **1 wrong
offline stitch** (two stored fragments merged 6.7 m apart: two-way agreement was not
enough), 16 fragments per home (sessions restored late and ended before confirming, so
each saved a duplicate), coverage of the biggest fragment 41%.

* Offline stitching now only re-checks **hints**: a session that found and verified a
  placement but ended before confirming saves its own fragment with that placement; a
  later session re-checks exactly that placement between the two stored maps, from both
  sides, with inlier ≥ 0.93. No blind searches between stored maps (a same-shaped room
  has nothing there to contradict it).
* Confirmation after 15 s (was 25) and 3 good checks.
* A second restore in the same session must also fit the live map *with the restored
  rooms in it* (walls and doorways around the room): this closed a 180° flip of a small
  fragment that had passed the pairwise cross-check (L1b: 1 wrong restore → L1c: 0).

| | L1 | L1c |
|---|---|---|
| known-room sessions relocalized | 33/67 (49%) | 39/67 (58%) |
| wrong restores / wrong stitches | 0 / 1 | 0 / 0 |
| fragments per home after 20 sessions | 16.0 | 10.5 |
| biggest fragment's coverage | 41% | 44% |
| error mean / p90 / max | 1.6 / 2.7 / 4.3 cm | 2.8 / 7.8 / 13.9 cm |

The error tail grew with history: fused sessions carry their own drift. Response: the
placement is re-refined at every verification and the latest one is used for fusing.

### Round 10 — symmetric homes (identical 4×4 m rooms, centred doorways)

* Furnished (S1): **2 wrong restores** with inlier 0.97–0.98 and no rival at all — a room
  placed onto the next identical room one room-width away (the session had seen almost no
  furniture). The "third look for walls-only matches" rule can't help: the world itself
  is ambiguous. → **Walls alone never decide**: at least one piece of furniture must agree.
  S1b: 0 wrong, 53% relocalized.
* Bare (S0: no furniture, only clutter): still **3 wrong restores** — the "furniture" that
  agreed was (a) the bottom of walls the camera never saw above 1.1 m and (b) floor noise in
  the 10–15 cm layer (a floor estimate a few cm off puts the floor there). → furniture
  samples must be low in *both* maps (the stored map usually saw the wall higher up),
  clusters must be compact (≤ 2.6 m: a long run is a wall), samples start at 15 cm.
  S0c: 1 restore of 30 sessions (correct), **0 wrong** — refusing is the right answer in a
  home of identical bare rooms.
* Standard bench after these (B4): 64% relocalized (B3: 66%), 0 wrong, error 1.6 / 3.2 cm.
