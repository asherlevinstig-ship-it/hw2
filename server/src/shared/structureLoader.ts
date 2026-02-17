import * as fs from "node:fs";
import * as path from "node:path";

export type BlockStructure = {
  name: string;
  size: { w: number; h: number; d: number };
  anchor: { x: number; y: number; z: number };
  blocks: Array<{ x: number; y: number; z: number; id: number }>;
};

export function loadBlockStructure(relPath: string): BlockStructure {
  const abs = path.join(process.cwd(), relPath);
  const raw = fs.readFileSync(abs, "utf8");
  const s = JSON.parse(raw) as BlockStructure;

  if (!s?.size || !s?.anchor || !Array.isArray(s.blocks)) {
    throw new Error(`Invalid block structure: ${relPath}`);
  }
  return s;
}
