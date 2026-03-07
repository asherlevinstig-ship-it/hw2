// server/src/rooms/MyRoom.ts
// FULL FILE - No Omits

import { Room, Client, matchMaker } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema, MapSchema, type } from "@colyseus/schema";

import {
  Items,
  ITEM_DEFS,
  RECIPES,
  type ItemStack as SharedItemStack,
} from "../shared/items.js";

import {
  loadBlockStructure,
  type BlockStructure,
} from "../shared/structureLoader.js";

import { 
  CombatSystem, 
  type CombatEvent, 
  type Combatant,
  type AttackRequest
} from "../combat/CombatSystem.js";
import { HealthComponent } from "../combat/components/HealthComponent.js";
import { ResourceComponent } from "../combat/components/ResourceComponent.js";
import { AuraComponent } from "../combat/components/AuraComponent.js";
import { StatusComponent } from "../combat/components/StatusComponent.js";
import { CooldownComponent } from "../combat/components/CooldownComponent.js";
import { StateComponent } from "../combat/components/StateComponent.js";
import { EquipmentComponent } from "../combat/components/EquipmentComponent.js";

import { InventoryManager, type InvState } from "../inventory/InventoryManager.js";
import { WorldGenerator } from "../world/WorldGenerator.js";

// --- SCHEMAS ---
export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 40;
  @type("number") z: number = 0;
  @type("number") yaw: number = 0;
  @type("number") hp: number = 20;
  @type("number") maxHp: number = 20;
  @type("number") mana: number = 50;
  @type("number") maxMana: number = 50;
  @type("string") classId: string = "";
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  id: string;
  chunkSize: number;
  x: number; 
  y: number;
  z: number;
};

type ChunkDataMsg = {
  id: string;
  chunkSize: number;
  x: number;
  y: number;
  z: number;
  voxels: Uint8Array;
};

type PlayerInfo = {
  id: string; 
  userId: string; 
  x: number;
  y: number;
  z: number;
  yaw: number;
  lastMoveAt: number;
  joinedAt: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  invulnUntil: number;
};

// UPDATED: Added mob types and pathfinding states
type MobType = "golem" | "zombie" | "skeleton" | "npc";

type MobInfo = {
  id: string;
  type: MobType;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
  vy: number; 
  tickPhase: number; 
  targetId: string | null; 
  lastPos: { x: number, y: number, z: number };
  lastPosTime: number;
  stuckAccumulator: number; 
  attackCooldown: number;   
  waypoints: Vec3[];
  lastPathCalcTime: number;
};

type Projectile = {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  damage: number;
  radius: number;
  createdAt: number;
};

type Drop = {
  dropId: string;
  itemId: number;
  count: number;
  x: number;
  y: number;
  z: number;
  createdAt: number;
};

type InvClickMsg = {
  area: "inv" | "hotbar";
  index: number;
  button: "L" | "R";
  shift?: boolean;
};

type CraftMsg = {
  recipeId: string;
  max?: boolean;
  times?: number;
};

type PlaceBlockMsg = {
  x: number;
  y: number;
  z: number;
  id: number; 
  fromSlot?: number; 
};

type StartMineMsg = { x: number; y: number; z: number; heldSlot?: number };
type MineProgressMsg = {
  x: number;
  y: number;
  z: number;
  progress: number; 
  stage: number; 
  done?: boolean;
  reason?: string;
};

type MiningState = {
  sessionId: string;
  userId: string;
  x: number;
  y: number;
  z: number;
  heldSlot: number;
  startedAt: number; 
  lastHeartbeatAt: number; 
  breakTimeMs: number;
  lastStageSent: number;
  lastProgressSentAt: number;
  lastBlockId: number;
};

type UseManaMsg = {
  amount: number;
  reason?: string;
};

type AddContainerMsg = {
  kind: "heart" | "mana";
  amount?: number; 
};

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function toInt(n: number): number {
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
function safeUserId(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  const trimmed = s.slice(0, 80);
  const ok = trimmed.replace(/[^a-zA-Z0-9_\-]/g, "");
  return ok.length >= 3 ? ok : "anon";
}

const EVENT_ROOM_NAMES = [
  "event_arena"
] as const;

export class MyRoom extends Room<any> {
  state!: MyRoomState;

  // Added for Hub Forwarding functionality
  private activeEventRoomId: string | null = null;
  private activeEventEndTime: number = 0;

  private readonly chunkSize = 32; 
  private readonly baseHeight = 12;

  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;
  private readonly WOOD_ID = 4;
  private readonly LEAVES_ID = 5;
  private readonly BEDROCK_ID = 6;
  private readonly CHEST_ID = 8; 
  private readonly COAL_ORE_ID = 30; 
  private readonly IRON_ORE_ID = 31; 
  private readonly GOLD_ORE_ID = 32; 
  private readonly DIAMOND_ORE_ID = 33; 
  private readonly SAND_ID = 11;
  private readonly SNOW_ID = 12;
  private readonly DEEPSLATE_ID = 90;
  private readonly TUFF_ID = 91;
  private readonly MOSS_ID = 92;
  private readonly MOSSY_STONE_ID = 93;
  private readonly DRIPSTONE_ID = 94;
  private readonly DRIPSTONE_BLOCK_ID = 95;
  private readonly GLOW_SHROOM_ID = 96;
  private readonly CRYSTAL_ID = 97;
  private readonly PLANKS_ID = 40;
  private readonly STONE_BRICKS_ID = 41;
  private readonly CARPET_ID = 42;
  private readonly GLASS_ID = 43;
  private readonly LANTERN_ID = 44;

  private readonly DROP_TTL_MS = 3 * 60 * 1000; 
  private readonly DROP_CLEANUP_EVERY_MS = 5000;

  private readonly minMoveIntervalMs = 60;
  private readonly snapshotIntervalMs = 500;
  private readonly maxAbsCoord = 100000;
  private readonly maxSpeedBlocksPerSec = 18;

  private lastSnapshotLogAt = 0;

  private readonly mineTickMs = 50;
  private readonly mineHeartbeatTimeoutMs = 450;
  private readonly mineReach = 6.0;
  private readonly mineProgressSendMinMs = 80;

  private worldTime = 0.26; 
  private readonly DAY_DURATION_MS = 1200000; 

  private readonly TOWN_CENTER_X = 0;
  private readonly TOWN_CENTER_Z = 0;
  private readonly SAFE_RADIUS = 64; 
  private readonly TOWN_PLAZA_RADIUS = 24; 
  private readonly TOWN_RING_RADIUS = 56;  
  private readonly TOWN_PATH_HALF_W = 3;  
  private readonly TOWN_CLEAR_HEIGHT = 24; 

  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");
  private readonly metaPath = path.join(this.worldDir, "meta.json");
  private worldSeed = 0;

  private invManager!: InventoryManager;
  private worldGen!: WorldGenerator;

  private players = new Map<string, PlayerInfo>();
  private mobs = new Map<string, MobInfo>();
  private chunks = new Map<string, Uint8Array>();
  private drops = new Map<string, Drop>();
  private projectiles = new Map<string, Projectile>();
  private nextDropSeq = 1;
  private mining = new Map<string, MiningState>(); 
  
  private chestLoot = new Map<string, SharedItemStack[]>(); 
  private signTexts = new Map<string, string>(); 
  
  private playerChunks = new Map<string, string>(); 
  private spatialGrid = new Map<string, Set<string>>(); 
  private combatTickCount = 0;

  private combat!: CombatSystem;
  private combatants = new Map<string, Combatant>();

  private townHall: BlockStructure | null = null;
  private eventTimer: any = null;
  private nextEventAt: number = 0;

  // =========================
  // Helper Methods
  // =========================
  private ensureDirs(): void {
    if (!fs.existsSync(this.worldDir)) fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir)) fs.mkdirSync(this.chunksDir, { recursive: true });
  }

  private loadOrCreateWorldSeed(options: any): number {
    const optSeedRaw = (options as any)?.worldSeed;
    if (typeof optSeedRaw === "number" && Number.isFinite(optSeedRaw)) {
      const s = (optSeedRaw | 0) >>> 0;
      this.writeWorldMeta({ worldSeed: s });
      return s;
    }

    const meta = this.readWorldMeta();
    if (meta && typeof meta.worldSeed === "number" && Number.isFinite(meta.worldSeed)) {
      const s = (meta.worldSeed | 0) >>> 0;
      return s;
    }

    const gen = this.generateSeed();
    this.writeWorldMeta({ worldSeed: gen });
    return gen;
  }

  private generateSeed(): number {
    const a = (Date.now() & 0xffffffff) >>> 0;
    const b = ((Math.random() * 0xffffffff) >>> 0) >>> 0;
    let s = (a ^ (b + 0x9e3779b9)) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    s = Math.imul(s, 0x85ebca6b) >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
    s = Math.imul(s, 0xc2b2ae35) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    return s >>> 0;
  }

  private readWorldMeta(): { worldSeed?: number, worldTime?: number } | null {
    try {
      if (!fs.existsSync(this.metaPath)) return null;
      const raw = fs.readFileSync(this.metaPath, "utf8");
      const j = JSON.parse(raw);
      if (typeof j !== "object" || j === null) return null;
      return j as any;
    } catch (e) {
      return null;
    }
  }

  private writeWorldMeta(meta: { worldSeed?: number, worldTime?: number }): void {
    try {
      const existing = this.readWorldMeta() || {};
      const combined = { ...existing, ...meta, worldTime: this.worldTime }; 
      const tmp = this.metaPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(combined));
      fs.renameSync(tmp, this.metaPath);
    } catch (e) {
      console.warn("[WORLD] meta write failed:", this.metaPath, e);
    }
  }

  private isCombatAllowedHere(x: number, z: number): boolean { 
    return !this.isInSafeZoneXZ(toInt(x), toInt(z)); 
  }

  private normalizeChunkRequestToIndex(rx: number, ry: number, rz: number): { cx: number; cy: number; cz: number } {
    const CS = this.chunkSize;
    const toIndex = (v: number) => {
      if (v !== 0 && v % CS === 0) return toInt(v / CS);
      return toInt(v);
    };
    return { cx: toIndex(rx), cy: toIndex(ry), cz: toIndex(rz) };
  }

  private chunkKey(cx: number, cy: number, cz: number): string { return `${cx},${cy},${cz}`; }
  
  private chunkFilePath(cx: number, cy: number, cz: number): string { return path.join(this.chunksDir, `c_${cx}_${cy}_${cz}.bin`); }
  
  private readChunkFromDisk(cx: number, cy: number, cz: number): Uint8Array | null {
    const fp = this.chunkFilePath(cx, cy, cz);
    try {
      if (!fs.existsSync(fp)) return null;
      const buf = fs.readFileSync(fp);
      const expected = this.chunkSize * this.chunkSize * this.chunkSize;
      if (buf.byteLength !== expected) {
        return null;
      }
      const out = new Uint8Array(expected);
      out.set(buf);
      return out;
    } catch (e) {
      return null;
    }
  }
  
  private writeChunkToDisk(cx: number, cy: number, cz: number, chunk: Uint8Array): void {
    const fp = this.chunkFilePath(cx, cy, cz);
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(chunk));
    fs.renameSync(tmp, fp);
  }

  private updatePlayerSpatial(sessionId: string, x: number, z: number) {
    const cx = Math.floor(x / this.chunkSize);
    const cz = Math.floor(z / this.chunkSize);
    const key = `${cx},${cz}`;

    const oldKey = this.playerChunks.get(sessionId);
    if (oldKey === key) return;

    if (oldKey) {
      const oldSet = this.spatialGrid.get(oldKey);
      if (oldSet) {
        oldSet.delete(sessionId);
        if (oldSet.size === 0) this.spatialGrid.delete(oldKey);
      }
    }

    this.playerChunks.set(sessionId, key);
    let newSet = this.spatialGrid.get(key);
    if (!newSet) {
      newSet = new Set();
      this.spatialGrid.set(key, newSet);
    }
    newSet.add(sessionId);
  }

  private removePlayerSpatial(sessionId: string) {
    const oldKey = this.playerChunks.get(sessionId);
    if (oldKey) {
      const oldSet = this.spatialGrid.get(oldKey);
      if (oldSet) {
        oldSet.delete(sessionId);
        if (oldSet.size === 0) this.spatialGrid.delete(oldKey);
      }
    }
    this.playerChunks.delete(sessionId);
  }

  // =========================
  // Voxel A* Pathfinding
  // =========================
  private findPathAStar(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number): Vec3[] {
      const startNode = { x: Math.floor(sx), y: Math.floor(sy), z: Math.floor(sz), g: 0, f: 0, parent: null as any };
      const targetNode = { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) };

      const open: any[] = [startNode];
      const closed = new Set<string>();

      let iter = 0;
      const MAX_ITER = 80; // Limit to prevent server CPU spikes
      
      let bestNode = startNode;
      let bestDist = Infinity;

      while (open.length > 0 && iter < MAX_ITER) {
          iter++;
          // Sort to get lowest f (A simple array sort is fast enough for < 80 nodes)
          open.sort((a, b) => a.f - b.f);
          const current = open.shift();

          const key = `${current.x},${current.y},${current.z}`;
          if (closed.has(key)) continue;
          closed.add(key);

          const distToTarget = Math.abs(current.x - targetNode.x) + Math.abs(current.y - targetNode.y) + Math.abs(current.z - targetNode.z);
          if (distToTarget < bestDist) {
              bestDist = distToTarget;
              bestNode = current;
          }

          if (distToTarget <= 1) { // Found it or close enough
              bestNode = current;
              break; 
          }

          // Check 4 horizontal neighbors
          const dirs = [ [1,0], [-1,0], [0,1], [0,-1] ];
          for (const d of dirs) {
              const nx = current.x + d[0];
              const nz = current.z + d[1];
              let ny = current.y;

              let canMove = false;

              const footBlock = this.getBlockAt(nx, ny, nz);
              const headBlock = this.getBlockAt(nx, ny + 1, nz);

              if (footBlock === this.AIR_ID && headBlock === this.AIR_ID) {
                  // Air ahead. Need to find a floor.
                  const floorBlock = this.getBlockAt(nx, ny - 1, nz);
                  if (floorBlock !== this.AIR_ID) {
                      canMove = true; // Normal walk on flat ground
                  } else {
                      // Drop down (max 3 blocks safely)
                      for(let drop = 2; drop <= 3; drop++) {
                          if (this.getBlockAt(nx, ny - drop, nz) !== this.AIR_ID) {
                              ny = ny - (drop - 1);
                              canMove = true;
                              break;
                          }
                      }
                  }
              } else if (footBlock !== this.AIR_ID && headBlock === this.AIR_ID) {
                  // Try stepping up 1 block (like stairs)
                  const aboveHeadBlock = this.getBlockAt(nx, ny + 2, nz);
                  if (aboveHeadBlock === this.AIR_ID) {
                      ny = ny + 1;
                      canMove = true; 
                  }
              }

              if (canMove) {
                  const nKey = `${nx},${ny},${nz}`;
                  if (!closed.has(nKey)) {
                      const g = current.g + 1;
                      const h = Math.abs(nx - targetNode.x) + Math.abs(ny - targetNode.y) + Math.abs(nz - targetNode.z);
                      open.push({ x: nx, y: ny, z: nz, g, f: g + h, parent: current });
                  }
              }
          }
      }

      const path: Vec3[] = [];
      let curr = bestNode;
      while (curr && curr.parent) {
          // Push center of blocks for smooth walking
          path.unshift({ x: curr.x + 0.5, y: curr.y, z: curr.z + 0.5 });
          curr = curr.parent;
      }
      return path;
  }

  onCreate(options: any) {
    console.log("MyRoom created", options);
    this.maxClients = 64;
    this.autoDispose = false;

    this.ensureDirs();
    
    const invDir = path.join(this.worldDir, "inventories");
    this.invManager = new InventoryManager(invDir);
    
    this.worldSeed = this.loadOrCreateWorldSeed(options);
    
    this.setState(new MyRoomState());

    try {
      const dataFolder = path.join(process.cwd(), "data");
      const townHallPath = path.join(dataFolder, "town_hall_v1.json");
      
      if (!fs.existsSync(dataFolder)) {
        fs.mkdirSync(dataFolder, { recursive: true });
      }

      if (fs.existsSync(townHallPath)) {
        this.townHall = loadBlockStructure(townHallPath);
      } else {
        this.townHall = this.buildMassiveTownHall();
      }
      
      const townY = this.baseHeight + 2;
      const baseY = townY + 1;
      const anchorX = this.townHall?.anchor.x ?? Math.floor(51 / 2);
      const anchorZ = this.townHall?.anchor.z ?? Math.floor(31 / 2);
      const worldX = this.TOWN_CENTER_X - anchorX;
      const worldY = baseY;
      const worldZ = this.TOWN_CENTER_Z - anchorZ;

      const registerSign = (lx: number, ly: number, lz: number, text: string) => {
          this.signTexts.set(`${worldX + lx},${worldY + ly},${worldZ + lz}`, text);
      };

      registerSign(25, 1, 3, "Welcome to the Town of Beginnings! West: Casino. East: Market.");
      registerSign(16, 1, 15, "[Gambling Den] Try your luck at the Moss Tables!");
      registerSign(6, 1, 15, "House Rules: 1. No weapons drawn. 2. All bets are final.");
      registerSign(34, 1, 15, "[Market District] Trade your hard-earned ores here!");
      registerSign(44, 1, 15, "Market Stall Available! Contact the Warden to rent.");

    } catch (e) {
      console.error("[STRUCT] FATAL: TownHall failed to generate!", (e as Error).message);
      this.townHall = null;
    }

    this.worldGen = new WorldGenerator({
        worldSeed: this.worldSeed,
        chunkSize: this.chunkSize,
        baseHeight: this.baseHeight,
        TOWN_CENTER_X: this.TOWN_CENTER_X,
        TOWN_CENTER_Z: this.TOWN_CENTER_Z,
        SAFE_RADIUS: this.SAFE_RADIUS,
        TOWN_PLAZA_RADIUS: this.TOWN_PLAZA_RADIUS,
        TOWN_RING_RADIUS: this.TOWN_RING_RADIUS,
        TOWN_PATH_HALF_W: this.TOWN_PATH_HALF_W,
        TOWN_CLEAR_HEIGHT: this.TOWN_CLEAR_HEIGHT,
        townHall: this.townHall,
        AIR_ID: this.AIR_ID,
        GRASS_ID: this.GRASS_ID,
        DIRT_ID: this.DIRT_ID,
        STONE_ID: this.STONE_ID,
        WOOD_ID: this.WOOD_ID,
        LEAVES_ID: this.LEAVES_ID,
        BEDROCK_ID: this.BEDROCK_ID,
        CHEST_ID: this.CHEST_ID,
        COAL_ORE_ID: this.COAL_ORE_ID,
        IRON_ORE_ID: this.IRON_ORE_ID,
        GOLD_ORE_ID: this.GOLD_ORE_ID,
        DIAMOND_ORE_ID: this.DIAMOND_ORE_ID,
        SAND_ID: this.SAND_ID,
        SNOW_ID: this.SNOW_ID,
        DEEPSLATE_ID: this.DEEPSLATE_ID,
        TUFF_ID: this.TUFF_ID,
        MOSS_ID: this.MOSS_ID,
        MOSSY_STONE_ID: this.MOSSY_STONE_ID,
        DRIPSTONE_ID: this.DRIPSTONE_ID,
        DRIPSTONE_BLOCK_ID: this.DRIPSTONE_BLOCK_ID,
        GLOW_SHROOM_ID: this.GLOW_SHROOM_ID,
        CRYSTAL_ID: this.CRYSTAL_ID,
        PLANKS_ID: this.PLANKS_ID,
        STONE_BRICKS_ID: this.STONE_BRICKS_ID,
        CARPET_ID: this.CARPET_ID,
        GLASS_ID: this.GLASS_ID,
        LANTERN_ID: this.LANTERN_ID
    });

    this.combat = new CombatSystem({
      isSafeZoneXZ: (x, z) => this.isInSafeZoneXZ(x, z),
      getBlockAt: (x, y, z) => this.getBlockAt(x, y, z),
      isCombatAllowedXZ: (x, z) => this.isCombatAllowedHere(x, z),
      emit: (e) => this.handleCombatEvent(e),
      getAllCombatants: () => Array.from(this.combatants.values()),
      AIR_ID: this.AIR_ID
    });
    
    const townY2 = this.baseHeight + 2;
    this.spawnMob("npc", "npc_giant_warden", 0, townY2, -35);

    let lastCombatTick = Date.now();
    
    // AI LOOP
    this.clock.setInterval(() => {
      const now = Date.now();
      const dt = now - lastCombatTick;
      this.combat.tick(dt);
      lastCombatTick = now;
      this.combatTickCount++;

      this.worldTime = (this.worldTime + (dt / this.DAY_DURATION_MS)) % 1;

      this.tickProjectiles(); 

      for (const mob of this.mobs.values()) {
        const c = this.combatants.get(mob.id);
        if (!c || c.health.isDead() || c.state.isStaggered()) continue;

        if (mob.type === "npc") continue;

        if (mob.attackCooldown > 0) mob.attackCooldown -= dt;

        let isMoving = false;

        const mcx = Math.floor(c.pos.x / this.chunkSize);
        const mcz = Math.floor(c.pos.z / this.chunkSize);
        let hasLocalPlayers = false;

        let nearbyPlayers: PlayerInfo[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const set = this.spatialGrid.get(`${mcx + dx},${mcz + dz}`);
            if (set && set.size > 0) {
              hasLocalPlayers = true;
              for (const pid of set) {
                const p = this.players.get(pid);
                if (p) nearbyPlayers.push(p);
              }
            }
          }
        }

        if (!hasLocalPlayers) continue;

        // 1. Aggro Check
        if (this.combatTickCount % 5 === mob.tickPhase) {
          if (now - mob.lastPosTime > 1000) {
            const dist = Math.sqrt((c.pos.x - mob.lastPos.x)**2 + (c.pos.z - mob.lastPos.z)**2);
            if (mob.targetId && dist < 1.5) {
                mob.stuckAccumulator += (now - mob.lastPosTime);
            } else {
                mob.stuckAccumulator = 0;
            }
            mob.lastPos = { x: c.pos.x, y: c.pos.y, z: c.pos.z };
            mob.lastPosTime = now;
          }

          let nearestPlayerId: string | null = null;
          let closestDist = 20.0; 

          for (const pl of nearbyPlayers) {
            const pdx = pl.x - c.pos.x;
            const pdy = pl.y - c.pos.y;
            const pdz = pl.z - c.pos.z;
            const dist = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz);
            
            if (dist < closestDist && !this.isInSafeZoneXZ(pl.x, pl.z)) {
              closestDist = dist;
              nearestPlayerId = pl.id;
            }
          }
          mob.targetId = nearestPlayerId;
        }

        // 2. Gravity
        let grounded = false;
        const cx = Math.floor(c.pos.x);
        const cz = Math.floor(c.pos.z);
        const blockBelow = this.getBlockAt(cx, Math.floor(c.pos.y - 0.05), cz);
        
        if (blockBelow === this.AIR_ID) {
          mob.vy -= 0.04;
          if (mob.vy < -0.6) mob.vy = -0.6;
          c.pos.y += mob.vy;
          isMoving = true;
        } else {
          mob.vy = 0;
          grounded = true;
          const groundLevel = Math.floor(c.pos.y - 0.05) + 1;
          if (c.pos.y < groundLevel) {
            c.pos.y = groundLevel;
            isMoving = true;
          }
        }

        // 3. Movement Intent & Abilities
        let targetDx = 0;
        let targetDz = 0;
        let intentDist = 0;

        const target = mob.targetId ? this.players.get(mob.targetId) : null;

        // Golem special slam attack
        if (mob.type === "golem" && mob.stuckAccumulator > 3000 && target && mob.attackCooldown <= 0) {
            const pdx = target.x - c.pos.x;
            const pdz = target.z - c.pos.z;
            mob.yaw = Math.atan2(pdx, pdz);
            c.yaw = mob.yaw;

            this.spawnProjectile(mob.id, c.pos.x, c.pos.y + 1.5, c.pos.z, target.x, target.y + 1.0, target.z);
            this.broadcast("playerSwing", { id: mob.id, attackId: "SLAM" });

            mob.stuckAccumulator = 0;
            mob.attackCooldown = 2500;
            continue; 
        }

        if (target) {
            targetDx = target.x - c.pos.x;
            targetDz = target.z - c.pos.z;
            intentDist = Math.sqrt(targetDx * targetDx + targetDz * targetDz);
            
            mob.yaw = Math.atan2(targetDx, targetDz);
            c.yaw = mob.yaw;

            // Skeleton Ranged Logic
            if (mob.type === "skeleton" && intentDist <= 10.0) {
                if (mob.attackCooldown <= 0) {
                    this.spawnProjectile(mob.id, c.pos.x, c.pos.y + 1.5, c.pos.z, target.x, target.y + 1.0, target.z);
                    this.broadcast("playerSwing", { id: mob.id, attackId: "SHOOT" });
                    mob.attackCooldown = 2000;
                }
                // Don't move closer if already in range
                if (intentDist > 3.0) intentDist = 0; 
            } 
            // Melee Logic
            else if (intentDist <= 1.8 && mob.attackCooldown <= 0) {
               if (c.state.canStartAttack()) {
                 this.combat.requestAttack(mob.id, { attackId: "UNARMED" });
                 mob.attackCooldown = 1000;
               }
               intentDist = 0;
            }
        } else {
            // Return to spawn point if no target
            targetDx = mob.spawnX - c.pos.x;
            targetDz = mob.spawnZ - c.pos.z;
            intentDist = Math.sqrt(targetDx * targetDx + targetDz * targetDz);

            if (intentDist > 1.0) {
              mob.yaw = Math.atan2(targetDx, targetDz);
              c.yaw = mob.yaw;
            } else {
              intentDist = 0;
            }
        }

        // 4. Pathfinding Execution
        if (intentDist > 0) {
            // Periodically refresh A* path
            if (now - mob.lastPathCalcTime > 1000 || mob.waypoints.length === 0) {
                let tx = c.pos.x + targetDx;
                let ty = target ? target.y : mob.spawnY;
                let tz = c.pos.z + targetDz;

                mob.waypoints = this.findPathAStar(c.pos.x, c.pos.y, c.pos.z, tx, ty, tz);
                mob.lastPathCalcTime = now;
            }

            let moveX = 0;
            let moveZ = 0;

            if (mob.waypoints.length > 0) {
                const nextWp = mob.waypoints[0];
                const wdx = nextWp.x - c.pos.x;
                const wdz = nextWp.z - c.pos.z;
                const wDist = Math.sqrt(wdx * wdx + wdz * wdz);

                if (wDist < 0.4) {
                    mob.waypoints.shift(); // Reached waypoint
                } else {
                    const speed = 0.08 * c.moveSpeedMul;
                    moveX = (wdx / wDist) * speed;
                    moveZ = (wdz / wDist) * speed;
                }
            } else {
                // Fallback direct steering if A* failed to find a path
                const speed = 0.08 * c.moveSpeedMul;
                moveX = (targetDx / intentDist) * speed;
                moveZ = (targetDz / intentDist) * speed;
            }

            const nextX = c.pos.x + moveX;
            const nextZ = c.pos.z + moveZ;

            const nextCx = Math.floor(nextX);
            const nextCz = Math.floor(nextZ);
            
            const blockAtNextFoot = this.getBlockAt(nextCx, Math.floor(c.pos.y + 0.1), nextCz);
            const blockAtNextHead = this.getBlockAt(nextCx, Math.floor(c.pos.y + 1.1), nextCz);

            if (blockAtNextFoot !== this.AIR_ID || blockAtNextHead !== this.AIR_ID) {
              const blockAboveHead = this.getBlockAt(nextCx, Math.floor(c.pos.y + 2.1), nextCz);
              
              if (grounded && blockAtNextFoot !== this.AIR_ID && blockAtNextHead === this.AIR_ID && blockAboveHead === this.AIR_ID) {
                mob.vy = 0.35; // Jump
                c.pos.y += mob.vy;
                c.pos.x = nextX;
                c.pos.z = nextZ;
                isMoving = true;
              }
            } else {
              c.pos.x = nextX;
              c.pos.z = nextZ;
              isMoving = true;
            }
        }

        if (isMoving) {
          mob.x = c.pos.x;
          mob.y = c.pos.y;
          mob.z = c.pos.z;
          this.broadcast("playerTransformOther", { id: mob.id, x: mob.x, y: mob.y, z: mob.z, yaw: mob.yaw });
        }
      }
    }, 50);

    this.clock.setInterval(() => {
        this.broadcast("worldTime", { time: this.worldTime });
        if (this.combatTickCount % 200 === 0) { 
             this.writeWorldMeta({ worldSeed: this.worldSeed }); 
        }
    }, 1000);

    // SPAWNER LOOP
    this.clock.setInterval(() => {
      // 1. Despawn distant mobs (Memory Leak Fix)
      const toDespawn: string[] = [];
      for (const [mobId, m] of this.mobs.entries()) {
        if (m.type === "npc") continue;
        
        let closestPlayerDistSq = Infinity;
        for (const p of this.players.values()) {
          const dx = p.x - m.x;
          const dz = p.z - m.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < closestPlayerDistSq) closestPlayerDistSq = distSq;
        }
        
        if (closestPlayerDistSq > 100 * 100) {
          toDespawn.push(mobId);
        }
      }

      for (const id of toDespawn) {
        this.mobs.delete(id);
        this.combatants.delete(id);
        this.broadcast("playerLeft", { id });
      }

      // 2. Spawn new mobs
      for (const [chunkKey, playerIds] of this.spatialGrid.entries()) {
        if (playerIds.size === 0) continue;
        const [cxStr, czStr] = chunkKey.split(',');
        const cx = parseInt(cxStr);
        const cz = parseInt(czStr);

        let mobsInChunk = 0;
        for (const m of this.mobs.values()) {
          const mcx = Math.floor(m.x / this.chunkSize);
          const mcz = Math.floor(m.z / this.chunkSize);
          if (mcx === cx && mcz === cz && m.type !== "npc") mobsInChunk++; 
        }

        const isNight = this.worldTime < 0.2 || this.worldTime > 0.8;
        const limit = isNight ? 6 : 2;

        if (mobsInChunk < limit) {
           const pId = Array.from(playerIds)[0];
           const p = this.players.get(pId);
           if (p) {
             const spawnX = p.x + (Math.random() * 32 - 16);
             const spawnZ = p.z + (Math.random() * 32 - 16);
             const distToP = Math.sqrt((spawnX - p.x)**2 + (spawnZ - p.z)**2);
             
             if (distToP > 12 && !this.isInSafeZoneXZ(spawnX, spawnZ)) {
                 const spawnY = this.heightAt(spawnX, spawnZ) + 1;
                 
                 // Randomly select mob type
                 const r = Math.random();
                 let mobType: MobType = "zombie";
                 if (r < 0.2) mobType = "golem";
                 else if (r < 0.5) mobType = "skeleton";

                 const id = `${mobType}_${Date.now().toString(16)}_${Math.floor(Math.random()*1000)}`;
                 this.spawnMob(mobType, id, spawnX, spawnY, spawnZ);
             }
           }
        }
      }
    }, 5000);

    this.clock.setInterval(() => {
      const allPlayers = Array.from(this.players.values()).map((p) => ({
        id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      }));
      const allMobs = Array.from(this.mobs.values()).map((m) => ({
        id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw,
      }));
      
      this.broadcast("playersSnapshot", [...allPlayers, ...allMobs]);

      const now = Date.now();
      if (now - this.lastSnapshotLogAt > 3000) {
        this.lastSnapshotLogAt = now;
      }
    }, this.snapshotIntervalMs);

    this.clock.setInterval(() => this.tickMining(), this.mineTickMs);
    this.clock.setInterval(() => this.cleanupDrops(), this.DROP_CLEANUP_EVERY_MS);

    this.startEventScheduler(180_000);

    this.onMessage("devTpCave", (client: Client) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const startX = Math.floor(pl.x);
      const startZ = Math.floor(pl.z);
      
      let foundX = -1, foundY = -1, foundZ = -1;
      
      searchLoop:
      for (let r = 0; r <= 64; r += 3) {
        for (let dx = -r; dx <= r; dx += 3) {
          for (let dz = -r; dz <= r; dz += 3) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r && r !== 0) continue;

            const px = startX + dx;
            const pz = startZ + dz;
            
            if (this.isInSafeZoneXZ(px, pz)) continue;

            const surfaceY = this.heightAt(px, pz);
            
            for (let y = surfaceY - 5; y > 8; y -= 2) {
              const block = this.getBlockAt(px, y, pz);
              if (block === this.AIR_ID) {
                const floor = this.getBlockAt(px, y - 1, pz);
                const head = this.getBlockAt(px, y + 1, pz);
                if (floor !== this.AIR_ID && head === this.AIR_ID) {
                  foundX = px;
                  foundY = y;
                  foundZ = pz;
                  break searchLoop;
                }
              }
            }
          }
        }
      }

      if (foundY !== -1) {
        pl.x = foundX + 0.5;
        pl.y = foundY;
        pl.z = foundZ + 0.5;
        c.pos.x = pl.x;
        c.pos.y = pl.y;
        c.pos.z = pl.z;
        this.updatePlayerSpatial(client.sessionId, pl.x, pl.z);

        client.send("playerRespawn", {
          id: pl.id,
          x: pl.x, y: pl.y, z: pl.z,
          hp: c.health.hp, maxHp: c.health.maxHp,
          mana: c.resources.mana, maxMana: c.resources.maxMana
        });
        client.send("chatMessage", { msg: `[DEV] Radar found cave! Teleporting to X:${foundX}, Y:${foundY}, Z:${foundZ}` });
      } else {
        client.send("chatMessage", { msg: "[DEV] Radar exhausted! No caves found within a 64-block radius." });
      }
    });

    this.onMessage("worldDataNeeded", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<WorldDataNeededMsg>;
      if (typeof p.id !== "string" || p.id.length < 1) return;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      const rx = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const ry = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const rz = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      const { cx, cy, cz } = this.normalizeChunkRequestToIndex(rx, ry, rz);
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      client.send("chunkData", { id: p.id, chunkSize: this.chunkSize, x: rx, y: ry, z: rz, voxels: chunk });
    });

    this.onMessage("playerMove", (client: Client, payload: unknown) => {
      const now = Date.now();
      const pl = this.players.get(client.sessionId);
      if (!pl) return;
      if (now - pl.lastMoveAt < this.minMoveIntervalMs) return;

      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3> & { yaw?: unknown };
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord);
      const y = clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord);
      const z = clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord);
      const yaw = isFiniteNumber(maybe.yaw) ? maybe.yaw as number : pl.yaw;

      const dtSec = Math.max(0.001, (now - Math.max(0, pl.lastMoveAt)) / 1000);
      const maxDist = this.maxSpeedBlocksPerSec * dtSec;

      const dx = x - pl.x; const dy = y - pl.y; const dz = z - pl.z;
      if (dx * dx + dy * dy + dz * dz > maxDist * maxDist * 9) return;

      pl.x = x; pl.y = y; pl.z = z; pl.yaw = yaw; pl.lastMoveAt = now;
      this.updatePlayerSpatial(client.sessionId, x, z);

      const c = this.combatants.get(client.sessionId);
      if (c) {
        c.pos.x = x; c.pos.y = y; c.pos.z = z; c.yaw = yaw;
      }

      this.broadcast("playerTransformOther", { id: client.sessionId, x, y, z, yaw }, { except: client });
    });

    this.onMessage("selectClass", (client: Client, payload: unknown) => {
      const p = payload as { classId?: string };
      if (!p || typeof p.classId !== "string") return;

      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      
      for (let i = 0; i < this.invManager.HOTBAR_SLOTS; i++) {
        inv.slots[i] = { id: 0, count: 0 } as any;
      }

      let archetype = "BASIC";
      inv.slots[0] = { id: Items.WOOD_PICK, count: 1, dur: ITEM_DEFS[Items.WOOD_PICK]?.tool?.maxDurability } as any;
      
      switch (p.classId) {
        case "VANGUARD":
          archetype = "IRON";
          inv.slots[1] = { id: Items.SKILL_AURA_HEAVY, count: 1 } as any;
          c.maxPoise = 200;
          c.poise = 200;
          c.blockMitigation = 0.75;
          break;
        case "NIGHTBLADE":
          archetype = "SHADOW";
          inv.slots[1] = { id: Items.SKILL_AURA_THRUST, count: 1 } as any;
          c.dodgeIframesMs = 600;
          c.critChance += 0.10;
          c.moveSpeedMul = 1.15;
          break;
        case "BLOODRAGER":
          archetype = "BLOOD";
          inv.slots[1] = { id: Items.SKILL_AURA_SLASH, count: 1 } as any;
          break;
        case "SPELLBLADE":
          archetype = "ASTRAL";
          inv.slots[1] = { id: Items.SKILL_AURA_HEAVY, count: 1 } as any;
          inv.slots[2] = { id: Items.SKILL_AURA_THRUST, count: 1 } as any;
          c.resources.maxMana = c.resources.maxMana * 2;
          c.resources.mana = c.resources.maxMana;
          c.resources.maxAura = c.resources.maxAura * 2;
          c.resources.aura = c.resources.maxAura;
          break;
        case "PROSPECTOR":
          archetype = "BASIC";
          inv.slots[0] = { id: Items.STONE_PICK, count: 1, dur: ITEM_DEFS[Items.STONE_PICK]?.tool?.maxDurability } as any;
          break;
        case "WARDEN":
          archetype = "BASIC";
          inv.slots[1] = { id: Items.SKILL_NATURE_GRASP, count: 1 } as any;
          break;
      }

      inv.stats.auraArchetype = archetype;
      c.aura.setArchetype(archetype as any);
      c.health.setMax(c.health.maxHp, true);

      this.invManager.saveInventory(pl.userId, inv);
      this.invManager.sendInvStateToClient(client, inv);
      c.onSync?.(c.snapshot());

      client.send("chatMessage", { msg: `You have awakened as ${p.classId}.` });
    });

    this.onMessage("attack", (client: Client, payload: unknown) => {
      const req = (payload as Partial<AttackRequest>) || {};
      this.combat.requestAttack(client.sessionId, {
        attackId: req.attackId,
        heldSlot: isFiniteNumber(req.heldSlot) ? toInt(req.heldSlot as number) : undefined,
        yaw: req.yaw,
        pitch: req.pitch
      });
    });

    this.onMessage("dodge", (client: Client, payload: unknown) => {
      const p = (payload as { dir?: Vec3 }) || {};
      if (p.dir && isFiniteNumber(p.dir.x) && isFiniteNumber(p.dir.y) && isFiniteNumber(p.dir.z)) {
        this.combat.requestDodge(client.sessionId, p.dir);
      }
    });

    this.onMessage("block", (client: Client, payload: unknown) => {
      const active = !!(payload as any)?.active;
      this.combat.setBlocking(client.sessionId, active);
    });

    this.onMessage("useMana", (client: Client, payload: unknown) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const p = (typeof payload === "object" && payload) ? (payload as Partial<UseManaMsg>) : {};
      const amount = isFiniteNumber(p.amount) ? clamp(toInt(p.amount), 0, 999999) : 0;
      if (amount <= 0) return;

      if (!c.resources.canPay(amount, 0)) {
        client.send("useManaResult", { ok: false, reason: "not_enough_mana", mana: c.resources.mana, maxMana: c.resources.maxMana });
        return;
      }

      c.resources.pay(amount, 0);
      c.onSync?.(c.snapshot()); 
      client.send("useManaResult", { ok: true, mana: c.resources.mana, maxMana: c.resources.maxMana });
    });

    this.onMessage("addContainer", (client: Client, payload: unknown) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const p = (typeof payload === "object" && payload) ? (payload as Partial<AddContainerMsg>) : {};
      const kind = p.kind === "mana" ? "mana" : "heart";
      const amt = isFiniteNumber(p.amount) ? clamp(toInt(p.amount), 1, 99) : 1;

      if (kind === "heart") {
        const addHp = amt * this.invManager.HP_PER_HEART;
        c.health.setMax(c.health.maxHp + addHp, true);
      } else {
        const addMana = amt * this.invManager.MANA_PER_CONTAINER;
        c.resources.maxMana = clamp(c.resources.maxMana + addMana, 0, 999999);
        c.resources.mana = c.resources.maxMana;
      }

      c.onSync?.(c.snapshot()); 
      client.send("addContainerResult", { ok: true, kind, hp: c.health.hp, maxHp: c.health.maxHp, mana: c.resources.mana, maxMana: c.resources.maxMana });
    });

    this.onMessage("useItem", (client: Client, payload: unknown) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const p = (typeof payload === "object" && payload) ? (payload as any) : {};
      const slot = isFiniteNumber(p.slot) ? toInt(p.slot) : -1;
      if (slot < 0 || slot >= this.invManager.INV_SLOTS) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      const stack = inv.slots[slot] as any;
      if (!stack || stack.id <= 0 || stack.count <= 0) return;

      let newArchetype: string | null = null;
      if (stack.id === Items.STONE_IRON) newArchetype = "IRON";
      else if (stack.id === Items.STONE_SHADOW) newArchetype = "SHADOW";
      else if (stack.id === Items.STONE_BLOOD) newArchetype = "BLOOD";
      else if (stack.id === Items.STONE_ASTRAL) newArchetype = "ASTRAL";

      if (newArchetype) {
        stack.count -= 1;
        if (stack.count <= 0) inv.slots[slot] = { id: 0, count: 0 } as any;

        inv.stats.auraArchetype = newArchetype;
        c.aura.setArchetype(newArchetype as any);

        this.invManager.inventoryAdd(inv, { id: Items.SKILL_AURA_SLASH, count: 1 } as any);
        this.invManager.inventoryAdd(inv, { id: Items.SKILL_AURA_HEAVY, count: 1 } as any);
        this.invManager.inventoryAdd(inv, { id: Items.SKILL_AURA_THRUST, count: 1 } as any);

        this.invManager.saveInventory(pl.userId, inv);
        this.invManager.sendInvStateToClient(client, inv);
        c.onSync?.(c.snapshot());

        client.send("chatMessage", { msg: `AWAKENED! You are now bound to the ${newArchetype} Essence.` });
      }
    });

    this.onMessage("startMine", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<StartMineMsg>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      const x = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));
      const heldSlot = isFiniteNumber((p as any).heldSlot) ? toInt((p as any).heldSlot) : -1;

      if (this.isInSafeZoneXZ(x, z)) return this.cancelMiningFor(client, "safe_zone");

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const dx = x + 0.5 - pl.x; const dy = y + 0.5 - pl.y; const dz = z + 0.5 - pl.z;
      if (dx * dx + dy * dy + dz * dz > this.mineReach * this.mineReach) return this.cancelMiningFor(client, "too_far");

      const blockId = this.getBlockAt(x, y, z);
      if (blockId === this.AIR_ID) return this.cancelMiningFor(client, "air");
      if (blockId === this.BEDROCK_ID) return this.cancelMiningFor(client, "bedrock");

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      const cur = this.mining.get(client.sessionId);
      const now = Date.now();

      if (cur && cur.x === x && cur.y === y && cur.z === z) {
        cur.lastHeartbeatAt = now;
        cur.heldSlot = heldSlot;
        if (this.getBlockAt(x, y, z) !== cur.lastBlockId) this.cancelMiningFor(client, "block_changed");
        return;
      }

      if (cur) this.cancelMiningFor(client, "retarget");

      const breakTimeMs = this.computeBreakTimeMs(blockId, inv, heldSlot);
      this.mining.set(client.sessionId, {
        sessionId: client.sessionId, userId: pl.userId, x, y, z, heldSlot,
        startedAt: now, lastHeartbeatAt: now, breakTimeMs,
        lastStageSent: -1, lastProgressSentAt: 0, lastBlockId: blockId,
      });
      client.send("mineProgress", { x, y, z, progress: 0, stage: 0 } satisfies MineProgressMsg);
    });

    this.onMessage("cancelMine", (client: Client, payload: unknown) => {
      const reason = typeof (payload as any)?.reason === "string" ? String((payload as any).reason).slice(0, 60) : "client_cancel";
      this.cancelMiningFor(client, reason);
    });

    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      if (this.isInSafeZoneXZ(x, z)) return;

      const oldId = this.getBlockAt(x, y, z);
      if (oldId === this.AIR_ID || oldId === this.BEDROCK_ID) return;

      const pl = this.players.get(client.sessionId);
      const inv = pl ? this.invManager.getOrLoadInventory(pl.userId) : null;
      const canDrop = this.canBlockDropWithTool(oldId, inv, -1);

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);
      if (canDrop) {
        const dropItem = this.blockIdToDropItemId(oldId);
        if (dropItem > 0) this.spawnDrop(dropItem, 1, x + 0.5, y + 0.65, z + 0.5);
      }
    });

    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<PlaceBlockMsg>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z) || !isFiniteNumber(maybe.id)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));
      const blockId = toInt(clamp(maybe.id, 0, 255));

      if (blockId === this.BEDROCK_ID || this.isInSafeZoneXZ(x, z)) return;
      if (this.getBlockAt(x, y, z) !== this.AIR_ID) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      const fromSlot = isFiniteNumber(maybe.fromSlot) ? toInt(maybe.fromSlot) : -1;
      if (fromSlot < 0 || fromSlot >= this.invManager.HOTBAR_SLOTS) return;

      const stack = inv.slots[fromSlot];
      if (!stack || (stack as any).id <= 0 || (stack as any).count <= 0) return;

      const def = ITEM_DEFS[(stack as any).id];
      if (!def || typeof def.placeBlockId !== "number" || def.placeBlockId !== blockId) return;

      (stack as any).count -= 1;
      if ((stack as any).count <= 0) inv.slots[fromSlot] = { id: 0, count: 0 } as any;

      this.invManager.saveInventory(pl.userId, inv);
      this.invManager.sendInvStateToClient(client, inv);

      const ms = this.mining.get(client.sessionId);
      if (ms && ms.x === x && ms.y === y && ms.z === z) this.cancelMiningFor(client, "placed_on_target");

      this.setBlockAuthoritative(x, y, z, blockId);
    });

    this.onMessage("interact", (client: Client, payload: unknown) => {
        const p = payload as { x: number, y: number, z: number };
        if (!p || !isFiniteNumber(p.x)) return;
        
        const blockId = this.getBlockAt(p.x, p.y, p.z);
        
        if (blockId === this.CHEST_ID) {
            const key = `${p.x},${p.y},${p.z}`;
            const signText = this.signTexts.get(key);
            const loot = this.chestLoot.get(key);
            
            if (signText) {
                client.send("chatMessage", { msg: `📖 ${signText}` });
            } else if (loot && loot.length > 0) {
                const inv = this.invManager.getOrLoadInventory(this.players.get(client.sessionId)!.userId);
                
                let found = "";
                for(const item of loot) {
                    this.invManager.inventoryAdd(inv, item);
                    found += `[${ITEM_DEFS[item.id].name} x${item.count}] `;
                }
                
                this.invManager.saveInventory(this.players.get(client.sessionId)!.userId, inv);
                this.invManager.sendInvStateToClient(client, inv);
                client.send("chatMessage", { msg: `Looted Chest: ${found}` });
                
                this.chestLoot.delete(key);
                this.setBlockAuthoritative(p.x, p.y, p.z, this.AIR_ID); 
                this.spawnDrop(Items.CHEST, 1, p.x + 0.5, p.y + 0.5, p.z + 0.5); 
            } else {
                client.send("chatMessage", { msg: "Chest is empty." });
                this.setBlockAuthoritative(p.x, p.y, p.z, this.AIR_ID);
            }
        }
    });

    this.onMessage("pickupDrop", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const dropId = typeof (payload as any).dropId === "string" ? (payload as any).dropId : "";
      if (!dropId) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const drop = this.drops.get(dropId);
      if (!drop) return;

      if (Date.now() - drop.createdAt > this.DROP_TTL_MS) {
        this.drops.delete(dropId);
        this.broadcast("dropDespawn", { dropId });
        return;
      }

      const dx = drop.x - pl.x; const dy = drop.y - pl.y; const dz = drop.z - pl.z;
      if (dx * dx + dy * dy + dz * dz > 2.6 * 2.6) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      const accepted = this.invManager.inventoryAdd(inv, { id: drop.itemId, count: drop.count });
      if (accepted <= 0) return;

      this.drops.delete(dropId);
      this.broadcast("dropDespawn", { dropId });
      this.invManager.saveInventory(pl.userId, inv);
      this.invManager.sendInvStateToClient(client, inv);
    });

    this.onMessage("invClick", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<InvClickMsg>;
      if (!isFiniteNumber(p.index)) return;

      const index = toInt(p.index);
      let slot = -1;
      if (p.area === "hotbar" && index >= 0 && index < this.invManager.HOTBAR_SLOTS) slot = index;
      else if (p.area === "inv" && index >= 0 && index < this.invManager.BACKPACK_SLOTS) slot = this.invManager.HOTBAR_SLOTS + index;

      if (slot < 0 || slot >= this.invManager.INV_SLOTS) return;

      const button = p.button === "R" ? "R" : "L";
      const shift = !!p.shift;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      this.invManager.applyInvClick(inv, slot, button, shift);
      this.invManager.saveInventory(pl.userId, inv);
      this.invManager.sendInvStateToClient(client, inv);
    });

    this.onMessage("craft", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<CraftMsg>;
      const recipeId = typeof p.recipeId === "string" ? p.recipeId : "";
      if (!recipeId) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.invManager.getOrLoadInventory(pl.userId);
      const recipe = RECIPES.find((r) => r.id === recipeId);
      if (!recipe) return client.send("craftResult", { ok: false, recipeId, crafted: 0, reason: "unknown_recipe" });

      const wantMax = !!p.max;
      const timesReq = isFiniteNumber(p.times) ? clamp(toInt(p.times), 1, 999) : 1;

      const craftableByInputs = () => {
        for (const req of recipe.inputs) if (this.invManager.inventoryCountSlots(inv, req.id) < req.count) return false;
        return true;
      };

      const tryCraftOnce = (): boolean => {
        for (const req of recipe.inputs) if (this.invManager.inventoryCountSlots(inv, req.id) < req.count) return false;
        if (!this.invManager.inventoryCanFit(inv, recipe.output.id, recipe.output.count)) return false;

        for (const req of recipe.inputs) this.invManager.inventoryRemoveSlots(inv, req.id, req.count);
        this.invManager.inventoryAdd(inv, { id: recipe.output.id, count: recipe.output.count });
        return true;
      };

      let crafted = 0;
      if (wantMax) {
        while (crafted < 999 && craftableByInputs()) {
          if (!tryCraftOnce()) break;
          crafted++;
        }
      } else {
        for (let i = 0; i < timesReq; i++) {
          if (!tryCraftOnce()) break;
          crafted++;
        }
      }

      if (crafted <= 0) {
        client.send("craftResult", { ok: false, recipeId, crafted: 0, reason: "missing_inputs_or_space" });
      } else {
        this.invManager.saveInventory(pl.userId, inv);
        this.invManager.sendInvStateToClient(client, inv);
        client.send("craftResult", { ok: true, recipeId, crafted, reason: "" });
      }
    });

    this.onMessage("ping", (client: Client, payload: unknown) => client.send("pong", payload));
  }

  onJoin(client: Client, options: any) {
    const userId = safeUserId(options.userId || client.sessionId);
    
    console.log(`[MyRoom] Player ${client.sessionId} joined as ${userId}.`);
    
    const pl: PlayerInfo = {
      id: client.sessionId,
      userId,
      x: this.TOWN_CENTER_X,
      y: 40,
      z: this.TOWN_CENTER_Z,
      yaw: 0,
      lastMoveAt: Date.now(),
      joinedAt: Date.now(),
      hp: 20, maxHp: 20, mana: 50, maxMana: 50, invulnUntil: 0
    };
    pl.y = this.heightAt(pl.x, pl.z) + 2;

    this.players.set(client.sessionId, pl);
    this.updatePlayerSpatial(client.sessionId, pl.x, pl.z);

    const inv = this.invManager.getOrLoadInventory(userId);
    const c = this.buildCombatant(client, pl, inv);
    this.combatants.set(client.sessionId, c);

    client.send("safeZone", { cx: this.TOWN_CENTER_X, cz: this.TOWN_CENTER_Z, r: this.SAFE_RADIUS, name: "Town of Beginnings" });
    client.send("worldTime", { time: this.worldTime });
    client.send("nextEventTime", { time: this.nextEventAt });
    client.send("youJoined", { x: pl.x, y: pl.y, z: pl.z });
    this.invManager.sendInvStateToClient(client, inv);

    const existing: any[] = [];
    this.players.forEach((p, id) => {
      if (id !== client.sessionId) existing.push({ id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, maxHp: p.maxHp });
    });
    client.send("existingPlayers", existing);

    this.broadcast("playerJoined", { id: client.sessionId, x: pl.x, y: pl.y, z: pl.z, hp: pl.hp, maxHp: pl.maxHp }, { except: client });
    this.drops.forEach(drop => client.send("dropSpawn", drop));

    // --- NEW: Forward late-joiners or missing-token reconnects to the active event ---
    if (this.activeEventRoomId && Date.now() < this.activeEventEndTime) {
        matchMaker.query({ roomId: this.activeEventRoomId }).then(async (rooms) => {
            if (rooms.length > 0) {
                console.log(`[Hub] Forwarding late-joiner ${client.sessionId} to active event.`);
                const reservation = await matchMaker.reserveSeatFor(rooms[0], { userId: pl.userId });
                client.send("joinEvent", reservation);
            } else {
                this.activeEventRoomId = null; 
            }
        }).catch(() => {
            this.activeEventRoomId = null;
        });
    }
  }

  onLeave(client: Client, code?: number) {
    console.log(`[MyRoom] Player ${client.sessionId} left.`);
    this.players.delete(client.sessionId);
    this.combatants.delete(client.sessionId);
    this.removePlayerSpatial(client.sessionId);
    this.cancelMiningFor(client, "left");
    this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("[MyRoom] Disposing Hub Room");
    if (this.eventTimer) this.eventTimer.clear();
  }

  private startEventScheduler(intervalMs: number) {
    this.nextEventAt = Date.now() + intervalMs;
    this.broadcast("nextEventTime", { time: this.nextEventAt });

    this.eventTimer = this.clock.setInterval(async () => {
      this.nextEventAt = Date.now() + intervalMs;
      
      if (this.clients.length === 0) {
          return; 
      }

      const randomEvent = EVENT_ROOM_NAMES[Math.floor(Math.random() * EVENT_ROOM_NAMES.length)];
      console.log(`[Hub] Spawning random event: ${randomEvent}`);
      
      this.broadcast("chatMessage", { msg: `Event starting! Teleporting to ${randomEvent} in 5 seconds...` });

      this.broadcast("nextEventTime", { time: 0 });

      this.clock.setTimeout(async () => {
          try {
            const eventRoom = await matchMaker.createRoom(randomEvent, {});

            this.activeEventRoomId = eventRoom.roomId;
            this.activeEventEndTime = Date.now() + 60_000; 

            for (const client of this.clients) {
              const pl = this.players.get(client.sessionId);
              const reservation = await matchMaker.reserveSeatFor(eventRoom, {
                 userId: pl?.userId || (client as any).userId
              });
              client.send("joinEvent", reservation);
            }
          } catch (e) {
            console.error("[Hub] Failed to create event room:", e);
          }
          
          this.broadcast("nextEventTime", { time: this.nextEventAt });

      }, 5000);
    }, intervalMs);
  }

  // =========================
  // Generic Mob Spawner
  // =========================
  private spawnMob(type: MobType, id: string, x: number, y: number, z: number) {
    let hp = 100;
    let moveSpeedMul = 1.0;
    let attackDmg = 10;
    
    if (type === "zombie") {
        hp = 60;
        moveSpeedMul = 1.3;
        attackDmg = 15;
    } else if (type === "skeleton") {
        hp = 40;
        moveSpeedMul = 1.1;
        attackDmg = 12;
    } else if (type === "npc") {
        hp = 999999;
        moveSpeedMul = 0;
        attackDmg = 0;
    }

    const mob: MobInfo = { 
      id, type, x, y, z, yaw: 0, 
      hp, maxHp: hp, 
      spawnX: x, spawnY: y, spawnZ: z,
      vy: 0,
      tickPhase: id.charCodeAt(id.length - 1) % 5,
      targetId: null,
      lastPos: { x, y, z },
      lastPosTime: Date.now(),
      stuckAccumulator: 0,
      attackCooldown: 0,
      waypoints: [],
      lastPathCalcTime: 0
    };
    this.mobs.set(id, mob);

    const health = new HealthComponent(mob.hp, mob.maxHp);
    const resources = new ResourceComponent(0, 0, 0, 0);
    const aura = new AuraComponent("BASIC", 0, 0, 0);
    const status = new StatusComponent();
    const cooldowns = new CooldownComponent();
    const state = new StateComponent();
    const equipment = new EquipmentComponent(() => 0); 

    const c: Combatant = {
      id,
      faction: "MOB",
      pos: { x, y, z },
      yaw: 0,
      radius: type === "npc" ? 1.5 : 0.4,
      height: type === "npc" ? 6.0 : 1.8,
      health, resources, aura, status, cooldowns, state, equipment,
      armor: type === "npc" ? 9999 : 5, 
      resist: {}, 
      critChance: 0, 
      critMult: 1.0, 
      maxPoise: type === "npc" ? 99999 : 300, 
      poise: type === "npc" ? 99999 : 300,
      blockAngleDeg: 0, 
      blockMitigation: type === "npc" ? 1.0 : 0, 
      dodgeIframesMs: 0, 
      moveSpeedMul, 
      invulnUntil: 0,
      snapshot() {
        return {
          id: this.id, faction: this.faction, pos: { ...this.pos }, yaw: this.yaw,
          radius: this.radius, height: this.height, state: this.state.state,
          hp: this.health.hp, maxHp: this.health.maxHp,
          mana: this.resources.mana, maxMana: this.resources.maxMana,
          aura: this.resources.aura, maxAura: this.resources.maxAura,
          auraTier: this.aura.tier, auraIntensity: this.aura.intensity, burnout: this.aura.burnout,
          poise: this.poise, maxPoise: this.maxPoise,
          armor: this.armor, resist: this.resist, blockAngleDeg: this.blockAngleDeg, blockMitigation: this.blockMitigation, dodgeIframesMs: this.dodgeIframesMs,
          critChance: this.critChance, critMult: this.critMult, moveSpeedMul: this.moveSpeedMul, invulnUntil: this.invulnUntil
        };
      },
      onSync: (snap) => {
        mob.hp = snap.hp;
      }
    };
    this.combatants.set(id, c);
  }

  private spawnDummy(id: string, x: number, y: number, z: number) {
      this.spawnMob("golem", id, x, y, z);
  }

  private spawnProjectile(ownerId: string, x: number, y: number, z: number, tx: number, ty: number, tz: number) {
      const id = `proj_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
      
      const dx = tx - x;
      const dy = ty - y;
      const dz = tz - z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const speed = 1.0; 

      const timeToTarget = dist / speed;
      const gravity = 0.04; 
      const arcY = (0.5 * gravity * timeToTarget * timeToTarget + dy) / timeToTarget;

      const p: Projectile = {
          id, ownerId,
          x, y, z,
          vx: (dx / timeToTarget),
          vy: arcY,
          vz: (dz / timeToTarget),
          damage: 15,
          radius: 0.5,
          createdAt: Date.now()
      };
      
      this.projectiles.set(id, p);
      this.broadcast("projectileSpawn", p);
  }

  private tickProjectiles() {
      const toRemove: string[] = [];
      const now = Date.now();

      for(const [id, p] of this.projectiles) {
          if (now - p.createdAt > 5000) {
              toRemove.push(id);
              continue;
          }

          p.x += p.vx;
          p.y += p.vy;
          p.z += p.vz;
          p.vy -= 0.04; 

          const cx = Math.floor(p.x);
          const cy = Math.floor(p.y);
          const cz = Math.floor(p.z);
          if (this.getBlockAt(cx, cy, cz) !== this.AIR_ID) {
              toRemove.push(id);
              continue;
          }

          for (const pl of this.players.values()) {
              if (pl.id === p.ownerId) continue;
              const dx = pl.x - p.x;
              const dy = (pl.y + 0.9) - p.y; 
              const dz = pl.z - p.z;
              if (dx*dx + dy*dy + dz*dz < 1.0) {
                  const combatant = this.combatants.get(pl.id);
                  if (combatant) {
                      this.combat.applyHit({
                          targetId: pl.id,
                          attackerId: p.ownerId,
                          damage: p.damage,
                          kind: "PHYSICAL",
                          knockback: { x: p.vx * 0.5, y: 0.2, z: p.vz * 0.5 }
                      });
                  }
                  toRemove.push(id);
                  break; 
              }
          }
      }

      for (const id of toRemove) {
          this.projectiles.delete(id);
          this.broadcast("projectileDespawn", { id });
      }
  }

  private handleCombatEvent(e: CombatEvent): void {
    if (e.type === "ATTACK_START") {
      this.broadcast("playerSwing", { id: e.attackerId, attackId: e.attackId });
    } 
    else if (e.type === "HIT") {
      const target: any = this.players.get(e.targetId) || this.mobs.get(e.targetId);
      if (target) {
        if (e.knockback) {
          target.x = clamp(target.x + e.knockback.x, -this.maxAbsCoord, this.maxAbsCoord);
          target.y = clamp(target.y + e.knockback.y, -this.maxAbsCoord, this.maxAbsCoord);
          target.z = clamp(target.z + e.knockback.z, -this.maxAbsCoord, this.maxAbsCoord);
          
          const c = this.combatants.get(target.id);
          if (c) {
            c.pos.x = target.x;
            c.pos.y = target.y;
            c.pos.z = target.z;
          }
          
          this.broadcast("playerTransformOther", { id: target.id, x: target.x, y: target.y, z: target.z, yaw: target.yaw });
        }
        
        this.broadcast("playerHit", {
          attackerId: e.attackerId,
          targetId: e.targetId,
          damage: e.damage,
          hpLeft: target.hp,
          maxHp: target.maxHp,
          knockback: e.knockback,
          kind: e.kind,
          crit: e.crit
        });
      }
    } 
    else if (e.type === "DEATH") {
      const isMob = this.mobs.has(e.targetId);
      const target: any = this.players.get(e.targetId) || this.mobs.get(e.targetId);
      const tc = this.combatants.get(e.targetId);

      if (target && tc) {
        this.broadcast("playerDowned", { id: target.id, by: e.sourceId });
        
        tc.health.setMax(tc.health.maxHp, true);
        tc.resources.mana = tc.resources.maxMana;
        tc.invulnUntil = Date.now() + 1500;
        tc.state.state = "IDLE";

        let rx, ry, rz;

        if (isMob) {
          const m = target as MobInfo;
          rx = m.spawnX; ry = m.spawnY; rz = m.spawnZ;
          tc.poise = tc.maxPoise;
          m.targetId = null;
        } else {
          rx = this.TOWN_CENTER_X;
          rz = this.TOWN_CENTER_Z;
          ry = this.heightAt(rx, rz) + 8;
        }

        target.x = rx; target.y = ry; target.z = rz;
        tc.pos.x = rx; tc.pos.y = ry; tc.pos.z = rz;
        if (!isMob) this.updatePlayerSpatial(target.id, rx, rz);

        this.broadcast("playerRespawn", { 
          id: target.id, 
          x: rx, y: ry, z: rz, 
          hp: tc.health.hp, maxHp: tc.health.maxHp, 
          mana: tc.resources.mana, maxMana: tc.resources.maxMana 
        });
        
        tc.onSync?.(tc.snapshot());
      }
    } 
    else if (e.type === "DODGE") {
      this.broadcast("playerDodge", { id: e.id, dir: e.dir });
    } 
    else if (e.type === "BLOCK") {
      this.broadcast("playerBlock", { id: e.id, active: e.active });
    }
  }

  private buildCombatant(client: Client, pl: PlayerInfo, inv: InvState): Combatant {
    const health = new HealthComponent(inv.stats.hp, inv.stats.maxHp);
    const resources = new ResourceComponent(inv.stats.mana, inv.stats.maxMana, 0, 100);
    
    const archetype = (inv.stats.auraArchetype as any) || "BASIC";
    const aura = new AuraComponent(archetype, 0, 0, 0);
    
    const status = new StatusComponent();
    const cooldowns = new CooldownComponent();
    const state = new StateComponent();
    const equipment = new EquipmentComponent((slot) => {
      const currentInv = this.invManager.getInventory(pl.userId);
      if (!currentInv) return 0;
      const s = currentInv.slots[slot ?? -1] || null;
      return s ? (s as any).id || 0 : 0;
    });

    const c: Combatant = {
      id: client.sessionId,
      faction: "PLAYER",
      pos: { x: pl.x, y: pl.y, z: pl.z },
      yaw: pl.yaw,
      radius: 0.4,
      height: 1.8,
      
      health, resources, aura, status, cooldowns, state, equipment,
      
      armor: 0,
      resist: {},
      critChance: 0.05,
      critMult: 1.5,
      maxPoise: 100,
      poise: 100,
      blockAngleDeg: 120,
      blockMitigation: 0.5,
      dodgeIframesMs: 400,
      moveSpeedMul: 1.0,
      invulnUntil: pl.invulnUntil,
      
      snapshot() {
        return {
          id: this.id, faction: this.faction, pos: { ...this.pos }, yaw: this.yaw,
          radius: this.radius, height: this.height, state: this.state.state,
          hp: this.health.hp, maxHp: this.health.maxHp,
          mana: this.resources.mana, maxMana: this.resources.maxMana,
          aura: this.resources.aura, maxAura: this.resources.maxAura,
          auraTier: this.aura.tier, auraIntensity: this.aura.intensity, burnout: this.aura.burnout,
          poise: this.poise, maxPoise: this.maxPoise,
          armor: this.armor, resist: this.resist, blockAngleDeg: this.blockAngleDeg, blockMitigation: this.blockMitigation, dodgeIframesMs: this.dodgeIframesMs,
          critChance: this.critChance, critMult: this.critMult, moveSpeedMul: this.moveSpeedMul, invulnUntil: this.invulnUntil
        };
      },

      onSync: (snap) => {
        let changed = false;
        
        if (pl.hp !== snap.hp || pl.maxHp !== snap.maxHp || pl.mana !== snap.mana || pl.maxMana !== snap.maxMana) {
          pl.hp = snap.hp;
          pl.maxHp = snap.maxHp;
          pl.mana = snap.mana;
          pl.maxMana = snap.maxMana;
          changed = true;
        }

        if (changed) {
           const currentInv = this.invManager.getOrLoadInventory(pl.userId);
           currentInv.stats.hp = pl.hp;
           currentInv.stats.maxHp = pl.maxHp;
           currentInv.stats.mana = pl.mana;
           currentInv.stats.maxMana = pl.maxMana;
           
           this.invManager.saveInventory(pl.userId, currentInv);

           const cl = this.clients.find(cli => cli.sessionId === pl.id);
           if (cl) {
             cl.send("statsUpdate", { 
               hp: pl.hp, maxHp: pl.maxHp, 
               mana: pl.mana, maxMana: pl.maxMana,
               aura: snap.aura, maxAura: snap.maxAura, burnout: snap.burnout
             });
           }
        }
      }
    };
    
    return c;
  }

  private buildMassiveTownHall(): BlockStructure {
    const blocks: Array<{ x: number; y: number; z: number; id: number }> = [];
    const w = 51;
    const d = 31;
    const h = 12;

    const add = (x: number, y: number, z: number, id: number) => {
      blocks.push({ x, y, z, id });
    };

    const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, id: number) => {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            add(x, y, z, id);
          }
        }
      }
    };

    fill(0, 1, 0, w - 1, h - 1, d - 1, this.AIR_ID);
    fill(0, 0, 0, w - 1, 0, d - 1, this.PLANKS_ID);
    fill(0, 1, 0, w - 1, h - 2, 0, this.STONE_BRICKS_ID); 
    fill(0, 1, d - 1, w - 1, h - 2, d - 1, this.STONE_BRICKS_ID); 
    fill(0, 1, 0, 0, h - 2, d - 1, this.STONE_BRICKS_ID); 
    fill(w - 1, 1, 0, w - 1, h - 2, d - 1, this.STONE_BRICKS_ID); 
    fill(22, 1, 0, 28, 4, 0, this.AIR_ID);
    fill(0, h - 1, 0, w - 1, h - 1, d - 1, this.WOOD_ID);
    fill(1, h, 1, w - 2, h + 1, d - 2, this.LEAVES_ID);
    fill(22, 1, 1, 28, 1, d - 2, this.CARPET_ID);

    fill(15, 1, 1, 15, h - 2, 6, this.PLANKS_ID);
    fill(15, 1, d - 7, 15, h - 2, d - 2, this.PLANKS_ID);
    fill(15, 1, 7, 15, 5, d - 8, this.AIR_ID);

    const makeTable = (tx: number, tz: number) => {
      fill(tx, 1, tz, tx + 2, 1, tz + 2, this.PLANKS_ID); 
      fill(tx, 2, tz, tx + 2, 2, tz + 2, this.MOSS_ID); 
      add(tx - 1, 1, tz + 1, this.PLANKS_ID);
      add(tx + 3, 1, tz + 1, this.PLANKS_ID);
      add(tx + 1, 1, tz - 1, this.PLANKS_ID);
      add(tx + 1, 1, tz + 3, this.PLANKS_ID);
    };
    
    makeTable(3, 4);
    makeTable(9, 4);
    makeTable(3, 12);
    makeTable(9, 12);
    makeTable(3, 20);
    makeTable(9, 20);

    fill(35, 1, 1, 35, h - 2, 6, this.PLANKS_ID);
    fill(35, 1, d - 7, 35, h - 2, d - 2, this.PLANKS_ID);
    fill(35, 1, 7, 35, 5, d - 8, this.AIR_ID);

    const makeStall = (sx: number, sz: number) => {
      fill(sx, 1, sz, sx + 4, 1, sz, this.PLANKS_ID); 
      fill(sx, 1, sz + 1, sx, 1, sz + 3, this.PLANKS_ID); 
      fill(sx + 4, 1, sz + 1, sx + 4, 1, sz + 3, this.PLANKS_ID); 
      add(sx + 1, 2, sz, this.CHEST_ID); 
      add(sx + 3, 2, sz, this.CHEST_ID); 
      fill(sx, 4, sz - 1, sx + 4, 4, sz + 3, this.LEAVES_ID); 
      add(sx, 2, sz, this.WOOD_ID); add(sx, 3, sz, this.WOOD_ID); 
      add(sx + 4, 2, sz, this.WOOD_ID); add(sx + 4, 3, sz, this.WOOD_ID);
    };

    makeStall(38, 4);
    makeStall(38, 12);
    makeStall(38, 20);

    add(16, 10, 15, this.CRYSTAL_ID);
    add(16, 9, 14, this.CRYSTAL_ID); add(16, 9, 16, this.CRYSTAL_ID);
    add(16, 8, 13, this.CRYSTAL_ID); add(16, 8, 17, this.CRYSTAL_ID);
    add(16, 7, 14, this.CRYSTAL_ID); add(16, 7, 16, this.CRYSTAL_ID);
    add(16, 6, 15, this.CRYSTAL_ID);

    add(34, 9, 14, this.GLOW_SHROOM_ID); add(34, 9, 15, this.GLOW_SHROOM_ID); add(34, 9, 16, this.GLOW_SHROOM_ID);
    add(34, 8, 13, this.GLOW_SHROOM_ID); add(34, 8, 17, this.GLOW_SHROOM_ID);
    add(34, 7, 13, this.GLOW_SHROOM_ID); add(34, 7, 17, this.GLOW_SHROOM_ID);
    add(34, 6, 14, this.GLOW_SHROOM_ID); add(34, 6, 15, this.GLOW_SHROOM_ID); add(34, 6, 16, this.GLOW_SHROOM_ID);

    add(22, 6, 6, this.LANTERN_ID);
    add(28, 6, 6, this.LANTERN_ID);
    add(22, 6, 14, this.LANTERN_ID);
    add(28, 6, 14, this.LANTERN_ID);
    add(22, 6, 22, this.LANTERN_ID);
    add(28, 6, 22, this.LANTERN_ID);

    add(25, 1, 3, this.CHEST_ID); 
    add(16, 1, 15, this.CHEST_ID); 
    add(6, 1, 15, this.CHEST_ID); 
    add(34, 1, 15, this.CHEST_ID); 
    add(44, 1, 15, this.CHEST_ID); 

    return {
      name: "massive_town_hall",
      size: { w, h, d },
      anchor: { x: Math.floor(w / 2), y: 0, z: Math.floor(d / 2) },
      blocks
    };
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);
    const cached = this.chunks.get(key);
    if (cached) return cached;

    const fromDisk = this.readChunkFromDisk(cx, cy, cz);
    if (fromDisk) {
      try {
        this.worldGen.stampTownIntoChunk(fromDisk, cx, cy, cz);
        this.writeChunkToDisk(cx, cy, cz, fromDisk);
      } catch (e) {}
      this.chunks.set(key, fromDisk);
      return fromDisk;
    }

    const gen = this.worldGen.generateChunk(cx, cy, cz);
    this.chunks.set(key, gen);
    return gen;
  }

  private getBlockAt(x: number, y: number, z: number): number {
    const CS = this.chunkSize;
    return this.getOrCreateChunk(floorDiv(x, CS), floorDiv(y, CS), floorDiv(z, CS))[this.worldGen["idx"](mod(x, CS), mod(y, CS), mod(z, CS))] | 0;
  }

  private setBlockAuthoritative(x: number, y: number, z: number, id: number): void {
    const CS = this.chunkSize;
    const cx = floorDiv(x, CS); const cy = floorDiv(y, CS); const cz = floorDiv(z, CS);
    const chunk = this.getOrCreateChunk(cx, cy, cz);
    const v = clamp(toInt(id), 0, 255);
    chunk[this.worldGen["idx"](mod(x, CS), mod(y, CS), mod(z, CS))] = v;

    try { this.writeChunkToDisk(cx, cy, cz, chunk); } catch (e) {}
    this.broadcast("blockUpdate", { x, y, z, id: v });
  }

  private cleanupDrops(): void {
    if (this.drops.size <= 0) return;
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, d] of this.drops.entries()) if (now - d.createdAt > this.DROP_TTL_MS) expired.push(id);
    for (const id of expired) { this.drops.delete(id); this.broadcast("dropDespawn", { dropId: id }); }
  }

  private spawnDrop(itemId: number, count: number, x: number, y: number, z: number): void {
    const id = `d_${Date.now().toString(16)}_${(this.nextDropSeq++).toString(16)}`;
    const drop: Drop = { dropId: id, itemId: clamp(toInt(itemId), 1, 999999), count: clamp(toInt(count), 1, 999999), x, y, z, createdAt: Date.now() };
    this.drops.set(id, drop);
    this.broadcast("dropSpawn", drop);
  }

  private blockIdToDropItemId(blockId: number): number {
    if (blockId === this.GRASS_ID) return Items.GRASS;
    if (blockId === this.DIRT_ID) return Items.DIRT;
    if (blockId === this.STONE_ID) return Items.STONE;
    if (blockId === this.WOOD_ID) return Items.WOOD_LOG;
    if (blockId === this.LEAVES_ID) return Items.LEAVES;
    if (blockId === this.SAND_ID) return Items.SAND;
    if (blockId === this.SNOW_ID) return Items.SNOW;
    if (blockId === this.COAL_ORE_ID) return Items.COAL;
    if (blockId === this.IRON_ORE_ID) return Items.RAW_IRON;
    if (blockId === this.GOLD_ORE_ID) return Items.RAW_GOLD;
    if (blockId === this.DIAMOND_ORE_ID) return Items.DIAMOND;
    if (blockId === this.PLANKS_ID) return Items.PLANKS;
    if (blockId === this.STONE_BRICKS_ID) return Items.STONE_BRICKS;
    if (blockId === this.CARPET_ID) return Items.CARPET;
    if (blockId === this.GLASS_ID) return Items.GLASS;
    if (blockId === this.LANTERN_ID) return Items.LANTERN;
    return 0; 
  }

  private isStoneLike(blockId: number): boolean { 
    return (blockId === this.STONE_ID || blockId === this.COAL_ORE_ID || blockId === this.IRON_ORE_ID || blockId === this.GOLD_ORE_ID || blockId === this.DIAMOND_ORE_ID || blockId === this.DEEPSLATE_ID || blockId === this.TUFF_ID || blockId === this.MOSSY_STONE_ID || blockId === this.DRIPSTONE_BLOCK_ID || blockId === this.STONE_BRICKS_ID); 
  }
  
  private requiredPickTierForDrops(blockId: number): number {
    if (blockId === this.STONE_ID || blockId === this.STONE_BRICKS_ID || blockId === this.COAL_ORE_ID || blockId === this.IRON_ORE_ID || blockId === this.DEEPSLATE_ID || blockId === this.TUFF_ID) return 1;
    if (blockId === this.GOLD_ORE_ID || blockId === this.DIAMOND_ORE_ID) return 3;
    return 0;
  }

  private canBlockDropWithTool(blockId: number, inv: InvState | null, heldSlot = -1): boolean {
    if (blockId === this.BEDROCK_ID) return false;
    const reqTier = this.requiredPickTierForDrops(blockId);
    if (reqTier <= 0) return true;
    if (!inv) return false;
    const picked = this.invManager.choosePickStack(inv, heldSlot);
    return picked ? picked.tool.tier >= reqTier : false;
  }

  private computeBreakTimeMs(blockId: number, inv: InvState, heldSlot = -1): number {
    let base = 450;
    
    if (blockId === this.LEAVES_ID) base = 180; 
    else if (blockId === this.GLASS_ID || blockId === this.LANTERN_ID) base = 150;
    else if (blockId === this.CARPET_ID) base = 250;
    else if (blockId === this.GRASS_ID || blockId === this.DIRT_ID) base = 420; 
    else if (blockId === this.SAND_ID || blockId === this.SNOW_ID) base = 360; 
    else if (blockId === this.WOOD_ID || blockId === this.PLANKS_ID) base = 950; 
    else if (blockId === this.STONE_ID || blockId === this.STONE_BRICKS_ID) base = 1250; 
    else if (blockId === this.TUFF_ID) base = 1350; 
    else if (blockId === this.COAL_ORE_ID) base = 1400; 
    else if (blockId === this.IRON_ORE_ID) base = 1650; 
    else if (blockId === this.DEEPSLATE_ID) base = 1800; 
    else if (blockId === this.GOLD_ORE_ID) base = 2200; 
    else if (blockId === this.DIAMOND_ORE_ID) base = 2850; 
    else if (blockId === this.BEDROCK_ID) return 999999999;
    
    const picked = this.invManager.choosePickStack(inv, heldSlot);
    if (this.isStoneLike(blockId)) base = picked ? Math.floor(base * picked.tool.speedMul) : Math.floor(base * 2.8);
    else if ((blockId === this.WOOD_ID || blockId === this.PLANKS_ID) && picked) base = Math.floor(base * 0.92);

    return clamp(base, 80, 12000);
  }

  private cancelMiningFor(client: Client, reason: string): void {
    const st = this.mining.get(client.sessionId);
    if (!st) return;
    this.mining.delete(client.sessionId);
    client.send("mineCancelled", { reason });
  }

  private tickMining(): void {
    const now = Date.now();
    for (const [sid, st] of this.mining.entries()) {
      const client = this.clients.find((c) => c.sessionId === sid);
      const pl = this.players.get(sid);
      if (!client || !pl) { this.cancelMiningFor(client!, "no_player"); continue; }
      if (now - st.lastHeartbeatAt > this.mineHeartbeatTimeoutMs) { this.cancelMiningFor(client, "timeout"); continue; }
      if (this.isInSafeZoneXZ(st.x, st.z)) { this.cancelMiningFor(client, "safe_zone"); continue; }

      const dx = st.x + 0.5 - pl.x; const dy = st.y + 0.5 - pl.y; const dz = st.z + 0.5 - pl.z;
      if (dx * dx + dy * dy + dz * dz > this.mineReach * this.mineReach) { this.cancelMiningFor(client, "too_far"); continue; }

      const currentId = this.getBlockAt(st.x, st.y, st.z);
      if (currentId === this.AIR_ID || currentId === this.BEDROCK_ID || currentId !== st.lastBlockId) { this.cancelMiningFor(client, "block_changed"); continue; }

      const inv = this.invManager.getOrLoadInventory(st.userId);
      const newBreak = this.computeBreakTimeMs(currentId, inv, st.heldSlot);
      if (newBreak !== st.breakTimeMs) {
        const p = st.breakTimeMs > 0 ? Math.max(0, now - st.startedAt) / st.breakTimeMs : 0;
        st.breakTimeMs = newBreak; st.startedAt = now - Math.floor(p * st.breakTimeMs);
      }

      const progress01 = clamp(Math.max(0, now - st.startedAt) / Math.max(1, st.breakTimeMs), 0, 1);
      const stage = clamp(Math.floor(progress01 * 10), 0, 9);

      if (stage !== st.lastStageSent || now - st.lastProgressSentAt >= this.mineProgressSendMinMs || progress01 >= 1) {
        st.lastStageSent = stage; st.lastProgressSentAt = now;
        const msg: MineProgressMsg = { x: st.x, y: st.y, z: st.z, progress: progress01, stage };

        if (progress01 >= 1) {
          const picked = this.invManager.choosePickStack(inv, st.heldSlot);
          const canDrop = this.canBlockDropWithTool(currentId, inv, st.heldSlot);

          this.setBlockAuthoritative(st.x, st.y, st.z, this.AIR_ID);
          if (canDrop) {
            const dropItem = this.blockIdToDropItemId(currentId);
            if (dropItem > 0) this.spawnDrop(dropItem, 1, st.x + 0.5, st.y + 0.65, st.z + 0.5);
          }

          if (picked && this.isStoneLike(currentId)) {
            this.invManager.damageTool(inv, picked.slotIndex);
            this.invManager.saveInventory(st.userId, inv);
            this.invManager.sendInvStateToClient(client, inv);
          }

          msg.done = true; client.send("mineProgress", msg); this.mining.delete(sid);
        } else {
          client.send("mineProgress", msg);
        }
      }
    }
  }

  public heightAt(worldX: number, worldZ: number): number {
    return this.worldGen.heightAt(worldX, worldZ);
  }

  public isInSafeZoneXZ(worldX: number, worldZ: number): boolean {
    if(!this.worldGen) {
        const dx = worldX - this.TOWN_CENTER_X; 
        const dz = worldZ - this.TOWN_CENTER_Z;
        return dx * dx + dz * dz <= this.SAFE_RADIUS * this.SAFE_RADIUS;
    }
    return this.worldGen.isInSafeZoneXZ(worldX, worldZ);
  }
}