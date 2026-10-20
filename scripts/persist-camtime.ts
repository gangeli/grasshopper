/** How long does a camera-depth (motion stereo) session take to simulate? */
import { makeHome } from '../src/sim/Home';
import { SimSession } from '../src/sim/MultiSession';
const home = makeHome(3);
const t0 = performance.now();
const s = new SimSession({ home, rooms: [0], seconds: 10, seed: 5, cameraDepth: true });
while (s.step());
console.log('frames', s.frames, 'depth points', s.world.depthPoints, 'ms', (performance.now() - t0).toFixed(0));
