// server/src/shared/structureLoader.ts
// FULL FILE - No Omits

import * as fs from "node:fs";
import * as path from "node:path";

export type BlockStructure = {
  name: string;
  size: { w: number; h: number; d: number };
  anchor: { x: number; y: number; z: number };
  blocks: Array<{ x: number; y: number; z: number; id: number }>;
};

export type StructureOp = {
  type: "fill" | "cut";
  id: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
};

export type RawStructureJSON = {
  name: string;
  size: { w: number; h: number; d: number };
  anchor: { x: number; y: number; z: number };
  blocks?: Array<{ x: number; y: number; z: number; id: number }>;
  ops?: Array<StructureOp>;
};

export function loadBlockStructure(filePath: string): BlockStructure {
  const fp = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const raw = fs.readFileSync(fp, "utf8");
  const s = JSON.parse(raw) as RawStructureJSON;

  if (!s?.size || !s?.anchor) {
    throw new Error(`Invalid block structure: ${filePath}`);
  }

  const blockMap = new Map<string, { x: number; y: number; z: number; id: number }>();

  // 1. Process explicit blocks first (if any exist in the JSON)
  if (Array.isArray(s.blocks)) {
    for (const b of s.blocks) {
      blockMap.set(`${b.x},${b.y},${b.z}`, b);
    }
  }

  // 2. Process procedural ops (fill/cut) to generate structure geometry
  if (Array.isArray(s.ops)) {
    for (const op of s.ops) {
      const minX = Math.min(op.from.x, op.to.x);
      const maxX = Math.max(op.from.x, op.to.x);
      const minY = Math.min(op.from.y, op.to.y);
      const maxY = Math.max(op.from.y, op.to.y);
      const minZ = Math.min(op.from.z, op.to.z);
      const maxZ = Math.max(op.from.z, op.to.z);

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = `${x},${y},${z}`;
            
            if (op.type === "fill") {
              blockMap.set(key, { x, y, z, id: op.id });
            } else if (op.type === "cut") {
              // A cut operation stamps an AIR block (0) to hollow out terrain
              blockMap.set(key, { x, y, z, id: 0 });
            }
          }
        }
      }
    }
  }

  return {
    name: s.name,
    size: s.size,
    anchor: s.anchor,
    blocks: Array.from(blockMap.values()),
  };
}