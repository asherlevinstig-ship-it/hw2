import fs from "fs";
import { Schematic } from "prismarine-schematic";

export type LoadedStructure = {
  width: number;
  height: number;
  length: number;
  blocks: number[][][]; // your internal numeric IDs
};

export async function loadSchematic(
  path: string,
  blockMap: Record<string, number>
): Promise<LoadedStructure> {
  const buf = fs.readFileSync(path);
  const schem = await Schematic.read(buf);

  const width = schem.size.x;
  const height = schem.size.y;
  const length = schem.size.z;

  const blocks: number[][][] = [];

  for (let x = 0; x < width; x++) {
    blocks[x] = [];
    for (let y = 0; y < height; y++) {
      blocks[x][y] = [];
      for (let z = 0; z < length; z++) {
        const block = schem.getBlock({ x, y, z });
        const name = block?.name ?? "minecraft:air";
        blocks[x][y][z] = blockMap[name] ?? 0;
      }
    }
  }

  return { width, height, length, blocks };
}
