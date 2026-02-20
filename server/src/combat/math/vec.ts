// server/src/combat/math/vec.ts
export type Vec3 = { x: number; y: number; z: number };

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function length2(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}
export function length(v: Vec3): number {
  return Math.sqrt(length2(v));
}
export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len <= 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// yaw assumed radians; pitch radians
export function yawPitchToDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * cp,
  };
}
