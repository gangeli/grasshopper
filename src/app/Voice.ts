import * as THREE from 'three';

/**
 * Hopper's voice and foley, synthesised with WebAudio (no audio assets).
 * Sounds are spatialised with an HRTF panner at the pet's position, so a
 * giggle is a real directional hint when seeking.
 */
export class Voice {
  ctx: AudioContext | null = null;
  private panner: PannerNode | null = null;
  private master: GainNode | null = null;
  muted = false;
  /** Log of played sounds (for tests). */
  readonly played: string[] = [];

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
    this.panner = this.ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 0.6;
    this.panner.rolloffFactor = 1.1;
    this.panner.connect(this.master);
  }

  /** Update listener (camera) and source (pet) positions. */
  updateSpatial(camera: THREE.Camera, petPos: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx || !this.panner) return;
    const t = ctx.currentTime;
    const l = ctx.listener;
    const p = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const f = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    const u = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t);
      l.forwardY.setValueAtTime(f.y, t);
      l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t);
      l.upY.setValueAtTime(u.y, t);
      l.upZ.setValueAtTime(u.z, t);
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
    }
    const pp = this.panner;
    if (pp.positionX) {
      pp.positionX.setValueAtTime(petPos.x, t);
      pp.positionY.setValueAtTime(petPos.y + 0.15, t);
      pp.positionZ.setValueAtTime(petPos.z, t);
    } else pp.setPosition(petPos.x, petPos.y + 0.15, petPos.z);
  }

  private out(spatial: boolean): AudioNode | null {
    if (!this.ctx || this.muted) return null;
    return spatial ? this.panner : this.master;
  }

  /** A single cute "chirp": two detuned oscillators with a pitch glide and vibrato. */
  private chirp(at: number, f0: number, f1: number, dur: number, vol: number, spatial = true, type: OscillatorType = 'sine') {
    const ctx = this.ctx, dest = this.out(spatial);
    if (!ctx || !dest) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = f0 * 2.2;
    filt.Q.value = 0.8;
    g.connect(filt);
    filt.connect(dest);
    for (const det of [0, 7]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), at + dur);
      o.detune.value = det;
      const vib = ctx.createOscillator();
      vib.frequency.value = 28;
      const vg = ctx.createGain();
      vg.gain.value = f0 * 0.03;
      vib.connect(vg);
      vg.connect(o.frequency);
      o.connect(g);
      o.start(at);
      vib.start(at);
      o.stop(at + dur + 0.02);
      vib.stop(at + dur + 0.02);
    }
  }

  private noise(at: number, dur: number, vol: number, freq: number, spatial = true) {
    const ctx = this.ctx, dest = this.out(spatial);
    if (!ctx || !dest) return;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(at);
  }

  private now() {
    return this.ctx ? this.ctx.currentTime + 0.01 : 0;
  }

  private log(name: string) {
    this.played.push(name);
    if (this.played.length > 200) this.played.shift();
  }

  giggle(loud = false): void {
    this.log('giggle');
    const t = this.now();
    const n = loud ? 6 : 4;
    const v = loud ? 0.5 : 0.28;
    for (let i = 0; i < n; i++) {
      const base = 1150 - i * 70 + Math.random() * 60;
      this.chirp(t + i * 0.11, base, base * 1.35, 0.085, v);
    }
  }

  greet(): void {
    this.log('greet');
    const t = this.now();
    this.chirp(t, 700, 1300, 0.14, 0.35);
    this.chirp(t + 0.16, 900, 1600, 0.18, 0.35);
  }

  hop(): void {
    this.log('hop');
    const t = this.now();
    this.chirp(t, 320, 520, 0.06, 0.08, true, 'triangle');
  }

  jump(): void {
    this.log('jump');
    const t = this.now();
    this.chirp(t, 500, 1500, 0.22, 0.25);
  }

  land(impact: number): void {
    this.log('land');
    const t = this.now();
    this.noise(t, 0.12, Math.min(0.6, 0.2 + impact * 0.4), 500);
    this.chirp(t, 260, 160, 0.08, 0.12, true, 'triangle');
  }

  surprised(): void {
    this.log('surprised');
    const t = this.now();
    this.chirp(t, 600, 1900, 0.18, 0.45);
  }

  /** Little victory arpeggio (not spatial). */
  fanfare(): void {
    this.log('fanfare');
    const t = this.now();
    [523, 659, 784, 1046].forEach((f, i) => this.chirp(t + 0.12 + i * 0.1, f, f * 1.01, 0.16, 0.25, false, 'triangle'));
  }

  tick(final = false): void {
    this.log('tick');
    const t = this.now();
    this.chirp(t, final ? 880 : 620, final ? 880 : 600, 0.07, 0.18, false, 'square');
  }
}
