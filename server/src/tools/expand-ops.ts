import * as fs from "node:fs";
import * as path from "node:path";

type Vec = { x: number; y: number; z: number };
type FillOp = { type: "fill" | "cut"; id: number; from: Vec; to: Vec };

type OpsStructure = {
  name: string;
  size: { w: number; h: number; d: number };
  anchor: Vec;
  ops: FillOp[];
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function normalizeRange(from: Vec, to: Vec) {
  const x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x);
  const y0 = Math.min(from.y, to.y), y1 = Math.max(from.y, to.y);
  const z0 = Math.min(from.z, to.z), z1 = Math.max(from.z, to.z);
  return { x0, x1, y0, y1, z0, z1 };
}
// layout matches your chunk idx style: x + w*(y + h*z)
function idx(x: number, y: number, z: number, w: number, h: number) {
  return x + w * (y + h * z);
}

const inRel = process.argv[2] ?? "server/src/structures/town_hall.ops.json";
const outRel = process.argv[3] ?? "server/src/structures/town_hall.blocks.json";

const inPath = path.join(process.cwd(), inRel);
const outPath = path.join(process.cwd(), outRel);

const src = JSON.parse(fs.readFileSync(inPath, "utf8")) as OpsStructure;
if (!src?.size || !src?.anchor || !Array.isArray(src.ops)) {
  throw new Error(`Invalid ops structure: ${inRel}`);
}

const { w, h, d } = src.size;
const vox = new Uint8Array(w * h * d); // AIR default = 0

for (const op of src.ops) {
  const r = normalizeRange(op.from, op.to);
  const x0 = clamp(r.x0, 0, w - 1), x1 = clamp(r.x1, 0, w - 1);
  const y0 = clamp(r.y0, 0, h - 1), y1 = clamp(r.y1, 0, h - 1);
  const z0 = clamp(r.z0, 0, d - 1), z1 = clamp(r.z1, 0, d - 1);

  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        vox[idx(x, y, z, w, h)] = op.id & 255;
      }
    }
  }
}

const blocks: Array<{ x: number; y: number; z: number; id: number }> = [];
for (let z = 0; z < d; z++) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idv = vox[idx(x, y, z, w, h)];
      if (idv !== 0) blocks.push({ x, y, z, id: idv });
    }
  }
}

const out = {
  name: src.name,
  size: src.size,
  anchor: src.anchor,
  blocks,
};

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`✅ Expanded ops -> blocks: ${blocks.length} blocks`);
console.log(`📄 Wrote: ${outRel}`);
