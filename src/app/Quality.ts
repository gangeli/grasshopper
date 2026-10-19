import type * as THREE from 'three';

/**
 * Frame-time governor: holds the device's frame rate by trading render cost
 * (where phones spend most of a frame: every fur shell redraws the whole
 * skinned body, at full screen resolution) for detail, one step at a time.
 *
 * Knobs, per level: how many fur shells are drawn (an evenly spread subset,
 * always including the outermost, so the coat keeps its length and colour
 * ramp and just gets sparser), render resolution (XR viewport scale where
 * the browser supports it, else the canvas pixel ratio), and the pet's
 * shadow (map size and how often it is redrawn).
 *
 * It steps down when frames are late (median interval clearly above the
 * display's), steps up again after a stretch of comfortable frames, and
 * backs off for a while when a step up didn't hold. When frames are
 * consistently at half the display rate it probes one level down to tell a
 * GPU-bound 30fps from a device that simply runs at 30 (ARCore runs AR
 * sessions at the camera's rate, often 30fps).
 *
 * ?quality=0..4 pins a level (0 = best); ?quality=auto (default) governs.
 */
export interface QualityLevel {
  name: string;
  /** Share of fur shells drawn. */
  shells: number;
  /** Render resolution factor (XR viewport scale / pixel-ratio multiplier). */
  scale: number;
  shadowSize: number;
  /** Redraw the shadow map every N frames. */
  shadowEvery: number;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { name: 'high', shells: 1, scale: 1, shadowSize: 1024, shadowEvery: 1 },
  { name: 'good', shells: 0.75, scale: 0.9, shadowSize: 1024, shadowEvery: 1 },
  { name: 'medium', shells: 0.55, scale: 0.8, shadowSize: 512, shadowEvery: 2 },
  { name: 'low', shells: 0.4, scale: 0.7, shadowSize: 512, shadowEvery: 2 },
  { name: 'lowest', shells: 0.25, scale: 0.6, shadowSize: 512, shadowEvery: 3 },
];

/** Known display / XR frame rates (ms per frame). */
const RATES = [1000 / 120, 1000 / 90, 1000 / 72, 1000 / 60, 1000 / 45, 1000 / 30, 1000 / 20];
function quantize(ms: number): number {
  let best = RATES[0];
  for (const r of RATES) if (Math.abs(Math.log(ms / r)) < Math.abs(Math.log(ms / best))) best = r;
  return best;
}

export interface QualityTargets {
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  /** Device pixel ratio used at full quality (non-XR). */
  basePixelRatio: number;
}

export class QualityGovernor {
  level: number;
  readonly pinned: boolean;
  private shells: THREE.Object3D[] = [];
  private intervals: number[] = [];
  private lastEval = 0;
  private lastChange = 0;
  private upBlockedUntil = 0;
  private lateEvals = 0;
  private trial: { from: number; until: number; kind: 'up' | 'probe'; base: number } | null = null;
  /** The display really runs at the slower rate (a probe found no faster one). */
  private rateLocked = false;
  private frame = 0;
  private settle = 0;
  private fresh = 0;
  /** Estimated display / session frame interval (ms). */
  base = 1000 / 60;
  /** Level changes (diagnostics). */
  readonly log: string[] = [];
  /** Current XR viewport scale (1 when not presenting). */
  viewportScale = 1;
  private appliedPixelRatio = -1;
  private appliedShadow = -1;

  constructor(readonly t: QualityTargets, opts: { level?: number | 'auto' } = {}) {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
    const want = opts.level ?? (q !== null && q !== 'auto' && q !== '' ? Number(q) : 'auto');
    this.pinned = want !== 'auto' && Number.isFinite(want);
    this.level = this.pinned ? Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(want as number))) : 0;
    t.renderer.shadowMap.autoUpdate = false;
    t.renderer.shadowMap.needsUpdate = true;
  }

  get current(): QualityLevel {
    return QUALITY_LEVELS[this.level];
  }

  /** The fur shells to thin out: meshes named fur1..furN under the pet. */
  attachPet(group: THREE.Object3D) {
    const shells: { o: THREE.Object3D; q: number }[] = [];
    group.traverse((o) => {
      const m = /^fur(\d+)$/.exec(o.name);
      if (m && (o as THREE.Mesh).isMesh) shells.push({ o, q: Number(m[1]) });
    });
    this.shells = shells.sort((a, b) => a.q - b.q).map((s) => s.o);
    this.applyShells();
  }

  describe(): string {
    const L = this.current;
    const n = this.shells.length, k = this.visibleShells();
    return `${this.pinned ? 'pinned ' : ''}${L.name} (L${this.level}) shells ${k}/${n} scale ${L.scale} shadow ${L.shadowSize}/${L.shadowEvery}f base ${(1000 / this.base).toFixed(0)}Hz`;
  }

  private visibleShells(): number {
    const n = this.shells.length;
    if (!n) return 0;
    return Math.max(Math.min(2, n), Math.min(n, Math.round(n * this.current.shells)));
  }

  private applyShells() {
    const n = this.shells.length;
    if (!n) return;
    const k = this.visibleShells();
    const show = new Set<number>();
    for (let i = 1; i <= k; i++) show.add(Math.round((i * n) / k));
    this.shells.forEach((o, idx) => (o.visible = show.has(idx + 1)));
  }

  private apply() {
    const L = this.current;
    this.applyShells();
    const r = this.t.renderer;
    if (!r.xr.isPresenting) {
      const pr = this.t.basePixelRatio * L.scale;
      if (pr !== this.appliedPixelRatio) {
        this.appliedPixelRatio = pr;
        r.setPixelRatio(pr);
      }
    }
    if (L.shadowSize !== this.appliedShadow) {
      this.appliedShadow = L.shadowSize;
      const sh = this.t.sun.shadow;
      sh.mapSize.set(L.shadowSize, L.shadowSize);
      // The old render target is freed; three.js allocates one at the new size.
      sh.map?.dispose();
      sh.map = null;
      r.shadowMap.needsUpdate = true;
    }
    this.viewportScale = L.scale;
  }

  private setLevel(level: number, now: number, why: string) {
    level = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, level));
    if (level === this.level) return;
    this.level = level;
    this.lastChange = now;
    this.lateEvals = 0;
    // A change itself can cost a slow frame or two (render targets resized):
    // judge the new level only on frames rendered after it settled.
    this.settle = 3;
    this.fresh = 0;
    this.apply();
    this.log.push(`${(now / 1000).toFixed(1)}s → ${this.current.name}: ${why}`);
    if (this.log.length > 50) this.log.shift();
  }

  /**
   * Once per frame, before rendering. `now` and `interval` in ms (interval =
   * time since the previous frame, 0 on the first).
   */
  update(now: number, interval: number) {
    if (this.frame++ === 0) this.apply();
    // Shadow map: redraw every N frames (the pet moves slowly; the map is soft).
    if (this.frame % this.current.shadowEvery === 0) this.t.renderer.shadowMap.needsUpdate = true;
    if (this.settle > 0) this.settle--;
    else if (interval > 0 && interval < 1500) {
      this.intervals.push(interval);
      this.fresh++;
      if (this.intervals.length > 240) this.intervals.shift();
    }
    if (this.pinned || now - this.lastEval < 500 || this.fresh < 20) return;
    this.lastEval = now;
    const all = this.intervals.slice().sort((a, b) => a - b);
    const recent = this.intervals.slice(-Math.min(30, this.fresh)).sort((a, b) => a - b);
    const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    // The display's interval: what the fastest regular frames achieve.
    this.base = quantize(q(all, 0.1));
    const p50 = q(recent, 0.5), p90 = q(recent, 0.9);
    const tr = this.trial;
    if (tr && now >= tr.until) {
      this.trial = null;
      if (tr.kind === 'probe') {
        // Did a lighter frame let the display run faster?
        if (quantize(q(recent, 0.25)) < tr.base * 0.8) this.log.push(`${(now / 1000).toFixed(1)}s probe: faster rate available`);
        else {
          this.rateLocked = true;
          this.setLevel(tr.from, now, `probe: the display runs at ${(1000 / tr.base).toFixed(0)}Hz anyway`);
        }
      } else if (p50 > this.base * 1.2) {
        this.setLevel(tr.from, now, 'step up did not hold');
        this.upBlockedUntil = now + 30000;
      }
      return;
    }
    if (tr) return;
    const late = p50 > this.base * 1.25 || p90 > this.base * 1.8;
    this.lateEvals = late ? this.lateEvals + 1 : 0;
    if (this.lateEvals >= 2 && this.level < QUALITY_LEVELS.length - 1) {
      this.setLevel(this.level + 1, now, `frames late (p50 ${p50.toFixed(1)}ms, p90 ${p90.toFixed(1)}ms vs ${this.base.toFixed(1)}ms)`);
      this.upBlockedUntil = Math.max(this.upBlockedUntil, now + 5000);
      return;
    }
    // Locked at a low rate (every frame ~2× the fastest known display rate)?
    if (!this.rateLocked && this.base >= 1000 / 45 && this.level < QUALITY_LEVELS.length - 1 && now - this.lastChange > 3000) {
      const from = this.level;
      this.setLevel(this.level + 1, now, 'probe: is the low frame rate ours?');
      this.trial = { from, until: now + 2500, kind: 'probe', base: this.base };
      return;
    }
    if (this.level > 0 && !late && p90 <= this.base * 1.15 && now > this.upBlockedUntil && now - this.lastChange > 6000) {
      const from = this.level;
      this.setLevel(this.level - 1, now, 'frames on time');
      this.trial = { from, until: now + 3000, kind: 'up', base: this.base };
    }
  }

  /** WebXR: request the level's viewport scale for these views (dynamic viewport scaling, where supported). */
  applyViewportScale(views: readonly XRView[] | undefined) {
    if (!views) return;
    for (const v of views) {
      const req = (v as unknown as { requestViewportScale?: (s: number | null) => void }).requestViewportScale;
      if (req) req.call(v, this.viewportScale);
    }
  }
}
