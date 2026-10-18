import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import type { MeshInput, PlaneInput } from '../world/WorldModel';
import type { SimRoom } from './SimRoom';

/** Pinhole camera pose. yaw=0 looks down -Z (three.js convention), pitch>0 looks up. */
export interface SimCamera {
  pos: Vec3;
  yaw: number;
  pitch: number;
  fovY: number; // radians
  aspect: number;
}

export function cameraBasis(c: SimCamera) {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const forward = { x: -sy * cp, y: sp, z: -cy * cp };
  const right = { x: cy, y: 0, z: -sy };
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };
  return { forward, right, up };
}

/** Project a world point; returns NDC (x,y ∈ [-1,1] when in view) and depth along forward. */
export function projectPoint(c: SimCamera, p: Vec3) {
  const { forward, right, up } = cameraBasis(c);
  const d = { x: p.x - c.pos.x, y: p.y - c.pos.y, z: p.z - c.pos.z };
  const z = d.x * forward.x + d.y * forward.y + d.z * forward.z;
  const x = d.x * right.x + d.y * right.y + d.z * right.z;
  const y = d.x * up.x + d.y * up.y + d.z * up.z;
  const t = Math.tan(c.fovY / 2);
  return { x: x / (z * t * c.aspect), y: y / (z * t), depth: z };
}

export function inFrustum(c: SimCamera, p: Vec3, margin = 1): boolean {
  const q = projectPoint(c, p);
  return q.depth > 0.05 && Math.abs(q.x) <= margin && Math.abs(q.y) <= margin;
}

export interface SensorCaps {
  depth: boolean;
  planes: boolean;
  mesh: boolean;
}

export class SimSensor {
  private rng: Rng;
  private detectedPlanes = new Map<string, PlaneInput>();
  private allPlanes: PlaneInput[];
  constructor(readonly room: SimRoom, readonly caps: SensorCaps = { depth: true, planes: true, mesh: false }, seed = 7, readonly depthNoise = 0.01) {
    this.rng = new Rng(seed);
    this.allPlanes = buildPlanes(room);
  }

  /**
   * A low-res depth image like ARCore's, turned into world points.
   * Points beyond maxRange are returned at their true position; the world
   * model clips them to free-space rays.
   */
  depthPoints(cam: SimCamera, w = 40, h = 30, maxRange = 5): Vec3[] {
    const { forward, right, up } = cameraBasis(cam);
    const t = Math.tan(cam.fovY / 2);
    const pts: Vec3[] = [];
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const nx = ((px + this.rng.next()) / w) * 2 - 1, ny = ((py + this.rng.next()) / h) * 2 - 1;
        const dx = forward.x + right.x * nx * t * cam.aspect + up.x * ny * t;
        const dy = forward.y + right.y * nx * t * cam.aspect + up.y * ny * t;
        const dz = forward.z + right.z * nx * t * cam.aspect + up.z * ny * t;
        const l = Math.hypot(dx, dy, dz);
        const d = { x: dx / l, y: dy / l, z: dz / l };
        const hit = this.room.raycast(cam.pos, d, maxRange * 1.5);
        let dist = Number.isFinite(hit.t) ? hit.t : maxRange * 1.5;
        dist *= 1 + this.gauss() * this.depthNoise;
        pts.push({ x: cam.pos.x + d.x * dist, y: cam.pos.y + d.y * dist, z: cam.pos.z + d.z * dist });
      }
    return pts;
  }

  /** Planes become "detected" once part of them has been seen; they then persist. */
  planes(cam: SimCamera): PlaneInput[] {
    for (const p of this.allPlanes) {
      if (this.detectedPlanes.has(p.id)) continue;
      const samples = planeSamples(p);
      let seen = 0;
      for (const s of samples) {
        const lifted = { x: s.x + p.normal.x * 0.01, y: s.y + p.normal.y * 0.01, z: s.z + p.normal.z * 0.01 };
        if (inFrustum(cam, lifted, 0.95) && this.room.visible(cam.pos, lifted)) seen++;
      }
      if (seen >= 2) this.detectedPlanes.set(p.id, p);
    }
    return [...this.detectedPlanes.values()];
  }

  /** Full scene mesh, as delivered by headsets that have a room scan. */
  meshes(): MeshInput[] {
    const W = this.room.halfW, D = this.room.halfD;
    const floor: MeshInput = { id: 'meshFloor', positions: [-W, 0, -D, W, 0, -D, W, 0, D, -W, 0, D], indices: [0, 2, 1, 0, 3, 2], label: 'floor' };
    return [floor, ...this.room.pieces.map((pc) => {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const b of pc.boxes) {
        const base = positions.length / 3;
        const xs = [b.min.x, b.max.x], ys = [b.min.y, b.max.y], zs = [b.min.z, b.max.z];
        for (let c = 0; c < 8; c++) positions.push(xs[c & 1], ys[(c >> 1) & 1], zs[(c >> 2) & 1]);
        const quads = [
          [0, 1, 3, 2],
          [4, 6, 7, 5],
          [0, 4, 5, 1],
          [2, 3, 7, 6],
          [0, 2, 6, 4],
          [1, 5, 7, 3],
        ];
        const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
        const P = (q: number) => [positions[(base + q) * 3], positions[(base + q) * 3 + 1], positions[(base + q) * 3 + 2]];
        for (const [a, b2, c, d] of quads) {
          // Orient each face outward (CCW seen from outside).
          const [ax, ay, az] = P(a), [bx, by, bz] = P(b2), [qx, qy, qz] = P(c);
          const nx = (by - ay) * (qz - az) - (bz - az) * (qy - ay);
          const ny = (bz - az) * (qx - ax) - (bx - ax) * (qz - az);
          const nz = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
          const out = nx * (ax - cx) + ny * (ay - cy) + nz * (az - cz) > 0;
          if (out) indices.push(base + a, base + b2, base + c, base + a, base + c, base + d);
          else indices.push(base + a, base + c, base + b2, base + a, base + d, base + c);
        }
      }
      return { id: `mesh${pc.id}`, positions, indices, label: pc.label };
    })];
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rng.next()), v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function planeSamples(p: PlaneInput): Vec3[] {
  const c = p.polygon;
  const out: Vec3[] = [];
  // Polygons here are rectangles: bilinear 4x4 samples.
  for (let a = 0.1; a < 1; a += 0.27)
    for (let b = 0.1; b < 1; b += 0.27) {
      const p0 = lerp3(c[0], c[1], a), p1 = lerp3(c[3], c[2], a);
      out.push(lerp3(p0, p1, b));
    }
  return out;
}
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Derive the planes a plane-detector would find: floor, raised tops, wall faces. */
export function buildPlanes(room: SimRoom): PlaneInput[] {
  const planes: PlaneInput[] = [];
  const W = room.halfW, D = room.halfD;
  planes.push({
    id: 'floor',
    polygon: [
      { x: -W, y: 0, z: -D },
      { x: W, y: 0, z: -D },
      { x: W, y: 0, z: D },
      { x: -W, y: 0, z: D },
    ],
    normal: { x: 0, y: 1, z: 0 },
    label: 'floor',
  });
  room.boxes.forEach((b, idx) => {
    const pc = room.pieces[b.piece];
    const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    if (pc.label !== 'wall' && b.max.y > 0.1 && area > 0.08) {
      // Top face unless something sits right on top of it.
      const covered = room.boxes.some((o) => o !== b && Math.abs(o.min.y - b.max.y) < 0.01 && o.min.x <= b.min.x + 0.01 && o.max.x >= b.max.x - 0.01 && o.min.z <= b.min.z + 0.01 && o.max.z >= b.max.z - 0.01);
      if (!covered)
        planes.push({
          id: `top${idx}`,
          polygon: [
            { x: b.min.x, y: b.max.y, z: b.min.z },
            { x: b.max.x, y: b.max.y, z: b.min.z },
            { x: b.max.x, y: b.max.y, z: b.max.z },
            { x: b.min.x, y: b.max.y, z: b.max.z },
          ],
          normal: { x: 0, y: 1, z: 0 },
          label: pc.label === 'table' || pc.label === 'bed' ? pc.label : undefined,
        });
    }
    if (pc.label === 'wall' || pc.label === 'bookshelf') {
      // Inner vertical faces facing the room centre.
      const faces: [Vec3, Vec3[]][] = [];
      const y0 = b.min.y, y1 = b.max.y;
      if (b.max.x <= -W + 1e-3 || (pc.label === 'bookshelf' && b.max.x < 0))
        faces.push([{ x: 1, y: 0, z: 0 }, [{ x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.max.x, y: y1, z: b.min.z }]]);
      if (b.min.x >= W - 1e-3 || (pc.label === 'bookshelf' && b.min.x > 0))
        faces.push([{ x: -1, y: 0, z: 0 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.min.x, y: y0, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
      if (b.max.z <= -D + 1e-3 || (pc.label === 'bookshelf' && b.max.z < 0))
        faces.push([{ x: 0, y: 0, z: 1 }, [{ x: b.min.x, y: y0, z: b.max.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }]]);
      if (b.min.z >= D - 1e-3 || (pc.label === 'bookshelf' && b.min.z > 0))
        faces.push([{ x: 0, y: 0, z: -1 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y1, z: b.min.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
      faces.forEach(([normal, polygon], f) => planes.push({ id: `wall${idx}_${f}`, polygon, normal, label: pc.label === 'wall' ? 'wall' : undefined }));
    }
  });
  return planes;
}
