import type { Vec3 } from '../core/math';
import { STRONG_OCC, VoxelGrid } from './VoxelGrid';
import { DepthConsistency, depthImageToPoints, filterDiscontinuities, PoseGate, type DepthImage } from './DepthFrame';

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
  /** Horizontal half-extent of the mapped area (meters). */
  halfExtent?: number;
  height?: number;
}

export const FLOOR_LAYERS_BELOW = 2;
/** Weakly-free: inferred, not observed. Depth-based navigation doesn't trust it. */
export const ASSUMED_FREE = -1;
/** Guessed solid (see SOFT_SOLID): a few free-space rays clear it. */
export const ASSUMED_SOLID = 15;
const HOLLOW_LABELS = new Set(['table', 'desk', 'bed', 'shelf']);

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
  }

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
    const n = Math.ceil((this.halfExtent * 2) / r);
    const ny = Math.ceil(this.height / r) + FLOOR_LAYERS_BELOW;
    this.floorY = y;
    // Snap the origin so the floor is exactly at a cell boundary.
    this.grid = new VoxelGrid({
      origin: { x: center.x - (n / 2) * r, y: y - FLOOR_LAYERS_BELOW * r, z: center.z - (n / 2) * r },
      res: r,
      nx: n,
      ny,
      nz: n,
    });
    // The below-floor layers are solid everywhere; whether you may *walk* there
    // is governed by the observed mask.
    const g = this.grid;
    for (let j = 0; j < FLOOR_LAYERS_BELOW; j++)
      for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) g.data[g.idx(i, j, k)] = 127;
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
            if (g.inBounds(i, j, k)) g.underside[g.idx(i, j, k)] |= down ? 1 : up ? 2 : 0;
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
    if (this.grid && !this.replaying && (!this.snapshots.length || t - this.snapshots[this.snapshots.length - 1].t >= this.snapshotEvery || t < this.snapshots[this.snapshots.length - 1].t)) {
      const g = this.grid;
      this.snapshots.push({ t, data: g.data.slice(), observed: g.observed.slice(), underside: g.underside.slice(), topFrac: g.topFrac.slice(), floorY: this.floorY, epoch: this.epoch });
      if (this.snapshots.length > 3) this.snapshots.shift();
    }
    // Let old floor evidence fade (half-life ~7s).
    if (Number.isFinite(this.floorWatchT) && t > this.floorWatchT) {
      const k = Math.exp(-(t - this.floorWatchT) / 10);
      for (let b = 0; b < this.floorWatch.length; b++) this.floorWatch[b] *= k;
    }
    this.floorWatchT = t;
    if (this.grid) {
      this.grid.now = t;
      if (++this.frameCount % 30 === 0) this.grid.pruneTransient();
    }
    if (!this.poseGate.accept(eye, fwd, t, emulatedPose) && this.gateFrames) return false;
    const sig: number[] | undefined = img.sigma ? [] : undefined;
    let depth = this.filterEdges ? filterDiscontinuities(img) : img.depth;
    if (this.multiView) depth = this.multiView.filter(img, depth, t);
    this.ingestDepth(eye, depthImageToPoints(img, depth, sig), 4.5, sig, t);
    return true;
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
          g.integrateRay(eye, { x: eye.x + ((p.x - eye.x) / d) * t, y: stopY, z: eye.z + ((p.z - eye.z) / d) * t }, false, 0, -3, 0);
        }
        continue;
      }
      if (far) {
        const target = { x: eye.x + ((p.x - eye.x) * maxRange) / d, y: eye.y + ((p.y - eye.y) * maxRange) / d, z: eye.z + ((p.z - eye.z) * maxRange) / d };
        g.integrateRay(eye, target, false, 0, -1, 3 * sigma);
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

  private remember(eye: Vec3, points: Vec3[], sigmas: number[] | undefined, t: number): void {
    const pts = new Float32Array(points.length * 3);
    points.forEach((p, q) => pts.set([p.x, p.y, p.z], q * 3));
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
    this.recoveries.relevel++;
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
    }
    g.observed.set(old.observed);
    g.version++;
    this.floorWatch.fill(0);
    this.conflictRate = 0;
    this.conflictWin = [];
    this.snapshots = [];
    this.replayFrames(() => true);
  }

  /** Recovery: age all evidence so new observations quickly override a map that drifted out of line. */
  softReset(factor = 0.3): void {
    if (!this.grid) return;
    this.recoveries.soft++;
    this.grid.ageEvidence(factor, FLOOR_LAYERS_BELOW);
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
  estimateMisalignment(opts: { frames?: number; maxShift?: number; maxYaw?: number; snapshot?: 'newest' | 'oldest' | 'event' } = {}): { dx: number; dz: number; dyaw: number; pivot: Vec3; base: number; best: number; n: number; degenerate: boolean; snapT: number } | null {
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
    const snap =
      opts.snapshot === 'event'
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
        pts.push(x, y, z);
      }
    const n = pts.length / 3;
    if (n < 60) return null;
    // Subsample to keep it cheap.
    const stride = Math.max(1, Math.floor(n / 1500));
    const score = (dx: number, dz: number, yaw: number) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      let sc = 0;
      for (let q = 0; q < pts.length; q += 3 * stride) {
        const rx = pts[q] - pivot.x, rz = pts[q + 2] - pivot.z;
        const x = pivot.x + c * rx + s * rz + dx, z = pivot.z - s * rx + c * rz + dz;
        const i = g.cellX(x), j = g.cellY(pts[q + 1]), k = g.cellZ(z);
        if (i < 1 || k < 1 || j < 0 || i >= g.nx - 1 || k >= g.nz - 1 || j >= g.ny) continue;
        const n0 = g.idx(i, j, k);
        // Soft score: on a confident surface voxel, or right next to one (x/z).
        if (data[n0] > STRONG_OCC) sc += 1;
        else if (data[n0 - 1] > STRONG_OCC || data[n0 + 1] > STRONG_OCC || data[n0 - g.nx] > STRONG_OCC || data[n0 + g.nx] > STRONG_OCC) sc += 0.35;
      }
      return sc;
    };
    const maxShift = opts.maxShift ?? 0.5, maxYaw = opts.maxYaw ?? 0.1;
    const used = Math.ceil(n / stride);
    // Prefer small corrections among near-ties: a support penalty of 3% of the
    // readings per 10cm of displacement (yaw counted at 1m from the camera).
    const pen = (dx: number, dz: number, yaw: number) => (0.03 * used * (Math.hypot(dx, dz) + Math.abs(yaw))) / 0.1;
    const base = score(0, 0, 0);
    let best = { dx: 0, dz: 0, dyaw: 0, s: base, v: base };
    const consider = (dx: number, dz: number, yaw: number) => {
      const sc = score(dx, dz, yaw), v = sc - pen(dx, dz, yaw);
      if (v > best.v) best = { dx, dz, dyaw: yaw, s: sc, v };
    };
    for (let yaw = -maxYaw; yaw <= maxYaw + 1e-9; yaw += 0.025)
      for (let dx = -maxShift; dx <= maxShift + 1e-9; dx += 0.05)
        for (let dz = -maxShift; dz <= maxShift + 1e-9; dz += 0.05) consider(dx, dz, yaw);
    // Refine around the best.
    const c0 = { ...best };
    for (let yaw = c0.dyaw - 0.0125; yaw <= c0.dyaw + 0.0126; yaw += 0.00625)
      for (let dx = c0.dx - 0.025; dx <= c0.dx + 0.026; dx += 0.0125)
        for (let dz = c0.dz - 0.025; dz <= c0.dz + 0.026; dz += 0.0125) consider(dx, dz, yaw);
    // Degenerate geometry (one long wall, a plain floor edge): the fit can
    // slide without losing support, so the correction isn't really known.
    // Require the support to drop when the correction is nudged every way.
    // (Partly constrained fits are fine: the small-correction preference keeps
    // the unconstrained part — sliding along a wall — near zero.)
    const drop = 0.06 * used;
    let flat = 0;
    for (const [ddx, ddz, dyw] of [[0.1, 0, 0], [-0.1, 0, 0], [0, 0.1, 0], [0, -0.1, 0], [0, 0, 0.05], [0, 0, -0.05]])
      if (score(best.dx + ddx, best.dz + ddz, best.dyaw + dyw) > best.s - drop) flat++;
    const degenerate = flat >= 5;
    return { dx: best.dx, dz: best.dz, dyaw: best.dyaw, pivot: { ...pivot }, base: Math.round(base), best: Math.round(best.s), n: used, degenerate, snapT: snap.t };
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
      g.observed.set(snap.observed);
      g.underside.set(snap.underside);
      g.topFrac.set(snap.topFrac);
      g.version++;
      this.snapshots = this.snapshots.filter((sn) => sn.t <= snap.t);
      this.replayFrames((f) => f.t > snap.t);
    } else {
      // No snapshot from before the jump: rebuild from what we have.
      this.rebuildAtFloor(this.floorY);
      this.floorRefinements--;
      this.snapshots = [];
      this.replayFrames(() => true);
    }
    this.applyRegistration(T);
  }

  private replayFrames(which: (f: { t: number }) => boolean): void {
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
  hardReset(): void {
    if (!this.grid) return;
    this.recoveries.hard++;
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
      if (Math.abs(off) < 0.02) return false;
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
