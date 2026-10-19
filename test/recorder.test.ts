import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/app/Recorder';

describe('session recorder', () => {
  it('writes a header + aligned float frames that round-trip', async () => {
    const r = new Recorder();
    const img = { w: 2, h: 2, depth: new Float32Array([1, 2, 0, 3.5]), invProj: Array(16).fill(0), camToWorld: Array(16).fill(1) };
    r.add(img, 0.5);
    r.add({ ...img, depth: new Float32Array([4, 4, 4, 4]) }, 0.6);
    const buf = Buffer.from(await r.toBlob().arrayBuffer());
    const hl = buf.readUInt32LE(0);
    const meta = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
    expect(meta.frames).toHaveLength(2);
    const start = 4 + hl + ((4 - ((4 + hl) % 4)) % 4);
    expect(start % 4).toBe(0);
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + buf.byteLength));
    expect(Array.from(data)).toEqual([1, 2, 0, 3.5, 4, 4, 4, 4]);
  });
});
