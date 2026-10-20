import type * as THREE from 'three';

/**
 * Frame profiler. Every frame is split into named sections (CPU time, from
 * performance.now()); the monitor keeps a rolling window and summarises it as
 * ms per frame per section, frame interval percentiles, renderer statistics
 * and, where the GPU exposes a timer query, GPU time of the render pass.
 *
 * Always on at section granularity (a handful of performance.now() calls per
 * frame): the quality governor reads it. ?perf=1 adds finer sections (method
 * wrappers on the world model, nav, health, animation), an on-screen overlay
 * and a console summary every 5s, so real-device numbers can be read off a
 * phone (chrome://inspect) or a screenshot.
 */
export interface PerfSummary {
  frames: number;
  /** Mean interval between frames (ms) and its percentiles: what the user sees. */
  intervalMean: number;
  intervalP50: number;
  intervalP95: number;
  fps: number;
  /** Main-thread JS time inside the frame callback (ms/frame). */
  cpuMean: number;
  cpuP95: number;
  /** Frames whose CPU time exceeded 16.7ms / 33ms. */
  longFrames: number;
  veryLongFrames: number;
  /** ms per frame (averaged over all frames) and worst single call, per section. */
  sections: Record<string, { msPerFrame: number; max: number; calls: number }>;
  /** GPU time of the render pass (ms), when the timer-query extension is available. */
  gpuMs: number | null;
  render: { calls: number; triangles: number; programs: number; geometries: number; textures: number };
  /** Drawing buffer size and estimated fragment load (see estimatePetFragments). */
  pixels: number;
  petCoverage: number;
  petLayers: number;
  fragMpx: number;
  quality: string;
}

type Sec = { sum: number; max: number; calls: number };

export class PerfMonitor {
  readonly detailed: boolean;
  private window = 240;
  private intervals: number[] = [];
  private cpu: number[] = [];
  private secs = new Map<string, Sec>();
  private frames = 0;
  private lastFrameT = -1;
  private frameT0 = 0;
  private lastLog = 0;
  private overlay: HTMLElement | null = null;
  private lastOverlay = 0;
  /** Latest values reported by the stage / governor. */
  renderInfo = { calls: 0, triangles: 0, programs: 0, geometries: 0, textures: 0 };
  frag = { pixels: 0, coverage: 0, layers: 0 };
  quality = '';
  /** Exponential average of frame interval and CPU time (ms), for the governor. */
  emaInterval = 16.7;
  emaCpu = 0;
  private gpu: GpuTimer | null = null;

  constructor(opts: { detailed?: boolean; overlayParent?: HTMLElement | null } = {}) {
    this.detailed = !!opts.detailed;
    if (this.detailed && typeof document !== 'undefined') {
      const o = document.createElement('pre');
      o.className = 'perf-overlay';
      Object.assign(o.style, {
        position: 'fixed', left: '4px', bottom: '4px', zIndex: '50', margin: '0', padding: '4px 6px',
        font: '10px/1.25 ui-monospace, monospace', color: '#e8ffe8', background: 'rgba(0,0,0,0.55)',
        pointerEvents: 'none', whiteSpace: 'pre', borderRadius: '4px', maxWidth: '96vw', overflow: 'hidden',
      });
      this.overlay = o;
      if (opts.overlayParent) opts.overlayParent.appendChild(o);
    }
  }

  /** Move the overlay (e.g. into the WebXR dom-overlay root, the only DOM visible in AR). */
  attachOverlay(parent: HTMLElement) {
    if (this.overlay) parent.appendChild(this.overlay);
  }

  static fromUrl(overlayParent?: HTMLElement | null): PerfMonitor {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    return new PerfMonitor({ detailed: q?.get('perf') === '1', overlayParent });
  }

  /** Optional GPU timing (EXT_disjoint_timer_query_webgl2); a no-op where unavailable. */
  enableGpuTimer(gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.gpu = GpuTimer.create(gl);
  }

  beginFrame(t: number) {
    const now = performance.now();
    if (this.lastFrameT >= 0) {
      const dt = t - this.lastFrameT;
      if (dt > 0 && dt < 1000) {
        push(this.intervals, dt, this.window);
        this.emaInterval += (dt - this.emaInterval) * 0.05;
      }
    }
    this.lastFrameT = t;
    this.frameT0 = now;
    this.frameSecs.clear();
  }

  endFrame() {
    const cpu = performance.now() - this.frameT0;
    push(this.cpu, cpu, this.window);
    this.emaCpu += (cpu - this.emaCpu) * 0.05;
    // Stutters (frames whose own work took >50ms), with when they happened:
    // the max column can't tell a one-off at startup from a recurring hitch.
    if (cpu > 50) {
      this.hitches.push({ at: this.frameT0, ms: cpu, top: this.topSection() });
      if (this.hitches.length > 200) this.hitches.shift();
    }
    this.frames++;
    if (!this.detailed) return;
    const now = performance.now();
    if (this.overlay && now - this.lastOverlay > 500) {
      this.lastOverlay = now;
      this.overlay.textContent = this.format(this.summary());
    }
    if (now - this.lastLog > 5000) {
      this.lastLog = now;
      console.log(`[hopper perf]\n${this.format(this.summary())}`);
    }
  }

  private hitches: { at: number; ms: number; top: string }[] = [];
  private frameSecs = new Map<string, number>();
  /** The section that took longest in the current frame. */
  private topSection(): string {
    let top = '', best = 0;
    for (const [k, v] of this.frameSecs) if (v > best && !k.endsWith('*')) [top, best] = [k, v];
    return top;
  }

  /** Add a measured duration (ms) to a section. */
  add(name: string, ms: number) {
    let s = this.secs.get(name);
    if (!s) this.secs.set(name, (s = { sum: 0, max: 0, calls: 0 }));
    s.sum += ms;
    s.calls++;
    if (ms > s.max) s.max = ms;
    this.frameSecs.set(name, (this.frameSecs.get(name) ?? 0) + ms);
  }

  /** Time fn() as section `name`. */
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  gpuBegin() {
    this.gpu?.begin();
  }
  gpuEnd() {
    this.gpu?.end();
  }

  /**
   * Wrap obj[method] so every call is timed as `label` (detailed mode only).
   * Nested calls of the same label are not double-counted.
   */
  instrument(obj: object | null | undefined, method: string, label: string) {
    if (!this.detailed || !obj) return;
    const o = obj as Record<string, unknown>;
    const orig = o[method];
    if (typeof orig !== 'function' || (orig as { __perf?: boolean }).__perf) return;
    let depth = 0;
    const self = this;
    const wrapped = function (this: unknown, ...a: unknown[]) {
      if (depth++) {
        try {
          return (orig as (...x: unknown[]) => unknown).apply(this, a);
        } finally {
          depth--;
        }
      }
      const t0 = performance.now();
      try {
        return (orig as (...x: unknown[]) => unknown).apply(this, a);
      } finally {
        depth--;
        self.add(label, performance.now() - t0);
      }
    };
    (wrapped as { __perf?: boolean }).__perf = true;
    o[method] = wrapped;
  }

  /** Reset the accumulated sections (e.g. after warm-up). */
  reset() {
    this.secs.clear();
    this.intervals.length = 0;
    this.cpu.length = 0;
    this.frames = 0;
  }

  summary(): PerfSummary {
    const n = Math.max(1, this.frames);
    const iv = this.intervals.slice().sort((a, b) => a - b);
    const cp = this.cpu.slice().sort((a, b) => a - b);
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const q = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
    const sections: PerfSummary['sections'] = {};
    for (const [k, s] of this.secs) sections[k] = { msPerFrame: s.sum / n, max: s.max, calls: s.calls };
    const im = mean(iv);
    const pixels = this.frag.pixels;
    return {
      frames: this.frames,
      intervalMean: im,
      intervalP50: q(iv, 0.5),
      intervalP95: q(iv, 0.95),
      fps: im > 0 ? 1000 / im : 0,
      cpuMean: mean(cp),
      cpuP95: q(cp, 0.95),
      longFrames: cp.filter((x) => x > 16.7).length,
      veryLongFrames: cp.filter((x) => x > 33).length,
      sections,
      gpuMs: this.gpu?.ms ?? null,
      render: { ...this.renderInfo },
      pixels,
      petCoverage: this.frag.coverage,
      petLayers: this.frag.layers,
      fragMpx: (pixels * this.frag.coverage * this.frag.layers) / 1e6,
      quality: this.quality,
    };
  }

  /** Stutters in the last minute (and the worst one's cause), plus the session total. */
  private hitchLine(): string {
    const now = performance.now();
    const recent = this.hitches.filter((h) => now - h.at < 60000);
    const worst = recent.reduce<{ ms: number; top: string } | null>((w, h) => (!w || h.ms > w.ms ? h : w), null);
    return `stutters >50ms: ${recent.length} in last 60s${worst ? ` (worst ${worst.ms.toFixed(0)}ms ${worst.top})` : ''}, ${this.hitches.length} total`;
  }

  format(s: PerfSummary): string {
    const lines = [
      `${s.fps.toFixed(1)} fps  int ${s.intervalP50.toFixed(1)}/${s.intervalP95.toFixed(1)}ms  cpu ${s.cpuMean.toFixed(2)} p95 ${s.cpuP95.toFixed(1)}ms  gpu ${s.gpuMs === null ? 'n/a' : s.gpuMs.toFixed(2) + 'ms'}`,
      `draws ${s.render.calls}  tris ${(s.render.triangles / 1000).toFixed(0)}k  progs ${s.render.programs}  px ${(s.pixels / 1e6).toFixed(2)}M  pet ${(s.petCoverage * 100).toFixed(1)}% x${s.petLayers} = ${s.fragMpx.toFixed(2)}Mfrag`,
      `q: ${s.quality}`,
      this.hitchLine(),
    ];
    const secs = Object.entries(s.sections).sort((a, b) => b[1].msPerFrame - a[1].msPerFrame);
    for (const [k, v] of secs.slice(0, 14)) lines.push(`${k.padEnd(22).slice(0, 22)} ${v.msPerFrame.toFixed(3).padStart(7)}  max ${v.max.toFixed(1)}`);
    return lines.join('\n');
  }
}

function push(a: number[], v: number, max: number) {
  a.push(v);
  if (a.length > max) a.shift();
}

/** Asynchronous GPU timer (results arrive a few frames late). */
class GpuTimer {
  private queries: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  ms: number | null = null;
  private constructor(private gl: WebGL2RenderingContext, private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }) {}
  static create(gl: WebGL2RenderingContext | WebGLRenderingContext): GpuTimer | null {
    const g2 = gl as WebGL2RenderingContext;
    if (typeof g2.createQuery !== 'function') return null;
    const ext = g2.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    return ext ? new GpuTimer(g2, ext) : null;
  }
  begin() {
    if (this.active) return;
    this.poll();
    if (this.queries.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.active);
    this.active = null;
  }
  private poll() {
    const gl = this.gl;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) this.ms = this.ms === null ? ns / 1e6 : this.ms * 0.9 + (ns / 1e6) * 0.1;
      gl.deleteQuery(q);
      this.queries.shift();
    }
  }
}

/**
 * Rough fragment load of the pet: the share of the drawing buffer its
 * bounding sphere covers on screen (from the camera's projection), and how
 * many full-coverage layers are shaded there (body + each visible fur shell;
 * shells are discarded per fragment but the shader still runs).
 */
export function petScreenCoverage(center: THREE.Vector3, radius: number, cam: THREE.Camera): number {
  const v = center.clone().applyMatrix4(cam.matrixWorldInverse);
  const depth = -v.z;
  if (depth < 0.05) return 0;
  const P = cam.projectionMatrix.elements;
  // Projected radius in NDC (x and y), screen area fraction = π rx ry / 4.
  const rx = (radius * P[0]) / depth, ry = (radius * P[5]) / depth;
  const cx = (v.x * P[0]) / depth, cy = (v.y * P[5]) / depth;
  if (Math.abs(cx) - rx > 1 || Math.abs(cy) - ry > 1) return 0;
  return Math.min(1, (Math.PI * rx * ry) / 4);
}
