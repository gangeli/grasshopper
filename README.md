# Hopper — an AR pet that plays hide and seek

Hopper is a small fantasy creature (part baby dragon, part grasshopper) that moves into your room
through your phone, tablet or headset. It maps your furniture, then hides — under tables, behind the
couch, inside baskets, tucked in corners — and you have to find it.

* **Play on Android** (Chrome) or **Meta Quest** (Quest Browser): open the GitHub Pages link and tap
  *Start in AR*.
* **No WebXR AR?** (iPhone Safari, desktop) Tap *Play in a virtual room*: the same game runs in a
  simulated room (drag to look, WASD / left-thumb to move, `C` to crouch).
* **Pose lab**: `lab.html` renders every animation as a contact sheet.
* **Rather have a dog?** The **model selector** picks who plays and in which coat: Hopper (mint, plum
  or ember) or a lean Hungarian **Vizsla** (golden rust, russet or sandy gold) — same game, same room,
  a dog's body and a dog's manners. It is on the start page and, while you play, behind the **🐾**
  button: the pet changes where it stands, mid-game. The choice is remembered.

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
    Animator       layered procedural animation: 17 actions, cross-fades, look-at, blinking,
                   spring-driven antennae/ears/tail, analytic 2-bone leg IK keeping feet planted
    PetController  path following: hop-walk cycle, turn → crouch → leap along a parabola → land
    species        which pet plays and in which coat: the model selector's choice, remembered
                   (or pinned by a link: ?pet=, ?coat=)
    parts, pose    what the pets share: the eye rig, nose leather, textures; the pose channels
    vizsla/        the other pet, built the same way (see "The Vizsla" below)
      sculpt         the dog as blended shapes, plus a separate lower jaw
      mesh           meshing, skinning, the coat's colour and groom; the ear leathers
      VizslaModel    the rig: eyes, nose, teeth and tongue, nails, collar with a glowing tag
      DogMotion      the same 17 actions as a dog does them; four-leg IK, gaits
  game/
    HideSpots      candidate spots scored by concealment from the seeker now and from sampled
                   standing/crouching viewpoints, cosiness (under/inside/corner), novelty, distance
    Visibility     is Hopper on screen and not occluded by the mapped world?
    HideAndSeek    the game state machine (roam → countdown → seek → found)
    Health         the "immune system": detects impossible or contradictory states and recovers
                   (see "Staying unstuck" below)
  app/            browser shell: Stage (renderer, shadows, occluder), HUD, synthesized Voice,
                  ArMode (WebXR), SimMode (virtual room), PetPicker (the model selector)
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

### The Vizsla

The second pet is a Hungarian Vizsla, made with the same kit as Hopper and to the same standard: a
signed-distance sculpt meshed and skinned in code, a shell coat, Hopper's eye rig at a dog's size.
What a dog needs that Hopper doesn't:

* **A quadruped rig.** Shoulder–elbow–wrist–toes in front, hip–stifle–hock–toes behind, each solved
  by two-bone IK to a paw target, so paws stay where they land (a planted paw creeps a few
  millimetres a second at most at a trot: `scripts/dog-motion-probe.ts`). The bone names are Hopper's, so the game samples either pet
  the same way.
* **Gaits.** It trots in diagonal pairs — overlapping at a walk, flying between them when it hurries —
  and opens into a bounding gallop at a run, the back flexing with each stride.
* **A mouth that opens.** The lower jaw is its own sculpt on a jaw bone, closing flush into a hollow
  under the muzzle; inside are teeth and a tongue, which stays in while it pants quietly and lolls out
  when it is excited or has been running.
* **Ears and tail.** Thin two-jointed ear leathers that swing as it moves, prick and fold back; a
  docked tail that wags from the root.
* **A short, sleek coat** (the fur shader's `sleek` option): close-lying, glossy, solid golden rust
  with the breed's lighter shadings — and no black anywhere: nose, eye rims, pads and nails are
  flesh-brown. Three coats, all within the breed's range: `golden` rust, `russet`, `sandy` gold
  (choose one in the model selector, or `lab.html?pet=vizsla&palette=russet`).
* **Dog manners** for the same 17 actions: it lies down like a sphinx to hide (flat, chin on the floor,
  under furniture), gives a paw to wave, startles back, quarters with its nose down and then freezes
  **on point** — foreleg up, tail out straight — celebrates with a bounce, a spin and a play bow, cocks
  its head at you while it waits, and when petted leans in with its whole back end wagging.
* **Room for a long body.** Nose to tail it is twice Hopper's length, so it senses the map around it:
  with furniture right ahead it lifts its head and draws back instead of poking through, and under a
  low table it drops to a belly-crawl.
* **A collar** whose tag glows for hints, where Hopper's antennae do.

Hopper is untouched by all this (its renders are pixel-identical): the layering, blinking, gaze and
eyes are shared, and each species brings its own actions and body.

### The model selector

One control (`app/PetPicker`) chooses the pet and its coat: a row of pets and, under it, that pet's
coats as swatches. It sits on the start page, where the showcase pet changes as you choose, and in
the HUD behind the 🐾 button, in the simulator and in AR alike.

* **Mid-game swaps happen in place.** `rebuildPet` builds the new body under the rig's own root group
  and frees what the old one held on the GPU, so the game, the controller and the scene keep the pet
  they had: same spot, same state. The animator rebinds to the new bones and carries on in the action
  it was playing, so a pet swapped while hiding stays hidden, in the new pet's hiding pose.
* **Remembered per pet** (`pet/species`): the pet, and each pet's own coat, so going back to Hopper
  brings back the coat you gave it. A link can pin both for one visit without changing that:
  `?pet=vizsla&coat=russet`.
* Building a body takes a moment (about a second for a coat not seen yet; bodies are cached per coat
  after that), so the choice shows at once and the control dims until the pet is there.

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
* `test/pet.test.ts`: for **both pets**: rig integrity and skin weights, every action stays finite and
  above the floor, IK keeps the feet planted, hiding poses are lower, cross-fades don't pop, and the
  controller lands jumps exactly. For the Vizsla also: planted paws don't skate and legs don't lock
  straight at a trot, it pants and points and sits, and it makes room for itself near furniture.
* `test/game.test.ts`: **a bot plays full rounds** in 8 rooms (hand-built and random). It maps by
  looking around, starts the game, keeps its eyes covered, then searches by walking the room, crouching
  and following giggles. The test asserts that Hopper is truly hidden (ground-truth raycasts against
  the real room, not the map) when seeking starts, that it reaches its spot, that it never clips
  through furniture, that "found" only fires when Hopper is really visible, and that the bot finds it
  in most rounds. Three more rounds are played with the Vizsla.
* `e2e/sim-bot.spec.ts`: the same bot plays in the browser simulator, with a screenshot per phase.
* `e2e/ar-emulated.spec.ts`: the **real WebXR code path** runs against the IWER emulator
  (`?emulate=phone|quest`). It requests an AR session, places Hopper with an XR select, maps by
  turning the emulated device, plays a round and walks the seeker around until Hopper is found.
* `e2e/contact-sheet.spec.ts`: renders every animation at several times as a review sheet.
* `e2e/vizsla.spec.ts`: the Vizsla's sheet, the start-page picker (swaps the pet, remembers it), and
  a full bot-played round with the Vizsla in the browser.
* `test/selector.test.ts`: the model selector's rules: every coat on offer is a real palette of that
  pet, choices are remembered per pet and a link can pin them; a rig rebuilt in place keeps its root,
  frees the old body and leaves nothing of the other pet behind; the animator carries every action
  over to the other body; and **a bot-played round survives two swaps** (a Vizsla takes over on the
  walk, Hopper comes back while it hides) and is still found, with no recoveries needed.
* `e2e/pet-picker.spec.ts`: the selector in the browser: on the start page (pets, coats, keyboard,
  remembered across visits), into the game, from the HUD mid-game (GPU resources don't pile up over
  repeated swaps; a round the bot plays through two swaps is still found), and inside an emulated AR
  session.

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
`?emulate=phone|quest` (AR without a device), `?record=1` (record an AR session for offline replay),
`?pet=vizsla|hopper` and `?coat=mint|plum|ember|golden|russet|sandy` (which pet, in which coat, for
this visit; `?pet=` also works on `lab.html`, where the coat is `&palette=`).

## Development

```
npm install
npm run dev        # https is needed for WebXR on a phone: use `npx vite --host` + a tunnel, or deploy
npm run build
```

CI (`.github/workflows/ci.yml`) runs everything above and publishes `dist/` to the `gh-pages` branch.
Enable it once under **Settings → Pages → Deploy from a branch → `gh-pages` / root**.
