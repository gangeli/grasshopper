"""Convert a TUM RGB-D sequence into a compact replay file for scripts/tum-replay.ts.

Usage: python3 -I scripts/tum/prep_tum.py <sequence_dir> <out_prefix> [stride] [grid_w grid_h]
Writes <out>.bin (float32 depth frames, metres, 0 = invalid, row 0 = top) and
<out>.json (per-frame time, camera-to-world matrix in our Y-up world, intrinsics).
"""
import json, sys
import numpy as np
from PIL import Image

seq, out = sys.argv[1], sys.argv[2]
stride = int(sys.argv[3]) if len(sys.argv) > 3 else 3
GW, GH = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (80, 60)
# Freiburg 1 depth intrinsics.
fx, fy, cx, cy, W, H = 517.3, 516.5, 318.6, 255.3, 640, 480

def load_list(p):
    rows = []
    for line in open(p):
        if line.startswith('#') or not line.strip():
            continue
        rows.append(line.split())
    return rows

depth = load_list(f'{seq}/depth.txt')
gt = np.array([[float(v) for v in r] for r in load_list(f'{seq}/groundtruth.txt')])

def quat_mat(qx, qy, qz, qw):
    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ])

# TUM world is Z-up; ours is Y-up: (X, Y, Z) -> (X, Z, -Y).
R_world = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)
# OpenCV camera (x right, y down, z forward) -> OpenGL camera (x right, y up, -z forward).
F = np.diag([1.0, -1.0, -1.0])

bw, bh = W // GW, H // GH
frames, blobs = [], []
t0 = None
for i in range(0, len(depth), stride):
    ts, fn = float(depth[i][0]), depth[i][1]
    k = np.argmin(np.abs(gt[:, 0] - ts))
    if abs(gt[k, 0] - ts) > 0.02:
        continue
    tx, ty, tz, qx, qy, qz, qw = gt[k, 1:]
    Rc = quat_mat(qx, qy, qz, qw)
    M = np.eye(4)
    M[:3, :3] = R_world @ Rc @ F
    M[:3, 3] = R_world @ np.array([tx, ty, tz])
    d = np.asarray(Image.open(f'{seq}/{fn}'), dtype=np.float32) / 5000.0
    # Block median of valid pixels: a lower-resolution, smoothed sensor like a phone's.
    blocks = d[: GH * bh, : GW * bw].reshape(GH, bh, GW, bw).transpose(0, 2, 1, 3).reshape(GH, GW, bh * bw)
    blocks = np.where(blocks > 0, blocks, np.nan)
    with np.errstate(all='ignore'):
        med = np.nanmedian(blocks, axis=2)
        valid_frac = np.mean(~np.isnan(blocks), axis=2)
    med = np.where((valid_frac > 0.5) & np.isfinite(med), med, 0).astype(np.float32)
    blobs.append(med.tobytes())
    if t0 is None:
        t0 = ts
    frames.append({'t': ts - t0, 'camToWorld': M.T.reshape(-1).tolist()})

# Inverse projection for the block grid: NDC (nx, ny) -> view-space point at z = -1.
a, b = (W / 2) / fx, (W / 2 - cx) / fx
c, e = (H / 2) / fy, (cy - H / 2) / fy
inv_proj = [a, 0, 0, 0, 0, c, 0, 0, 0, 0, 0, 0, b, e, -1, 1]
open(f'{out}.bin', 'wb').write(b''.join(blobs))
json.dump({'w': GW, 'h': GH, 'invProj': inv_proj, 'frames': frames, 'source': seq}, open(f'{out}.json', 'w'))
print(f'{len(frames)} frames, {GW}x{GH}, duration {frames[-1]["t"]:.1f}s')
