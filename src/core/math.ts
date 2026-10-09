/** Tiny allocation-light vector helpers for the headless simulation (no Three.js dependency). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wrap an angle to [-PI, PI]. */
export const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
/** Frame-rate independent exponential approach. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));
export const dist2D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const dist3D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Forward direction of a heading (model faces +Z at yaw 0). */
export const forwardOf = (yaw: number): Vec3 => ({ x: Math.sin(yaw), y: 0, z: Math.cos(yaw) });
/** Right-hand direction of a heading. */
export const rightOf = (yaw: number): Vec3 => ({ x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) });
/** Heading that faces along (dx, dz). */
export const yawOf = (dx: number, dz: number): number => Math.atan2(dx, dz);
/** Wrap a distance difference along a closed loop of length L to [-L/2, L/2]. */
export const wrapDelta = (d: number, L: number): number => {
  d = d % L;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
};
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
