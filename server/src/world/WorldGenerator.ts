// server/src/world/WorldGenerator.ts
// FULL FILE - No Omits

import { type BlockStructure } from "../shared/structureLoader.js";

export interface WorldGenConfig {
  worldSeed: number;
  chunkSize: number;
  baseHeight: number;
  TOWN_CENTER_X: number;
  TOWN_CENTER_Z: number;
  SAFE_RADIUS: number;
  TOWN_PLAZA_RADIUS: number;
  TOWN_RING_RADIUS: number;
  TOWN_PATH_HALF_W: number;
  TOWN_CLEAR_HEIGHT: number;
  townHall: BlockStructure | null;
  
  AIR_ID: number;
  GRASS_ID: number;
  DIRT_ID: number;
  STONE_ID: number;
  WOOD_ID: number;
  LEAVES_ID: number;
  BEDROCK_ID: number;
  CHEST_ID: number;
  COAL_ORE_ID: number;
  IRON_ORE_ID: number;
  GOLD_ORE_ID: number;
  DIAMOND_ORE_ID: number;
  SAND_ID: number;
  SNOW_ID: number;
  DEEPSLATE_ID: number;
  TUFF_ID: number;
  MOSS_ID: number;
  MOSSY_STONE_ID: number;
  DRIPSTONE_ID: number;
  DRIPSTONE_BLOCK_ID: number;
  GLOW_SHROOM_ID: number;
  CRYSTAL_ID: number;
  PLANKS_ID: number;
  STONE_BRICKS_ID: number;
  CARPET_ID: number;
  GLASS_ID: number;
  LANTERN_ID: number;
}

type CaveBiome = "LUSH" | "DRIPSTONE" | "DEEP_DARKISH" | "CRYSTAL" | "TUFFY";

type OreDef = {
  id: number;
  minY: number;
  peakY: number;
  maxY: number;
  baseChance: number;
  veinSize: [number, number];
};

type PoiType = "HUT";
type PoiTier = "COMMON" | "RARE" | "LEGENDARY";

type PoiCandidate = {
  exists: boolean;
  rx: number;
  rz: number;
  x0: number;
  y0: number;
  z0: number;
  rot: 0 | 90 | 180 | 270;
  tier: PoiTier;
  type: PoiType;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type StampOp = { dx: number; dy: number; dz: number; id: number };

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function toInt(n: number): number {
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export class WorldGenerator {
  private cfg: WorldGenConfig;

  private readonly BIOME_FOREST = 1;
  private readonly BIOME_DESERT = 2;
  private readonly BIOME_SNOW = 3;

  private readonly REGION_SIZE = 128;
  private readonly POI_CHANCE = 0.13;
  private readonly POI_EDGE_PAD = 16;

  private readonly ORES: OreDef[];
  private readonly CaveBiomeRules: Record<CaveBiome, { wall: number; floor: number; ceil: number; deco?: { chance: number; place: (ctx: { x: number; y: number; z: number; rand: () => number }) => number | null; }[]; }>;

  constructor(cfg: WorldGenConfig) {
    this.cfg = cfg;

    this.ORES = [
      { id: cfg.COAL_ORE_ID, minY: 15, peakY: 45, maxY: 90, baseChance: 0.06, veinSize: [6, 14] },
      { id: cfg.IRON_ORE_ID, minY: 10, peakY: 28, maxY: 70, baseChance: 0.05, veinSize: [4, 10] },
      { id: cfg.GOLD_ORE_ID, minY: 5, peakY: 16, maxY: 35, baseChance: 0.025, veinSize: [3, 8] },
      { id: cfg.DIAMOND_ORE_ID, minY: -10, peakY: 5, maxY: 18, baseChance: 0.012, veinSize: [2, 6] },
    ];

    this.CaveBiomeRules = {
      LUSH: {
        wall: cfg.MOSSY_STONE_ID,
        floor: cfg.MOSS_ID,
        ceil: cfg.MOSSY_STONE_ID,
        deco: [{ chance: 0.03, place: ({ rand }) => (rand() < 0.5 ? cfg.GLOW_SHROOM_ID : null) }],
      },
      DRIPSTONE: {
        wall: cfg.DRIPSTONE_BLOCK_ID,
        floor: cfg.DRIPSTONE_BLOCK_ID,
        ceil: cfg.DRIPSTONE_BLOCK_ID,
        deco: [{ chance: 0.06, place: ({ rand }) => (rand() < 0.7 ? cfg.DRIPSTONE_ID : null) }],
      },
      DEEP_DARKISH: {
        wall: cfg.DEEPSLATE_ID,
        floor: cfg.DEEPSLATE_ID,
        ceil: cfg.DEEPSLATE_ID,
      },
      CRYSTAL: {
        wall: cfg.STONE_ID,
        floor: cfg.STONE_ID,
        ceil: cfg.STONE_ID,
        deco: [{ chance: 0.02, place: ({ rand }) => (rand() < 0.8 ? cfg.CRYSTAL_ID : null) }],
      },
      TUFFY: {
        wall: cfg.TUFF_ID,
        floor: cfg.TUFF_ID,
        ceil: cfg.TUFF_ID,
      },
    };
  }

  private idx(i: number, j: number, k: number): number {
    const CS = this.cfg.chunkSize;
    return i + CS * (j + CS * k);
  }

  private hash3i(x: number, y: number, z: number): number {
    const seed = this.cfg.worldSeed | 0;
    let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  private hash2i(x: number, z: number, salt = 0): number {
    const seed = (this.cfg.worldSeed + (salt | 0)) | 0;
    let h = x * 374761393 + z * 668265263 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  private smoothstep(t: number): number { return t * t * (3 - 2 * t); }

  private valueNoise2(x: number, z: number, cellSize: number, salt = 0): number {
    const cx = floorDiv(x, cellSize); const cz = floorDiv(z, cellSize);
    const fx = (x - cx * cellSize) / cellSize; const fz = (z - cz * cellSize) / cellSize;
    const sx = this.smoothstep(clamp(fx, 0, 1)); const sz = this.smoothstep(clamp(fz, 0, 1));

    const v00 = this.hash2i(cx, cz, salt); const v10 = this.hash2i(cx + 1, cz, salt);
    const v01 = this.hash2i(cx, cz + 1, salt); const v11 = this.hash2i(cx + 1, cz + 1, salt);

    const ix0 = v00 + (v10 - v00) * sx; const ix1 = v01 + (v11 - v01) * sx;
    return ix0 + (ix1 - ix0) * sz;
  }

  private fbm2(x: number, z: number, baseCell: number, octaves: number, salt = 0): number {
    let sum = 0; let amp = 1; let norm = 0; let cell = baseCell;
    for (let i = 0; i < octaves; i++) {
      const n = this.valueNoise2(x, z, Math.max(4, cell), salt + i * 1013);
      sum += n * amp; norm += amp; amp *= 0.5; cell = Math.floor(cell * 0.5);
    }
    return norm > 0 ? sum / norm : 0.5;
  }

  private valueNoise3(x: number, y: number, z: number, cellSize: number, salt = 0): number {
    const cx = floorDiv(x, cellSize); const cy = floorDiv(y, cellSize); const cz = floorDiv(z, cellSize);
    const fx = (x - cx * cellSize) / cellSize; const fy = (y - cy * cellSize) / cellSize; const fz = (z - cz * cellSize) / cellSize;
    const sx = this.smoothstep(clamp(fx, 0, 1)); const sy = this.smoothstep(clamp(fy, 0, 1)); const sz = this.smoothstep(clamp(fz, 0, 1));
    const h = (ix: number, iy: number, iz: number) => this.hash3i(ix, iy, iz + salt);

    const v000 = h(cx, cy, cz); const v100 = h(cx + 1, cy, cz); const v010 = h(cx, cy + 1, cz); const v110 = h(cx + 1, cy + 1, cz);
    const v001 = h(cx, cy, cz + 1); const v101 = h(cx + 1, cy, cz + 1); const v011 = h(cx, cy + 1, cz + 1); const v111 = h(cx + 1, cy + 1, cz + 1);

    const ix00 = v000 + (v100 - v000) * sx; const ix10 = v010 + (v110 - v010) * sx;
    const ix01 = v001 + (v101 - v001) * sx; const ix11 = v011 + (v111 - v011) * sx;
    const iy0 = ix00 + (ix10 - ix00) * sy; const iy1 = ix01 + (ix11 - ix01) * sy;
    return iy0 + (iy1 - iy0) * sz;
  }

  private fbm3(x: number, y: number, z: number, baseCell: number, octaves: number, salt = 0): number {
    let sum = 0; let amp = 1; let norm = 0; let cell = baseCell;
    for (let i = 0; i < octaves; i++) {
      const n = this.valueNoise3(x, y, z, Math.max(4, cell), salt + i * 1013);
      sum += n * amp; norm += amp; amp *= 0.5; cell = Math.floor(cell * 0.5);
    }
    return norm > 0 ? sum / norm : 0.5;
  }

  public isInSafeZoneXZ(worldX: number, worldZ: number): boolean {
    const dx = worldX - this.cfg.TOWN_CENTER_X; 
    const dz = worldZ - this.cfg.TOWN_CENTER_Z;
    return dx * dx + dz * dz <= this.cfg.SAFE_RADIUS * this.cfg.SAFE_RADIUS;
  }

  private getBiome(worldX: number, worldZ: number): number {
    if (this.isInSafeZoneXZ(worldX, worldZ)) return this.BIOME_FOREST;
    const temp = this.fbm2(worldX, worldZ, 320, 3, 10000);
    const moist = this.fbm2(worldX, worldZ, 260, 3, 20000);
    if (temp < 0.36) return this.BIOME_SNOW;
    if (temp > 0.66 && moist < 0.46) return this.BIOME_DESERT;
    return this.BIOME_FOREST;
  }

  public heightAt(worldX: number, worldZ: number): number {
    const biome = this.getBiome(worldX, worldZ);
    const macro = Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6;
    if (biome === this.BIOME_DESERT) return this.cfg.baseHeight + Math.floor(macro * 0.45 + Math.sin(worldX / 34) * 2 + Math.cos(worldZ / 31) * 2);
    if (biome === this.BIOME_SNOW) return this.cfg.baseHeight + 4 + Math.floor(macro * 0.85 + (Math.sin(worldX / 22) * 4 + Math.cos(worldZ / 19) * 4) * 0.75);
    return this.cfg.baseHeight + Math.floor(macro * 0.9);
  }

  private shouldPlaceTreeAt(worldX: number, worldZ: number, biome: number): boolean {
    if (this.isInSafeZoneXZ(worldX, worldZ)) return false;
    if (biome === this.BIOME_DESERT) return false;
    const cell = biome === this.BIOME_FOREST ? 6 : 9;
    const r = this.hash2i(floorDiv(worldX, cell), floorDiv(worldZ, cell), 33333);
    if (biome === this.BIOME_FOREST) return r > 0.73;
    if (biome === this.BIOME_SNOW) return r > 0.88;
    return false;
  }

  private treeHeight(worldX: number, worldZ: number, biome: number): number {
    const r = this.hash2i(worldX, worldZ, 44444);
    if (biome === this.BIOME_SNOW) return 6 + Math.floor(r * 4);
    return 4 + Math.floor(r * 3);
  }

  private poiCandidateForRegion(rx: number, rz: number): PoiCandidate {
    const regionSize = this.REGION_SIZE;
    const roll = this.hash2i(rx, rz, 70001);
    if (roll >= this.POI_CHANCE) return { exists: false, rx, rz, x0: 0, y0: 0, z0: 0, rot: 0, tier: "COMMON", type: "HUT", minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1 };

    const type: PoiType = "HUT";
    const tierRoll = this.hash2i(rx, rz, 70003);
    const tier: PoiTier = tierRoll < 0.84 ? "COMMON" : tierRoll < 0.97 ? "RARE" : "LEGENDARY";
    const rotRoll = this.hash2i(rx, rz, 70004);
    const rot: 0 | 90 | 180 | 270 = rotRoll < 0.25 ? 0 : rotRoll < 0.5 ? 90 : rotRoll < 0.75 ? 180 : 270;

    const pad = this.POI_EDGE_PAD;
    const ox = pad + Math.floor(this.hash2i(rx, rz, 70005) * (regionSize - pad * 2));
    const oz = pad + Math.floor(this.hash2i(rx, rz, 70006) * (regionSize - pad * 2));
    const worldX = rx * regionSize + ox; const worldZ = rz * regionSize + oz;

    if (this.isInSafeZoneXZ(worldX, worldZ)) return { exists: false, rx, rz, x0: 0, y0: 0, z0: 0, rot: 0, tier: "COMMON", type: "HUT", minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1 };

    const y0 = this.heightAt(worldX, worldZ) + 1;
    const dims = this.poiDims(type, tier);
    return { exists: true, rx, rz, x0: worldX, y0, z0: worldZ, rot, tier, type, minX: worldX, minY: y0, minZ: worldZ, maxX: worldX + dims.w - 1, maxY: y0 + dims.h - 1, maxZ: worldZ + dims.d - 1 };
  }

  private poiDims(type: PoiType, tier: PoiTier): { w: number; h: number; d: number } {
    if (type === "HUT") {
      if (tier === "LEGENDARY") return { w: 11, h: 7, d: 11 };
      if (tier === "RARE") return { w: 9, h: 6, d: 9 };
      return { w: 7, h: 5, d: 7 };
    }
    return { w: 7, h: 5, d: 7 };
  }

  private poiOps(type: PoiType, tier: PoiTier): StampOp[] {
    const ops: StampOp[] = [];
    const wood = this.cfg.PLANKS_ID; const stone = this.cfg.STONE_BRICKS_ID; const leaves = this.cfg.LEAVES_ID;

    if (type === "HUT") {
      const dims = this.poiDims(type, tier);
      const w = dims.w, d = dims.d, h = dims.h;

      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) ops.push({ dx: x, dy: 0, dz: z, id: stone });
      for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) { ops.push({ dx: x, dy: y, dz: 0, id: wood }); ops.push({ dx: x, dy: y, dz: d - 1, id: wood }); }
        for (let z = 0; z < d; z++) { ops.push({ dx: 0, dy: y, dz: z, id: wood }); ops.push({ dx: w - 1, dy: y, dz: z, id: wood }); }
      }
      const roofY = h - 1;
      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) ops.push({ dx: x, dy: roofY, dz: z, id: leaves });

      const doorX = Math.floor(w / 2);
      return ops.filter((o) => !(o.id === wood && o.dz === 0 && o.dx === doorX && (o.dy === 1 || o.dy === 2)));
    }
    return [];
  }

  private rotateLocal(dx: number, dz: number, w: number, d: number, rot: 0 | 90 | 180 | 270): { rx: number; rz: number } {
    if (rot === 0) return { rx: dx, rz: dz };
    if (rot === 90) return { rx: d - 1 - dz, rz: dx };
    if (rot === 180) return { rx: w - 1 - dx, rz: d - 1 - dz };
    return { rx: dz, rz: w - 1 - dx };
  }

  private stampPoiIntoChunk(vox: Uint8Array, cx: number, cy: number, cz: number): void {
    const CS = this.cfg.chunkSize;
    const chunkMinX = cx * CS; const chunkMinY = cy * CS; const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1; const chunkMaxY = chunkMinY + CS - 1; const chunkMaxZ = chunkMinZ + CS - 1;
    const regMinX = floorDiv(chunkMinX, this.REGION_SIZE); const regMaxX = floorDiv(chunkMaxX, this.REGION_SIZE);
    const regMinZ = floorDiv(chunkMinZ, this.REGION_SIZE); const regMaxZ = floorDiv(chunkMaxZ, this.REGION_SIZE);

    for (let rx = regMinX; rx <= regMaxX; rx++) {
      for (let rz = regMinZ; rz <= regMaxZ; rz++) {
        const poi = this.poiCandidateForRegion(rx, rz);
        if (!poi.exists) continue;
        if (poi.maxX < chunkMinX || poi.minX > chunkMaxX || poi.maxY < chunkMinY || poi.minY > chunkMaxY || poi.maxZ < chunkMinZ || poi.minZ > chunkMaxZ) continue;

        const dims = this.poiDims(poi.type, poi.tier);
        const ops = this.poiOps(poi.type, poi.tier);

        for (const op of ops) {
          const rotPos = this.rotateLocal(op.dx, op.dz, dims.w, dims.d, poi.rot);
          const wx = poi.x0 + rotPos.rx; const wy = poi.y0 + op.dy; const wz = poi.z0 + rotPos.rz;

          if (wx < chunkMinX || wx > chunkMaxX || wy < chunkMinY || wy > chunkMaxY || wz < chunkMinZ || wz > chunkMaxZ) continue;
          const ii = this.idx(wx - chunkMinX, wy - chunkMinY, wz - chunkMinZ);
          if (vox[ii] === this.cfg.BEDROCK_ID || op.id === this.cfg.AIR_ID) continue;
          vox[ii] = clamp(toInt(op.id), 0, 255);
        }
      }
    }
  }

  public stampTownIntoChunk(vox: Uint8Array, cx: number, cy: number, cz: number): void {
    const CS = this.cfg.chunkSize;
    const chunkMinX = cx * CS; const chunkMinY = cy * CS; const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1; const chunkMaxY = chunkMinY + CS - 1; const chunkMaxZ = chunkMinZ + CS - 1;

    const closestX = clamp(this.cfg.TOWN_CENTER_X, chunkMinX, chunkMaxX);
    const closestZ = clamp(this.cfg.TOWN_CENTER_Z, chunkMinZ, chunkMaxZ);
    const r = this.cfg.SAFE_RADIUS + 2;
    if ((closestX - this.cfg.TOWN_CENTER_X) ** 2 + (closestZ - this.cfg.TOWN_CENTER_Z) ** 2 > r * r) return;

    const shrines = [
      { hx: this.cfg.TOWN_CENTER_X + 13, hz: this.cfg.TOWN_CENTER_Z + 13 },
      { hx: this.cfg.TOWN_CENTER_X - 13, hz: this.cfg.TOWN_CENTER_Z + 13 },
      { hx: this.cfg.TOWN_CENTER_X + 13, hz: this.cfg.TOWN_CENTER_Z - 13 },
      { hx: this.cfg.TOWN_CENTER_X - 13, hz: this.cfg.TOWN_CENTER_Z - 13 },
    ];

    const pillars = [
      { px: 56, pz: 0 }, { px: -56, pz: 0 }, { px: 0, pz: 56 }, { px: 0, pz: -56 },
      { px: 40, pz: 40 }, { px: -40, pz: 40 }, { px: 40, pz: -40 }, { px: -40, pz: -40 }
    ];

    for (let lx = 0; lx < CS; lx++) {
      for (let lz = 0; lz < CS; lz++) {
        const wx = chunkMinX + lx; const wz = chunkMinZ + lz;
        const dx = wx - this.cfg.TOWN_CENTER_X; const dz = wz - this.cfg.TOWN_CENTER_Z;
        const d2 = dx * dx + dz * dz;
        const dist = Math.sqrt(d2);

        if (dist > this.cfg.TOWN_RING_RADIUS + 3) continue;

        const townY = this.cfg.baseHeight + 2; 
        
        const inPlaza = dist <= this.cfg.TOWN_PLAZA_RADIUS + 2;
        const inTown = dist <= this.cfg.TOWN_RING_RADIUS;
        const inRingWall = dist >= this.cfg.TOWN_RING_RADIUS && dist <= this.cfg.TOWN_RING_RADIUS + 1.5;
        const inPath = (Math.abs(dz) <= this.cfg.TOWN_PATH_HALF_W && dist <= this.cfg.TOWN_RING_RADIUS) || 
                       (Math.abs(dx) <= this.cfg.TOWN_PATH_HALF_W && dist <= this.cfg.TOWN_RING_RADIUS);

        let shrineLocal: { ox: number; oz: number } | null = null;
        for (const c of shrines) {
          const ox = wx - c.hx; const oz = wz - c.hz;
          if (Math.abs(ox) <= 2 && Math.abs(oz) <= 2) { shrineLocal = { ox, oz }; break; }
        }

        let pillarLocal: { ox: number; oz: number } | null = null;
        for (const p of pillars) {
          const ox = dx - p.px; const oz = dz - p.pz;
          if (Math.abs(ox) <= 1 && Math.abs(oz) <= 1) { pillarLocal = { ox, oz }; break; }
        }

        for (let ly = 0; ly < CS; ly++) {
          const wy = chunkMinY + ly;
          const ii = this.idx(lx, ly, lz);

          if (vox[ii] === this.cfg.BEDROCK_ID) continue;

          if (wy > townY && wy <= townY + this.cfg.TOWN_CLEAR_HEIGHT) vox[ii] = this.cfg.AIR_ID;
          
          if (inTown && wy < townY) {
             vox[ii] = wy < townY - 2 ? this.cfg.DIRT_ID : this.cfg.STONE_BRICKS_ID;
          }

          if (inTown && wy === townY) {
            if (inPath) {
               vox[ii] = this.cfg.DIRT_ID;
            } else if (inPlaza) {
               const checker = (Math.abs(wx) + Math.abs(wz)) % 2 === 0;
               vox[ii] = checker ? this.cfg.STONE_BRICKS_ID : this.cfg.TUFF_ID;
            } else {
               const r = this.hash2i(wx, wz, 999);
               vox[ii] = r < 0.1 ? this.cfg.MOSS_ID : r < 0.2 ? this.cfg.MOSSY_STONE_ID : this.cfg.GRASS_ID;
            }
          }

          if (inRingWall && wy >= townY && wy <= townY + 3 && !inPath) {
             if (wy === townY || wy === townY + 1) vox[ii] = this.cfg.STONE_BRICKS_ID;
             if (wy === townY + 2 || wy === townY + 3) vox[ii] = this.cfg.LEAVES_ID;
          }

          if (pillarLocal && wy >= townY && wy <= townY + 6) {
             if (wy === townY + 6) {
               if (pillarLocal.ox === 0 && pillarLocal.oz === 0) vox[ii] = this.cfg.CRYSTAL_ID;
               else vox[ii] = this.cfg.AIR_ID;
             } else if (wy === townY) {
               vox[ii] = this.cfg.STONE_BRICKS_ID;
             } else {
               if (Math.abs(pillarLocal.ox) + Math.abs(pillarLocal.oz) <= 1) vox[ii] = this.cfg.DEEPSLATE_ID;
               else vox[ii] = this.cfg.AIR_ID;
             }
          }

          if (shrineLocal && wy >= townY && wy <= townY + 6) {
            const ox = shrineLocal.ox; const oz = shrineLocal.oz;
            const isCorner = Math.abs(ox) === 2 && Math.abs(oz) === 2;
            const isCenter = ox === 0 && oz === 0;
            const distToCenter = Math.max(Math.abs(ox), Math.abs(oz));

            if (wy === townY) {
              vox[ii] = this.cfg.STONE_BRICKS_ID; 
            } else if (wy > townY && wy <= townY + 3) {
              if (isCorner) vox[ii] = this.cfg.WOOD_ID; 
              else if (isCenter && wy === townY + 1) vox[ii] = this.cfg.TUFF_ID; 
              else if (isCenter && wy === townY + 2) vox[ii] = this.cfg.CRYSTAL_ID; 
              else vox[ii] = this.cfg.AIR_ID; 
            } else if (wy === townY + 4) {
              if (distToCenter === 2) vox[ii] = this.cfg.PLANKS_ID;
              else vox[ii] = this.cfg.AIR_ID;
            } else if (wy === townY + 5) {
              if (distToCenter === 1) vox[ii] = this.cfg.PLANKS_ID;
              else vox[ii] = this.cfg.AIR_ID;
            } else if (wy === townY + 6) {
              if (isCenter) vox[ii] = this.cfg.PLANKS_ID;
              else vox[ii] = this.cfg.AIR_ID;
            }
          }
        }
      }
    }

    if (this.cfg.townHall) {
      const townY = this.cfg.baseHeight + 2;
      const baseY = townY + 1; 
      const worldX = this.cfg.TOWN_CENTER_X - this.cfg.townHall.anchor.x;
      const worldY = baseY - this.cfg.townHall.anchor.y;
      const worldZ = this.cfg.TOWN_CENTER_Z - this.cfg.townHall.anchor.z;
      this.stampStructureIntoChunk(vox, cx, cy, cz, this.cfg.townHall, worldX, worldY, worldZ);
    }
  }

  private stampStructureIntoChunk(
    vox: Uint8Array, cx: number, cy: number, cz: number,
    s: { size: { w: number; h: number; d: number }; blocks: Array<{ x: number; y: number; z: number; id: number }> },
    worldX: number, worldY: number, worldZ: number
  ): void {
    const CS = this.cfg.chunkSize;
    const chunkMinX = cx * CS; const chunkMinY = cy * CS; const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1; const chunkMaxY = chunkMinY + CS - 1; const chunkMaxZ = chunkMinZ + CS - 1;
    if (worldX + s.size.w - 1 < chunkMinX || worldX > chunkMaxX || worldY + s.size.h - 1 < chunkMinY || worldY > chunkMaxY || worldZ + s.size.d - 1 < chunkMinZ || worldZ > chunkMaxZ) return;

    for (const b of s.blocks) {
      const wx = worldX + b.x; const wy = worldY + b.y; const wz = worldZ + b.z;
      if (wx < chunkMinX || wx > chunkMaxX || wy < chunkMinY || wy > chunkMaxY || wz < chunkMinZ || wz > chunkMaxZ) continue;
      const ii = this.idx(wx - chunkMinX, wy - chunkMinY, wz - chunkMinZ);
      if (vox[ii] === this.cfg.BEDROCK_ID) continue;
      vox[ii] = clamp(toInt(b.id), 0, 255);
    }
  }

  private pickCaveBiome(y: number, biomeNoise: number): CaveBiome {
    if (y < 18) return "DEEP_DARKISH";
    if (biomeNoise > 0.55) return "DRIPSTONE";
    if (biomeNoise < -0.55) return "LUSH";
    if (y > 25 && biomeNoise > 0.35 && biomeNoise < 0.45) return "CRYSTAL";
    if (biomeNoise < -0.2 && biomeNoise > -0.35) return "TUFFY";
    return "DEEP_DARKISH";
  }

  private baseStoneForDepth(y: number): number { return y < 18 ? this.cfg.DEEPSLATE_ID : this.cfg.STONE_ID; }

  private triCurve(y: number, minY: number, peakY: number, maxY: number) {
    if (y <= minY || y >= maxY) return 0;
    if (y === peakY) return 1;
    return y < peakY ? (y - minY) / (peakY - minY) : (maxY - y) / (maxY - peakY);
  }

  private chooseOreForY(y: number, rand: () => number): number | null {
    for (const ore of this.ORES) if (rand() < ore.baseChance * this.triCurve(y, ore.minY, ore.peakY, ore.maxY)) return ore.id;
    return null;
  }

  private carveVein(vox: Uint8Array, startX: number, startY: number, startZ: number, oreId: number, size: number, rand: () => number) {
    let x = startX, y = startY, z = startZ;
    for (let i = 0; i < size; i++) {
      if (x >= 0 && x < this.cfg.chunkSize && y >= 0 && y < this.cfg.chunkSize && z >= 0 && z < this.cfg.chunkSize) {
        const idx = this.idx(x, y, z);
        const current = vox[idx];
        if (current === this.cfg.STONE_ID || current === this.cfg.DEEPSLATE_ID || current === this.cfg.TUFF_ID) vox[idx] = oreId;
      }
      const r = rand();
      if (r < 0.25) x++; else if (r < 0.5) x--; else if (r < 0.7) z++; else if (r < 0.9) z--; else y += rand() < 0.5 ? 1 : -1;
    }
  }

  public generateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const CS = this.cfg.chunkSize;
    const vox = new Uint8Array(CS * CS * CS);

    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i; const worldZ = cz * CS + k;
        const biome = this.getBiome(worldX, worldZ);
        const height = this.heightAt(worldX, worldZ);
        const surfaceId = biome === this.BIOME_DESERT ? this.cfg.SAND_ID : biome === this.BIOME_SNOW ? this.cfg.SNOW_ID : this.cfg.GRASS_ID;
        const subsurfaceId = biome === this.BIOME_DESERT ? this.cfg.SAND_ID : this.cfg.DIRT_ID;

        for (let j = 0; j < CS; j++) {
          const worldY = cy * CS + j;
          const idx = this.idx(i, j, k);

          if (worldY <= 4 && this.hash3i(worldX, worldY, worldZ) < 0.95 - worldY * 0.18) { vox[idx] = this.cfg.BEDROCK_ID; continue; }
          if (worldY > height) { vox[idx] = this.cfg.AIR_ID; continue; }
          if (worldY === height) { vox[idx] = surfaceId; continue; }
          if (worldY > height - 4) { vox[idx] = subsurfaceId; continue; }

          let block = this.baseStoneForDepth(worldY);
          if (worldY < height - 5 && worldY > 5 && this.fbm3(worldX, worldY, worldZ, 24, 2, 8888) < 0.45) block = this.cfg.AIR_ID;
          vox[idx] = block;
        }
      }
    }

    const skinnedVox = new Uint8Array(vox);
    for (let x = 0; x < CS; x++) {
      for (let y = 0; y < CS; y++) {
        for (let z = 0; z < CS; z++) {
          const idx = this.idx(x, y, z);
          const current = vox[idx];
          if (current === this.cfg.STONE_ID || current === this.cfg.DEEPSLATE_ID) {
            const worldX = cx * CS + x; const worldY = cy * CS + y; const worldZ = cz * CS + z;
            const up = y < CS - 1 ? vox[this.idx(x, y + 1, z)] : this.cfg.AIR_ID;
            const down = y > 0 ? vox[this.idx(x, y - 1, z)] : this.cfg.STONE_ID;
            const left = x > 0 ? vox[this.idx(x - 1, y, z)] : this.cfg.STONE_ID;
            const right = x < CS - 1 ? vox[this.idx(x + 1, y, z)] : this.cfg.STONE_ID;
            const front = z > 0 ? vox[this.idx(x, y, z - 1)] : this.cfg.STONE_ID;
            const back = z < CS - 1 ? vox[this.idx(x, y, z + 1)] : this.cfg.STONE_ID;

            const isCeil = down === this.cfg.AIR_ID;
            const isFloor = up === this.cfg.AIR_ID;
            const isWall = !isCeil && !isFloor && (left === this.cfg.AIR_ID || right === this.cfg.AIR_ID || front === this.cfg.AIR_ID || back === this.cfg.AIR_ID);

            if (isFloor || isCeil || isWall) {
              const rules = this.CaveBiomeRules[this.pickCaveBiome(worldY, this.fbm2(worldX, worldZ, 120, 2, 7777))];
              if (isFloor) skinnedVox[idx] = rules.floor; else if (isCeil) skinnedVox[idx] = rules.ceil; else if (isWall) skinnedVox[idx] = rules.wall;

              if (rules.deco) {
                let rSalt = 0; const rand = () => this.hash3i(worldX, worldY, worldZ + rSalt++);
                for (const d of rules.deco) {
                  if (rand() < d.chance) {
                    const decoId = d.place({ x: worldX, y: worldY, z: worldZ, rand });
                    if (decoId !== null) {
                      if (isFloor && y < CS - 1) skinnedVox[this.idx(x, y + 1, z)] = decoId;
                      else if (isCeil && y > 0) skinnedVox[this.idx(x, y - 1, z)] = decoId;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    vox.set(skinnedVox);

    let oreSalt = 0;
    for (let x = 0; x < CS; x++) {
      for (let y = 0; y < CS; y++) {
        for (let z = 0; z < CS; z++) {
          const idx = this.idx(x, y, z);
          if (vox[idx] === this.cfg.STONE_ID || vox[idx] === this.cfg.DEEPSLATE_ID || vox[idx] === this.cfg.TUFF_ID) {
            const worldY = cy * CS + y;
            const rand = () => this.hash3i(cx * CS + x, worldY, cz * CS + z + oreSalt++);
            const oreId = this.chooseOreForY(worldY, rand);
            if (oreId) {
              this.carveVein(vox, x, y, z, oreId, Math.floor(def.veinSize[0] + (def.veinSize[1] - def.veinSize[0] + 1) * rand()), rand);
            }
          }
        }
      }
    }

    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i; const worldZ = cz * CS + k;
        const biome = this.getBiome(worldX, worldZ);
        if (this.shouldPlaceTreeAt(worldX, worldZ, biome) && biome !== this.BIOME_DESERT) {
          const height = this.heightAt(worldX, worldZ);
          const tH = this.treeHeight(worldX, worldZ, biome);
          for (let j = 0; j < CS; j++) {
            const worldY = cy * CS + j; const idx = this.idx(i, j, k);
            if (worldY >= height + 1 && worldY <= height + tH) { vox[idx] = this.cfg.WOOD_ID; } 
            else if (worldY >= height + tH - 1 && worldY <= height + tH + 2) {
              if (this.hash3i(worldX, worldY, worldZ) > (biome === this.BIOME_SNOW ? 0.42 : 0.22) && vox[idx] === this.cfg.AIR_ID) vox[idx] = this.cfg.LEAVES_ID;
            }
          }
        }
      }
    }

    this.stampPoiIntoChunk(vox, cx, cy, cz);
    this.stampTownIntoChunk(vox, cx, cy, cz);

    return vox;
  }
}