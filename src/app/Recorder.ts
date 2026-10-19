import type { DepthImage } from '../world/DepthFrame';

/**
 * Records an AR session's depth frames and tracked poses (enable with
 * ?record=1) so mapping can be replayed and evaluated offline with
 * scripts/tum-replay.ts. File format (.hopperrec): a 4-byte little-endian
 * header length, a JSON header {w, h, invProj, frames: [{t, camToWorld}]},
 * then float32 depth frames back to back (metres, 0 = none, row 0 = top).
 */
export class Recorder {
  private frames: { t: number; camToWorld: number[] }[] = [];
  private depth: Float32Array<ArrayBuffer>[] = [];
  private w = 0;
  private h = 0;
  private invProj: number[] = [];
  constructor(readonly maxFrames = 1500) {}

  get count(): number {
    return this.frames.length;
  }

  add(img: DepthImage, t: number): void {
    if (this.frames.length >= this.maxFrames) return;
    this.w = img.w;
    this.h = img.h;
    this.invProj = Array.from(img.invProj);
    this.frames.push({ t, camToWorld: Array.from(img.camToWorld) });
    this.depth.push(new Float32Array(img.depth));
  }

  toBlob(): Blob {
    const header = new TextEncoder().encode(JSON.stringify({ w: this.w, h: this.h, invProj: this.invProj, frames: this.frames, source: 'hopper-ar' }));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, header.byteLength, true);
    // Pad so the float data starts 4-byte aligned.
    const pad = new Uint8Array((4 - ((4 + header.byteLength) % 4)) % 4).fill(32);
    return new Blob([len, header, pad, ...this.depth], { type: 'application/octet-stream' });
  }

  download(name = `hopper-${new Date().toISOString().replace(/[:.]/g, '-')}.hopperrec`): void {
    const url = URL.createObjectURL(this.toBlob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
