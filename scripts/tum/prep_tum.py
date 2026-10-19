"""Convert a TUM RGB-D sequence into a compact replay file for scripts/tum-replay.ts.

Usage: python3 -I scripts/tum/prep_tum.py <sequence_dir> <out_prefix> [stride] [grid_w grid_h] [--rgb]
Writes <out>.bin (float32 depth frames, metres, 0 = invalid, row 0 = top) and
<out>.json (per-frame time, camera-to-world matrix in our Y-up world, intrinsics).
With --rgb also writes, per frame, the nearest colour image as 160x120 8-bit
grey (<out>.gray) and the Kinect depth at that resolution (<out>.d160, float32)
for evaluating depth-from-motion on the real camera images. TUM depth is
registered to the colour camera, so both share the colour intrinsics.
"""
import json, sys
import numpy as np
from PIL import Image

want_rgb = '--rgb' in sys.argv
argv = [a for a in sys.argv if a != '--rgb']
seq, out = argv[1], argv[2]
stride = int(argv[3]) if len(argv) > 3 else 3
GW, GH = (int(argv[4]), int(argv[5])) if len(argv) > 5 else (80, 60)
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
rgb = load_list(f'{seq}/rgb.txt') if want_rgb else []
rgb_t = np.array([float(r[0]) for r in rgb]) if want_rgb else None
grays, d160s, rgb_dt, rgb_pose, rgb_time = [], [], [], [], []
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
# Freiburg 1 colour camera distortion (TUM calibration): for each undistorted
# pixel, where to sample in the distorted image.
k1, k2, p1, p2, k3 = 0.262383, -0.953104, -0.005358, 0.002628, 1.163314
uu, vv = np.meshgrid(np.arange(W) + 0.0, np.arange(H) + 0.0)
xn, yn = (uu - cx) / fx, (vv - cy) / fy
r2 = xn * xn + yn * yn
rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 ** 3
xd = xn * rad + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn)
yd = yn * rad + p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn
UMAP_X, UMAP_Y = xd * fx + cx, yd * fy + cy
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
    if want_rgb:
        j = int(np.argmin(np.abs(rgb_t - ts)))
        rgb_dt.append(float(rgb_t[j] - ts))
        # Ground-truth pose at the colour image's own timestamp (mocap at 100Hz, interpolated).
        tr = rgb_t[j]
        k1 = int(np.searchsorted(gt[:, 0], tr))
        k0 = max(0, k1 - 1); k1 = min(len(gt) - 1, k1)
        u = 0.0 if gt[k1, 0] == gt[k0, 0] else (tr - gt[k0, 0]) / (gt[k1, 0] - gt[k0, 0])
        p0, p1 = gt[k0, 1:4], gt[k1, 1:4]
        q0, q1 = gt[k0, 4:8], gt[k1, 4:8]
        if np.dot(q0, q1) < 0: q1 = -q1
        q = q0 * (1 - u) + q1 * u; q /= np.linalg.norm(q)
        Mr = np.eye(4)
        Mr[:3, :3] = R_world @ quat_mat(*q) @ F
        Mr[:3, 3] = R_world @ (p0 * (1 - u) + p1 * u)
        rgb_pose.append(Mr.T.reshape(-1).tolist())
        rgb_time.append(float(tr))
        g = np.asarray(Image.open(f'{seq}/{rgb[j][1]}').convert('L'), dtype=np.float32)
        # Undistort (phones hand apps rectified images), then 4x4 box-downsample.
        x0, y0 = np.floor(UMAP_X).astype(int), np.floor(UMAP_Y).astype(int)
        ax, ay = UMAP_X - x0, UMAP_Y - y0
        x0c, y0c = np.clip(x0, 0, 638), np.clip(y0, 0, 478)
        und = (g[y0c, x0c] * (1 - ax) * (1 - ay) + g[y0c, x0c + 1] * ax * (1 - ay) + g[y0c + 1, x0c] * (1 - ax) * ay + g[y0c + 1, x0c + 1] * ax * ay)
        small = und.reshape(120, 4, 160, 4).mean(axis=(1, 3))
        grays.append(np.clip(np.round(small), 0, 255).astype(np.uint8).tobytes())
        b4 = d[:480, :640].reshape(120, 4, 160, 4).transpose(0, 2, 1, 3).reshape(120, 160, 16)
        b4 = np.where(b4 > 0, b4, np.nan)
        with np.errstate(all='ignore'):
            m4 = np.nanmedian(b4, axis=2)
        d160s.append(np.where(np.isfinite(m4), m4, 0).astype(np.float32).tobytes())
    if t0 is None:
        t0 = ts
    frames.append({'t': ts - t0, 'camToWorld': M.T.reshape(-1).tolist()})

# Inverse projection for the block grid: NDC (nx, ny) -> view-space point at z = -1.
a, b = (W / 2) / fx, (W / 2 - cx) / fx
c, e = (H / 2) / fy, (cy - H / 2) / fy
inv_proj = [a, 0, 0, 0, 0, c, 0, 0, 0, 0, 0, 0, b, e, -1, 1]
open(f'{out}.bin', 'wb').write(b''.join(blobs))
meta = {'w': GW, 'h': GH, 'invProj': inv_proj, 'frames': frames, 'source': seq}
if want_rgb:
    open(f'{out}.gray', 'wb').write(b''.join(grays))
    open(f'{out}.d160', 'wb').write(b''.join(d160s))
    meta['rgb'] = {'w': 160, 'h': 120, 'fx': fx / 4, 'fy': fy / 4, 'cx': cx / 4, 'cy': cy / 4, 'dt': rgb_dt, 'poses': rgb_pose, 't': [x - rgb_time[0] for x in rgb_time]}
json.dump(meta, open(f'{out}.json', 'w'))
print(f'{len(frames)} frames, {GW}x{GH}, duration {frames[-1]["t"]:.1f}s')
