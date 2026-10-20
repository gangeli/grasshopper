/**
 * Rigid 2D transforms about the vertical axis (yaw + x/z shift), plus an
 * integer layer shift: what separates two sessions' map frames once both
 * floors are known. Convention: apply(T, p) = R(yaw)·p + t with
 *   x' = cos·x − sin·z + tx,   z' = sin·x + cos·z + tz.
 */
export interface Pose2 {
  yaw: number;
  tx: number;
  tz: number;
  /** Vertical shift in layers (floor-relative maps: usually 0). */
  dj?: number;
}

export const IDENTITY: Pose2 = { yaw: 0, tx: 0, tz: 0, dj: 0 };

export function applyPose(T: Pose2, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  return { x: c * x - s * z + T.tx, z: s * x + c * z + T.tz };
}

/** A∘B: first B, then A. */
export function composePose(A: Pose2, B: Pose2): Pose2 {
  const c = Math.cos(A.yaw), s = Math.sin(A.yaw);
  return { yaw: wrapAngle(A.yaw + B.yaw), tx: c * B.tx - s * B.tz + A.tx, tz: s * B.tx + c * B.tz + A.tz, dj: (A.dj ?? 0) + (B.dj ?? 0) };
}

export function invertPose(T: Pose2): Pose2 {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  // p = R⁻¹(p' − t)
  return { yaw: wrapAngle(-T.yaw), tx: -(c * T.tx + s * T.tz), tz: -(-s * T.tx + c * T.tz), dj: -(T.dj ?? 0) };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Distance between two poses: translation (m) of a point at `at` and yaw difference (rad). */
export function poseDelta(A: Pose2, B: Pose2, at = { x: 0, z: 0 }): { dist: number; dyaw: number } {
  const a = applyPose(A, at.x, at.z), b = applyPose(B, at.x, at.z);
  return { dist: Math.hypot(a.x - b.x, a.z - b.z), dyaw: Math.abs(wrapAngle(A.yaw - B.yaw)) };
}

/**
 * The Pose2 equivalent of a column-major 4x4 rigid transform that only
 * rotates about +y (e.g. a WebXR / three.js matrix): x' = m0·x + m8·z + m12,
 * z' = m2·x + m10·z + m14.
 */
export function poseFromMatrix(m: ArrayLike<number>): Pose2 {
  // m0 = cos, m2 = sin under our convention (z' = sin·x + ...).
  return { yaw: Math.atan2(m[2], m[0]), tx: m[12], tz: m[14], dj: 0 };
}

export function poseToMatrix(T: Pose2, dy = 0): number[] {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, T.tx, dy, T.tz, 1];
}

export function isFinitePose(T: Pose2): boolean {
  return Number.isFinite(T.yaw) && Number.isFinite(T.tx) && Number.isFinite(T.tz);
}
