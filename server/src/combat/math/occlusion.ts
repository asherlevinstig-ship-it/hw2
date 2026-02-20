// server/src/combat/math/occlusion.ts
import type { Vec3 } from "./vec.js";
import { sub, length, normalize, add, scale } from "./vec.js";

export type VoxelRaycastInput = {
  from: Vec3;
  to: Vec3;
  step: number;     // 0.2..0.5 recommended
  maxSteps: number; // safety
};

export type VoxelRaycastResult = {
  blocked: boolean;
  hit?: { x: number; y: number; z: number; blockId: number };
};

// Simple stepped raycast against integer voxel grid.
// If you want higher quality later, swap to true DDA.
export function voxelRaycast(
  input: VoxelRaycastInput,
  getBlockAt: (x: number, y: number, z: number) => number,
  AIR_ID: number
): VoxelRaycastResult {
  const dir = sub(input.to, input.from);
  const dist = length(dir);
  if (dist <= 1e-6) return { blocked: false };

  const step = Math.max(0.05, input.step);
  const n = normalize(dir);

  const steps = Math.min(input.maxSteps, Math.ceil(dist / step));

  for (let i = 0; i <= steps; i++) {
    const p = add(input.from, scale(n, i * step));
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);

    const id = getBlockAt(x, y, z) | 0;
    if (id !== AIR_ID && id !== 0) {
      return { blocked: true, hit: { x, y, z, blockId: id } };
    }
  }

  return { blocked: false };
}
