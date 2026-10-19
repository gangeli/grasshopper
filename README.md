# Hopper — an AR pet that plays hide and seek

Hopper is a small fantasy creature (part baby dragon, part grasshopper) that moves into your room
through your phone, tablet or headset. It maps your furniture, then hides — under tables, behind the
couch, inside baskets, tucked in corners — and you have to find it.

* **Play on Android** (Chrome) or **Meta Quest** (Quest Browser): open the GitHub Pages link and tap
  *Start in AR*.
* **No WebXR AR?** (iPhone Safari, desktop) Tap *Play in a virtual room*: the same game runs in a
  simulated room (drag to look, WASD / left-thumb to move, `C` to crouch).
* **Pose lab**: `lab.html` renders every animation as a contact sheet.

## How a round works

1. Tap the floor to place Hopper. Move around so it can map the room (the HUD shows mapped m²).
2. Tap **Play hide & seek** and cover your eyes. Hopper picks a spot that's hidden from where you are
   (and from much of the room), runs there — avoiding obstacles and **jumping** onto or into things —
   and settles into a hiding pose.
3. Look around. Hopper giggles now and then (spatial audio, so you can follow the sound), its
   antennae twitch and glow, and it peeks out sometimes. **Hint** makes it giggle on demand. On *hard*,
   it sneaks to a new spot once if you get close without seeing it.
4. You find it when enough of it is in view (not hidden behind real furniture) for a moment, or by
   tapping it.

## Architecture

```
src/
  world/      the room model, shared by every device and the simulator
    VoxelGrid      5 cm log-odds occupancy grid, DDA ray traversal, "unknown under a seen top is solid"
    WorldModel     fuses hit-tests, planes (+semantic labels), room meshes and depth into the grid
    NavGrid        2.5D navigation: multi-level surfaces, crawl spaces, lazily built parabolic jump links, A*
    Segmentation   "object detection": connected footprints → table / couch / chair / basket / shelf …
    StereoDepth    motion stereo (depth from a moving camera) — used to test phones without depth
    DriftMonitor   notices the tracking frame sliding against the map and realigns it
  pet/
    PetModel       sculpted (SDF → surface nets) furry creature: auto-skinned to 38 bones, shell fur,
                   textured eyes with cornea/lids/lashes, painted mouth; no external assets
    Animator       layered procedural animation: 16 actions, cross-fades, look-at, blinking,
                   spring-driven antennae/ears/tail, analytic 2-bone leg IK keeping feet planted
    PetController  path following: hop-walk cycle, turn → crouch → leap along a parabola → land
  game/
    HideSpots      candidate spots scored by concealment from the seeker now and from sampled
                   standing/crouching viewpoints, cosiness (under/inside/corner), novelty, distance
    Visibility     is Hopper on screen and not occluded by the mapped world?
    HideAndSeek    the game state machine (roam → countdown → seek → found)
    Health         the "immune system": detects impossible or contradictory states and recovers
                   (see "Staying unstuck" below)
  app/            browser shell: Stage (renderer, shadows, occluder), HUD, synthesized Voice,
                  ArMode (WebXR), SimMode (virtual room)
  sim/            test harness: procedural rooms, simulated sensors (depth/planes/mesh),
                  a seeker bot that plays the game, round runner
  emulate/        IWER WebXR emulator bridge: an emulated AR phone or Quest whose
                  hit-tests/planes/meshes/depth come from a simulated room
```

**Sensing per device.** ARCore phones: hit-test + planes + CPU depth (depth carves free space and
marks obstacles, so arbitrary objects such as baskets or boxes are mapped). Quest 3: planes with
semantic labels + the scene mesh. Plane-only devices fall back to heuristics (tables are hollow,
seats are solid). **Occlusion**: the occupancy grid is greedily meshed into a depth-only occluder so
real furniture hides the pet; devices with GPU depth also get three.js' depth occlusion.

**The creature** is built in code rather than loaded from a rigged asset. That gives full control over
the rig for procedural motion: jumps of any height or distance, peeking around arbitrary edges,
squeezing under furniture. Everything is skinned or bone-parented and animated procedurally.

## Staying unstuck

Real sensors drift, jump and lie. A wrong guess is bad; getting stuck in a broken state is worse. So
the map lives in its own *map frame* (kept glued to the room by WebXR anchors and by self-registration
against recent depth), and a health monitor watches for states that shouldn't happen:

| Symptom | Recovery |
|---|---|
| Tracking lost / orientation-only / NaN poses | the game freezes, the HUD explains; nothing is mapped meanwhile |
| The world frame jumped after a loss | realign the map if two looks agree on the correction; otherwise age the map, and if it moved a lot, clear it and bring Hopper back to you |
| Slow drift | small, well-supported corrections (never from a single view, a moving person or a blank wall) |
| The floor itself shows up as an obstacle (floor estimate too low) or Hopper floats (too high) | relevel the floor from floor planes + depth (keeping the rest of the map), undo if fresh evidence disagrees |
| Hopper inside an obstacle, floating, under the floor, NaN, off the map | hop to the nearest valid spot or come back to the player |
| Walking without getting anywhere, phases that never end | stop and replan; move the game along |
| Covered camera, garbage depth | frames rejected |
| Nothing to play on for 30 s | tell the player what to do (or tap ↻ rescan / move) |

`test/health.test.ts` breaks each of these on purpose; `scripts/soak-batch.sh` plays 12 × 5 minutes
with random faults every minute or so (relocalisation jumps, wrong floors, map wipes, covered camera,
NaN poses, the pet dropped inside furniture…) and reports stalls, time spent inside real furniture and
map precision.

## Testing without humans

```
npm test                 # unit + simulation tests (vitest, node)
npm run test:e2e         # browser tests (Playwright + headless Chromium)
npm run sheet            # just the pose contact sheet → artifacts/contact-sheet.png
```

* `test/world.test.ts`: in simulated rooms scanned like a phone (depth+planes) and like a Quest
  (mesh), no nav node is inside furniture, there are walkable surfaces under and on tables, the
  table top and the inside of a basket are reachable *by jumping*, and paths and jump arcs never
  pass through furniture. Object labelling is checked too.
* `test/pet.test.ts`: rig integrity and skin weights, every action stays finite and above the floor,
  IK keeps the feet planted, hiding poses are lower, cross-fades don't pop, and the controller lands
  jumps exactly.
* `test/game.test.ts`: **a bot plays full rounds** in 8 rooms (hand-built and random). It maps by
  looking around, starts the game, keeps its eyes covered, then searches by walking the room, crouching
  and following giggles. The test asserts that Hopper is truly hidden (ground-truth raycasts against
  the real room, not the map) when seeking starts, that it reaches its spot, that it never clips
  through furniture, that "found" only fires when Hopper is really visible, and that the bot finds it
  in most rounds.
* `e2e/sim-bot.spec.ts`: the same bot plays in the browser simulator, with a screenshot per phase.
* `e2e/ar-emulated.spec.ts`: the **real WebXR code path** runs against the IWER emulator
  (`?emulate=phone|quest`). It requests an AR session, places Hopper with an XR select, maps by
  turning the emulated device, plays a round and walks the seeker around until Hopper is found.
* `e2e/contact-sheet.spec.ts`: renders every animation at several times as a review sheet.

### Stress testing mapping & pathfinding (realistic sensing, real data)

See **[docs/stress-testing.md](docs/stress-testing.md)** for the full results. In short:

* `test/mapping-stress.test.ts` (CI): ground-truth collision / landing / false-free guards in cluttered
  rooms with blank walls, dark sofas, glass, mirrors, a person walking through, phone-like depth
  (persistent bias, holes, flying pixels) and tracking errors (drift, relocalisation jumps, loss).
* `test/runtime-safety.test.ts` (CI): a box dropped in Hopper's path mid-walk is detected and avoided.
* `scripts/map-report.ts`, `scripts/real-report.ts`: full metric tables across sensor profiles.
* `scripts/tum-replay.ts`: replays **real** RGB-D data (TUM fr1_room) and evaluates against held-out
  real frames: `python3 -I scripts/tum/prep_tum.py <tum_dir> data/tum/fr1_room && npx tsx scripts/tum-replay.ts data/tum/fr1_room --phone --pose-noise`.

**Record your own room on a phone:** open the app with `?record=1`, play/map as usual, tap ✕. The
browser downloads a `.hopperrec` file (depth frames + tracked poses), and
`npx tsx scripts/tum-replay.ts your-room.hopperrec --png map.png` reports the same metrics on it.

Handy URL parameters: `?sim=1&room=living|bedroom|empty|r<seed>&bot=1&speed=4&fixed=1&seed=N`,
`?emulate=phone|quest` (AR without a device), `?record=1` (record an AR session for offline replay).

## Development

```
npm install
npm run dev        # https is needed for WebXR on a phone: use `npx vite --host` + a tunnel, or deploy
npm run build
```

CI (`.github/workflows/ci.yml`) runs everything above and publishes `dist/` to the `gh-pages` branch.
Enable it once under **Settings → Pages → Deploy from a branch → `gh-pages` / root**.
