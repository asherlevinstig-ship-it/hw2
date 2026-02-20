// server/src/combat/math/cone.ts
import { dot, normalize, sub, type Vec3 } from "./vec.js";
import type { CombatSnapshot, EntityId } from "../CombatSystem.js";
import { clamp01 } from "./curves.js";

export type ConeQueryInput = {
  origin: Vec3;     // attacker eye
  dir: Vec3;        // forward
  range: number;    // max distance
  arcDeg: number;   // full arc, e.g. 70
  maxTargets: number;
  includeSelf: boolean;
};

// Returns target ids ordered by distance ascending
export function coneQuery(input: ConeQueryInput, entities: CombatSnapshot[]): EntityId[] {
  const o = input.origin;
  const d = normalize(input.dir);
  const r2 = Math.max(0.01, input.range) ** 2;

  // precompute cos half-angle
  const half = (Math.max(1, input.arcDeg) * Math.PI) / 180 / 2;
  const cosHalf = Math.cos(half);

  const scored: Array<{ id: EntityId; dist2: number }> = [];

  for (const e of entities) {
    if (!input.includeSelf && e.id === ("" as any)) {
      // note: caller filters self; we keep cone pure
    }

    const center = { x: e.pos.x, y: e.pos.y + e.height * 0.55, z: e.pos.z };
    const v = sub(center, o);

    const dist2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (dist2 > r2) continue;

    const vn = normalize(v);
    const c = dot(d, vn);

    // within arc
    if (c < cosHalf) continue;

    scored.push({ id: e.id, dist2 });
  }

  scored.sort((a, b) => a.dist2 - b.dist2);
  return scored.slice(0, Math.max(1, input.maxTargets)).map((s) => s.id);
}
