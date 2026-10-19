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
