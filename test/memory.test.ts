import { describe, expect, it } from 'vitest';
import { WorldModel } from '../src/world/WorldModel';

/** Long sessions must not keep every surface the device ever reported. */
describe('memory: surfaces the device drops are forgotten', () => {
  const quad = (id: string, y: number, x0: number) => ({
    id,
    polygon: [
      { x: x0, y, z: 0 },
      { x: x0 + 1, y, z: 0 },
      { x: x0 + 1, y, z: 1 },
      { x: x0, y, z: 1 },
    ],
    normal: { x: 0, y: 1, z: 0 },
  });
  it('drops planes that are no longer live, including their floor evidence', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 50; i++) w.ingestPlane(quad(`p${i}`, 0, i * 0.01));
    const inputs = (w as unknown as { planeInputs: Map<string, unknown>; floorPlanes: Map<string, unknown> });
    expect(inputs.planeInputs.size).toBe(50);
    w.forgetSurfaces({ planes: new Set(['p49']) });
    expect(inputs.planeInputs.size).toBe(1);
    expect([...inputs.floorPlanes.keys()]).toEqual(['p49']);
  });
});
