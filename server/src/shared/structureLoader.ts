// server/src/shared/structureLoader.ts
import * as fs from "node:fs";
import * as path from "node:path";

export type BlockStructure = {
  name: string;
  size: { w: number; h: number; d: number };
  anchor: { x: number; y: number; z: number };
  blocks: Array<{ x: number; y: number; z: number; id: number }>;
};

export function loadBlockStructure(filePath: string): BlockStructure {
  // ✅ if caller passed an absolute path, keep it; otherwise resolve relative to cwd
  const fp = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const raw = fs.readFileSync(fp, "utf8");
  const s = JSON.parse(raw) as BlockStructure;

  if (!s?.size || !s?.anchor || !Array.isArray(s.blocks)) {
    throw new Error(`Invalid block structure: ${filePath}`);
  }
  return s;
}