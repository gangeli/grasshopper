import type { Vec3 } from '../core/math';
import { OCC_THRESHOLD, STRONG_OCC, VoxelGrid } from './VoxelGrid';
import { DepthConsistency, depthImageToPoints, filterDiscontinuities, PoseGate, type DepthImage } from './DepthFrame';
import type { ImportOptions, SerializedMap } from './MapFormat';
import { CHUNK, exportGrid, importIntoGrid, type Lattice } from './mapIO';
import { ChunkStore, keyCx, keyCz, mergeChunkInto, shiftCopy, shiftInPlace, type StoredChunk } from './ChunkStore';
import type { Correction } from './warp';
import { angDiff, frameHeading, PlaceMemory, type PlaceMatch } from './PlaceMemory';
import type { SerializedChunk } from './MapFormat';

/**
 * Everything the pet knows about the physical room. It fuses the sensor
 * streams a WebXR device can offer (planes, meshes, depth, hit tests) into one
 * occupancy grid, which navigation, hiding-spot search and occlusion read.
 * The simulator feeds exactly the same inputs.
 */

export interface PlaneInput {
  id: string;
  /** Polygon vertices in world space, on the plane. */
  polygon: Vec3[];
  /** Unit normal pointing away from the solid side (up for floors and table tops). */
  normal: Vec3;
  label?: string;
}

export interface MeshInput {
  id: string;
  /** Flat xyz world-space vertex positions. */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  label?: string;
}

export interface LabeledRegion {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
}

export interface WorldModelOptions {
  res?: number;
  /** Horizontal half-extent of the dense window around the player (meters); rounded to whole chunks. */
  halfExtent?: number;
  height?: number;
}

export const FLOOR_LAYERS_BELOW = 2;
/** Weakly-free: inferred, not observed. Depth-based navigation doesn't trust it. */
export const ASSUMED_FREE = -1;
/** Guessed solid (see SOFT_SOLID): a few free-space rays clear it. */
export const ASSUMED_SOLID = 15;
const HOLLOW_LABELS = new Set(['table', 'desk', 'bed', 'shelf']);

export interface MisalignmentOptions {
  frames?: number;
  maxShift?: number;
  maxYaw?: number;
  /**
   * What to match the recent frames against: a recent snapshot of the map,
   * the oldest one kept, the one taken at the last tracking loss, or 'aged':
   * the live map's structure that hasn't been re-observed for `minAge`
   * seconds (what was mapped before the camera came back: loop closure).
   */
  snapshot?: 'newest' | 'oldest' | 'event' | 'aged';
  /** For 'aged': structure last hit at least this long before the frames (s). */
  minAge?: number;
}
export interface Misalignment {
  dx: number;
  dz: number;
  dyaw: number;
  pivot: Vec3;
  base: number;
  best: number;
  n: number;
  degenerate: boolean;
  snapT: number;
  /** 'aged' searches: median time the matched old structure was last observed (s), else NaN. */
  oldT: number;
}

export class WorldModel {
  grid: VoxelGrid | null = null;
  floorY = 0;
  readonly res: number;
  readonly halfExtent: number;
  readonly height: number;
  readonly labels = new Map<string, LabeledRegion>();
  private planeVersions = new Map<string, string>();
  /** Inputs kept so the grid can be rebuilt if the floor estimate is corrected. */
  private planeInputs = new Map<string, PlaneInput>();
  private meshInputs = new Map<string, MeshInput>();
  private center: Vec3 = { x: 0, y: 0, z: 0 };
  /** Increments whenever the grid is replaced (consumers must rebuild derived data). */
  epoch = 0;
  /** Floor-height evidence from depth: 1cm histogram around the current estimate. */
  private floorHist = new Float32Array(31);
  private floorSamples = 0;
  floorRefinements = 0;
  private floorPlanes = new Map<string, { y: number; area: number }>();
  private pendingFloorOffset: number | null = null;
  private histRefined = false;
  /** Allow the early ±3cm depth-histogram floor refinement (see refineFloor). */
  histogramRefine = false;
  /** Set false once play starts: rebuilding the map mid-round would be disruptive. */
  allowFloorRefine = true;
  /** Number of depth points integrated so far (diagnostics/HUD). */
  depthPoints = 0;

  constructor(opts: WorldModelOptions = {}) {
    this.res = opts.res ?? 0.05;
    this.halfExtent = opts.halfExtent ?? 6;
    this.height = opts.height ?? 2.6;
    this.windowChunks = Math.max(3, Math.round((this.halfExtent * 2) / (this.res * CHUNK)));
  }

  // --- The dense window and the archive --------------------------------------------
  // `grid` is a dense window of windowChunks × windowChunks chunks on a lattice
  // fixed at the first floor placement. It follows the camera: when the
  // camera nears its edge, the window moves by whole chunks; chunks leaving
  // it go to the archive and chunks entering it come back from there. So the
  // map has no size limit while everything that runs on the map (navigation,
  // shadow inference, occluders, hiding spots, drift checks) keeps working
  // on one dense grid around the player.
  /** Window size in chunks per side. */
  readonly windowChunks: number;
  /** Move the window with the camera (false: one fixed grid around the start). */
  followCamera = true;
  /** Map outside the window. */
  archive = new ChunkStore();
  /** Lattice origin (map frame x/z of lattice cell 0) and the window's offset on it (cells). */
  private latX = 0;
  private latZ = 0;
  private wi = 0;
  private wk = 0;
  private latticeSet = false;
  /** Number of times the window moved. */
  recenters = 0;
  /** See VoxelGrid.staleAfter (s; 0 = off). */
  forgetStaleAfter = 0;

  get ready(): boolean {
    return this.grid !== null;
  }

  /** First layer of free space above the floor. */
  get floorLayer(): number {
    return FLOOR_LAYERS_BELOW;
  }

  /** Establish the floor height and an anchor point; allocates the grid. */
  setFloor(y: number, center: Vec3): void {
    if (this.grid) return;
    if (!this.frameIsIdentity) {
      const c = this.toMapPoint({ x: center.x, y, z: center.z });
      center = c;
      y = c.y;
    }
    this.allocateGrid(y, center);
  }

  /** Allocate the grid with the floor at y (map frame). */
  private allocateGrid(y: number, center: Vec3): void {
    this.center = { ...center };
    const r = this.res;
    const n = this.windowChunks * CHUNK;
    const ny = Math.ceil(this.height / r) + FLOOR_LAYERS_BELOW;
    this.floorY = y;
    if (!this.latticeSet) {
      this.latX = center.x - (n / 2) * r;
      this.latZ = center.z - (n / 2) * r;
      this.wi = this.wk = 0;
      this.latticeSet = true;
    }
    // Snap the origin so the floor is exactly at a cell boundary.
    this.grid = new VoxelGrid({
      origin: { x: this.latX + this.wi * r, y: y - FLOOR_LAYERS_BELOW * r, z: this.latZ + this.wk * r },
      res: r,
      nx: n,
      ny,
      nz: n,
    });
    this.grid.hitTime = new Uint32Array(this.grid.data.length);
    this.grid.stamp = this.timeCode(this.now);
    // The below-floor layers are solid everywhere; whether you may *walk* there
    // is governed by the observed mask.
    const g = this.grid;
    for (let j = 0; j < FLOOR_LAYERS_BELOW; j++)
      for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) g.data[g.idx(i, j, k)] = 127;
    g.touchAll();
  }

  isFloorHeight(y: number, tol = 0.06): boolean {
    return Math.abs(y - this.floorY) < tol;
  }

  /** A hit-test result on a surface, e.g. where the user tapped. */
  ingestHit(p: Vec3, normal?: Vec3): void {
    if (!this.grid) return;
    if (!this.frameIsIdentity) {
      p = this.toMapPoint(p);
      if (normal) normal = this.toMapDir(normal);
    }
    if ((!normal || normal.y > 0.8) && this.isFloorHeight(p.y)) this.grid.markObserved(p.x, p.z, 4);
  }

  ingestPlane(plane: PlaneInput): void {
    if (!this.frameIsIdentity) plane = { ...plane, polygon: plane.polygon.map((q) => this.toMapPoint(q)), normal: this.toMapDir(plane.normal) };
    this.ingestPlaneMap(plane);
  }

  private ingestPlaneMap(plane: PlaneInput): void {
    this.planeInputs.set(plane.id, plane);
    const g = this.grid;
    if (!g || plane.polygon.length < 3) return;
    // Skip re-rasterizing an unchanged plane.
    const sig = plane.polygon.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(';');
    if (this.planeVersions.get(plane.id) === sig) return;
    this.planeVersions.set(plane.id, sig);

    const n = normalize(plane.normal);
    const horizontal = Math.abs(n.y) > 0.85;
    const c = centroid(plane.polygon);
    if (horizontal && n.y > 0 && this.isFloorHeight(c.y, 0.1)) {
      // Floor planes are fitted over many points: the best floor-height evidence.
      let area = 0;
      rasterizePolygon(plane.polygon, n, 0.1, () => (area += 0.01));
      this.floorPlanes.set(plane.id, { y: c.y, area });
      // Floor: rasterize into the observed mask.
      rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => g.markObserved(p.x, p.z));
      return;
    }
    if (horizontal && n.y < 0) return; // ceilings: irrelevant for a small pet
    // Raised horizontal planes: tables/desks/beds are slabs you can get under;
    // low unlabeled surfaces (seats, ottomans) are assumed solid to the floor
    // since plane detection alone can't tell us what's beneath them.
    const heightAboveFloor = c.y - this.floorY;
    const label = plane.label?.toLowerCase();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const q of plane.polygon) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z);
      maxZ = Math.max(maxZ, q.z);
    }
    // Narrow strips (couch backs, arm rests, shelves' tops) are almost never hollow.
    const narrow = Math.min(maxX - minX, maxZ - minZ) < 0.3;
    const hollow = label ? HOLLOW_LABELS.has(label) : heightAboveFloor >= 0.6 && !narrow;
    const thickness = horizontal ? 0.04 : 0.08;
    const min = { x: 0, y: 0, z: 0 }, max = { x: 0, y: 0, z: 0 };
    rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => {
      // Extrude into the solid side of the plane.
      const q = { x: p.x - n.x * thickness, y: p.y - n.y * thickness, z: p.z - n.z * thickness };
      min.x = Math.min(p.x, q.x) - 1e-3;
      min.y = Math.min(p.y, q.y) - 1e-3;
      min.z = Math.min(p.z, q.z) - 1e-3;
      max.x = Math.max(p.x, q.x) + 1e-3;
      max.y = Math.max(p.y, q.y) + 1e-3;
      max.z = Math.max(p.z, q.z) + 1e-3;
      g.fillBox(min, max, 100);
      if (horizontal && n.y > 0) g.noteHeight(g.cellX(p.x), g.cellY(p.y - 1e-4), g.cellZ(p.z), p.y);
    });
    if (horizontal) {
      // Below a raised plane: tables are open underneath, seats/ottomans are
      // probably solid. Either way it's only a guess: write it weakly into
      // unknown cells so real depth observations override it.
      rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => {
        const i = g.cellX(p.x), k = g.cellZ(p.z);
        const jTop = g.cellY(p.y - thickness) - 1;
        for (let j = this.floorLayer; j <= jTop; j++) if (g.get(i, j, k) === 0) g.set(i, j, k, hollow ? ASSUMED_FREE : ASSUMED_SOLID);
      });
    }
    if (plane.label) this.addLabel(plane.id, plane.label, plane.polygon, horizontal ? -0.05 : 0);
  }

  /**
   * The device stopped reporting these planes/meshes (merged, replaced or
   * dropped): forget them, so map rebuilds don't re-apply stale surfaces and
   * long sessions don't keep every surface ever seen. What they already
   * contributed to the voxel map stays until newer evidence replaces it.
   */
  forgetSurfaces(live: { planes?: Set<string>; meshes?: Set<string> }): void {
    if (live.planes)
      for (const id of [...this.planeInputs.keys()])
        if (!live.planes.has(id)) {
          this.planeInputs.delete(id);
          this.planeVersions.delete(id);
          this.floorPlanes.delete(id);
          this.labels.delete(id);
        }
    if (live.meshes)
      for (const id of [...this.meshInputs.keys()])
        if (!live.meshes.has(id)) {
          this.meshInputs.delete(id);
          this.labels.delete(id);
        }
  }

  ingestMesh(mesh: MeshInput): void {
    if (!this.frameIsIdentity) {
      const P = Array.from(mesh.positions);
      for (let q = 0; q < P.length; q += 3) {
        const m = this.toMapPoint({ x: P[q], y: P[q + 1], z: P[q + 2] });
        P[q] = m.x;
        P[q + 1] = m.y;
        P[q + 2] = m.z;
      }
      mesh = { ...mesh, positions: P };
    }
    this.ingestMeshMap(mesh);
  }

  private ingestMeshMap(mesh: MeshInput): void {
    this.meshInputs.set(mesh.id, mesh);
    const g = this.grid;
    if (!g) return;
    const P = mesh.positions, I = mesh.indices;
    const step = g.res * 0.5;
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
    const pts: Vec3[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
      load(P, I[t], a);
      load(P, I[t + 1], b);
      load(P, I[t + 2], c);
      const e1 = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const e2 = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
      const nu = Math.max(1, Math.ceil(e1 / step)), nv = Math.max(1, Math.ceil(e2 / step));
      // Triangle normal from CCW winding (outward-facing, as XR meshes are).
      const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
      const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const down = ny < -0.7 * Math.hypot(nx, ny, nz);
      const up = ny > 0.7 * Math.hypot(nx, ny, nz);
      for (let u = 0; u <= nu; u++)
        for (let v = 0; v <= nv - (u * nv) / nu; v++) {
          const fu = u / nu, fv = v / nv;
          const x = a.x + (b.x - a.x) * fu + (c.x - a.x) * fv;
          const y = a.y + (b.y - a.y) * fu + (c.y - a.y) * fv;
          const z = a.z + (b.z - a.z) * fu + (c.z - a.z) * fv;
          if (y < this.floorY + 0.03) {
            g.markObserved(x, z);
          } else {
            const i = g.cellX(x), j = g.cellY(y), k = g.cellZ(z);
            if (g.get(i, j, k) < 100) g.set(i, j, k, 100);
            if (up) g.noteHeight(i, j, k, y);
            if (g.inBounds(i, j, k)) {
              g.underside[g.idx(i, j, k)] |= down ? 1 : up ? 2 : 0;
              g.touchColumn(i, k);
            }
          }
          if (mesh.label) pts.push({ x, y, z });
        }
    }
    if (mesh.label && pts.length) this.addLabel(mesh.id, mesh.label, pts, 0);
  }

  /**
   * Depth noise model: sigma(z) = sigmaA + sigmaB·z². Defaults are typical of
   * ARCore depth (≈1.8cm at 1m, ≈11cm at 3m). Readings are weighted by it:
   * noisy far readings only carve free space (cautiously) and never create
   * obstacles on their own.
   */
  depthSigmaA = 0.006;
  depthSigmaB = 0.012;
  /** Readings noisier than this only carve free space. */
  maxHitSigma = 0.06;

  readonly poseGate = new PoseGate();
  private frameCount = 0;
  /** Treat precise readings 2.5–6cm above the floor as weak obstacle evidence. */
  lowBandEvidence = true;
  /** Free-space carving stops this many sigmas short of each reading. */
  carveSigmas = 3.5;
  /** Dynamic-obstacle (change) detection, see VoxelGrid.noteSurprise. */
  detectChanges = true;
  /** Weight free-space evidence by measurement precision (see ingestDepth). */
  weightedCarving = true;
  /** Gate depth frames on tracking quality. */
  gateFrames = true;
  /** Drop depth-discontinuity pixels. */
  filterEdges = true;
  /**
   * Multi-view consistency gate for densified depth without confidence (what
   * WebXR depth-sensing delivers on phones without a depth sensor). Null = off.
   */
  multiView: DepthConsistency | null = null;
  /** Max height above the floor at which a noisy reading still counts as floor. */
  floorTolCap = 0.06;

  // --- Health telemetry (see game/Health.ts) ---------------------------------------
  /**
   * Rolling histogram (1cm bins, −25..+25cm around floorY) of close, steeply
   * downward readings: where the floor *really* is, decaying over ~10s.
   */
  private floorWatch = new Float32Array(51);
  private floorWatchT = -Infinity;
  /**
   * Share of precise readings over the last few seconds that contradict the
   * map: the reading lies *behind* surfaces the map is confident about (its
   * ray passes through strongly occupied voxels). A few % is normal (noise,
   * things moved); a sustained high rate means the map and reality no longer
   * line up.
   */
  conflictRate = 0;
  private conflictWin: { t: number; rays: number; bad: number; carve: number }[] = [];
  /**
   * Share of precise readings landing in space the map is confident is empty
   * (same window). Noisy — grazing views, people walking — so diagnostic only.
   */
  surpriseRate = 0;
  /** Window (s) for conflictRate. */
  conflictWindow = 3;
  /** Depth frames rejected as garbage (covered camera, NaN poses). */
  garbageFrames = 0;
  /** Recent depth frames, re-integrated after a floor correction so the map survives it. */
  private replay: { eye: Vec3; pts: Float32Array; sig: Float32Array | null; t: number }[] = [];
  private replayPoints = 0;
  /** Max points kept for replay (≈ the last minute of phone depth). */
  replayBudget = 600_000;
  /** Periodic copies of the grid, so a late-detected misalignment can be undone (see realign). */
  private snapshots: { t: number; data: Int8Array; observed: Uint8Array; underside: Uint8Array; topFrac: Uint8Array; floorY: number; epoch: number }[] = [];
  snapshotEvery = 4;
  private replaying = false;
  /** Times the map was rebuilt or aged by a recovery (diagnostics). */
  recoveries = { relevel: 0, soft: 0, hard: 0, realign: 0 };

  // --- Map frame vs tracking frame --------------------------------------------------
  // Everything in the model (voxels, nav, the pet) lives in the *map frame*. The
  // device reports poses in its *tracking frame*, which can drift or jump when
  // tracking relocalises. trackingToMap = registration · anchor maps incoming
  // data into the map frame; content is rendered with its inverse.
  private anchorC: number[] = identity4();
  private regC: number[] = identity4();
  private t2m: number[] = identity4();
  private m2t: number[] = identity4();
  /** Increments whenever the frame correction changes. */
  frameVersion = 0;
  /** Time of the last tracking loss/recovery reported by the device (relocalisation jumps happen then). */
  lastTrackingEvent = -Infinity;
  /** Time of the most recent depth frame (device clock). */
  now = 0;
  /** The map as it was when tracking was last lost (before any jump could leak in). */
  eventSnapshot: { t: number; data: Int8Array; epoch: number } | null = null;
  noteTrackingEvent(t: number): void {
    // Loss and recovery both report; snapshot at the first of a burst.
    if (this.grid && !(t - this.lastTrackingEvent < 20 && this.eventSnapshot)) this.eventSnapshot = { t, data: this.grid.data.slice(), epoch: this.epoch };
    this.lastTrackingEvent = t;
  }

  /** Correction from a world anchor (tracking → map), e.g. WebXR anchors that the platform keeps glued to the real world. */
  setAnchorCorrection(m: ArrayLike<number> | null): void {
    const next = m ? Array.from(m) : identity4();
    if (!next.every(Number.isFinite)) return;
    this.anchorC = next;
    this.updateFrame();
  }

  /** Apply an extra map-frame correction on top of the current one (from self-registration). */
  applyRegistration(delta: ArrayLike<number>): void {
    if (!Array.from(delta).every(Number.isFinite)) return;
    this.regC = mul4(delta, this.regC);
    this.recoveries.realign++;
    this.updateFrame();
  }

  private updateFrame(): void {
    this.t2m = mul4(this.regC, this.anchorC);
    this.m2t = invertRigid4(this.t2m);
    this.frameVersion++;
    // History kept in the old frame no longer lines up.
    this.poseGate.reset();
    this.multiView?.reset();
    this.conflictWin = [];
    this.conflictRate = 0;
  }

  trackingToMap(): number[] {
    return this.t2m.slice();
  }
  mapToTracking(): number[] {
    return this.m2t.slice();
  }
  toMapPoint(p: Vec3): Vec3 {
    return xform(this.t2m, p, 1);
  }
  toMapDir(d: Vec3): Vec3 {
    return xform(this.t2m, d, 0);
  }
  toTrackingPoint(p: Vec3): Vec3 {
    return xform(this.m2t, p, 1);
  }
  private get frameIsIdentity(): boolean {
    return this.frameVersion === 0;
  }

  /**
   * Full depth front end, shared by the device and the simulator: gate frames
   * taken under bad tracking, drop discontinuity ("flying") pixels, lift to
   * world points and integrate. `t` is in seconds. Returns false if the frame
   * was rejected.
   */
  ingestDepthImage(img: DepthImage, t: number, emulatedPose = false): boolean {
    if (!this.frameIsIdentity) img = { ...img, camToWorld: mul4(this.t2m, img.camToWorld) };
    this.now = t;
    const M = img.camToWorld;
    const eye = { x: M[12], y: M[13], z: M[14] };
    const fwd = { x: -M[8], y: -M[9], z: -M[10] };
    // Garbage in: a broken pose, or a covered / face-down camera (almost
    // everything within a hand's breadth). Integrating it would paint
    // obstacles in mid-air or carve nonsense.
    for (let q = 0; q < 16; q++)
      if (!Number.isFinite(M[q])) {
        this.garbageFrames++;
        return false;
      }
    let valid = 0, near = 0;
    for (let q = 0; q < img.depth.length; q++) {
      const d = img.depth[q];
      if (d > 0.05 && Number.isFinite(d)) {
        valid++;
        if (d < 0.3) near++;
      }
    }
    if (valid > 20 && near > 0.5 * valid) {
      this.garbageFrames++;
      return false;
    }
    if (this.grid && !this.replaying && this.followCamera) this.follow(eye, t);
    if (!this.replaying) this.noteWalk(eye, t);
    if (this.grid && !this.replaying && (!this.snapshots.length || t - this.snapshots[this.snapshots.length - 1].t >= this.snapshotEvery || t < this.snapshots[this.snapshots.length - 1].t)) {
      this.takeSnapshot(t);
    }
    // Let old floor evidence fade (half-life ~7s).
    if (Number.isFinite(this.floorWatchT) && t > this.floorWatchT) {
      const k = Math.exp(-(t - this.floorWatchT) / 10);
      for (let b = 0; b < this.floorWatch.length; b++) this.floorWatch[b] *= k;
    }
    this.floorWatchT = t;
    if (this.grid) {
      this.grid.now = t;
      this.grid.stamp = this.timeCode(t);
      this.grid.staleAfter = this.forgetStaleAfter;
      this.grid.shieldedCarving = this.shieldedCarving;
      if (++this.frameCount % 30 === 0) this.grid.pruneTransient();
      // Frames waiting to be re-integrated (sliced replays, a re-attach): a few per frame.
      this.stepReplayQueue(3);
      // A warp in progress: a few window layers / archive chunks per frame.
      this.stepWarp(2);
    }
    if (!this.poseGate.accept(eye, fwd, t, emulatedPose) && this.gateFrames) return false;
    const sig: number[] | undefined = img.sigma ? [] : undefined;
    let depth = this.filterEdges ? filterDiscontinuities(img) : img.depth;
    if (this.multiView) depth = this.multiView.filter(img, depth, t);
    const pts = depthImageToPoints(img, depth, sig);
    if (this.holdOnConflict && this.grid && !this.replaying) {
      // A view that contradicts the map wholesale (many readings lie behind
      // surfaces the map is sure of) is a frame that slid against the map
      // (drift, a loop, a tracking jump) more often than a changed room.
      // Writing it in would double walls and carve through furniture: hold
      // it back (it stays in the replay buffer) until the drift monitor
      // finds the correction, or for a few seconds at most.
      const c = t >= this.holdCooldownUntil || this.heldSince !== null ? this.probeConflict(eye, pts, sig) : { n: 0, rate: 0 };
      const contradicts = c.n >= 40 && c.rate >= this.holdConflictRate;
      // Once holding, keep holding until a view clearly agrees with the map
      // again (or the drift monitor resolves it, or time runs out).
      const agrees = c.n >= 40 && c.rate < this.holdConflictRate / 3;
      if (contradicts && this.heldSince === null) this.heldSince = t;
      if (this.heldSince !== null && !agrees && t - this.heldSince < this.holdMaxSeconds) {
        this.remember(eye, pts, sig, t);
        this.heldFrames++;
        return true;
      }
      if (this.heldSince !== null) this.releaseHeld();
    }
    this.ingestDepth(eye, pts, 4.5, sig, t);
    this.settlePlaces();
    return true;
  }

  // --- Re-anchoring after a frame jump that couldn't be resolved ------------------------
  /**
   * The map from before a tracking jump the drift monitor couldn't resolve:
   * the archive (window included) and place memory, in the old map frame.
   * Mapping goes on in a fresh map; when the camera sees a place the old map
   * knows, the drift monitor relocalises against its place memory and the
   * old map comes back (reattach), corrected into one frame with the new.
   */
  dormant: { archive: ChunkStore; places: PlaceMemory; t: number } | null = null;
  /** Detaches and successful re-attachments (diagnostics). */
  detaches = 0;
  reattaches = 0;
  /** Frames to re-integrate a few per frame (after a reattach). */
  private replayQueue: { eye: Vec3; pts: Float32Array; sig: Float32Array | null; t: number }[] = [];
  private stepReplayQueue(n: number): void {
    if (!this.replayQueue.length || !this.grid) return;
    const batch = this.replayQueue.splice(0, n);
    this.replaying = true;
    try {
      for (const f of batch) {
        const pts: Vec3[] = [];
        for (let q = 0; q < f.pts.length; q += 3) pts.push({ x: f.pts[q], y: f.pts[q + 1], z: f.pts[q + 2] });
        this.ingestDepth(f.eye, pts, 4.5, f.sig ? Array.from(f.sig) : undefined, f.t);
      }
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Recovery that keeps the map: the view no longer fits the map and no
   * correction was found. Instead of clearing it, put the whole map (window
   * and archive) and its place memory aside as `dormant` and start a fresh
   * one in the current frame. (If a dormant map is already waiting, it is
   * kept and only the fresh one is cleared.)
   */
  detachMap(): void {
    const g = this.grid;
    if (!g) return;
    this.finishWarp();
    this.detaches++;
    if (!this.dormant) {
      this.loadPending();
      // What the camera saw before things went wrong goes into the place
      // memory now (not only frames settled for 10s): relocalisation needs it.
      const ev = this.now - this.lastTrackingEvent < 30 ? this.lastTrackingEvent : Infinity;
      if (this.placeMemory) {
        const gr = g;
        this.placeMemory.settle(this.replay, this.now, this.floorY, (x, y, z) => {
          const i = gr.cellX(x), j = gr.cellY(y), k = gr.cellZ(z);
          return gr.inBounds(i, j, k) ? gr.data[gr.idx(i, j, k)] >= 0 : null;
        }, Math.min(ev, this.heldSince ?? Infinity), 0);
      }
      const C = CHUNK, W = this.windowChunks;
      // The window joins the archive (from this grid, which is replaced below and never written again).
      for (let a = 0; a < W; a++) for (let b = 0; b < W; b++) this.archive.defer(g, this.wi, this.wk, this.wi / C + a, this.wk / C + b, this.floorLayer, this.now);
      this.placeMemory?.close();
      this.dormant = { archive: this.archive, places: this.placeMemory ?? new PlaceMemory(), t: this.now };
      this.archive = new ChunkStore();
      if (this.placeMemory) this.placeMemory = new PlaceMemory();
    } else {
      this.archive.clear();
      this.placeMemory?.clear();
    }
    this.recoveries.hard++;
    this.pendingLoads = [];
    this.replayQueue = [];
    this.snapshots = [];
    this.eventSnapshot = null;
    this.replay = [];
    this.replayPoints = 0;
    this.rebuildAtFloor(this.floorY);
    this.floorRefinements--; // not a refinement
    this.floorWatch.fill(0);
    this.conflictRate = 0;
    this.conflictWin = [];
    this.multiView?.reset();
  }

  /**
   * The current frame relocalised against the dormant map: `c` maps current
   * map coordinates onto the dormant map's. The dormant map becomes the map
   * again (its frame is the map frame from now on), what the fresh map
   * learnt since the detach is re-integrated, corrected, from the replay
   * buffer (a few frames per frame), and the fresh place memory joins the old.
   */
  reattach(c: { dx: number; dz: number; dyaw: number; pivot: Vec3 }): void {
    const d = this.dormant;
    if (!d || !this.grid) return;
    this.finishWarp();
    this.dormant = null;
    this.reattaches++;
    const cs = Math.cos(c.dyaw), sn = Math.sin(c.dyaw);
    const fix = (x: number, z: number): [number, number] => {
      const rx = x - c.pivot.x, rz = z - c.pivot.z;
      return [c.pivot.x + cs * rx + sn * rz + c.dx, c.pivot.z - sn * rx + cs * rz + c.dz];
    };
    // Buffered frames since the detach, corrected.
    const frames = this.replay.filter((f) => f.t >= d.t);
    for (const f of frames) {
      [f.eye.x, f.eye.z] = fix(f.eye.x, f.eye.z);
      for (let q = 0; q < f.pts.length; q += 3) [f.pts[q], f.pts[q + 2]] = fix(f.pts[q], f.pts[q + 2]);
    }
    if (this.placeMemory) {
      d.places.absorb(this.placeMemory, { dx: c.dx, dz: c.dz, dyaw: c.dyaw, pivot: c.pivot });
      this.placeMemory = d.places;
    }
    d.archive.flush();
    this.archive = d.archive;
    this.pendingLoads = [];
    this.snapshots = [];
    this.eventSnapshot = null;
    // Route input through the correction, then a blank window (same place on
    // the lattice) that the archive refills over the next frames.
    const T = [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, 0, 0, 0, 1];
    const o = fix(0, 0);
    T[12] = o[0];
    T[14] = o[1];
    this.applyRegistration(T);
    this.recoveries.realign--; // (applyRegistration counts one; this is a reattach)
    this.rebuildAtFloor(this.floorY);
    this.floorRefinements--;
    this.requeueArchived();
    this.replayQueue = frames;
  }

  /**
   * Submaps of settled frames for loop closure (see PlaceMemory). Null: off.
   */
  placeMemory: PlaceMemory | null = new PlaceMemory();
  private settlePlaces(): void {
    const pm = this.placeMemory, g = this.grid;
    if (!pm || !g) return;
    pm.settle(this.replay, this.now, this.floorY, (x, y, z) => {
      const i = g.cellX(x), j = g.cellY(y), k = g.cellZ(z);
      if (!g.inBounds(i, j, k)) return null;
      return g.data[g.idx(i, j, k)] >= 0;
    }, this.heldSince ?? Infinity);
  }

  /**
   * Loop closure against place memory: align the recent frames (or those
   * from `since` on) with the submaps of one earlier visit to this place
   * (the oldest one that saw enough of it) that ended at least `minAge`
   * seconds before them. Resumable.
   */
  /** Where the camera is (map frame) and which way it looks (x/z heading), from the newest buffered frame. */
  viewNow(): { x: number; z: number; h: number } | null {
    const f = this.replay[this.replay.length - 1];
    if (!f) return null;
    return { x: f.eye.x, z: f.eye.z, h: frameHeading(f, this.floorY) ?? 0 };
  }
  /** Why the last place search returned nothing (diagnostics). */
  placeWhy = '';
  private noPlace(why: string): null {
    this.placeWhy = why;
    return null;
  }
  *placeSearch(opts: { frames?: number; since?: number; minAge: number; maxShift: number; maxYaw: number; memory?: PlaceMemory; penalty?: number; span?: number }): Generator<void, (Misalignment & { second: number; secondAt: PlaceMatch['secondAt']; constraint: number; unique: number; visitT0: number }) | null, void> {
    const pm = opts.memory ?? this.placeMemory, g = this.grid;
    if (!pm || !g || !this.replay.length) return this.noPlace('no memory/grid/frames');
    let frames = this.replay.slice(-(opts.frames ?? 20));
    if (opts.since !== undefined) frames = frames.filter((f) => f.t >= opts.since!);
    // At most the last few seconds (the frame drifts while the camera moves on).
    const tEnd = frames.length ? frames[frames.length - 1].t : 0;
    frames = frames.filter((f) => f.t >= tEnd - (opts.span ?? 3));
    if (!frames.length) return this.noPlace('no frames in span');
    const pts: number[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const headings: number[] = [];
    for (const f of frames) {
      const h = frameHeading(f, this.floorY);
      if (h !== null && !headings.some((x) => angDiff(x, h) < 0.2)) headings.push(h);
      for (let q = 0; q < f.pts.length; q += 3) {
        const x = f.pts[q], y = f.pts[q + 1], z = f.pts[q + 2];
        if (y < this.floorY + 0.06 || y > this.floorY + 2.2) continue;
        if (f.sig && f.sig[q / 3] > 0.08) continue;
        if (Math.hypot(x - f.eye.x, y - f.eye.y, z - f.eye.z) > 2.5) continue;
        const i = g.cellX(x), j = g.cellY(y), k = g.cellZ(z);
        if (g.inBounds(i, j, k) && g.isTransient(g.idx(i, j, k))) continue;
        pts.push(x, y, z);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    if (pts.length < 180 || !headings.length) return this.noPlace('too few readings');
    const pad = opts.maxShift + 0.3;
    const eye = frames[frames.length - 1].eye;
    const visits = pm.visitsNear({ minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }, frames[0].t - opts.minAge, { x: eye.x, z: eye.z, headings, maxDist: 1.5 + opts.maxShift, maxTurn: 0.6 + opts.maxYaw });
    if (!visits.length) return this.noPlace('no visit seen from here');
    // The oldest visit and the two that saw the most of this place: whichever explains the view best.
    const cand = [...new Set([visits[0], ...visits.slice().sort((a, b) => b.cells - a.cells).slice(0, 1)])].filter((v) => v.cells >= 150);
    if (!cand.length) return this.noPlace('no visit with enough structure');
    const pivot = frames[frames.length - 1].eye;
    const epoch = this.epoch, fv = this.frameVersion;
    const m: PlaceMatch | null = yield* pm.alignBest(pts, pivot, cand, opts.maxShift, opts.maxYaw, opts.penalty);
    if (!m || this.epoch !== epoch || this.frameVersion !== fv) return this.noPlace(`search gave up${pm.why ? `: ${pm.why}` : ''}`);
    return { dx: m.dx, dz: m.dz, dyaw: m.dyaw, pivot: m.pivot, base: m.base, best: m.best, n: m.n, degenerate: m.degenerate, snapT: frames[0].t, oldT: m.visitT1, second: m.second, secondAt: m.secondAt, constraint: m.constraint, unique: m.unique, visitT0: m.visitT0 };
  }

  /** See VoxelGrid.shieldedCarving. */
  shieldedCarving = false;
  /** See ingestDepthImage: hold back frames that contradict the map (on by default). */
  holdOnConflict = true;
  /** Share of probed readings behind confident surfaces that makes a frame "contradicting". */
  holdConflictRate = 0.25;
  holdMaxSeconds = 3;
  /** Time of the first held frame, while frames are held. */
  heldSince: number | null = null;
  heldFrames = 0;
  holdsReleased = 0;
  /** After letting held frames in, don't hold again for a while (the map may simply be out of date). */
  private holdCooldownUntil = -Infinity;
  holdsResolved = 0;

  /** Integrate the held frames as they are (the contradiction wasn't explained by a frame correction). */
  releaseHeld(): void {
    const since = this.heldSince;
    if (since === null) return;
    this.heldSince = null;
    this.holdsReleased++;
    this.holdCooldownUntil = this.now + 8;
    this.replayFrames((f) => f.t >= since);
  }

  /** The drift monitor corrected the frame for the held frames (realign replayed them): stop holding. */
  heldResolved(): void {
    if (this.heldSince === null) return;
    this.heldSince = null;
    this.holdsResolved++;
  }

  /**
   * Share of (a sample of) precise off-floor readings that contradict the
   * map: the reading lies in space the map is sure is empty, or its ray
   * passes through an occupied voxel well before reaching it.
   */
  probeConflict(eye: Vec3, pts: Vec3[], sig?: number[]): { n: number; rate: number } {
    const g = this.grid!;
    const stride = Math.max(1, Math.floor(pts.length / 300));
    let n = 0, bad = 0;
    for (let q = 0; q < pts.length; q += stride) {
      const p = pts[q];
      if (p.y < this.floorY + 0.08) continue;
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z, d = Math.hypot(dx, dy, dz);
      if (d < 0.3 || d > 3) continue;
      if (sig && sig[q] > 0.04) continue;
      const sigma = this.depthSigmaA + this.depthSigmaB * d * d;
      const stop = d - Math.max(0.15, 3 * sigma);
      if (stop <= 0.2) continue;
      n++;
      // The reading itself in space the map is sure is empty...
      const pi = g.cellX(p.x), pj = g.cellY(p.y), pk = g.cellZ(p.z);
      if (g.inBounds(pi, pj, pk) && g.data[g.idx(pi, pj, pk)] <= -20) {
        bad++;
        continue;
      }
      // ...or its ray through something the map is sure is there.
      let hits = 0, last = -1;
      for (let s = 0.1; s < stop; s += g.res * 0.7) {
        const i = g.cellX(eye.x + (dx / d) * s), j = g.cellY(eye.y + (dy / d) * s), k = g.cellZ(eye.z + (dz / d) * s);
        if (!g.inBounds(i, j, k)) continue;
        const idx = g.idx(i, j, k);
        if (idx === last) continue;
        last = idx;
        if (g.data[idx] > OCC_THRESHOLD + 10 && g.data[idx] !== 127) hits++;
        if (hits >= 1) break;
      }
      if (hits >= 1) bad++;
    }
    return { n, rate: n ? bad / n : 0 };
  }

  /**
   * Keep a copy of the grid (the newest 3, every `snapshotEvery` s). A full
   * copy is ~9MB, so the buffers of the snapshot that drops out are reused,
   * and the rarely-changing underside / sub-voxel height layers are shared
   * with the previous snapshot while they are unchanged (snapshots are never
   * written to, only copied from).
   */
  private takeSnapshot(t: number): void {
    const g = this.grid!;
    const prev = this.snapshots.length ? this.snapshots[this.snapshots.length - 1] : null;
    const old = this.snapshots.length >= 3 ? this.snapshots.shift()! : null;
    const owned = (a: Uint8Array | Int8Array) => !this.snapshots.some((s) => s.data === a || s.observed === a || s.underside === a || s.topFrac === a);
    const copy = <A extends Int8Array | Uint8Array>(src: A, reuse: A | undefined, share: A | undefined): A => {
      if (share && share.length === src.length && sameBytes(share, src)) return share;
      if (reuse && reuse.length === src.length && owned(reuse)) {
        reuse.set(src);
        return reuse;
      }
      return src.slice() as A;
    };
    this.snapshots.push({
      t,
      data: copy(g.data, old?.data, undefined),
      observed: copy(g.observed, old?.observed, undefined),
      underside: copy(g.underside, old?.underside, prev?.underside),
      topFrac: copy(g.topFrac, old?.topFrac, prev?.topFrac),
      floorY: this.floorY,
      epoch: this.epoch,
    });
  }

  /** Memory held by the grid copies kept for recovery (bytes, shared buffers counted once). */
  snapshotBytes(): number {
    const seen = new Set<ArrayBufferLike>();
    let n = 0;
    const add = (a: { buffer: ArrayBufferLike; byteLength: number }) => {
      if (!seen.has(a.buffer)) (seen.add(a.buffer), (n += a.byteLength));
    };
    for (const s of this.snapshots) for (const a of [s.data, s.observed, s.underside, s.topFrac]) add(a);
    if (this.eventSnapshot) add(this.eventSnapshot.data);
    return n;
  }

  /**
   * Keep the camera (map frame) inside the inner part of the window: when
   * it gets within two chunks of an edge, move the window by whole chunks
   * so the camera is near the middle again.
   */
  follow(eye: Vec3, t = this.now): void {
    const g = this.grid;
    if (!g || !Number.isFinite(eye.x + eye.z)) return;
    // (A warp in progress holds the window where it is: it works in window indices.)
    if (this.warpTask) return;
    const W = this.windowChunks, lo = Math.min(2, (W - 1) >> 1), hi = W - 1 - lo;
    const ci = Math.floor(g.cellX(eye.x) / CHUNK), ck = Math.floor(g.cellZ(eye.z) / CHUNK);
    // Where the camera's chunk should end up; if a companion point (the pet)
    // is given, prefer the target that keeps it inside the window too.
    const K = this.keepInWindow;
    const target = (c: number, other: number | null) => {
      if (c >= lo && c <= hi) return c;
      const base = c < lo ? Math.min(lo + 1, hi) : Math.max(hi - 1, lo);
      if (other === null) return base;
      // Shifting by (c - tgt) moves the other point to other - (c - tgt): keep it in [0, W-1] if we can.
      for (const tgt of [base, c < lo ? lo : hi, c < lo ? Math.min(lo + 2, hi) : Math.max(hi - 2, lo)]) {
        const o = other - (c - tgt);
        if (o >= 0 && o <= W - 1) return tgt;
      }
      return base;
    };
    const oi = K && Number.isFinite(K.x + K.z) ? Math.floor(g.cellX(K.x) / CHUNK) : null;
    const ok = K && Number.isFinite(K.x + K.z) ? Math.floor(g.cellZ(K.z) / CHUNK) : null;
    const si = ci - target(ci, oi), sk = ck - target(ck, ok);
    if (si || sk) this.moveWindow(si, sk, t);
    else {
      // Between moves: finish archiving what the last move left behind, bring
      // back what it entered, and have fresh arrays ready for the next one
      // (all of it off the move's frame).
      this.archive.step(2);
      this.dormant?.archive.step(2);
      this.loadPending(2);
      this.prepareSpare();
    }
  }

  /** Queue every archived chunk inside the window for merging back (merging only fills unknown voxels). */
  private requeueArchived(): void {
    const C = CHUNK, W = this.windowChunks;
    for (let a = 0; a < W; a++)
      for (let b = 0; b < W; b++) {
        const cx = this.wi / C + a, cz = this.wk / C + b;
        if (this.archive.has(cx, cz) && !this.pendingLoads.some(([x, z]) => x === cx && z === cz)) this.pendingLoads.push([cx, cz]);
      }
  }

  /** Archived chunks that entered the window and aren't loaded into it yet (lattice chunk coords). */
  private pendingLoads: [number, number][] = [];
  /** Merge up to n pending chunks into the window (all of them: Infinity). */
  loadPending(n = Infinity): void {
    const g = this.grid;
    if (!g) return;
    for (let q = 0; q < n && this.pendingLoads.length; q++) {
      const [cx, cz] = this.pendingLoads.shift()!;
      mergeChunkInto(this.archive, g, this.wi, this.wk, cx, cz, this.floorLayer);
    }
  }

  /** A point to keep inside the window when it moves, if possible (the pet); set by the game. */
  keepInWindow: Vec3 | null = null;

  /** Arrays for the next window, allocated ahead of a move (one per call). */
  private spare: { data?: Int8Array; observed?: Uint8Array; underside?: Uint8Array; topFrac?: Uint8Array; hitTime?: Uint32Array } = {};
  /**
   * Keep a spare set of window arrays ready so a window move doesn't
   * allocate (~25 MB held permanently for a few ms saved per move). Off by
   * default: memory matters more on a phone.
   */
  preallocateWindow = false;
  private prepareSpare(): void {
    const g = this.grid;
    if (!g || !this.preallocateWindow) return;
    const n = g.data.length, s = this.spare;
    if (!s.data) s.data = new Int8Array(n);
    else if (!s.hitTime) s.hitTime = new Uint32Array(n);
    else if (!s.underside) s.underside = new Uint8Array(n);
    else if (!s.topFrac) s.topFrac = new Uint8Array(n);
    else if (!s.observed) s.observed = new Uint8Array(g.nx * g.nz);
  }
  private takeSpare<K extends keyof WorldModel['spare']>(k: K, len: number, make: () => NonNullable<WorldModel['spare'][K]>): NonNullable<WorldModel['spare'][K]> {
    const a = this.spare[k];
    this.spare[k] = undefined;
    return (a && a.length === len ? a : make()) as NonNullable<WorldModel['spare'][K]>;
  }

  /** Session clock start (first depth frame), for hit time codes. */
  private t0 = NaN;
  /** Inverse of timeCode (start of that second). */
  timeOf(code: number): number {
    return (Number.isFinite(this.t0) ? this.t0 : 0) + code - 1;
  }
  /** Distance the camera has moved (m, map frame), and its value at each time code. */
  walked = 0;
  private walkLog = new Float32Array(65537);
  private walkCode = 0;
  private lastEye: Vec3 | null = null;
  private noteWalk(eye: Vec3, t: number): void {
    if (this.lastEye) {
      const d = Math.hypot(eye.x - this.lastEye.x, eye.z - this.lastEye.z);
      // Jumps of the tracking frame aren't walking.
      if (d < 0.5) this.walked += d;
    }
    this.lastEye = { ...eye };
    const code = this.timeCode(t);
    for (let c = this.walkCode + 1; c <= code; c++) this.walkLog[c] = this.walkLog[this.walkCode];
    if (code >= this.walkCode) {
      this.walkLog[code] = this.walked;
      this.walkCode = code;
    }
  }
  /** Distance walked by time code `code`. */
  walkedAt(code: number): number {
    return this.walkLog[Math.max(0, Math.min(this.walkCode, code))];
  }

  /**
   * Loop closure for what was mapped in between (pose graph lite): the frame
   * was right at t0 and off by `c` at t1; structure observed in between is
   * moved by its share of `c` (linear in distance walked), in the live window
   * and in the archive, chunk by chunk (memory: only the moving voxels).
   * Returns the number of voxels moved (0 when sliced: see sliceWarps).
   */
  warpSince(t0: number, t1: number, c: Correction): number {
    this.finishWarp();
    const it = this.warpSteps(t0, t1, c);
    if (this.sliceWarps) {
      this.warpTask = it;
      this.stepWarp(1);
      return 0;
    }
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  }
  /**
   * Spread a warp over the following depth frames (a pass over the whole
   * window and the archive: 100+ ms in one go on a phone). Meanwhile the
   * window stays put and recovery operations finish it first.
   */
  sliceWarps = true;
  private warpTask: Generator<void, number, void> | null = null;
  /** A warp is being applied (drift checks wait for it). */
  get warpBusy(): boolean {
    return this.warpTask !== null;
  }
  /** Advance the warp in progress by up to n steps (each ~one window layer or archive chunk). */
  stepWarp(n: number): void {
    const it = this.warpTask;
    if (!it) return;
    for (let q = 0; q < n; q++)
      if (it.next().done) {
        this.warpTask = null;
        return;
      }
  }
  /** Complete a warp in progress now (before anything that replaces or moves the grid). */
  finishWarp(): void {
    const it = this.warpTask;
    if (!it) return;
    this.warpTask = null;
    while (!it.next().done);
  }

  private *warpSteps(t0: number, t1: number, c: Correction): Generator<void, number, void> {
    const g = this.grid;
    if (!g || !g.hitTime || !(t1 > t0)) return 0;
    const code0 = this.timeCode(t0), code1 = this.timeCode(t1);
    const w0 = this.walkedAt(code0), w1 = this.walkedAt(code1);
    const span = w1 - w0;
    const alpha = (code: number) => Math.max(0, Math.min(1, span > 0.05 ? (this.walkedAt(code) - w0) / span : (code - code0) / Math.max(1, code1 - code0)));
    const cache = new Map<number, [number, number, number, number]>();
    const corrFor = (code: number) => {
      let e = cache.get(code);
      if (!e) {
        const a = alpha(code), yaw = a * c.dyaw;
        e = [Math.cos(yaw), Math.sin(yaw), a * c.dx, a * c.dz];
        cache.set(code, e);
      }
      return e;
    };
    const C = CHUNK, W = this.windowChunks, r = this.res, ny = g.ny, fl = this.floorLayer;
    const layer = g.nx * g.nz, CC = C * C, n = CC * ny;
    const wcx = this.wi / C, wcz = this.wk / C;
    const inWin = (cx: number, cz: number) => cx >= wcx && cx < wcx + W && cz >= wcz && cz < wcz + W;
    // Movers: lattice cell (I, J, K) → (I', J, K'), with what they carry.
    const dI: number[] = [], dK: number[] = [], dJ: number[] = [], vals: number[] = [], hits: number[] = [], tops: number[] = [], unders: number[] = [];
    const px = c.pivot.x, pz = c.pivot.z;
    const visit = (I: number, J: number, K: number, v: number, h: number, top: number, under: number): boolean => {
      if (v <= 0 || v === 127) return false;
      const last = h & 0xffff;
      if (last < code0 || last > code1) return false;
      const [cs, sn, tx, tz] = corrFor(last);
      const x = this.latX + (I + 0.5) * r - px, z = this.latZ + (K + 0.5) * r - pz;
      const X = px + cs * x + sn * z + tx, Z = pz - sn * x + cs * z + tz;
      const I2 = Math.floor((X - this.latX) / r), K2 = Math.floor((Z - this.latZ) / r);
      if (I2 === I && K2 === K) return false;
      dI.push(I2);
      dK.push(K2);
      dJ.push(J);
      vals.push(v);
      hits.push(h);
      tops.push(top);
      unders.push(under);
      return true;
    };
    // Right away (before the passes below are spread over frames): recovery
    // copies predate the warp (restoring one would undo it); buffered frames
    // from the interval move with what they mapped (replays then land where
    // the warped map is); place memory moves along.
    this.snapshots = [];
    this.eventSnapshot = null;
    for (const f of this.replay) {
      if (f.t < t0 || f.t > t1) continue;
      const [cs, sn, tx, tz] = corrFor(this.timeCode(f.t));
      const fix = (x: number, z: number): [number, number] => {
        const rx = x - px, rz = z - pz;
        return [px + cs * rx + sn * rz + tx, pz - sn * rx + cs * rz + tz];
      };
      [f.eye.x, f.eye.z] = fix(f.eye.x, f.eye.z);
      for (let q = 0; q < f.pts.length; q += 3) [f.pts[q], f.pts[q + 2]] = fix(f.pts[q], f.pts[q + 2]);
    }
    this.placeMemory?.warp(t0, t1, (tt) => corrFor(this.timeCode(tt)), c.pivot);
    this.warps++;
    // Chunks still coming back into the window, or still being archived from
    // an earlier window, must be where the passes below look (a few per step).
    while (this.pendingLoads.length) {
      this.loadPending(2);
      yield;
    }
    while (this.archive.step(2)) yield;
    // Pass 1a: the window.
    const gh = g.hitTime;
    for (let j = fl; j < ny; j++, yield)
      for (let k = 0; k < g.nz; k++)
        for (let i = 0; i < g.nx; i++) {
          const q = j * layer + k * g.nx + i;
          if (visit(this.wi + i, j, this.wk + k, g.data[q], gh[q], g.topFrac[q], g.underside[q])) {
            g.data[q] = 0;
            gh[q] = 0;
            g.topFrac[q] = 255;
            g.underside[q] = 0;
          }
        }
    // Pass 1b: archived chunks with hits in the interval (dense hit times while being edited).
    const dense = new Map<number, { cx: number; cz: number; ch: StoredChunk; hit: Uint32Array }>();
    const denseOf = (cx: number, cz: number, ch: StoredChunk) => {
      const key = cx * 65536 + cz;
      let d = dense.get(key);
      if (!d) {
        const hit = new Uint32Array(n);
        if (ch.hitIdx) for (let q = 0; q < ch.hitIdx.length; q++) hit[ch.hitIdx[q]] = ch.hitVal![q];
        d = { cx, cz, ch, hit };
        dense.set(key, d);
      }
      return d;
    };
    for (const [key, ch] of [...this.archive.map]) {
      if (!ch.hitVal) continue;
      const cx = keyCx(key), cz = keyCz(key);
      if (inWin(cx, cz)) continue;
      yield;
      let touched = false;
      for (let q = 0; q < ch.hitVal.length && !touched; q++) {
        const h = ch.hitVal[q] & 0xffff;
        if (h >= code0 && h <= code1) touched = true;
      }
      if (!touched) continue;
      // Re-level to the current floor if it was stored against another one.
      if (ch.oy !== g.origin.y) continue;
      const d = denseOf(cx, cz, ch);
      for (let q = 0; q < ch.hitIdx!.length; q++) {
        const li = ch.hitIdx![q], i = li % C, k = Math.floor(li / C) % C, j = Math.floor(li / CC);
        if (j < fl) continue;
        if (visit(cx * C + i, j, cz * C + k, ch.data[li], d.hit[li], ch.topFrac ? ch.topFrac[li] : 255, ch.underside ? ch.underside[li] : 0)) {
          ch.data[li] = 0;
          d.hit[li] = 0;
          if (ch.topFrac) ch.topFrac[li] = 255;
          if (ch.underside) ch.underside[li] = 0;
        }
      }
    }
    // Pass 2: write the movers where they belong (the stronger evidence wins).
    const m = vals.length;
    for (let q = 0; q < m; q++) {
      if (q % 20000 === 19999) yield;
      const I = dI[q], K = dK[q], J = dJ[q];
      const cx = Math.floor(I / C), cz = Math.floor(K / C);
      if (inWin(cx, cz)) {
        const t = J * layer + (K - this.wk) * g.nx + (I - this.wi);
        if (g.data[t] >= vals[q] && g.data[t] > 0) continue;
        g.data[t] = vals[q];
        gh[t] = hits[q];
        if (tops[q] !== 255) g.topFrac[t] = tops[q];
        g.underside[t] |= unders[q];
        continue;
      }
      let ch = this.archive.get(cx, cz);
      if (!ch) {
        const data = new Int8Array(n);
        data.fill(127, 0, fl * CC);
        ch = { data, observed: new Uint8Array(CC), underside: null, topFrac: null, hitIdx: null, hitVal: null, oy: g.origin.y, t: this.now };
        this.archive.put(cx, cz, ch);
      }
      if (ch.oy !== g.origin.y) continue;
      const d = denseOf(cx, cz, ch);
      const li = (J * C + (K - cz * C)) * C + (I - cx * C);
      if (ch.data[li] >= vals[q] && ch.data[li] > 0) continue;
      ch.data[li] = vals[q];
      d.hit[li] = hits[q];
      if (tops[q] !== 255) (ch.topFrac ??= new Uint8Array(n).fill(255))[li] = tops[q];
      if (unders[q]) (ch.underside ??= new Uint8Array(n))[li] |= unders[q];
    }
    // Back to sparse hit times.
    for (const { ch, hit } of dense.values()) {
      yield;
      const idx: number[] = [], val: number[] = [];
      for (let q = 0; q < n; q++) if (hit[q] !== 0 && ch.data[q] > 0) (idx.push(q), val.push(hit[q]));
      ch.hitIdx = idx.length ? Uint16Array.from(idx) : null;
      ch.hitVal = idx.length ? Uint32Array.from(val) : null;
    }
    if (!m) return 0;
    g.touchAll();
    g.version++;
    return m;
  }
  /** Loop-closure warps applied (diagnostics). */
  warps = 0;

  /** Whole seconds since the session started, from 1 (VoxelGrid.hitTime). */
  timeCode(t: number): number {
    if (!Number.isFinite(t)) return 1;
    if (!Number.isFinite(this.t0)) this.t0 = t;
    return Math.max(1, Math.min(65535, 1 + Math.floor(t - this.t0)));
  }

  /** Move the window by (si, sk) chunks. */
  moveWindow(si: number, sk: number, t = this.now): void {
    this.finishWarp();
    const old = this.grid;
    if (!old || (!si && !sk)) return;
    const C = CHUNK, W = this.windowChunks, r = this.res;
    const oldWi = this.wi, oldWk = this.wk;
    const newWi = oldWi + si * C, newWk = oldWk + sk * C;
    const inWin = (cx: number, cz: number, wi: number, wk: number) => cx >= wi / C && cx < wi / C + W && cz >= wk / C && cz < wk / C + W;
    // 1. Chunks leaving the window go to the archive (over the next frames:
    // the old grid isn't written to any more). One that entered on an earlier
    // move and wasn't merged back yet holds only what was seen since: merge
    // its archived copy in first, or the save would replace the archived
    // data with that (or, if nothing was seen, delete it).
    for (let a = 0; a < W; a++)
      for (let b = 0; b < W; b++) {
        const cx = oldWi / C + a, cz = oldWk / C + b;
        if (inWin(cx, cz, newWi, newWk)) continue;
        const p = this.pendingLoads.findIndex(([x, z]) => x === cx && z === cz);
        if (p >= 0) {
          this.pendingLoads.splice(p, 1);
          mergeChunkInto(this.archive, old, oldWi, oldWk, cx, cz, this.floorLayer);
        }
        this.archive.defer(old, oldWi, oldWk, cx, cz, this.floorLayer, t);
      }
    // 2. The new window: the overlap copied, the rest from the archive.
    // (Copy whole arrays, then shift in place: one memcpy and a row-wise
    // copyWithin each, no per-row views.)
    const di = newWi - oldWi, dk = newWk - oldWk, fl = FLOOR_LAYERS_BELOW;
    const n = old.data.length;
    const shifted = <A extends Int8Array | Uint8Array | Uint32Array>(a: A, dst: A, layers: number, fill: (j: number) => number): A => {
      shiftCopy(a, dst, old.nx, old.nz, layers, di, dk, fill);
      return dst;
    };
    const g = new VoxelGrid(
      { origin: { x: this.latX + newWi * r, y: old.origin.y, z: this.latZ + newWk * r }, res: r, nx: old.nx, ny: old.ny, nz: old.nz },
      {
        data: shifted(old.data, this.takeSpare('data', n, () => new Int8Array(n)), old.ny, (j) => (j < fl ? 127 : 0)),
        observed: shifted(old.observed, this.takeSpare('observed', old.nx * old.nz, () => new Uint8Array(old.nx * old.nz)), 1, () => 0),
        underside: shifted(old.underside, this.takeSpare('underside', n, () => new Uint8Array(n)), old.ny, () => 0),
        topFrac: shifted(old.topFrac, this.takeSpare('topFrac', n, () => new Uint8Array(n)), old.ny, () => 255),
      },
    );
    g.hitTime = shifted(old.hitTime ?? new Uint32Array(n), this.takeSpare('hitTime', n, () => new Uint32Array(n)), old.ny, () => 0);
    g.stamp = old.stamp;
    const entering: [number, number][] = [];
    for (let a = 0; a < W; a++)
      for (let b = 0; b < W; b++) {
        const cx = newWi / C + a, cz = newWk / C + b;
        if (!inWin(cx, cz, oldWi, oldWk)) entering.push([cx, cz]);
      }
    // Archived chunks come back over the next frames (merged: what is
    // observed meanwhile wins); pending ones that left again stay archived.
    this.pendingLoads = this.pendingLoads.filter(([cx, cz]) => inWin(cx, cz, newWi, newWk));
    for (const [cx, cz] of entering) if (this.archive.has(cx, cz)) this.pendingLoads.push([cx, cz]);
    g.stickyOccupied = old.stickyOccupied;
    g.now = old.now;
    g.version = old.version + 1;
    g.touchAll();
    // 3. Recovery copies move with the window, in place (the entering part as archived).
    const moved = new Set<Int8Array | Uint8Array>();
    const shiftArr = <A extends Int8Array | Uint8Array>(a: A, kind: 'data' | 'observed' | 'underside' | 'topFrac'): A => {
      if (moved.has(a)) return a; // shared between snapshots
      moved.add(a);
      const fl = this.floorLayer;
      shiftInPlace(a, g.nx, g.nz, kind === 'observed' ? 1 : g.ny, di, dk, kind === 'data' ? (j) => (j < fl ? 127 : 0) : kind === 'topFrac' ? () => 255 : () => 0);
      // (The entering part stays unknown: drift checks ignore readings there.)
      return a;
    };
    // Only the newest snapshot moves along (each shift costs a pass over the
    // window); older ones are dropped and replaced within seconds.
    this.snapshots = this.snapshots.filter((sn) => sn.epoch === this.epoch).slice(-1);
    for (const sn of this.snapshots) {
      sn.data = shiftArr(sn.data, 'data');
      sn.observed = shiftArr(sn.observed, 'observed');
      sn.underside = shiftArr(sn.underside, 'underside');
      sn.topFrac = shiftArr(sn.topFrac, 'topFrac');
    }
    if (this.eventSnapshot && this.eventSnapshot.epoch === this.epoch) this.eventSnapshot.data = shiftArr(this.eventSnapshot.data, 'data');
    else this.eventSnapshot = null;
    const nextEpoch = this.epoch + 1;
    for (const sn of this.snapshots) sn.epoch = nextEpoch;
    if (this.eventSnapshot) this.eventSnapshot.epoch = nextEpoch;
    this.wi = newWi;
    this.wk = newWk;
    this.grid = g;
    this.epoch = nextEpoch;
    this.recenters++;
  }

  /** Memory held by the map (bytes): the grid's arrays, recovery snapshots, replay buffer. */
  memoryBytes(): { grid: number; snapshots: number; replay: number; archive: number; places: number; total: number } {
    const g = this.grid;
    const grid = g ? g.data.byteLength + g.observed.byteLength + g.underside.byteLength + g.topFrac.byteLength + (g.shadow?.byteLength ?? 0) + (g.hitTime?.byteLength ?? 0) : 0;
    const snapshots = this.snapshotBytes();
    let replay = 0;
    for (const f of this.replay) replay += f.pts.byteLength + (f.sig?.byteLength ?? 0) + 64;
    const archive = this.archive.bytes();
    const places = (this.placeMemory?.bytes() ?? 0) + (this.dormant ? this.dormant.places.bytes() + this.dormant.archive.bytes() : 0);
    return { grid, snapshots, replay, archive, places, total: grid + snapshots + replay + archive + places };
  }

  /**
   * Integrate a set of depth samples taken from `eye`. Points near the floor
   * mark the floor as observed; others mark occupancy and carve free space.
   */
  ingestDepth(eye: Vec3, points: Vec3[], maxRange = 4.5, sigmas?: number[], t = 0): void {
    const g = this.grid;
    if (!g) return;
    const r = g.res;
    if (!this.replaying) this.remember(eye, points, sigmas, t);
    let rays = 0, conflicted = 0, carved = 0;
    // Scratch ray end point (no object per reading).
    const tgt = this._tgt;
    for (let q = 0; q < points.length; q++) {
      const p = points[q];
      const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      if (d < 0.1) continue;
      this.depthPoints++;
      const far = d > maxRange;
      // The sensor's own per-pixel uncertainty when it has one (never more optimistic than the model).
      const sigma = Math.max(this.depthSigmaA + this.depthSigmaB * d * d, sigmas ? sigmas[q] : 0);
      const dirY = (p.y - eye.y) / d;
      // Collect floor-height evidence from close, steeply downward readings.
      if (d < 1.5 && dirY < -0.4 && Math.abs(p.y - this.floorY) < 0.15) {
        this.floorHist[Math.round((p.y - this.floorY) * 100) + 15]++;
        this.floorSamples++;
      }
      if (!this.replaying && d < 1.8 && dirY < -0.5 && Math.abs(p.y - this.floorY) < 0.25) this.floorWatch[Math.round((p.y - this.floorY) * 100) + 25]++;
      // Vertical uncertainty of this point.
      const sy = sigma * Math.abs(dirY);
      // Floor only if close to it given the noise, capped so a small toy
      // can't be explained away as "noisy floor".
      const floorTol = Math.min(this.floorTolCap, 0.025 + sy);
      if (!far && p.y < this.floorY + floorTol) {
        // Floor (within noise). Free space down to just above it.
        g.markObserved(p.x, p.z);
        const lowBand = p.y > this.floorY + 0.025;
        if (lowBand && sigma <= 0.03 && this.lowBandEvidence) {
          // Ambiguous: noisy floor or a small toy. A close, precise reading here
          // is weak obstacle evidence; consistent repeats make it an obstacle.
          g.add(g.cellX(p.x), g.cellY(p.y), g.cellZ(p.z), 5);
        }
        // Clearly-floor precise readings clear the layer just above the floor.
        const stopY = !lowBand && sigma <= 0.03 ? this.floorY + 0.02 : this.floorY + floorTol;
        if (dirY < -0.05) {
          const t = (stopY - eye.y) / dirY;
          tgt.x = eye.x + ((p.x - eye.x) / d) * t;
          tgt.y = stopY;
          tgt.z = eye.z + ((p.z - eye.z) / d) * t;
          g.integrateRay(eye, tgt, false, 0, -3, 0);
        }
        continue;
      }
      if (far) {
        tgt.x = eye.x + ((p.x - eye.x) * maxRange) / d;
        tgt.y = eye.y + ((p.y - eye.y) * maxRange) / d;
        tgt.z = eye.z + ((p.z - eye.z) * maxRange) / d;
        g.integrateRay(eye, tgt, false, 0, -1, 3 * sigma);
        continue;
      }
      // Change detection: a reading inside space we're confident is empty
      // means something new is there (works at any range we trust at all).
      if (this.detectChanges && sigma < 0.15 && p.y > this.floorY + 0.06) {
        const i = g.cellX(p.x), j = g.cellY(p.y), k = g.cellZ(p.z);
        if (g.inBounds(i, j, k) && g.data[g.idx(i, j, k)] <= -10) g.noteSurprise(i, j, k, { x: p.x - eye.x, z: p.z - eye.z }, this.floorLayer);
      }
      const carveShort = Math.max(r * 1.5, this.carveSigmas * sigma);
      // Free-space evidence is weighted by precision too: a close, precise ray
      // clears space confidently, a distant noisy one only nudges it.
      const miss = this.weightedCarving ? -Math.max(1, Math.round(3 * Math.min(1, 0.03 / sigma))) : -3;
      if (sigma > this.maxHitSigma) {
        // Too uncertain to place an obstacle; still (weak) evidence of free space nearer.
        g.integrateRay(eye, p, false, 0, -1, carveShort);
        continue;
      }
      const hitDelta = Math.round(14 * Math.min(1, Math.max(0.4, 0.025 / sigma)));
      let landedInFree = false;
      if (sigma < 0.04) {
        const i = g.cellX(p.x), j = g.cellY(p.y), k = g.cellZ(p.z);
        landedInFree = g.inBounds(i, j, k) && g.data[g.idx(i, j, k)] <= -20;
      }
      const c = g.integrateRay(eye, p, true, hitDelta, miss, carveShort);
      if (sigma < 0.04) {
        rays++;
        if (c >= 2) conflicted++;
        if (landedInFree) carved++;
      }
    }
    if (!this.replaying && rays > 0) {
      const w = this.conflictWin;
      w.push({ t, rays, bad: conflicted, carve: carved });
      while (w.length && w[0].t < t - this.conflictWindow) w.shift();
      let R = 0, B = 0, C = 0;
      for (const e of w) {
        R += e.rays;
        B += e.bad;
        C += e.carve;
      }
      if (R >= 150) this.surpriseRate = C / R;
      // Too few precise readings (looking far away) says nothing either way.
      this.conflictRate = R >= 150 ? B / R : this.conflictRate * 0.9;
    }
  }

  private readonly _tgt: Vec3 = { x: 0, y: 0, z: 0 };

  /** Number of buffered frames from time t on. */
  replayFramesSince(t: number): number {
    let n = 0;
    for (let q = this.replay.length - 1; q >= 0 && this.replay[q].t >= t; q--) n++;
    return n;
  }

  private remember(eye: Vec3, points: Vec3[], sigmas: number[] | undefined, t: number): void {
    const pts = new Float32Array(points.length * 3);
    for (let q = 0; q < points.length; q++) {
      const p = points[q];
      pts[q * 3] = p.x;
      pts[q * 3 + 1] = p.y;
      pts[q * 3 + 2] = p.z;
    }
    this.replay.push({ eye: { ...eye }, pts, sig: sigmas ? Float32Array.from(sigmas) : null, t });
    this.replayPoints += points.length;
    while (this.replayPoints > this.replayBudget && this.replay.length > 1) this.replayPoints -= this.replay.shift()!.pts.length / 3;
  }

  /**
   * Fresh depth readings (last `maxAge` s) inside a vertical cylinder — e.g.
   * the pet's body. Independent of the map's (possibly stale) beliefs: if
   * the camera currently sees surfaces there, something real is there.
   */
  recentPointsIn(c: Vec3, radius: number, y0: number, y1: number, maxAge = 2): { points: number; frames: number } {
    let points = 0, frames = 0;
    const r2 = radius * radius;
    for (let f = this.replay.length - 1; f >= 0; f--) {
      const fr = this.replay[f];
      if (this.now - fr.t > maxAge) break;
      let n = 0;
      for (let q = 0; q < fr.pts.length; q += 3) {
        const dx = fr.pts[q] - c.x, dz = fr.pts[q + 2] - c.z, y = fr.pts[q + 1];
        if (dx * dx + dz * dz < r2 && y > c.y + y0 && y < c.y + y1) n++;
      }
      if (n) {
        points += n;
        frames++;
      }
    }
    return { points, frames };
  }

  /** Area-weighted height of detected floor planes, if there are enough of them. */
  floorPlaneEstimate(minArea = 2): { y: number; area: number } | null {
    let pa = 0, py = 0;
    for (const fp of this.floorPlanes.values()) {
      pa += fp.area;
      py += fp.y * fp.area;
    }
    return pa >= minArea ? { y: py / pa, area: pa } : null;
  }

  /**
   * Where recent close, downward readings say the floor is, relative to the
   * current estimate: the dominant 1cm height bin (smoothed), its share of all
   * such readings, and their (decayed) count.
   */
  floorEvidence(): { offset: number; share: number; mass: number; median: number; below: number; above: number; kernelMode: number; kernelGain: number } {
    const h = this.floorWatch;
    let total = 0, best = 0, bestB = 25;
    for (let b = 0; b < h.length; b++) {
      total += h[b];
      const s3 = (h[b - 1] ?? 0) + h[b] + (h[b + 1] ?? 0);
      if (s3 > best) {
        best = s3;
        bestB = b;
      }
    }
    let sw = 0, sy = 0;
    for (let b = Math.max(0, bestB - 2); b <= Math.min(h.length - 1, bestB + 2); b++) {
      sw += h[b];
      sy += h[b] * (b - 25);
    }
    // Robust summaries for broad distributions: median offset, and the share
    // of readings clearly below / above the current floor (±2cm).
    let acc = 0, median = 0, below = 0, above = 0;
    for (let b = 0; b < h.length; b++) {
      if (acc < total / 2 && acc + h[b] >= total / 2) median = (b - 25) / 100;
      acc += h[b];
      if (b - 25 <= -2) below += h[b];
      if (b - 25 >= 2) above += h[b];
    }
    // Kernel-smoothed mode (σ = 3cm) and how much denser the readings are
    // there than at the current floor height: robust for broad, noisy data.
    const dens = (c: number) => {
      let d = 0;
      for (let b = 0; b < h.length; b++) d += h[b] * Math.exp(-((b - 25 - c) ** 2) / 18);
      return d;
    };
    let kMode = 0, kBest = -1;
    for (let c = -20; c <= 20; c++) {
      const d = dens(c);
      if (d > kBest) {
        kBest = d;
        kMode = c;
      }
    }
    const d0 = dens(0);
    return {
      offset: sw ? sy / sw / 100 : 0,
      share: total ? sw / total : 0,
      mass: total,
      median,
      below: total ? below / total : 0,
      above: total ? above / total : 0,
      kernelMode: kMode / 100,
      kernelGain: d0 > 0 ? kBest / d0 : 0,
    };
  }

  /**
   * Recovery: move the floor to `y` and rebuild the map, re-integrating the
   * recent depth frames so the room isn't forgotten. Use when the floor is
   * known to be wrong (e.g. the floor itself shows up as an obstacle).
   */
  relevelFloor(y: number): void {
    if (!this.grid || !Number.isFinite(y)) return;
    this.finishWarp();
    this.recoveries.relevel++;
    // Chunks still being brought back must be in the grid that gets copied.
    this.loadPending();
    const old = this.grid;
    this.rebuildAtFloor(y);
    // Keep what we know above the floor (the bulk of the map, including
    // areas seen long ago that the replay buffer no longer covers): copy it
    // across, aligned by height. The band just above the floor is exactly what
    // the floor height changes the meaning of, so it's left to the replay.
    const g = this.grid!;
    const shift = Math.round((g.origin.y - old.origin.y) / g.res);
    const layer = g.nx * g.nz;
    for (let j = FLOOR_LAYERS_BELOW + 3; j < g.ny; j++) {
      const jo = j + shift;
      if (jo < FLOOR_LAYERS_BELOW || jo >= old.ny) continue;
      g.data.set(old.data.subarray(jo * layer, (jo + 1) * layer), j * layer);
      g.underside.set(old.underside.subarray(jo * layer, (jo + 1) * layer), j * layer);
      g.topFrac.set(old.topFrac.subarray(jo * layer, (jo + 1) * layer), j * layer);
      if (old.hitTime && g.hitTime) g.hitTime.set(old.hitTime.subarray(jo * layer, (jo + 1) * layer), j * layer);
    }
    g.observed.set(old.observed);
    g.touchAll();
    g.version++;
    this.floorWatch.fill(0);
    this.conflictRate = 0;
    this.conflictWin = [];
    this.snapshots = [];
    this.replayFrames(() => true);
  }

  /** Recovery: age all evidence so new observations quickly override a map that drifted out of line. */
  softReset(factor = 0.3, around?: { x: number; z: number; radius: number }): void {
    if (!this.grid) return;
    this.finishWarp();
    this.recoveries.soft++;
    const g = this.grid;
    this.grid.ageEvidence(factor, FLOOR_LAYERS_BELOW, around ? { i0: g.cellX(around.x - around.radius), i1: g.cellX(around.x + around.radius), k0: g.cellZ(around.z - around.radius), k1: g.cellZ(around.z + around.radius) } : undefined);
    this.snapshots = [];
    this.replay = [];
    this.replayPoints = 0;
    this.conflictRate = 0;
    this.multiView?.reset();
    this.conflictWin = [];
  }

  /**
   * Does recent depth line up with the map? Searches small rigid corrections
   * (x/z shift, yaw about the camera) that maximise how many recent precise
   * off-floor readings land on confidently occupied voxels. Returns the best
   * correction and the support with and without it. Cheap enough to run every
   * couple of seconds (coarse-to-fine, a few thousand points).
   */
  /** Debug hook: called with the scoring function of each misalignment search. */
  debugScore: ((score: (dx: number, dz: number, yaw: number) => number, pts: number[], data: Int8Array) => void) | null = null;
  estimateMisalignment(opts: MisalignmentOptions = {}): Misalignment | null {
    const it = this.misalignmentSearch(opts);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  }

  /**
   * estimateMisalignment as a resumable search: it pauses (yields) between
   * steps so a caller can spread it over several frames. If the map or its
   * frame changes while paused, the search gives up (returns null) rather
   * than mix old and new data.
   */
  *misalignmentSearch(opts: MisalignmentOptions = {}): Generator<void, Misalignment | null, void> {
    const g = this.grid;
    if (!g || !this.replay.length) return null;
    let frames = this.replay.slice(-(opts.frames ?? 10));
    if (opts.snapshot === 'event' && this.eventSnapshot) frames = frames.filter((f) => f.t > this.eventSnapshot!.t);
    if (!frames.length) return null;
    // Score against the map as it was *before* these frames (the live grid
    // already contains them, misplaced or not).
    const t0 = frames[0].t;
    const usable = this.snapshots.filter((sn) => sn.t <= t0 - 1 && sn.epoch === this.epoch);
    const ev = this.eventSnapshot;
    const aged = opts.snapshot === 'aged';
    const hit = g.hitTime;
    if (aged && !hit) return null;
    // 'aged': occupied voxels hit since `cutoff` count as unseen (what the
    // camera added lately, possibly in a drifted frame).
    const cutoff = aged ? this.timeCode(t0 - (opts.minAge ?? 30)) : 0;
    const snap = aged
      ? { t: t0, data: g.data }
      : opts.snapshot === 'event'
        ? ev && ev.epoch === this.epoch && ev.t <= t0
          ? ev
          : undefined
        : opts.snapshot === 'oldest'
          ? usable[0]
          : usable[usable.length - 1];
    if (!snap) return null;
    const data = snap.data;
    const pivot = frames[frames.length - 1].eye;
    const pts: number[] = [];
    for (const f of frames)
      for (let q = 0; q < f.pts.length; q += 3) {
        const x = f.pts[q], y = f.pts[q + 1], z = f.pts[q + 2];
        const d = Math.hypot(x - f.eye.x, y - f.eye.y, z - f.eye.z);
        if (d > 2.5 || y < this.floorY + 0.06) continue;
        if (f.sig && f.sig[q / 3] > 0.04) continue;
        // Moving things (people) would "align" with where they were a moment ago.
        const ti = g.cellX(x), tj = g.cellY(y), tk = g.cellZ(z);
        if (g.inBounds(ti, tj, tk) && g.isTransient(g.idx(ti, tj, tk))) continue;
        // Space the old map never saw says nothing either way (and would let
        // the search "align" new territory with some look-alike elsewhere).
        if (!g.inBounds(ti, tj, tk)) continue;
        // ('aged': these frames are already in the live map, so every point
        // sits on structure it made itself; which points can say anything is
        // decided below, by whether old structure is within reach.)
        if (!aged && data[g.idx(ti, tj, tk)] === 0) continue;
        pts.push(x, y, z);
      }
    const n = pts.length / 3;
    if (n < 60) return null;
    // Subsample to keep it cheap.
    const stride = Math.max(1, Math.floor(n / 1500));
    // The search below scores ~500 candidate corrections: precompute what
    // doesn't depend on the candidate (offsets from the pivot, voxel layer)
    // into typed arrays, and inline the grid indexing (same arithmetic).
    const m = Math.ceil(pts.length / (3 * stride));
    const RX = new Float64Array(m), RZ = new Float64Array(m), J = new Int32Array(m);
    for (let q = 0, u = 0; q < pts.length; q += 3 * stride, u++) {
      RX[u] = pts[q] - pivot.x;
      RZ[u] = pts[q + 2] - pivot.z;
      J[u] = g.cellY(pts[q + 1]);
    }
    const px = pivot.x, pz = pivot.z, ox = g.origin.x, oz = g.origin.z, res = g.res, gnx = g.nx, gny = g.ny, gnz = g.nz;
    const layer = gnx * gnz, inv = 1 / res;
    for (let u = 0; u < m; u++) J[u] = J[u] >= 0 && J[u] < gny ? J[u] * layer : -1;
    // Each voxel's contribution only depends on the snapshot: memoise it
    // (0 none, 1 = +1, 2 = +0.7, 3 = +0.35, 4 = -0.5; 127 = not yet known).
    const cls = aged ? this.agedClasses(data.length) : this.scoreClasses(data);
    // Old structure: occupied since before the cutoff ('born' time code).
    const strongOld = (n1: number) => data[n1] > STRONG_OCC && hit![n1] >>> 16 < cutoff;
    const classOf = aged
      ? (n0: number) => {
          let c = cls[n0];
          if (c !== 127) return c;
          // Only structure that predates the frames counts; free space can't
          // be dated (the frames being checked may have carved it), so
          // landing in it neither helps nor hurts.
          const old = hit![n0] >>> 16 < cutoff;
          if (old && data[n0] > STRONG_OCC) c = 1;
          else if (old && data[n0] > OCC_THRESHOLD) c = 2;
          else if (strongOld(n0 - 1) || strongOld(n0 + 1) || strongOld(n0 - gnx) || strongOld(n0 + gnx)) c = 3;
          else c = 0;
          cls[n0] = c;
          return c;
        }
      : (n0: number) => {
          let c = cls[n0];
          if (c !== 127) return c;
          if (data[n0] > STRONG_OCC) c = 1;
          else if (data[n0] > OCC_THRESHOLD) c = 2;
          else if (data[n0 - 1] > STRONG_OCC || data[n0 + 1] > STRONG_OCC || data[n0 - gnx] > STRONG_OCC || data[n0 + gnx] > STRONG_OCC) c = 3;
          else if (data[n0] < -20) c = 4;
          else c = 0;
          cls[n0] = c;
          return c;
        };
    // Rotated offsets per yaw (the search visits ~80 shifts per yaw).
    const X0 = new Float64Array(m), Z0 = new Float64Array(m);
    // ...and each point's x cell (+ layer) per (yaw, dx): the search sweeps dz innermost.
    const XI = new Int32Array(m);
    let cachedYaw = NaN, cachedDx = NaN;
    const score = (dx: number, dz: number, yaw: number, flags: Uint8Array | null = null) => {
      if (yaw !== cachedYaw) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        for (let u = 0; u < m; u++) {
          const rx = RX[u], rz = RZ[u];
          X0[u] = px + c * rx + s * rz;
          Z0[u] = pz - s * rx + c * rz;
        }
        cachedYaw = yaw;
        cachedDx = NaN;
      }
      if (dx !== cachedDx) {
        for (let u = 0; u < m; u++) {
          const a = X0[u] + dx - ox, qt = a * inv;
          let i = Math.floor(qt);
          if (qt - i < 1e-9 || i + 1 - qt < 1e-9) i = Math.floor(a / res);
          XI[u] = J[u] < 0 || i < 1 || i >= gnx - 1 ? -1 : J[u] + i;
        }
        cachedDx = dx;
      }
      // Hot loop: everything in locals (closure slots aren't hoisted out of loops).
      const xi = XI, z0 = Z0, C = cls, n = m, ozz = oz, iv = inv, rs = res, kmax = gnz - 1, rowLen = gnx;
      let sc = 0;
      for (let u = 0; u < n; u++) {
        const ji = xi[u];
        if (ji < 0) continue;
        // floor(a / res), exactly: the multiply is the same up to a few ulps,
        // so only a quotient within 1e-9 of a cell boundary needs the division.
        const a = z0[u] + dz - ozz, qt = a * iv;
        let k = Math.floor(qt);
        if (qt - k < 1e-9 || k + 1 - qt < 1e-9) k = Math.floor(a / rs);
        if (k < 1 || k >= kmax) continue;
        const n0 = ji + k * rowLen;
        const cc = C[n0];
        // Soft score: on a confident surface voxel (+1), or one seen less
        // often, e.g. a wall the camera only swept past (+0.7), or right next
        // to a confident one in x/z (+0.35); landing deep in space the old map
        // saw through clearly argues against a correction (-0.5): a look-alike
        // surface elsewhere would put points there.
        const c = cc !== 127 ? cc : classOf(n0);
        if (c === 1) sc += 1;
        else if (c === 2) sc += 0.7;
        else if (c === 3) sc += 0.35;
        else if (c === 4) sc -= 0.5;
        if (flags !== null && c >= 1 && c <= 3) flags[u] = 1;
      }
      return sc;
    };
    if (this.debugScore) this.debugScore(score, pts, data);
    const epoch = this.epoch, frameV = this.frameVersion, snapT = snap.t;
    const stale = () => this.grid !== g || this.epoch !== epoch || this.frameVersion !== frameV || snap.t !== snapT || snap.data !== data;
    const maxShift = opts.maxShift ?? 0.5, maxYaw = opts.maxYaw ?? 0.1;
    let used = Math.ceil(n / stride);
    if (aged) {
      // Which readings could match old structure under some correction? A
      // coarse pass over the search range flags them; the rest (new
      // territory) say nothing and don't count.
      const flags = new Uint8Array(m);
      for (let yaw = -maxYaw; yaw <= maxYaw + 1e-9; yaw += Math.max(0.05, maxYaw / 2)) {
        for (let dx = -maxShift; dx <= maxShift + 1e-9; dx += 0.1) {
          for (let dz = -maxShift; dz <= maxShift + 1e-9; dz += 0.1) score(dx, dz, yaw, flags);
          yield;
          if (stale()) return null;
        }
      }
      used = 0;
      for (let u = 0; u < m; u++) used += flags[u];
      if (used < 60) return null;
    }
    // Prefer small corrections among near-ties: a support penalty of 3% of the
    // readings per 10cm of displacement (yaw counted at 1m from the camera).
    const pen = (dx: number, dz: number, yaw: number) => (0.03 * used * (Math.hypot(dx, dz) + Math.abs(yaw))) / 0.1;
    const base = score(0, 0, 0);
    let best = { dx: 0, dz: 0, dyaw: 0, s: base, v: base };
    const consider = (dx: number, dz: number, yaw: number) => {
      const sc = score(dx, dz, yaw), v = sc - pen(dx, dz, yaw);
      if (v > best.v) best = { dx, dz, dyaw: yaw, s: sc, v };
    };
    for (let yaw = -maxYaw; yaw <= maxYaw + 1e-9; yaw += 0.025) {
      for (let dx = -maxShift; dx <= maxShift + 1e-9; dx += 0.05) {
        for (let dz = -maxShift; dz <= maxShift + 1e-9; dz += 0.05) consider(dx, dz, yaw);
        yield;
        if (stale()) return null;
      }
    }
    // Refine around the best.
    const c0 = { ...best };
    for (let yaw = c0.dyaw - 0.0125; yaw <= c0.dyaw + 0.0126; yaw += 0.00625) {
      for (let dx = c0.dx - 0.025; dx <= c0.dx + 0.026; dx += 0.0125)
        for (let dz = c0.dz - 0.025; dz <= c0.dz + 0.026; dz += 0.0125) consider(dx, dz, yaw);
      yield;
      if (stale()) return null;
    }
    // Degenerate geometry (one long wall, a plain floor edge): the fit can
    // slide without losing support, so the correction isn't really known.
    // Require the support to drop when the correction is nudged every way.
    // (Partly constrained fits are fine: the small-correction preference keeps
    // the unconstrained part — sliding along a wall — near zero.)
    const drop = 0.06 * used;
    let flat = 0;
    for (const [ddx, ddz, dyw] of [[0.1, 0, 0], [-0.1, 0, 0], [0, 0.1, 0], [0, -0.1, 0], [0, 0, 0.05], [0, 0, -0.05]])
      if (score(best.dx + ddx, best.dz + ddz, best.dyaw + dyw) > best.s - drop) flat++;
    // A shift along a direction the geometry doesn't pin down (sliding along
    // a wall onto a better-mapped stretch of it, where support just keeps
    // rising to the edge of the search) isn't a measurement either.
    const mag = Math.hypot(best.dx, best.dz);
    let slides = false;
    if (mag > 0.1) {
      const ux = (0.1 * best.dx) / mag, uz = (0.1 * best.dz) / mag;
      // A real fit is a peak: support falls off both ways along the shift.
      slides = !(score(best.dx + ux, best.dz + uz, best.dyaw) < best.s - drop && score(best.dx - ux, best.dz - uz, best.dyaw) < best.s - drop);
    }
    const degenerate = flat >= 5 || slides;
    // When was the structure the frames matched mapped? (The median hit time
    // of the old voxels the corrected readings land on.)
    let oldT = NaN;
    if (aged) {
      const cs = Math.cos(best.dyaw), sn = Math.sin(best.dyaw), codes: number[] = [];
      for (let u = 0; u < m; u++) {
        if (J[u] < 0) continue;
        const x = px + cs * RX[u] + sn * RZ[u] + best.dx, z = pz - sn * RX[u] + cs * RZ[u] + best.dz;
        const i = Math.floor((x - ox) / res), k = Math.floor((z - oz) / res);
        if (i < 0 || k < 0 || i >= gnx || k >= gnz) continue;
        const n0 = J[u] + k * gnx + i;
        const c = classOf(n0);
        if (c === 1 || c === 2) codes.push(hit![n0] >>> 16);
      }
      if (codes.length) {
        codes.sort((a, b) => a - b);
        oldT = this.timeOf(codes[codes.length >> 1]);
      }
    }
    return { dx: best.dx, dz: best.dz, dyaw: best.dyaw, pivot: { ...pivot }, base: Math.round(base), best: Math.round(best.s), n: used, degenerate, snapT: snap.t, oldT };
  }

  private scoreMemo: { data: Int8Array | null; t: number; cls: Int8Array | null } = { data: null, t: NaN, cls: null };
  private agedMemo: Int8Array | null = null;
  /** A fresh class memo for an 'aged' search (the live map changes between searches). */
  private agedClasses(len: number): Int8Array {
    if (!this.agedMemo || this.agedMemo.length !== len) this.agedMemo = new Int8Array(len);
    this.agedMemo.fill(127);
    return this.agedMemo;
  }
  /** Per-voxel score classes for estimateMisalignment, memoised per snapshot (127 = unknown). */
  private scoreClasses(data: Int8Array): Int8Array {
    const m = this.scoreMemo;
    // Snapshot buffers are reused, so the key is the buffer and its contents' time.
    const snapT = this.snapshots.find((s) => s.data === data)?.t ?? this.eventSnapshot?.t ?? NaN;
    if (!m.cls || m.cls.length !== data.length) m.cls = new Int8Array(data.length);
    if (m.data !== data || m.t !== snapT || Number.isNaN(snapT)) {
      m.cls.fill(127);
      m.data = data;
      m.t = snapT;
    }
    return m.cls;
  }

  /**
   * Recovery: the tracking frame moved against the map by the correction T
   * (yaw about `pivot`, then shift) starting around time `since`. Undo the
   * damage: restore the grid from a snapshot taken before `since`, replay the
   * buffered frames after it (correcting the ones from `since` on), and route
   * all future input through T.
   */
  realign(dx: number, dz: number, dyaw: number, pivot: Vec3, since: number): void {
    if (!this.grid) return;
    this.finishWarp();
    const c = Math.cos(dyaw), s = Math.sin(dyaw);
    const fix = (p: { x: number; y: number; z: number }) => {
      const rx = p.x - pivot.x, rz = p.z - pivot.z;
      return { x: pivot.x + c * rx + s * rz + dx, y: p.y, z: pivot.z - s * rx + c * rz + dz };
    };
    // T as a matrix (map frame): x' = R(x - pivot) + pivot + d.
    const T = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
    const tp = fix({ x: 0, y: 0, z: 0 });
    T[12] = tp.x;
    T[14] = tp.z;
    const snap = [...this.snapshots].reverse().find((sn) => sn.t <= since && sn.epoch === this.epoch && sn.floorY === this.floorY);
    this.eventSnapshot = null;
    // Correct the buffered frames from `since` on.
    for (const f of this.replay)
      if (f.t >= since) {
        f.eye = fix(f.eye);
        for (let q = 0; q < f.pts.length; q += 3) {
          const p = fix({ x: f.pts[q], y: f.pts[q + 1], z: f.pts[q + 2] });
          f.pts[q] = p.x;
          f.pts[q + 2] = p.z;
        }
      }
    if (snap) {
      const g = this.grid;
      g.data.set(snap.data);
      g.touchAll();
      g.observed.set(snap.observed);
      g.underside.set(snap.underside);
      g.topFrac.set(snap.topFrac);
      g.version++;
      this.snapshots = this.snapshots.filter((sn) => sn.t <= snap.t);
      // Chunks that came back from the archive after the snapshot are blank
      // in it: merge them back again (or they'd be archived blank on leaving).
      this.requeueArchived();
      this.replayFrames((f) => f.t > snap.t);
    } else {
      // No snapshot from before the jump: keep the map (everything outside
      // the replay buffer would be lost by a rebuild) and lay the corrected
      // frames over it; contradicted leftovers erode as they're seen through.
      this.snapshots = [];
      this.replayFrames((f) => f.t >= since);
    }
    this.placeMemory?.realign({ dx, dz, dyaw, pivot }, since);
    this.applyRegistration(T);
  }

  /**
   * Re-integrate buffered frames a few per depth frame instead of all at
   * once (a realignment replays up to ~10s of frames: 100+ms in one frame on
   * a phone). Until they are in, the map lacks the last seconds' detail.
   */
  sliceReplays = false;
  private replayFrames(which: (f: { t: number }) => boolean): void {
    if (this.sliceReplays) {
      const q = this.replay.filter(which);
      // (Frames already queued and replayed again replace their queued copy.)
      const set = new Set(q);
      this.replayQueue = [...this.replayQueue.filter((f) => !set.has(f)), ...q];
      return;
    }
    this.replaying = true;
    try {
      for (const f of this.replay) {
        if (!which(f)) continue;
        const pts: Vec3[] = [];
        for (let q = 0; q < f.pts.length; q += 3) pts.push({ x: f.pts[q], y: f.pts[q + 1], z: f.pts[q + 2] });
        this.ingestDepth(f.eye, pts, 4.5, f.sig ? Array.from(f.sig) : undefined, f.t);
      }
    } finally {
      this.replaying = false;
    }
  }

  /** Recovery of last resort: forget the depth map (keep the floor and planes) and start mapping afresh. */
  hardReset(around?: { x: number; z: number; radius: number }): void {
    if (!this.grid) return;
    this.finishWarp();
    if (around) {
      // A large map: forget what's around the player (it contradicts what
      // the camera sees) and weaken the rest of the window so it gives way
      // wherever it's looked at again; farther areas are kept.
      this.recoveries.hard++;
      this.loadPending();
      const g = this.grid, layer = g.nx * g.nz;
      const i0 = Math.max(0, g.cellX(around.x - around.radius)), i1 = Math.min(g.nx - 1, g.cellX(around.x + around.radius));
      const k0 = Math.max(0, g.cellZ(around.z - around.radius)), k1 = Math.min(g.nz - 1, g.cellZ(around.z + around.radius));
      g.ageEvidence(0.3, FLOOR_LAYERS_BELOW);
      for (let j = FLOOR_LAYERS_BELOW; j < g.ny; j++)
        for (let k = k0; k <= k1; k++) {
          const a = j * layer + k * g.nx + i0, b = j * layer + k * g.nx + i1 + 1;
          g.data.fill(0, a, b);
          g.underside.fill(0, a, b);
          g.topFrac.fill(255, a, b);
          g.hitTime?.fill(0, a, b);
        }
      g.touchAll();
      g.version++;
      this.snapshots = [];
      this.eventSnapshot = null;
      this.replay = [];
      this.replayPoints = 0;
      this.floorWatch.fill(0);
      this.conflictRate = 0;
      this.conflictWin = [];
      this.multiView?.reset();
      return;
    }
    this.recoveries.hard++;
    // Forget the window, including what was about to come back into it
    // (explicitly: left in the archive, it would be deleted by accident when
    // the blank window chunk is archived, or come back if it isn't).
    for (const [cx, cz] of this.pendingLoads) this.archive.delete(cx, cz);
    this.pendingLoads = [];
    this.snapshots = [];
    this.replay = [];
    this.replayPoints = 0;
    this.rebuildAtFloor(this.floorY);
    this.floorRefinements--; // not a refinement
    this.floorWatch.fill(0);
    this.conflictRate = 0;
    this.conflictWin = [];
    this.multiView?.reset();
  }

  /**
   * The floor height comes from the placement hit-test, which can be off by a
   * few cm. Depth sees lots of floor, so check the estimate against it and, if
   * it's clearly off, rebuild the grid at the corrected height (early on, so
   * little is lost). Returns true if the floor moved.
   */
  refineFloor(minSamples = 400): boolean {
    if (!this.grid || !this.allowFloorRefine || this.floorRefinements >= 2) return false;
    // Prefer detected floor planes (area-weighted) once there are enough of them.
    let pa = 0, py = 0;
    for (const fp of this.floorPlanes.values()) {
      pa += fp.area;
      py += fp.y * fp.area;
    }
    if (pa >= 2) {
      const off = py / pa - this.floorY;
      // A small correction of the hit-test height only: a plane far from our
      // floor is another surface (the player chose to play on a table).
      if (Math.abs(off) < 0.02 || Math.abs(off) > 0.15) return false;
      this.relevelFloor(this.floorY + off);
      return true;
    }
    // Depth-only refinement is biased by a few cm on blank floors (it moved
    // floors 3cm the wrong way in tests); the health monitor handles depth
    // evidence with stricter rules. Off unless asked for.
    if (!this.histogramRefine) return false;
    if (this.floorSamples < minSamples) return false;
    let best = 0;
    for (let b = 1; b < this.floorHist.length; b++) if (this.floorHist[b] > this.floorHist[best]) best = b;
    // Sub-bin estimate from the neighbouring bins.
    const h = this.floorHist, l = h[best - 1] ?? 0, rr = h[best + 1] ?? 0;
    const off = (best - 15 + (rr - l) / Math.max(1, h[best] + l + rr)) / 100;
    this.floorHist.fill(0);
    this.floorSamples = 0;
    // Hysteresis: a 1–2cm error is harmless and within tracking noise; only
    // correct a clear error that two consecutive windows agree on.
    const prev = this.pendingFloorOffset;
    // After one correction, only a gross error (tracking reset) justifies another.
    this.pendingFloorOffset = Math.abs(off) >= (this.floorRefinements ? 0.05 : 0.03) ? off : null;
    if (prev === null || this.pendingFloorOffset === null || Math.abs(prev - off) > 0.015) return false;
    this.pendingFloorOffset = null;
    // Depth alone (no floor plane to confirm) is biased on blank floors: allow
    // only one small correction this way.
    if (this.histRefined) return false;
    this.histRefined = true;
    const corr = Math.max(-0.03, Math.min(0.03, (prev + off) / 2));
    this.relevelFloor(this.floorY + corr);
    return true;
  }

  private rebuildAtFloor(newY: number): boolean {
    this.floorRefinements++;
    this.floorHist.fill(0);
    this.floorSamples = 0;
    this.grid = null;
    this.planeVersions.clear();
    this.labels.clear();
    this.allocateGrid(newY, this.center);
    this.epoch++;
    for (const pl of this.planeInputs.values()) this.ingestPlaneMap(pl);
    for (const m of this.meshInputs.values()) this.ingestMeshMap(m);
    return true;
  }

  // --- Export / import (persistence) -------------------------------------------------
  /** Horizontal lattice of the map (chunk boundaries); fixed for the session. */
  private lattice(): Lattice {
    const g = this.grid!;
    return { originX: this.latX, originY: g.origin.y, originZ: this.latZ, oi: this.wi, ok: this.wk };
  }

  /**
   * The voxel map as plain data (see MapFormat.ts): every chunk holding any
   * observation. Map frame. Null before the floor is set.
   */
  exportMap(): SerializedMap | null {
    const g = this.grid;
    if (!g) return null;
    this.finishWarp();
    this.loadPending();
    const lat = this.lattice();
    return {
      version: 1,
      res: g.res,
      chunkSize: CHUNK,
      ny: g.ny,
      originX: lat.originX,
      originY: lat.originY,
      originZ: lat.originZ,
      floorY: this.floorY,
      floorLayer: this.floorLayer,
      chunks: this.exportChunks(g, lat),
    };
  }

  /** The window's chunks plus the archived ones outside it, levelled to the current floor. */
  private exportChunks(g: VoxelGrid, lat: Lattice): SerializedChunk[] {
    const out = exportGrid(g, lat, this.floorY, this.floorLayer);
    const C = CHUNK, W = this.windowChunks;
    const tmp = new VoxelGrid({ origin: g.origin, res: g.res, nx: C, ny: g.ny, nz: C });
    for (const [key, c] of this.archive.map) {
      const cx = keyCx(key), cz = keyCz(key);
      if (cx >= this.wi / C && cx < this.wi / C + W && cz >= this.wk / C && cz < this.wk / C + W) continue;
      if (c.oy === g.origin.y) {
        const ch: SerializedChunk = { cx, cz, occ: c.data.slice(), observed: c.observed.slice() };
        if (c.underside) ch.underside = c.underside.slice();
        if (c.topFrac) ch.topFrac = c.topFrac.slice();
        out.push(ch);
      } else {
        // Stored against another floor height: re-level through a one-chunk grid.
        tmp.data.fill(0);
        tmp.observed.fill(0);
        tmp.underside.fill(0);
        tmp.topFrac.fill(255);
        this.archive.loadInto(tmp, cx * C, cz * C, cx, cz, this.floorLayer);
        for (let j = 0; j < FLOOR_LAYERS_BELOW; j++) tmp.data.fill(127, j * C * C, (j + 1) * C * C);
        out.push(...exportGrid(tmp, { ...lat, oi: cx * C, ok: cz * C }, this.floorY, this.floorLayer));
      }
    }
    return out;
  }

  /**
   * Load a serialized map (e.g. from an earlier session). `transform`
   * (column-major 4x4 rigid) maps the serialized map's frame into this map's
   * frame; omit it when the frames coincide. If the floor isn't set yet, it
   * is set from the imported map. Recovery snapshots taken before the import
   * are dropped (restoring one would undo the import). Returns the number of
   * voxels changed.
   */
  importMap(m: SerializedMap, transform?: ArrayLike<number> | null, opts: ImportOptions = {}): number {
    if (!m || m.version !== 1) return 0;
    this.finishWarp();
    if (transform && !Array.from(transform).every(Number.isFinite)) return 0;
    if (!this.grid) {
      const fy = transform ? transform[13] + transform[5] * m.floorY : m.floorY;
      this.allocateGrid(fy, { x: 0, y: fy, z: 0 });
    }
    const n = this.importEverywhere(m, transform ?? null, opts);
    // The imported map carries depth evidence (seen-empty space): navigation
    // applies the same seen-free rules as for a depth-built map.
    if (n > 0 && this.depthPoints === 0 && m.chunks.some((c) => c.occ.some((v) => v < 0))) this.depthPoints = 1;
    this.snapshots = [];
    this.eventSnapshot = null;
    return n;
  }

  /**
   * Import into the whole map: the window directly, and the archive through
   * window-sized tiles covering wherever the imported map lands.
   */
  private importEverywhere(m: SerializedMap, T: ArrayLike<number> | null, opts: ImportOptions): number {
    const g = this.grid!, C = CHUNK, W = this.windowChunks, r = this.res;
    this.loadPending();
    let n = importIntoGrid(g, this.lattice(), this.floorLayer, m, T, opts);
    // Where the imported chunks land (lattice chunk range).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const M = T ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const c of m.chunks)
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = m.originX + (c.cx + a) * m.chunkSize * m.res, z = m.originZ + (c.cz + b) * m.chunkSize * m.res;
        const X = M[0] * x + M[8] * z + M[12], Z = M[2] * x + M[10] * z + M[14];
        minX = Math.min(minX, X);
        maxX = Math.max(maxX, X);
        minZ = Math.min(minZ, Z);
        maxZ = Math.max(maxZ, Z);
      }
    if (!Number.isFinite(minX)) return n;
    const cx0 = Math.floor((minX - this.latX) / (r * C)), cx1 = Math.floor((maxX - this.latX) / (r * C));
    const cz0 = Math.floor((minZ - this.latZ) / (r * C)), cz1 = Math.floor((maxZ - this.latZ) / (r * C));
    const wcx = this.wi / C, wcz = this.wk / C;
    const inWin = (cx: number, cz: number) => cx >= wcx && cx < wcx + W && cz >= wcz && cz < wcz + W;
    for (let tx = cx0; tx <= cx1; tx += W)
      for (let tz = cz0; tz <= cz1; tz += W) {
        // Skip tiles entirely inside the window (already imported).
        let outside = false;
        for (let a = 0; a < W && !outside; a++) for (let b = 0; b < W && !outside; b++) if (!inWin(tx + a, tz + b)) outside = true;
        if (!outside) continue;
        const tile = new VoxelGrid({ origin: { x: this.latX + tx * C * r, y: g.origin.y, z: this.latZ + tz * C * r }, res: r, nx: W * C, ny: g.ny, nz: W * C });
        const tl = W * C * W * C;
        for (let j = 0; j < FLOOR_LAYERS_BELOW; j++) tile.data.fill(127, j * tl, (j + 1) * tl);
        for (let a = 0; a < W; a++) for (let b = 0; b < W; b++) if (!inWin(tx + a, tz + b)) this.archive.loadInto(tile, tx * C, tz * C, tx + a, tz + b, this.floorLayer);
        n += importIntoGrid(tile, { originX: this.latX, originY: g.origin.y, originZ: this.latZ, oi: tx * C, ok: tz * C }, this.floorLayer, m, T, opts);
        for (let a = 0; a < W; a++) for (let b = 0; b < W; b++) if (!inWin(tx + a, tz + b)) this.archive.saveFrom(tile, tx * C, tz * C, tx + a, tz + b, this.floorLayer, this.now);
      }
    return n;
  }

  private addLabel(id: string, label: string, pts: Vec3[], padBelow: number) {
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
    min.y += padBelow;
    this.labels.set(id, { id, label: label.toLowerCase(), min, max });
  }
}

function load(P: ArrayLike<number>, i: number, out: Vec3) {
  out.x = P[i * 3];
  out.y = P[i * 3 + 1];
  out.z = P[i * 3 + 2];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function centroid(pts: Vec3[]): Vec3 {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    c.x += p.x;
    c.y += p.y;
    c.z += p.z;
  }
  c.x /= pts.length;
  c.y /= pts.length;
  c.z /= pts.length;
  return c;
}

/** Calls `visit` with world-space points sampled on a grid covering the (convex or not) polygon. */
export function rasterizePolygon(poly: Vec3[], normal: Vec3, step: number, visit: (p: Vec3) => void): void {
  const n = normalize(normal);
  // Plane basis.
  const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let u = cross(ref, n);
  u = normalize(u);
  const v = cross(n, u);
  const o = poly[0];
  const p2 = poly.map((p) => {
    const d = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [a, b] of p2) {
    minU = Math.min(minU, a);
    maxU = Math.max(maxU, a);
    minV = Math.min(minV, b);
    maxV = Math.max(maxV, b);
  }
  for (let a = minU; a <= maxU + 1e-9; a += step)
    for (let b = minV; b <= maxV + 1e-9; b += step) {
      if (!pointInPoly2(a, b, p2)) continue;
      visit({ x: o.x + u.x * a + v.x * b, y: o.y + u.y * a + v.y * b, z: o.z + u.z * a + v.z * b });
    }
}

function pointInPoly2(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    // Treat points on the boundary as inside by expanding slightly.
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi + 1e-6) inside = !inside;
  }
  return inside;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function identity4(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
/** A·B for column-major 4x4 matrices. */
export function mul4(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
  return o;
}
export function invertRigid4(M: ArrayLike<number>): number[] {
  const o = identity4();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * M[12] + o[4 + r] * M[13] + o[8 + r] * M[14]);
  return o;
}
function xform(M: ArrayLike<number>, p: Vec3, w: number): Vec3 {
  return {
    x: M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12] * w,
    y: M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13] * w,
    z: M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14] * w,
  };
}

/** Byte-wise equality of two same-length typed arrays (word at a time where aligned). */
function sameBytes(a: Int8Array | Uint8Array, b: Int8Array | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  let q = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const w = n >> 2;
    const A = new Int32Array(a.buffer, a.byteOffset, w), B = new Int32Array(b.buffer, b.byteOffset, w);
    for (let i = 0; i < w; i++) if (A[i] !== B[i]) return false;
    q = w << 2;
  }
  for (; q < n; q++) if (a[q] !== b[q]) return false;
  return true;
}
