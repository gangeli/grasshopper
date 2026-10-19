# Mapping & pathfinding stress testing

The question this answers: **with a real phone camera, does Hopper walk into furniture, stand on thin
air, or jump onto things that aren't there?** These are the failure modes people notice. Everything
below is automated and reproducible.

## How it's tested

### 1. Simulated rooms with realistic operating conditions (`real` profile)

The first simulator was too kind: clean boxes, noise that averaged out over frames, and a tidy
scanning script. Realistic conditions now include:

| Effect | Model |
|---|---|
| Depth noise | σ(z) = 0.8cm + 1.5cm·z² per pixel, plus a frame-level correlated bias |
| **Persistent bias** | World-anchored error field (±1.5σ). The same wall is "bent" the same way every frame, so it doesn't average out. This is the dominant real effect. |
| Edge bleeding | Flying pixels and smoothing across silhouettes |
| Holes | Random dropouts, blobs, and texture-less walls and floors (50% holes, 2.5× noise) and dark fabric (60% holes) |
| Glass | Invisible to depth and to plane detection; still solid |
| Mirrors | Depth sees a phantom room *behind* the mirror |
| Clutter | Toys (4–14cm), cables, rugs, books on tables, pillows |
| Moving people | Someone walks through the room while it's being mapped |
| Tracking | Drift, jitter, **relocalisation jumps** (8cm / 2°), tracking loss, motion blur |
| Planes | Boundary errors, height errors, none on glass or mirrors, slow on blank surfaces |
| Human scanning | Wanders, whip-pans, crouches, looks at random things. No neat 360° sweeps. |

Metrics come from ground truth (`src/sim/MapMetrics.ts`). The reports are `scripts/map-report.ts` and
`scripts/real-report.ts`:

- **paths colliding / max penetration**: random nav paths (walks *and* jump arcs) checked against real geometry with the pet's body (7cm radius, 3–22cm high)
- **bad landings**: jump landings with no real surface within 6cm
- **unsupported nodes**: places the pet would stand on nothing
- **false-free**: real solid space (voxels wholly inside furniture) that the map believes it *saw* empty
- **surface error**: distance from mapped obstacle voxels to the real surface (furniture only, no walls)

### 2. Real sensor data (TUM RGB-D `fr1_room`)

A real office walked with a handheld Kinect, with motion-capture ground-truth poses
(`scripts/tum/prep_tum.py`, `scripts/tum-replay.ts`). There's no ground-truth mesh, so the map is built
from even frames and checked against the **held-out odd frames**. The replay also runs
**phone-resolution** (40×30, what the app samples from ARCore) and **phone-like tracking error**
(drift, jitter, relocalisation jumps on the mapping frames).

```
npx tsx scripts/tum-replay.ts data/tum/fr1_room [--phone] [--pose-noise] [--png out.png]
```

Real reference data is itself noisy (±5–8cm), so a single held-out reading 4cm above a floor node is
noise, not an object. "Real object in the pet's body" therefore means ≥25% of the readings in the pet's
footprint, from ≥2 frames, sit 8–22cm above where it stands. The stricter variants are printed too.

### 3. Full games and runtime safety

- `test/game.test.ts`: the seeker bot plays complete rounds in 8 clean and **6 realistic** rooms. It asserts Hopper is truly hidden at the start (core body), never clips furniture, and that "found" only fires when Hopper is really visible.
- `test/runtime-safety.test.ts`: a box is dropped in Hopper's path mid-walk. The live map flags it, the path guard stops and replans, and Hopper never touches it.
- `test/mapping-stress.test.ts`: CI regression guards on the realistic metrics.
- `e2e/ar-emulated.spec.ts`: the real WebXR code path on an emulated phone and Quest, now with noisy, biased depth.

## Results (current code)

### Real data: TUM fr1_room, phone resolution + phone-like tracking error

| Metric | Value |
|---|---|
| Nodes with a real object inside the pet's body | **0.4%** |
| Standing-height error (real surface − node) | median **1.0cm**, p90 **2.9cm** |
| Jump landings without real support (observed landings) | **8 / 356** (2%) |
| Walkable area | 6.6 m² |
| Held-out rays passing through mapped "phantoms" | 5.8% (benign: Hopper just avoids them) |
| False-free (8cm behind held-out surfaces, <2m) | 7.9%* |

\*Upper bound. The metric assumes objects ≥8cm thick, but offices are full of monitor panels and
chair backs where 8cm "behind" really is empty.

![TUM fr1_room top-down: walls orange, furniture brown (by height), walkable green, nodes with real
intrusions red, camera path blue](tum-fr1-room-topdown.png)

### Simulated, realistic conditions (12 dressed rooms, human scanning, `real` profile)

| Metric | Value |
|---|---|
| Paths brushing furniture | 4.3% (median worst 5cm, max 13cm) |
| Jump landings on nothing | **0 / 635** |
| Standing on nothing | 0.02% of nodes |
| False-free | 2.3% |
| Surface error p95 | 8.0cm |
| Walkable area (mean) | 11.2 m² |
| Frames rejected by the tracking gate | 31% |

Clean rooms with an ARCore-like sensor (`arcore`) have essentially zero collisions (max 2cm) and zero
bad landings. With the deliberately awful `harsh` profile, Hopper stays safe but gets only 2–4m² in
some rooms.

## Phones without a depth sensor: depth from the camera

Most phones have no depth sensor; ARCore computes depth from camera motion and
WebXR hands the app that (densified) result. To test that regime honestly:

- **`src/sim/CameraSim.ts`** renders the simulated rooms as a phone camera sees them: textured
  furniture, nearly blank walls and floors, dark fabric, see-through glass with faint reflections,
  mirrors, ceiling lights with shadows, lagging auto-exposure, shot/read noise, vignetting, motion
  blur (shutter centred on the frame time) and 8-bit quantisation. Poses come from the same tracking
  error model, with VIO-like smooth short-term error (~1% of the distance moved).
- **`src/world/StereoDepth.ts`** is plane-sweep motion stereo on those frames: census matching over
  up to four nearby frames, cost aggregation, sub-sample refinement, and strict acceptance
  (uniqueness, texture, the aperture problem — texture parallel to the epipolar line can't fix
  depth — baseline geometry, angular speed, number of views). It reports a per-pixel σ that the
  mapper uses instead of its generic noise model. An optional ARCore-like edge-aware densification
  produces the dense depth WebXR actually delivers.
- **`DepthConsistency`** (`src/world/DepthFrame.ts`) keeps only depth pixels that another recent view
  supports and none sees through: interpolated fills move with the viewpoint, real surfaces don't.

| 12 dressed rooms, `real` profile | camera-only stereo | depth-sensor model |
|---|---|---|
| False-free (solid believed seen-empty) | **0.4%** | 1.1% |
| Paths brushing furniture (max penetration) | 4.4% (5cm) | 5.8% (5cm) |
| Jump landings on nothing | **0 / 645** | 1 / 877 |
| Walkable area (mean) | 6.8 m² | 12.0 m² |

Camera depth is at least as safe but maps less: blank floors and walls give no matches. A fully
textureless floor (room r29) is close to unplayable from the camera alone — the game tells the
player to point at the floor in better light rather than inventing ground.

**Real camera images (TUM fr1/room colour frames, Kinect as reference)**, after undistortion: motion
stereo has a median error of 4.3% (signed −1.2%), 6% of pixels off by >25%. Mapping from *dense*
(filled) stereo without the consistency gate puts phantom surfaces on 31% of held-out rays and real
objects inside the pet's body at 2.1% of nodes; with the gate those drop to 10% and 0.3% (Kinect-built
map: 9% and 0.2%). Coverage on that sequence is low (1.6 m² vs 8.2 m² from the Kinect), because the
camera mostly looks at desks and the floor is only glimpsed.

## Staying unstuck: fault injection and recovery

A mapping mistake is bad; a state the game can't get out of is worse. `src/game/Health.ts` watches
for impossible or contradictory states every frame and recovers, gentlest fix first. It is exercised
two ways:

- `test/health.test.ts` (CI) breaks one thing at a time: NaN/negative/huge camera input, a NaN pet,
  a floating pet, a floor estimate 5–10cm too low or too high, a covered camera, a map wipe mid-round,
  a map rebuild under the nav graph, and a big relocalisation jump after a tracking loss.
- `scripts/soak-batch.sh` plays 12 rooms × 5 minutes continuously (round after round) while injecting
  a random fault every 60–90s: relocalisation jumps of 15–35cm (with a tracking-loss event),
  "silent" loop-closure jumps of 6–15cm, floor shifts of ±5–10cm, a covered camera, NaN poses, the
  pet dropped inside furniture / into mid-air / to NaN, and full map wipes. On top of that the
  sensor itself is the pessimistic `real` profile (drift, its own relocalisation blips, tracking
  loss, persistent depth bias).

| Fault soak: 12 rooms × 5 min, a random fault every 60–90 s, `real` sensing | Result |
|---|---|
| Rounds played | 59 |
| Longest stretch with no round going anywhere | **41 s** (median 23 s) — never stuck |
| Crashes / exceptions | **0** |
| Frames with a non-finite pet position (the injected `petNaN` fault, fixed the next frame) | 2 |
| Time the pet was visibly inside real furniture | 16 s in total (one case: 6 cm into a textureless bookshelf that depth barely sees) |
| Map precision at the end (mapped obstacles that are real, as the camera now sees the room) | median 64%, min 46% — faults every minute leave some ghosts that later views clear |

Healthy sessions (24 rounds, no injected faults): every round finished, no false realignments, no
false depth-only floor moves (plane-based refinements improved floor accuracy, e.g. 4.0→1.2cm);
after the simulator's own tracking losses the map was aged a few times and reset twice.

**Mechanisms** (and the bugs the fault tests found on the way):

- **Map frame vs tracking frame.** Everything (map, nav, pet) lives in a map frame; incoming data is
  mapped into it through `trackingToMap = registration · anchor`. On devices with WebXR anchors the
  app feeds the anchor's motion in, so platform relocalisations carry the map along. Content is
  rendered under a `mapRoot` group with the inverse transform.
- **Self-registration (`DriftMonitor`).** Recent precise depth is scored against a *snapshot* of the map
  taken before those frames (the live map is already contaminated by them). A correction is applied
  only with strong support, when it beats "no correction" by 2×, agrees across two looks and — for
  drift — across two snapshots (a person walking by "aligns" with where they were a moment ago; real
  drift moves everything the same way). Ties prefer the smallest correction, so a long wall can't drag
  the map along itself. Big searches (±50cm) only happen right after the device reports a tracking
  loss, against the map as it was at the loss; the correction then undoes everything since (grid
  restored from a snapshot, buffered frames replayed corrected). False realignments in healthy
  sessions: 5 of 18 rounds before these rules, 0 of 18 after.
- **When no consistent correction exists** after a loss, the evidence is aged (keeping every voxel's
  class — an earlier version scaled log-odds and made obstacles vanish, so a hidden pet was "found"
  through a box) and, if the world clearly moved a lot, the map is cleared and the pet re-anchored in
  front of the player. No new rounds start while the map is suspicious.
- **Floor.** Floor planes and depth near the floor must agree (or depth alone must show an error
  ≥5cm, beyond its own few-cm bias) before the floor moves; the move keeps the rest of the map (voxels
  shifted, only the near-floor band re-learned) and is undone if fresh evidence points back.
- **Pet sanity.** NaN, off-map, under the floor, floating, or inside something — judged from the
  map, from space the map infers is solid (inside a sofa), and from *live* depth landing in the pet's
  body — leads to a hop to the nearest valid node (or back to the player).
- **Flow.** A move that stops making progress along its path, or a phase far past its time limit, is
  ended; a seek phase reveals the pet even if it never stopped moving (it used to wait forever).
- **Garbage in.** Covered-camera frames (most readings <30cm), NaN/∞ depth and non-finite poses are
  rejected before they touch the map.
- **A latent sink fixed:** the nav graph kept a reference to the old voxel grid after *any* map
  rebuild (including the original floor refinement), freezing navigation on a stale map forever.

## What the stress tests found (and what changed)

Ordered roughly by impact:

1. **Depth front end (`src/world/DepthFrame.ts`), shared by the device and the simulator.**
   - A discontinuity filter on *inverse* depth (its second difference): it removes flying pixels at silhouettes but keeps floors seen at glancing angles. The first version compared raw depth, which threw away the whole distant floor.
   - A **pose gate** that drops frames during tracking loss (`emulatedPosition`) and for 0.8s after implausible pose jumps.
2. **Precision-weighted evidence.** Far, noisy readings only nudge free space, and above σ = 6cm they never create obstacles. Carving stops 3.5σ short of each reading.
3. **Only trust what was seen.** Standable surfaces must be strongly observed (not guessed), most of the pet's body footprint must have been *seen* empty, and jump arcs must cross observed-empty space.
4. **Jumps.**
   - Arcs are checked with the pet's width, and their height adapts so Hopper vaults basket rims.
   - Landings need a ~10cm no-drop-off zone.
   - **You can't drop onto a spot under something, or leap up from one.** On the real data, Hopper was jumping from a desk to the floor *under the same desk* through gaps in the thin desktop.
   - Same-height leaps only go over mapped obstacles.
5. **Floor height.** Refined from detected floor planes, with hysteresis. Depth-only corrections are limited to one ±3cm step, because blank floors are biased (one room had its floor "corrected" 6cm wrong). Sub-voxel surface heights stop Hopper floating up to 5cm above tables.
6. **Small and low things.**
   - Tight floor classification (≤6cm) means toys don't vanish into "noisy floor", and precise readings 2.5–6cm up count as weak obstacle evidence.
   - Hopper never stands on 5–12cm "platforms", which are mostly floor noise.
7. **Hiding vs. finding under uncertainty.** When choosing a spot, unknown space counts as see-through: only hide behind observed things, with a 6cm margin. When deciding "found", unknown space counts as blocking.
8. **Runtime safety.** A dynamic-obstacle layer reacts to readings inside space the map is sure is empty (the column down to the floor and 20cm behind the seen face become temporary obstacles). The path ahead is re-checked 3×/s, and Hopper stops and replans if it's blocked.

## Known limitations (honest list)

- **Tracking error blurs the map.** With 1–2° of yaw drift, a ray that grazes a box corner is placed through it, so ~4% of paths can brush furniture by a few cm, and rarely up to ~13cm at a corner. An occupancy map can't fully undo pose error. Better relocalisation (anchors) and pose-graph-aware maps would help.
- **Small things under ~4cm** (cables, flat toys) are below what phone depth separates from the floor. Hopper walks over them, which is mostly fine visually.
- **Glass:** a glass table top is invisible to depth and to plane detection. Hopper can't stand on it and may path under it. It's see-through for the game too, so "found" stays correct.
- **The simulator is still a model.** The `real` profile is meant to be pessimistic, and the TUM replay uses a Kinect, not an ARCore phone, which has different error characteristics. **The next validation step is a recorded ARCore session** (depth + poses), replayed through `tum-replay.ts`-style tooling. The `DepthImage` format the app logs is the same one the replay uses.
