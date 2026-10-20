import * as THREE from 'three';

/**
 * Recorded sample banks (public/sfx/, generated with ElevenLabs Sound
 * Effects). Each key maps to its variant files; one is picked at random.
 */
export const SAMPLE_BANKS: Readonly<Record<string, readonly string[]>> = {
  giggle: ['giggle-1.mp3', 'giggle-2.mp3', 'giggle-3.mp3', 'giggle-4.mp3'],
  giggleLoud: ['giggle-loud-1.mp3', 'giggle-loud-2.mp3'],
  greet: ['greet-1.mp3', 'greet-2.mp3', 'greet-3.mp3', 'greet-4.mp3'],
  hop: ['hop-1.mp3', 'hop-2.mp3'],
  jump: ['jump-1.mp3', 'jump-2.mp3'],
  land: ['land-1.mp3', 'land-2.mp3', 'land-3.mp3'],
  surprised: ['surprised-1.mp3', 'surprised-2.mp3'],
  fanfare: ['fanfare-1.mp3', 'fanfare-2.mp3'],
  yawn: ['yawn-1.mp3', 'yawn-2.mp3'],
  sneeze: ['sneeze-1.mp3', 'sneeze-2.mp3'],
  purr: ['purr-1.mp3', 'purr-2.mp3'],
  /** Being petted: contented coos and purr-trills. */
  pet: ['pet-1.mp3', 'pet-2.mp3', 'pet-3.mp3', 'pet-4.mp3'],
  /** A happy little "love" chirp (lots of petting). */
  love: ['love-1.mp3', 'love-2.mp3', 'love-3.mp3'],
};

/**
 * Hopper's voice and foley. Plays recorded samples (public/sfx/) when they
 * have loaded, otherwise falls back to sounds synthesised with WebAudio.
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
  /** Decoded sample variants per bank (empty until loaded / if loading fails). */
  private readonly samples = new Map<string, AudioBuffer[]>();
  private readonly lastPick = new Map<string, AudioBuffer>();

  /** Number of banks with at least one decoded sample. */
  get sampleBanksLoaded(): number {
    return this.samples.size;
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    if (typeof window === 'undefined') return;
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
    void this.loadSamples();
  }

  /** Fetch and decode all sample banks in the background; failures are silent. */
  private async loadSamples(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || typeof fetch !== 'function') return;
    let base: string;
    try {
      base = new URL('sfx/', typeof document !== 'undefined' ? document.baseURI : undefined).href;
    } catch {
      return;
    }
    const loadOne = async (file: string): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(base + file);
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        return await new Promise<AudioBuffer>((resolve, reject) => {
          // Callback form for older Safari; the promise form also resolves.
          const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        });
      } catch {
        return null;
      }
    };
    await Promise.all(
      Object.entries(SAMPLE_BANKS).map(async ([bank, files]) => {
        const bufs = (await Promise.all(files.map(loadOne))).filter((b): b is AudioBuffer => !!b);
        if (bufs.length) this.samples.set(bank, bufs);
      }),
    );
  }

  /**
   * Play a random variant of a sample bank. Returns false when no sample is
   * available (caller then uses the synthesised fallback).
   */
  private sample(bank: string, vol: number, spatial = true, rateMin = 0.95, rateMax = 1.08): boolean {
    const bufs = this.samples.get(bank);
    const ctx = this.ctx;
    if (!ctx || !bufs || !bufs.length) return false;
    const dest = this.out(spatial);
    if (!dest) return true; // muted: sample path handled it (silently)
    let buf = bufs[Math.floor(Math.random() * bufs.length)];
    if (bufs.length > 1 && buf === this.lastPick.get(bank)) buf = bufs[(bufs.indexOf(buf) + 1) % bufs.length];
    this.lastPick.set(bank, buf);
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rateMin + Math.random() * (rateMax - rateMin);
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g);
      g.connect(dest);
      src.start(this.now());
      return true;
    } catch {
      return false;
    }
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
    if (this.sample(loud ? 'giggleLoud' : 'giggle', loud ? 1.0 : 0.75)) return;
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
    if (this.sample('greet', 0.8)) return;
    const t = this.now();
    this.chirp(t, 700, 1300, 0.14, 0.35);
    this.chirp(t + 0.16, 900, 1600, 0.18, 0.35);
  }

  hop(): void {
    this.log('hop');
    if (this.sample('hop', 0.45, true, 0.9, 1.15)) return;
    const t = this.now();
    this.chirp(t, 320, 520, 0.06, 0.08, true, 'triangle');
  }

  jump(): void {
    this.log('jump');
    if (this.sample('jump', 0.7)) return;
    const t = this.now();
    this.chirp(t, 500, 1500, 0.22, 0.25);
  }

  land(impact: number): void {
    this.log('land');
    if (this.sample('land', Math.min(1, 0.4 + impact * 0.6), true, 0.92, 1.08)) return;
    const t = this.now();
    this.noise(t, 0.12, Math.min(0.6, 0.2 + impact * 0.4), 500);
    this.chirp(t, 260, 160, 0.08, 0.12, true, 'triangle');
  }

  surprised(): void {
    this.log('surprised');
    if (this.sample('surprised', 0.85)) return;
    const t = this.now();
    this.chirp(t, 600, 1900, 0.18, 0.45);
  }

  /** Little victory arpeggio (not spatial). */
  fanfare(): void {
    this.log('fanfare');
    if (this.sample('fanfare', 0.6, false, 0.98, 1.04)) return;
    const t = this.now();
    [523, 659, 784, 1046].forEach((f, i) => this.chirp(t + 0.12 + i * 0.1, f, f * 1.01, 0.16, 0.25, false, 'triangle'));
  }

  tick(final = false): void {
    this.log('tick');
    const t = this.now();
    this.chirp(t, final ? 880 : 620, final ? 880 : 600, 0.07, 0.18, false, 'square');
  }

  /** Sleepy yawn (for future idle behaviour). */
  yawn(): void {
    this.log('yawn');
    if (this.sample('yawn', 0.7)) return;
    const t = this.now();
    this.chirp(t, 900, 1300, 0.35, 0.2);
    this.chirp(t + 0.35, 1300, 600, 0.6, 0.18);
  }

  /** Cute little sneeze (for future idle behaviour). */
  sneeze(): void {
    this.log('sneeze');
    if (this.sample('sneeze', 0.75)) return;
    const t = this.now();
    this.chirp(t, 800, 1400, 0.2, 0.2);
    this.noise(t + 0.24, 0.12, 0.35, 4000);
    this.chirp(t + 0.24, 1600, 900, 0.1, 0.3);
  }

  /**
   * Being petted: a soft contented coo / purr-trill. `happiness` (0..1)
   * nudges it a little brighter and louder as Hopper gets happier.
   */
  pet(happiness = 0): void {
    this.log('pet');
    const h = Math.max(0, Math.min(1, happiness));
    if (this.sample('pet', 0.8 + 0.2 * h, true, 0.98 + 0.06 * h, 1.04 + 0.08 * h)) return;
    // Fallback: a rolling purr that rises into a little coo.
    const t = this.now();
    for (let i = 0; i < 6; i++) this.chirp(t + i * 0.07, 430 + 20 * i, 410 + 20 * i, 0.065, 0.07, true, 'triangle');
    this.chirp(t + 0.45, 820 + 200 * h, 1150 + 250 * h, 0.22, 0.2);
  }

  /** The sound for a petting response (see game/Petting). */
  petReaction(r: { sound: 'pet' | 'love' | 'giggle' | 'greet' | 'surprised'; happiness: number; big: boolean }): void {
    switch (r.sound) {
      case 'pet':
        this.pet(r.happiness);
        break;
      case 'love':
        this.love();
        // The big happy hop: a giggle on top of the love chirp.
        if (r.big) setTimeout(() => this.giggle(false), 450);
        break;
      case 'greet':
        this.greet();
        break;
      case 'surprised':
        this.surprised();
        setTimeout(() => this.giggle(false), 600);
        break;
      default:
        this.giggle(false);
    }
  }

  /** A happy rising "love" chirp (after lots of petting). */
  love(): void {
    this.log('love');
    if (this.sample('love', 0.85)) return;
    const t = this.now();
    this.chirp(t, 900, 1500, 0.16, 0.28);
    this.chirp(t + 0.18, 1200, 1900, 0.2, 0.26);
  }

  /** Content purr / happy trill (idle contentment). */
  purr(): void {
    this.log('purr');
    if (this.sample('purr', 0.7)) return;
    const t = this.now();
    for (let i = 0; i < 8; i++) this.chirp(t + i * 0.08, 420, 400, 0.07, 0.08, true, 'triangle');
  }
}
