import { describe, expect, it } from 'vitest';
import { CS, CS2, chunkKey, emptyMap, getOrCreateChunk, knownVoxels, voxelAt, type ChunkedMap } from '../src/world/persist/ChunkedMap';
import { decodeMap, encodeMap } from '../src/world/persist/codec';
import { MapStore, MemoryKV } from '../src/world/persist/MapStore';
import { exportLive, importLive, liveLattice } from '../src/world/persist/adapter';
import { applyPose, composePose, invertPose, poseDelta, poseFromMatrix, poseToMatrix } from '../src/world/persist/pose';
import { transformMap } from '../src/world/persist/Stitcher';
import { fromSerialized, toSerialized } from '../src/world/persist/mapFormatBridge';
import { extractFeatures, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize, runToEnd } from '../src/world/persist/Relocalizer';
import { MapMemory } from '../src/world/persist/MapMemory';
import { WorldModel } from '../src/world/WorldModel';
import { makeHome } from '../src/sim/Home';
import { SimSession, storedMapQuality } from '../src/sim/MultiSession';
import { Rng } from '../src/core/rng';
import { scanRoom } from '../src/sim/scan';
import { livingRoom } from '../src/sim/SimRoom';

function randomMap(seed: number): ChunkedMap {
  const rng = new Rng(seed);
  const m = emptyMap(0.05, 52, { x: 0.123, y: -1.4, z: -3.21 });
  for (let n = 0; n < 12; n++) {
    const c = getOrCreateChunk(m, rng.int(-5, 5), rng.int(-5, 5));
    for (let q = 0; q < 4000; q++) c.occ[rng.int(0, c.occ.length - 1)] = rng.int(-60, 120);
    for (let q = 0; q < CS2; q++) c.observed[q] = rng.chance(0.5) ? 1 : 0;
    if (rng.chance(0.5)) {
      c.underside = new Uint8Array(CS2 * m.ny);
      c.underside[rng.int(0, c.underside.length - 1)] = 3;
    }
    if (rng.chance(0.5)) {
      c.topFrac = new Uint8Array(CS2 * m.ny).fill(255);
      c.topFrac[rng.int(0, c.topFrac.length - 1)] = 77;
    }
  }
  return m;
}

function sameMap(a: ChunkedMap, b: ChunkedMap) {
  expect(b.res).toBeCloseTo(a.res, 9);
  expect(b.ny).toBe(a.ny);
  expect(b.origin).toEqual(a.origin);
  expect([...b.chunks.keys()].sort()).toEqual([...a.chunks.keys()].sort());
  for (const [k, c] of a.chunks) {
    const d = b.chunks.get(k)!;
    expect(Buffer.from(d.occ.buffer).equals(Buffer.from(c.occ.buffer))).toBe(true);
    expect(Array.from(d.observed)).toEqual(Array.from(c.observed));
    expect(d.underside ? Array.from(d.underside) : null).toEqual(c.underside ? Array.from(c.underside) : null);
    expect(d.topFrac ? Array.from(d.topFrac) : null).toEqual(c.topFrac ? Array.from(c.topFrac) : null);
  }
}

describe('map persistence: storage', () => {
  it('encodes and decodes a map exactly (compressed)', async () => {
    const m = randomMap(1);
    const bytes = await encodeMap(m);
    sameMap(m, await decodeMap(bytes));
    // Uncompressed works too.
    sameMap(m, await decodeMap(await encodeMap(m, false)));
  });

  it('detects corrupted and truncated data', async () => {
    const bytes = await encodeMap(randomMap(2), false);
    const bad = bytes.slice();
    bad[bad.length - 100] ^= 0x55;
    await expect(decodeMap(bad)).rejects.toThrow();
    await expect(decodeMap(bytes.slice(0, bytes.length - 7))).rejects.toThrow();
    await expect(decodeMap(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it('stores fragments crash-safely, keeps a backup, survives quota and broken storage', async () => {
    const kv = new MemoryKV();
    const store = await MapStore.open(kv);
    const a = randomMap(3), b = randomMap(4);
    expect(await store.save('f1', a, { area: 3 })).not.toBeNull();
    expect(await store.save('f1', b, { area: 4 })).not.toBeNull();
    sameMap(b, (await (await MapStore.open(kv)).load('f1'))!);
    // Corrupt the current generation: the backup (previous version) is used.
    const meta = store.list()[0];
    const raw = kv.data.get(`frag:f1:${meta.gen}`) as Uint8Array;
    raw[40] ^= 0xff;
    const reopened = await MapStore.open(kv);
    sameMap(a, (await reopened.load('f1'))!);
    expect(reopened.corrupt.has('f1')).toBe(true);
    // Quota: the save fails, the stored version is untouched.
    kv.quota = 1000;
    expect(await store.save('f1', randomMap(5), { area: 1 })).toBeNull();
    expect(store.lastError).toMatch(/storage full/);
    kv.quota = Infinity;
    // Broken storage: everything fails softly.
    kv.broken = true;
    expect(await store.save('f2', a, { area: 1 })).toBeNull();
    expect(await store.load('f1')).toBeNull();
    kv.broken = false;
    expect(await store.clear()).toBe(true);
    expect((await MapStore.open(kv)).list()).toEqual([]);
  });

  it('prunes the smallest fragments to stay within budget', async () => {
    const kv = new MemoryKV();
    const store = await MapStore.open(kv);
    const m = randomMap(6);
    const size = (await encodeMap(m)).length;
    store.budget = size * 2.5;
    await store.save('small', m, { area: 1 });
    await store.save('big', m, { area: 10 });
    await store.save('new', m, { area: 5 });
    expect(store.list().map((f) => f.id).sort()).toEqual(['big', 'new']);
  });
});

describe('map persistence: frames and resampling', () => {
  it('pose algebra matches the matrix convention', () => {
    const A = { yaw: 0.7, tx: 1.2, tz: -0.4, dj: 0 }, B = { yaw: -2.1, tx: -3, tz: 0.5, dj: 0 };
    const p = applyPose(composePose(A, B), 0.3, 0.9);
    const q = applyPose(A, applyPose(B, 0.3, 0.9).x, applyPose(B, 0.3, 0.9).z);
    expect(p.x).toBeCloseTo(q.x, 9);
    expect(p.z).toBeCloseTo(q.z, 9);
    const r = applyPose(composePose(A, invertPose(A)), 0.3, 0.9);
    expect(r.x).toBeCloseTo(0.3, 9);
    expect(r.z).toBeCloseTo(0.9, 9);
    const back = poseFromMatrix(poseToMatrix(A));
    expect(poseDelta(back, A).dist).toBeLessThan(1e-9);
  });

  it('exports and imports the live grid exactly', () => {
    const { world } = scanRoom(livingRoom(), undefined, { seed: 3 });
    const before = Buffer.from(world.grid!.data);
    const m = exportLive(world)!;
    expect(knownVoxels(m)).toBeGreaterThan(1000);
    world.grid!.data.fill(0, 2 * world.grid!.nx * world.grid!.nz);
    expect(importLive(world, m)).toBe(true);
    expect(Buffer.from(world.grid!.data).equals(before)).toBe(true);
  });

  it('converts losslessly to and from the world model exchange format (MapFormat)', () => {
    const { world } = scanRoom(livingRoom(), undefined, { seed: 5 });
    const direct = exportLive(world)!;
    const viaFormat = fromSerialized(world.exportMap()!);
    sameMap(direct, viaFormat);
    // And back: a fresh world imports it ('replace') into the same contents.
    const w2 = new WorldModel();
    w2.setFloor(world.floorY, { x: 0, y: 0, z: 0 });
    // Same lattice: copy the grid origin.
    (w2.grid!.origin as { x: number; z: number }).x = world.grid!.origin.x;
    (w2.grid!.origin as { x: number; z: number }).z = world.grid!.origin.z;
    w2.importMap(toSerialized(direct), null, { mode: 'replace' });
    sameMap(direct, exportLive(w2)!);
  });

  it('a transform and its inverse bring a map back (nearest-voxel resampling)', () => {
    const { world } = scanRoom(livingRoom(), undefined, { seed: 4 });
    const m = exportLive(world)!;
    const T = { yaw: 1.234, tx: 3.3, tz: -7.1, dj: 0 };
    const other = transformMap(m, T, { res: m.res, ny: m.ny, origin: { x: 0.0123, y: 0, z: 0.031 } });
    const back = transformMap(other, invertPose(T), m);
    let same = 0, total = 0;
    for (const c of m.chunks.values())
      for (let q = 0; q < c.occ.length; q++) {
        if (c.occ[q] <= 20) continue;
        total++;
        const j = Math.floor(q / CS2), l = q % CS2;
        const I = c.cx * CS + (l % CS), K = c.cz * CS + Math.floor(l / CS);
        // Within one voxel (resampling twice at an arbitrary angle).
        let hit = false;
        for (let dk = -1; dk <= 1 && !hit; dk++) for (let di = -1; di <= 1 && !hit; di++) if (voxelAt(back, I + di, K + dk, j) > 20) hit = true;
        if (hit) same++;
      }
    expect(same / total).toBeGreaterThan(0.97);
    expect(back.chunks.has(chunkKey(0, 0)) || back.chunks.size > 0).toBe(true);
  });
});

function sessionPair(seed: number, roomsA: number[], roomsB: number[], secondsB = 30) {
  const home = makeHome(seed);
  const A = new SimSession({ home, rooms: roomsA, seconds: 60, seed: seed * 10 + 1, noise: 'arcore' });
  while (A.step());
  const B = new SimSession({ home, rooms: roomsB, seconds: secondsB, seed: seed * 10 + 2, noise: 'arcore' });
  while (B.step());
  return { home, A, B };
}

function search(A: SimSession, B: SimSession) {
  const mA = exportLive(A.world)!, mB = exportLive(B.world)!;
  const frag = new FragmentIndex(extractFeatures(mA), new FragmentLookup(mA));
  const fB = extractFeatures(mB);
  const r = runToEnd(relocalize({ features: fB, lookup: new FragmentLookup(mB) }, frag));
  const truth = composePose(A.truth, invertPose(B.truth));
  const at = { x: (fB.bbox!.x0 + fB.bbox!.x1) / 2, z: (fB.bbox!.z0 + fB.bbox!.z1) / 2 };
  return { r, err: r.best ? poseDelta(r.best.pose, truth, at) : null };
}

describe('map persistence: relocalization', () => {
  it('finds a new session (unknown yaw and offset) in a stored map, accurately', () => {
    const { A, B } = sessionPair(3, [0, 1], [0]);
    const { r, err } = search(A, B);
    expect(r.accepted).toBe(true);
    expect(err!.dist).toBeLessThan(0.08);
    expect(err!.dyaw).toBeLessThan((1.5 * Math.PI) / 180);
  });

  it('refuses to place a session from another room', () => {
    const { A, B } = sessionPair(10, [0, 1], [2]);
    const { r } = search(A, B);
    expect(r.accepted).toBe(false);
  });

  it('refuses ambiguous placements in a symmetric room', () => {
    // An empty square room looks the same turned by 90°: no answer is right.
    const home = makeHome(5, { cols: 1, rows: 1, symmetric: true, furnish: 0 });
    const A = new SimSession({ home, rooms: [0], seconds: 40, seed: 51, noise: 'arcore' });
    while (A.step());
    const B = new SimSession({ home, rooms: [0], seconds: 30, seed: 52, noise: 'arcore' });
    while (B.step());
    const { r } = search(A, B);
    expect(r.accepted).toBe(false);
  });
});

describe('map persistence: restore, verify, undo', () => {
  it('restores a stored map into a new session and can take it back exactly', async () => {
    const home = makeHome(3);
    const kv = new MemoryKV();
    // Session A maps two rooms and saves.
    const A = new SimSession({ home, rooms: [0, 1], seconds: 60, seed: 31, noise: 'arcore' });
    const memA = new MapMemory(await MapStore.open(kv));
    await memA.load();
    memA.attach(A.world);
    while (A.step()) memA.tick(A.t, Infinity);
    await memA.flush();
    expect((await MapStore.open(kv)).list().length).toBe(1);
    // Session B, fresh frame, one of those rooms.
    const B = new SimSession({ home, rooms: [0], seconds: 40, seed: 32, noise: 'arcore' });
    let restored: { fragment: string } | null = null, changed = 0;
    const memB = new MapMemory(await MapStore.open(kv), { onRestored: (i) => (restored = i), onMapChanged: () => changed++ });
    await memB.load();
    memB.attach(B.world);
    let restoredAt = -1;
    while (B.step()) {
      memB.tick(B.t, Infinity);
      if (restored && restoredAt < 0) restoredAt = B.t;
    }
    expect(restored).not.toBeNull();
    expect(changed).toBeGreaterThan(0);
    // The restored placement is right.
    const truth = composePose(A.truth, invertPose(B.truth));
    const link = memB.links[0];
    expect(poseDelta(link.pose, truth, { x: B.world.grid!.origin.x + 6, z: B.world.grid!.origin.z + 6 }).dist).toBeLessThan(0.1);
    // The live map now covers (much) more than B saw itself.
    const own = memB.sessionEvidence()!;
    const live = exportLive(B.world)!;
    expect(knownVoxels(live)).toBeGreaterThan(knownVoxels(own) * 1.2);
    // Undo: the live grid is the session's own observations again.
    memB.undo(link, 'test');
    const after = exportLive(B.world)!;
    expect(knownVoxels(after)).toBe(knownVoxels(own));
    expect(memB.links.length).toBe(0);
  });

  it('stitches two rooms mapped in separate sessions when a third session visits both', async () => {
    const home = makeHome(3);
    const kv = new MemoryKV();
    const truths = new Map<string, ReturnType<typeof composePose>>();
    const run = async (rooms: number[], seed: number, seconds: number) => {
      const s = new SimSession({ home, rooms, seconds, seed, noise: 'arcore' });
      const mem = new MapMemory(await MapStore.open(kv), {}, { confirmAfter: 15 });
      await mem.load();
      mem.attach(s.world);
      while (s.step()) mem.tick(s.t, Infinity);
      await mem.flush();
      truths.set(mem.sessionId, s.truth);
      return { s, mem };
    };
    await run([0], 300, 50);
    await run([2], 301, 50);
    expect((await MapStore.open(kv)).list().length).toBe(2);
    // Starts in room 0, walks into room 2: finds both, confirms both, stitches.
    const { mem } = await run([0, 2], 302, 120);
    expect(mem.links.filter((l) => l.confirmed).length).toBe(2);
    const store = await MapStore.open(kv);
    expect(store.list().length).toBe(1);
    const id = store.list()[0].id;
    const m = (await store.load(id))!;
    const q = storedMapQuality(m, home.room, truths.get(id)!);
    // Both rooms, in one consistent frame: obstacles where the walls and furniture are.
    expect(q.precision).toBeGreaterThan(0.9);
    expect(q.coveredArea).toBeGreaterThan(20);
  });

  it('keeps playing when storage is broken', async () => {
    const kv = new MemoryKV();
    kv.broken = true;
    const store = await MapStore.open(kv);
    const mem = new MapMemory(store);
    await mem.load();
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    mem.attach(w);
    mem.tick(1, Infinity);
    await mem.flush();
    expect(mem.fragments.size).toBe(0);
    expect(liveLattice(w)).not.toBeNull();
  });
});
