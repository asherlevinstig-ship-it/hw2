// server/src/rooms/MyRoom.ts
// FULL FILE - No Omits
// Option B (server authoritative chunks) + multiplayer + persistence + Chest Debug Logs

import { Room, Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";

// Shared items (single source of truth) - NodeNext requires ".js"
import {
  Items,
  ITEM_DEFS,
  RECIPES,
  type ItemStack as SharedItemStack,
} from "../shared/items.js";

// Path B: load pre-expanded block structures
import {
  loadBlockStructure,
  type BlockStructure,
} from "../shared/structureLoader.js";

// Combat System Imports
import { 
  CombatSystem, 
  type CombatEvent, 
  type CombatSnapshot, 
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

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  id: string;
  chunkSize: number;
  x: number; // NOA chunk coord (often chunk ORIGIN)
  y: number;
  z: number;
};

type ChunkDataMsg = {
  id: string;
  chunkSize: number;
  // echo request coords exactly so client pending check passes
  x: number;
  y: number;
  z: number;
  voxels: Uint8Array;
};

type PlayerInfo = {
  id: string; // sessionId
  userId: string; // persistent id from client localStorage
  x: number;
  y: number;
  z: number;
  yaw: number;
  lastMoveAt: number;
  joinedAt: number;
  
  // Stats (Authoritative truth synced from Combatant)
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  invulnUntil: number;
};

type MobInfo = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
  vy: number; // Vertical velocity for gravity and jumping
  tickPhase: number; // For interleaved AI ticking
  targetId: string | null; // Cached aggro target

  // Stuck/Frustration Logic
  lastPos: { x: number, y: number, z: number };
  lastPosTime: number;
  stuckAccumulator: number; // ms stuck
  attackCooldown: number;   // ms until next attack/throw
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

type ItemStack = SharedItemStack;

type PlayerStats = {
  hp: number;
  maxHp: number;      // in hp units (2 per heart)
  mana: number;
  maxMana: number;
  auraArchetype: string; // Added for Awakening System
};

type InvState = {
  slots: ItemStack[]; // HOTBAR + BACKPACK
  cursor: ItemStack;
  stats: PlayerStats;
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
  id: number; // blockId to place
  fromSlot?: number; // hotbar index to consume from
};

type StartMineMsg = { x: number; y: number; z: number; heldSlot?: number };
type MineProgressMsg = {
  x: number;
  y: number;
  z: number;
  progress: number; // 0..1
  stage: number; // 0..9
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
  startedAt: number; // ms
  lastHeartbeatAt: number; // ms
  breakTimeMs: number;
  lastStageSent: number;
  lastProgressSentAt: number;
  lastBlockId: number;
};

// =========================
// Cave Biome Typings
// =========================
type CaveBiome = "LUSH" | "DRIPSTONE" | "DEEP_DARKISH" | "CRYSTAL" | "TUFFY";

type OreDef = {
  id: number;
  minY: number;
  peakY: number;
  maxY: number;
  baseChance: number; // chance per solid block *at peak*
  veinSize: [number, number]; // min,max
};

// =========================
// Client Message Typings
// =========================
type UseManaMsg = {
  amount: number;
  reason?: string;
};

type AddContainerMsg = {
  kind: "heart" | "mana";
  amount?: number; // default 1 container
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

/** =========================
 * POIs (region grid)
 * ========================= */
type PoiType = "HUT";
type PoiTier = "COMMON" | "RARE" | "LEGENDARY";

type PoiCandidate = {
  exists: boolean;
  rx: number;
  rz: number;
  x0: number; // world origin for placement (min corner)
  y0: number;
  z0: number;
  rot: 0 | 90 | 180 | 270;
  tier: PoiTier;
  type: PoiType;
  // world bbox inclusive
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type StampOp = { dx: number; dy: number; dz: number; id: number };

export class MyRoom extends Room {
  // =========================
  // Constants
  // =========================
  private readonly chunkSize = 32; // MUST match client
  private readonly baseHeight = 12;

  private readonly HOTBAR_SLOTS = 5;
  private readonly BACKPACK_SLOTS = 20;
  private readonly INV_SLOTS = this.HOTBAR_SLOTS + this.BACKPACK_SLOTS;

  // Block IDs (MUST match client)
  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;
  private readonly WOOD_ID = 4;
  private readonly LEAVES_ID = 5;

  // Minerals + bedrock (MUST match client)
  private readonly BEDROCK_ID = 6;
  private readonly CHEST_ID = 8; // Loot Chest
  private readonly COAL_ORE_ID = 30; 
  private readonly IRON_ORE_ID = 31; 
  private readonly GOLD_ORE_ID = 32; 
  private readonly DIAMOND_ORE_ID = 33; 

  // Biome surface blocks (MUST match client)
  private readonly SAND_ID = 11;
  private readonly SNOW_ID = 12;

  // ===== CAVE BIOME BLOCKS =====
  private readonly DEEPSLATE_ID = 90;
  private readonly TUFF_ID = 91;
  private readonly MOSS_ID = 92;
  private readonly MOSSY_STONE_ID = 93;
  private readonly DRIPSTONE_ID = 94;
  private readonly DRIPSTONE_BLOCK_ID = 95;
  private readonly GLOW_SHROOM_ID = 96;
  private readonly CRYSTAL_ID = 97;

  private readonly CaveBiomeRules: Record<
    CaveBiome,
    {
      wall: number;
      floor: number;
      ceil: number;
      deco?: {
        chance: number;
        place: (ctx: { x: number; y: number; z: number; rand: () => number }) => number | null;
      }[];
    }
  > = {
    LUSH: {
      wall: this.MOSSY_STONE_ID,
      floor: this.MOSS_ID,
      ceil: this.MOSSY_STONE_ID,
      deco: [{ chance: 0.03, place: ({ rand }) => (rand() < 0.5 ? this.GLOW_SHROOM_ID : null) }],
    },
    DRIPSTONE: {
      wall: this.DRIPSTONE_BLOCK_ID,
      floor: this.DRIPSTONE_BLOCK_ID,
      ceil: this.DRIPSTONE_BLOCK_ID,
      deco: [{ chance: 0.06, place: ({ rand }) => (rand() < 0.7 ? this.DRIPSTONE_ID : null) }],
    },
    DEEP_DARKISH: {
      wall: this.DEEPSLATE_ID,
      floor: this.DEEPSLATE_ID,
      ceil: this.DEEPSLATE_ID,
    },
    CRYSTAL: {
      wall: this.STONE_ID,
      floor: this.STONE_ID,
      ceil: this.STONE_ID,
      deco: [{ chance: 0.02, place: ({ rand }) => (rand() < 0.8 ? this.CRYSTAL_ID : null) }],
    },
    TUFFY: {
      wall: this.TUFF_ID,
      floor: this.TUFF_ID,
      ceil: this.TUFF_ID,
    },
  };

  private readonly ORES: OreDef[] = [
    { id: this.COAL_ORE_ID, minY: 15, peakY: 45, maxY: 90, baseChance: 0.06, veinSize: [6, 14] },
    { id: this.IRON_ORE_ID, minY: 10, peakY: 28, maxY: 70, baseChance: 0.05, veinSize: [4, 10] },
    { id: this.GOLD_ORE_ID, minY: 5, peakY: 16, maxY: 35, baseChance: 0.025, veinSize: [3, 8] },
    { id: this.DIAMOND_ORE_ID, minY: -10, peakY: 5, maxY: 18, baseChance: 0.012, veinSize: [2, 6] },
  ];

  // Drops cleanup
  private readonly DROP_TTL_MS = 3 * 60 * 1000; // 3 minutes
  private readonly DROP_CLEANUP_EVERY_MS = 5000;

  // Movement / safety
  private readonly minMoveIntervalMs = 60;
  private readonly snapshotIntervalMs = 500;
  private readonly maxAbsCoord = 100000;
  private readonly maxSpeedBlocksPerSec = 18;

  private lastMoveLogAt = 0;
  private lastSnapshotLogAt = 0;

  // Mining: hold-to-mine
  private readonly mineTickMs = 50;
  private readonly mineHeartbeatTimeoutMs = 450;
  private readonly mineReach = 6.0;
  private readonly mineProgressSendMinMs = 80;

  // Day/Night Cycle
  private worldTime = 0; // 0.0 to 1.0 (0=midnight, 0.5=noon)
  private readonly DAY_DURATION_MS = 1200000; // 20 minutes per day

  // Biomes
  private readonly BIOME_FOREST = 1;
  private readonly BIOME_DESERT = 2;
  private readonly BIOME_SNOW = 3;

  // POIs (region grid)
  private readonly REGION_SIZE = 128;
  private readonly POI_CHANCE = 0.13;
  private readonly POI_EDGE_PAD = 16;

  // =========================
  // Town of Beginnings (safe zone)
  // MASSIVE EXPANSION VARIABLES
  // =========================
  private readonly TOWN_CENTER_X = 0;
  private readonly TOWN_CENTER_Z = 0;
  private readonly SAFE_RADIUS = 64; 

  private readonly TOWN_PLAZA_RADIUS = 24; 
  private readonly TOWN_RING_RADIUS = 56;  
  private readonly TOWN_PATH_HALF_W = 3;  
  private readonly TOWN_CLEAR_HEIGHT = 24; 

  // =========================
  // Stats & Mana Constants
  // =========================
  private readonly HP_PER_HEART = 2;
  private readonly DEFAULT_HEARTS = 10;            
  private readonly DEFAULT_MANA_CONTAINERS = 5;  
  private readonly MANA_PER_CONTAINER = 10;        

  // =========================
  // World meta / seed
  // =========================
  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");
  private readonly invDir = path.join(this.worldDir, "inventories");
  private readonly metaPath = path.join(this.worldDir, "meta.json");
  private worldSeed = 0;

  // =========================
  // State Maps
  // =========================
  private players = new Map<string, PlayerInfo>();
  private mobs = new Map<string, MobInfo>();
  private chunks = new Map<string, Uint8Array>();
  private drops = new Map<string, Drop>();
  private projectiles = new Map<string, Projectile>(); // NEW: Projectiles
  private nextDropSeq = 1;
  private mining = new Map<string, MiningState>(); 
  private inventories = new Map<string, InvState>();
  private chestLoot = new Map<string, SharedItemStack[]>(); // Key: "x,y,z"
  
  // =========================
  // Spatial Hashing (50+ Player Scaling)
  // =========================
  private playerChunks = new Map<string, string>(); // sessionId -> "cx,cz"
  private spatialGrid = new Map<string, Set<string>>(); // "cx,cz" -> Set<sessionId>
  private combatTickCount = 0;

  // =========================
  // Combat System
  // =========================
  private combat!: CombatSystem;
  private combatants = new Map<string, Combatant>();

  // =========================
  // Structures
  // =========================
  private townHall: BlockStructure | null = null;

  // =========================
  // Spatial Hashing Helpers
  // =========================
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
  // onCreate
  // =========================
  onCreate(options: any) {
    console.log("MyRoom created", options);
    this.maxClients = 64;
    this.autoDispose = false;

    this.ensureDirs();
    console.log("[WORLD] persistence dirs:", { chunks: this.chunksDir, inventories: this.invDir });
    this.worldSeed = this.loadOrCreateWorldSeed(options);

    // Initialize Component-Based Combat Engine
    this.combat = new CombatSystem({
      isSafeZoneXZ: (x, z) => this.isInSafeZoneXZ(x, z),
      getBlockAt: (x, y, z) => this.getBlockAt(x, y, z),
      isCombatAllowedXZ: (x, z) => this.isCombatAllowedHere(x, z),
      emit: (e) => this.handleCombatEvent(e),
      getAllCombatants: () => Array.from(this.combatants.values()),
      AIR_ID: this.AIR_ID
    });

    // Spawn initial dummy
    this.spawnDummy("target_dummy_1", -77, 18, -2);

    // Start Combat & Physics Tick Loop
    let lastCombatTick = Date.now();
    this.clock.setInterval(() => {
      const now = Date.now();
      const dt = now - lastCombatTick;
      this.combat.tick(dt);
      lastCombatTick = now;
      this.combatTickCount++;

      // Day/Night Cycle Tick
      this.worldTime = (this.worldTime + (dt / this.DAY_DURATION_MS)) % 1;

      this.tickProjectiles(); // Move projectiles every tick

      // Upgraded Mob AI: Interleaved, Chunk-Sleep, Spatial Aggro, Stuck Check
      for (const mob of this.mobs.values()) {
        const c = this.combatants.get(mob.id);
        if (!c || c.health.isDead() || c.state.isStaggered()) continue;

        // Reduce cooldowns
        if (mob.attackCooldown > 0) mob.attackCooldown -= dt;

        let isMoving = false;

        // 1. Determine Chunk Sleep State
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

        // Chunk Sleep: Skip all AI and physics if no players are nearby
        if (!hasLocalPlayers) continue;

        // 2. Interleaved Target Finding (Only run AI every 5th tick based on mob identity)
        if (this.combatTickCount % 5 === mob.tickPhase) {
          // STUCK CHECK LOGIC
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
          let closestDist = 16.0; // Aggro Radius

          for (const pl of nearbyPlayers) {
            const pdx = pl.x - c.pos.x;
            const pdy = pl.y - c.pos.y;
            const pdz = pl.z - c.pos.z;
            const dist = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz);
            
            if (dist < closestDist) {
              closestDist = dist;
              nearestPlayerId = pl.id;
            }
          }
          mob.targetId = nearestPlayerId;
        }

        // 3. Gravity & Ground Check (Runs every tick for active chunks)
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

        // Horizontal movement intent
        let targetDx = 0;
        let targetDz = 0;
        let intentDist = 0;

        // 4. Frustration / Stuck State: Throw Rock
        if (mob.stuckAccumulator > 3000 && mob.targetId && mob.attackCooldown <= 0) {
            const target = this.players.get(mob.targetId);
            if (target) {
                // Face target
                const pdx = target.x - c.pos.x;
                const pdz = target.z - c.pos.z;
                mob.yaw = Math.atan2(pdx, pdz);
                c.yaw = mob.yaw;

                // Fire Projectile
                this.spawnProjectile(mob.id, c.pos.x, c.pos.y + 1.5, c.pos.z, target.x, target.y + 1.0, target.z);
                
                // Trigger animation via fake attack event
                this.broadcast("playerSwing", { id: mob.id, attackId: "SLAM" });

                // Reset stuck timer & set cooldown
                mob.stuckAccumulator = 0;
                mob.attackCooldown = 2500;
                continue; // Skip movement this tick
            }
        }

        // 5. State: CHASE
        if (mob.targetId && mob.attackCooldown <= 0) {
          const target = this.players.get(mob.targetId);
          if (target) {
            targetDx = target.x - c.pos.x;
            targetDz = target.z - c.pos.z;
            intentDist = Math.sqrt(targetDx * targetDx + targetDz * targetDz);

            mob.yaw = Math.atan2(targetDx, targetDz);
            c.yaw = mob.yaw;

            if (intentDist <= 1.8) {
               if (c.state.canStartAttack()) {
                 this.combat.requestAttack(mob.id, { attackId: "UNARMED" });
               }
               intentDist = 0;
            }
          } else {
            mob.targetId = null; // Lost target
          }
        } 
        // 6. State: RETURN TO SPAWN
        if (!mob.targetId) {
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

        // 7. Apply Horizontal Movement & Jumping
        if (intentDist > 0) {
          const speed = mob.targetId ? (0.08 * c.moveSpeedMul) : Math.min(intentDist, 0.05);
          const moveX = (targetDx / intentDist) * speed;
          const moveZ = (targetDz / intentDist) * speed;

          const nextX = c.pos.x + moveX;
          const nextZ = c.pos.z + moveZ;

          const nextCx = Math.floor(nextX);
          const nextCz = Math.floor(nextZ);
          
          const blockAtNextFoot = this.getBlockAt(nextCx, Math.floor(c.pos.y + 0.1), nextCz);
          const blockAtNextHead = this.getBlockAt(nextCx, Math.floor(c.pos.y + 1.1), nextCz);

          if (blockAtNextFoot !== this.AIR_ID || blockAtNextHead !== this.AIR_ID) {
            const blockAboveHead = this.getBlockAt(nextCx, Math.floor(c.pos.y + 2.1), nextCz);
            
            if (grounded && blockAtNextFoot !== this.AIR_ID && blockAtNextHead === this.AIR_ID && blockAboveHead === this.AIR_ID) {
              mob.vy = 0.35;
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

    // Broadcast World Time (Every 1 second)
    this.clock.setInterval(() => {
        this.broadcast("worldTime", { time: this.worldTime });
        // Save persistantly
        if (this.combatTickCount % 200 === 0) { // Every 10s
             this.writeWorldMeta({ worldSeed: this.worldSeed }); // Will update to include time below
        }
    }, 1000);

    // Dynamic Dharma Spawners
    this.clock.setInterval(() => {
      for (const [chunkKey, playerIds] of this.spatialGrid.entries()) {
        if (playerIds.size === 0) continue;
        const [cxStr, czStr] = chunkKey.split(',');
        const cx = parseInt(cxStr);
        const cz = parseInt(czStr);

        let mobsInChunk = 0;
        for (const m of this.mobs.values()) {
          const mcx = Math.floor(m.x / this.chunkSize);
          const mcz = Math.floor(m.z / this.chunkSize);
          if (mcx === cx && mcz === cz) mobsInChunk++;
        }

        // Night time (0.8 - 0.2) allows higher mob density
        const isNight = this.worldTime < 0.2 || this.worldTime > 0.8;
        const limit = isNight ? 5 : 2;

        // Station dispensing limit per active chunk
        if (mobsInChunk < limit) {
           const pId = Array.from(playerIds)[0];
           const p = this.players.get(pId);
           if (p) {
             const spawnX = p.x + (Math.random() * 24 - 12);
             const spawnZ = p.z + (Math.random() * 24 - 12);
             // Avoid spawning too close to player or in safe zone
             const distToP = Math.sqrt((spawnX - p.x)**2 + (spawnZ - p.z)**2);
             if (distToP > 8 && !this.isInSafeZoneXZ(spawnX, spawnZ)) {
                 const spawnY = this.heightAt(spawnX, spawnZ) + 1;
                 const id = `golem_${Date.now().toString(16)}_${Math.floor(Math.random()*1000)}`;
                 this.spawnDummy(id, spawnX, spawnY, spawnZ);
             }
           }
        }
      }
    }, 5000);

    // GENERATE MASSIVE PROCEDURAL TOWN HALL
    try {
      this.townHall = this.buildMassiveTownHall();
      console.log(`[STRUCT] Massive TownHall generated in-memory. Blocks: ${this.townHall?.blocks?.length ?? 0}`);
    } catch (e) {
      console.error("[STRUCT] FATAL: TownHall failed to generate!", (e as Error).message);
      this.townHall = null;
    }

    // players + mobs snapshot
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

    // mining + drops
    this.clock.setInterval(() => this.tickMining(), this.mineTickMs);
    this.clock.setInterval(() => this.cleanupDrops(), this.DROP_CLEANUP_EVERY_MS);

    // =========================
    // Cave Teleport Developer Tool (SPIRAL RADAR)
    // =========================
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

    // =========================
    // Chunk streaming
    // =========================
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

    // =========================
    // Movement
    // =========================
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
      const yaw = isFiniteNumber(maybe.yaw) ? maybe.yaw : pl.yaw;

      const dtSec = Math.max(0.001, (now - Math.max(0, pl.lastMoveAt)) / 1000);
      const maxDist = this.maxSpeedBlocksPerSec * dtSec;

      const dx = x - pl.x; const dy = y - pl.y; const dz = z - pl.z;
      if (dx * dx + dy * dy + dz * dz > maxDist * maxDist * 9) return;

      pl.x = x; pl.y = y; pl.z = z; pl.yaw = yaw; pl.lastMoveAt = now;
      this.updatePlayerSpatial(client.sessionId, x, z);

      // Sync to Combatant
      const c = this.combatants.get(client.sessionId);
      if (c) {
        c.pos.x = x; c.pos.y = y; c.pos.z = z; c.yaw = yaw;
      }

      this.broadcast("playerTransformOther", { id: client.sessionId, x, y, z, yaw }, { except: client });
    });

    // =========================
    // Class Selection Handler
    // =========================
    this.onMessage("selectClass", (client: Client, payload: unknown) => {
      const p = payload as { classId?: string };
      if (!p || typeof p.classId !== "string") return;

      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const inv = this.getOrLoadInventory(pl.userId);
      
      for (let i = 0; i < this.HOTBAR_SLOTS; i++) {
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

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);
      c.onSync?.(c.snapshot());

      client.send("chatMessage", { msg: `You have awakened as ${p.classId}.` });
    });

    // =========================
    // Combat Listeners
    // =========================
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

    // =========================
    // Stats: Use Mana
    // =========================
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

    // =========================
    // Stats: Add Container (Heart/Mana)
    // =========================
    this.onMessage("addContainer", (client: Client, payload: unknown) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const p = (typeof payload === "object" && payload) ? (payload as Partial<AddContainerMsg>) : {};
      const kind = p.kind === "mana" ? "mana" : "heart";
      const amt = isFiniteNumber(p.amount) ? clamp(toInt(p.amount), 1, 99) : 1;

      if (kind === "heart") {
        const addHp = amt * this.HP_PER_HEART;
        c.health.setMax(c.health.maxHp + addHp, true);
      } else {
        const addMana = amt * this.MANA_PER_CONTAINER;
        c.resources.maxMana = clamp(c.resources.maxMana + addMana, 0, 999999);
        c.resources.mana = c.resources.maxMana;
      }

      c.onSync?.(c.snapshot()); 
      client.send("addContainerResult", { ok: true, kind, hp: c.health.hp, maxHp: c.health.maxHp, mana: c.resources.mana, maxMana: c.resources.maxMana });
    });

    // =========================
    // Item Consumption & Awakening
    // =========================
    this.onMessage("useItem", (client: Client, payload: unknown) => {
      const pl = this.players.get(client.sessionId);
      const c = this.combatants.get(client.sessionId);
      if (!pl || !c) return;

      const p = (typeof payload === "object" && payload) ? (payload as any) : {};
      const slot = isFiniteNumber(p.slot) ? toInt(p.slot) : -1;
      if (slot < 0 || slot >= this.INV_SLOTS) return;

      const inv = this.getOrLoadInventory(pl.userId);
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

        this.inventoryAdd(inv, { id: Items.SKILL_AURA_SLASH, count: 1 } as any);
        this.inventoryAdd(inv, { id: Items.SKILL_AURA_HEAVY, count: 1 } as any);
        this.inventoryAdd(inv, { id: Items.SKILL_AURA_THRUST, count: 1 } as any);

        this.saveInventory(pl.userId, inv);
        this.sendInvStateToClient(client, inv);
        c.onSync?.(c.snapshot());

        client.send("chatMessage", { msg: `AWAKENED! You are now bound to the ${newArchetype} Essence.` });
      }
    });

    // =========================
    // Mining, Placing, Crafting, Inventory ...
    // =========================
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

      const inv = this.getOrLoadInventory(pl.userId);
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
      const inv = pl ? this.getOrLoadInventory(pl.userId) : null;
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

      const inv = this.getOrLoadInventory(pl.userId);
      const fromSlot = isFiniteNumber(maybe.fromSlot) ? toInt(maybe.fromSlot) : -1;
      if (fromSlot < 0 || fromSlot >= this.HOTBAR_SLOTS) return;

      const stack = inv.slots[fromSlot];
      if (!stack || (stack as any).id <= 0 || (stack as any).count <= 0) return;

      const def = ITEM_DEFS[(stack as any).id];
      if (!def || typeof def.placeBlockId !== "number" || def.placeBlockId !== blockId) return;

      (stack as any).count -= 1;
      if ((stack as any).count <= 0) inv.slots[fromSlot] = { id: 0, count: 0 } as any;

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);

      const ms = this.mining.get(client.sessionId);
      if (ms && ms.x === x && ms.y === y && ms.z === z) this.cancelMiningFor(client, "placed_on_target");

      this.setBlockAuthoritative(x, y, z, blockId);
    });

    // Handle Chest Interaction
    this.onMessage("interact", (client: Client, payload: unknown) => {
        const p = payload as { x: number, y: number, z: number };
        if (!p || !isFiniteNumber(p.x)) return;
        
        const blockId = this.getBlockAt(p.x, p.y, p.z);
        console.log(`[CHEST DEBUG] Player interacted at ${p.x}, ${p.y}, ${p.z}. Found blockId: ${blockId}`);
        
        if (blockId === this.CHEST_ID) {
            const key = `${p.x},${p.y},${p.z}`;
            const loot = this.chestLoot.get(key);
            
            if (loot && loot.length > 0) {
                const inv = this.getOrLoadInventory(this.players.get(client.sessionId)!.userId);
                
                let found = "";
                for(const item of loot) {
                    this.inventoryAdd(inv, item);
                    found += `[${ITEM_DEFS[item.id].name} x${item.count}] `;
                }
                
                this.saveInventory(this.players.get(client.sessionId)!.userId, inv);
                this.sendInvStateToClient(client, inv);
                client.send("chatMessage", { msg: `Looted Chest: ${found}` });
                
                // Empty the chest and break it visualy
                this.chestLoot.delete(key);
                this.setBlockAuthoritative(p.x, p.y, p.z, this.AIR_ID); 
                this.spawnDrop(Items.CHEST, 1, p.x + 0.5, p.y + 0.5, p.z + 0.5); // Drop the chest itself
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

      const inv = this.getOrLoadInventory(pl.userId);
      const accepted = this.inventoryAdd(inv, { id: drop.itemId, count: drop.count });
      if (accepted <= 0) return;

      this.drops.delete(dropId);
      this.broadcast("dropDespawn", { dropId });
      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);
    });

    this.onMessage("invClick", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<InvClickMsg>;
      if (!isFiniteNumber(p.index)) return;

      const index = toInt(p.index);
      let slot = -1;
      if (p.area === "hotbar" && index >= 0 && index < this.HOTBAR_SLOTS) slot = index;
      else if (p.area === "inv" && index >= 0 && index < this.BACKPACK_SLOTS) slot = this.HOTBAR_SLOTS + index;

      if (slot < 0 || slot >= this.INV_SLOTS) return;

      const button = p.button === "R" ? "R" : "L";
      const shift = !!p.shift;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.getOrLoadInventory(pl.userId);
      this.applyInvClick(inv, slot, button, shift);
      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);
    });

    this.onMessage("craft", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<CraftMsg>;
      const recipeId = typeof p.recipeId === "string" ? p.recipeId : "";
      if (!recipeId) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.getOrLoadInventory(pl.userId);
      const recipe = RECIPES.find((r) => r.id === recipeId);
      if (!recipe) return client.send("craftResult", { ok: false, recipeId, crafted: 0, reason: "unknown_recipe" });

      const wantMax = !!p.max;
      const timesReq = isFiniteNumber(p.times) ? clamp(toInt(p.times), 1, 999) : 1;

      const craftableByInputs = () => {
        for (const req of recipe.inputs) if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        return true;
      };

      const tryCraftOnce = (): boolean => {
        for (const req of recipe.inputs) if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        if (!this.inventoryCanFit(inv, recipe.output.id, recipe.output.count)) return false;

        for (const req of recipe.inputs) this.inventoryRemoveSlots(inv, req.id, req.count);
        this.inventoryAdd(inv, { id: recipe.output.id, count: recipe.output.count });
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
        this.saveInventory(pl.userId, inv);
        this.sendInvStateToClient(client, inv);
        client.send("craftResult", { ok: true, recipeId, crafted, reason: "" });
      }
    });

    this.onMessage("ping", (client: Client, payload: unknown) => client.send("pong", payload));
  }

  // =========================
  // Spawner Helper
  // =========================
  private spawnDummy(id: string, x: number, y: number, z: number) {
    const mob: MobInfo = { 
      id, x, y, z, yaw: 0, 
      hp: 1000, maxHp: 1000, 
      spawnX: x, spawnY: y, spawnZ: z,
      vy: 0,
      tickPhase: id.charCodeAt(id.length - 1) % 5,
      targetId: null,
      lastPos: { x, y, z },
      lastPosTime: Date.now(),
      stuckAccumulator: 0,
      attackCooldown: 0
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
      radius: 0.4,
      height: 1.8,
      health, resources, aura, status, cooldowns, state, equipment,
      armor: 5, resist: {}, critChance: 0, critMult: 1.0, maxPoise: 300, poise: 300,
      blockAngleDeg: 0, blockMitigation: 0, dodgeIframesMs: 0, moveSpeedMul: 1.0, invulnUntil: 0,
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

  // =========================
  // Projectile System
  // =========================
  private spawnProjectile(ownerId: string, x: number, y: number, z: number, tx: number, ty: number, tz: number) {
      const id = `proj_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
      
      const dx = tx - x;
      const dy = ty - y;
      const dz = tz - z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const speed = 1.0; // blocks per tick (50ms) = 20 blocks/sec

      // Simple ballistic arc estimate
      const timeToTarget = dist / speed;
      const gravity = 0.04; // Must match physics loop
      // Add extra Y velocity to arc it
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
          p.vy -= 0.04; // Gravity

          // Ground Collision
          const cx = Math.floor(p.x);
          const cy = Math.floor(p.y);
          const cz = Math.floor(p.z);
          if (this.getBlockAt(cx, cy, cz) !== this.AIR_ID) {
              toRemove.push(id);
              continue;
          }

          // Player Collision
          for (const pl of this.players.values()) {
              if (pl.id === p.ownerId) continue;
              const dx = pl.x - p.x;
              const dy = (pl.y + 0.9) - p.y; // Center mass
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

  // =========================
  // Combat Event Router
  // =========================
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

  // =========================
  // Combatant Factory
  // =========================
  private buildCombatant(client: Client, pl: PlayerInfo, inv: InvState): Combatant {
    const health = new HealthComponent(inv.stats.hp, inv.stats.maxHp);
    const resources = new ResourceComponent(inv.stats.mana, inv.stats.maxMana, 0, 100);
    
    const archetype = (inv.stats.auraArchetype as any) || "BASIC";
    const aura = new AuraComponent(archetype, 0, 0, 0);
    
    const status = new StatusComponent();
    const cooldowns = new CooldownComponent();
    const state = new StateComponent();
    const equipment = new EquipmentComponent((slot) => {
      const currentInv = this.inventories.get(pl.userId);
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
           const currentInv = this.getOrLoadInventory(pl.userId);
           currentInv.stats.hp = pl.hp;
           currentInv.stats.maxHp = pl.maxHp;
           currentInv.stats.mana = pl.mana;
           currentInv.stats.maxMana = pl.maxMana;
           
           this.saveInventory(pl.userId, currentInv);

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

  // =========================
  // Join/Leave
  // =========================
  onJoin(client: Client, options: any) {
    const userId = safeUserId(options?.userId);
    console.log("onJoin", { sessionId: client.sessionId, userId });

    const spacing = 5;
    let spawnX = this.TOWN_CENTER_X;
    let spawnZ = this.TOWN_CENTER_Z;

    let slot = 0;
    while (true) {
      const sx = this.TOWN_CENTER_X + (slot % 6) * spacing - 12;
      const sz = this.TOWN_CENTER_Z + Math.floor(slot / 6) * spacing - 12;

      const dx = sx - this.TOWN_CENTER_X;
      const dz = sz - this.TOWN_CENTER_Z;
      const d2 = dx * dx + dz * dz;
      const innerR = Math.max(6, this.SAFE_RADIUS - 8);
      if (d2 > innerR * innerR) {
        slot++;
        if (slot > 4096) break;
        continue;
      }

      let occupied = false;
      for (const p of this.players.values()) {
        if (Math.abs(p.x - sx) < 1 && Math.abs(p.z - sz) < 1) {
          occupied = true; break;
        }
      }
      if (!occupied) {
        spawnX = sx; spawnZ = sz; break;
      }
      slot++;
      if (slot > 4096) break;
    }

    const surfaceY = this.heightAt(spawnX, spawnZ);
    const spawnY = surfaceY + 8;

    const inv = this.getOrLoadInventory(userId);

    const spawn: PlayerInfo = {
      id: client.sessionId,
      userId,
      x: spawnX, y: spawnY, z: spawnZ,
      yaw: 0,
      lastMoveAt: 0,
      joinedAt: Date.now(),
      hp: inv.stats.hp,
      maxHp: inv.stats.maxHp,
      mana: inv.stats.mana,
      maxMana: inv.stats.maxMana,
      invulnUntil: Date.now() + 1500, // spawn protection
    };

    this.players.set(client.sessionId, spawn);
    this.updatePlayerSpatial(client.sessionId, spawn.x, spawn.z);
    
    const combatant = this.buildCombatant(client, spawn, inv);
    this.combatants.set(client.sessionId, combatant);

    this.sendInvStateToClient(client, inv);
    
    // Load world meta (seed + time)
    const meta = this.readWorldMeta();
    if (meta && typeof meta.worldTime === "number") {
        this.worldTime = meta.worldTime;
    }
    client.send("worldMeta", { worldSeed: this.worldSeed, worldTime: this.worldTime });

    client.send("safeZone", { cx: this.TOWN_CENTER_X, cz: this.TOWN_CENTER_Z, radius: this.SAFE_RADIUS, name: "Town of Beginnings" });

    for (const d of this.drops.values()) {
      if (Date.now() - d.createdAt > this.DROP_TTL_MS) continue;
      client.send("dropSpawn", d);
    }

    const existingPlayers = Array.from(this.players.values())
      .filter((pl) => pl.id !== client.sessionId)
      .map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw }));
      
    const existingMobs = Array.from(this.mobs.values())
      .map((m) => ({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw }));

    client.send("existingPlayers", [...existingPlayers, ...existingMobs]);
    this.broadcast("playerJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw }, { except: client });
    client.send("youJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw });

    const allNowPlayers = Array.from(this.players.values()).map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw }));
    const allNowMobs = Array.from(this.mobs.values()).map((m) => ({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw }));
    client.send("playersSnapshot", [...allNowPlayers, ...allNowMobs]);
  }

  onLeave(client: Client, code?: number) {
    console.log("onLeave", client.sessionId, "code:", code);
    this.cancelMiningFor(client, "leave");
    this.combatants.delete(client.sessionId);
    this.removePlayerSpatial(client.sessionId);
    const existed = this.players.delete(client.sessionId);
    if (existed) this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("MyRoom disposed");
    this.players.clear();
    this.mobs.clear();
    this.mining.clear();
    this.combatants.clear();
    this.spatialGrid.clear();
    this.playerChunks.clear();
  }

  // =========================
  // Chunk coord normalization
  // =========================
  private normalizeChunkRequestToIndex(
    rx: number,
    ry: number,
    rz: number
  ): { cx: number; cy: number; cz: number } {
    const CS = this.chunkSize;
    const toIndex = (v: number) => {
      if (v !== 0 && v % CS === 0) return toInt(v / CS); // origin -> index
      return toInt(v); // index
    };
    return { cx: toIndex(rx), cy: toIndex(ry), cz: toIndex(rz) };
  }

  // =========================
  // Persistence: directories
  // =========================
  private ensureDirs(): void {
    if (!fs.existsSync(this.worldDir)) fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir)) fs.mkdirSync(this.chunksDir, { recursive: true });
    if (!fs.existsSync(this.invDir)) fs.mkdirSync(this.invDir, { recursive: true });
  }

  // =========================
  // Persistence: world seed
  // =========================
  private loadOrCreateWorldSeed(options: any): number {
    const optSeedRaw = (options as any)?.worldSeed;
    if (typeof optSeedRaw === "number" && Number.isFinite(optSeedRaw)) {
      const s = (optSeedRaw | 0) >>> 0;
      this.writeWorldMeta({ worldSeed: s });
      console.log("[WORLD] seed set from options:", s);
      return s;
    }

    const meta = this.readWorldMeta();
    if (meta && typeof meta.worldSeed === "number" && Number.isFinite(meta.worldSeed)) {
      const s = (meta.worldSeed | 0) >>> 0;
      console.log("[WORLD] seed loaded from meta:", s);
      return s;
    }

    const gen = this.generateSeed();
    this.writeWorldMeta({ worldSeed: gen });
    console.log("[WORLD] seed generated + saved:", gen);
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
      console.warn("[WORLD] meta read failed:", this.metaPath, e);
      return null;
    }
  }

  private writeWorldMeta(meta: { worldSeed: number, worldTime?: number }): void {
    try {
      // Preserve existing if passing partial
      const existing = this.readWorldMeta() || {};
      const combined = { ...existing, ...meta, worldTime: this.worldTime }; // Always save current time
      
      const tmp = this.metaPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(combined));
      fs.renameSync(tmp, this.metaPath);
    } catch (e) {
      console.warn("[WORLD] meta write failed:", this.metaPath, e);
    }
  }

  // =========================
  // Persistence: chunks
  // =========================
  private chunkKey(cx: number, cy: number, cz: number): string { return `${cx},${cy},${cz}`; }
  private chunkFilePath(cx: number, cy: number, cz: number): string { return path.join(this.chunksDir, `c_${cx}_${cy}_${cz}.bin`); }
  private readChunkFromDisk(cx: number, cy: number, cz: number): Uint8Array | null {
    const fp = this.chunkFilePath(cx, cy, cz);
    try {
      if (!fs.existsSync(fp)) return null;
      const buf = fs.readFileSync(fp);
      const expected = this.chunkSize * this.chunkSize * this.chunkSize;
      if (buf.byteLength !== expected) {
        console.warn("[WORLD] chunk file wrong size, ignoring:", fp, { got: buf.byteLength, expected });
        return null;
        }
      const out = new Uint8Array(expected);
      out.set(buf);
      return out;
    } catch (e) {
      console.warn("[WORLD] read failed:", fp, e);
      return null;
    }
  }
  private writeChunkToDisk(cx: number, cy: number, cz: number, chunk: Uint8Array): void {
    const fp = this.chunkFilePath(cx, cy, cz);
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(chunk));
    fs.renameSync(tmp, fp);
  }

  // =========================
  // Persistence: inventories & stats
  // =========================
  private invFilePath(userId: string): string { return path.join(this.invDir, `inv_${userId}.json`); }

  private readInvFromDisk(userId: string): InvState | null {
    const fp = this.invFilePath(userId);
    try {
      if (!fs.existsSync(fp)) return null;
      const raw = fs.readFileSync(fp, "utf8");
      const j = JSON.parse(raw);

      const slotsIn = Array.isArray(j?.slots) ? j.slots : null;
      const cursorIn = typeof j?.cursor === "object" && j?.cursor ? j.cursor : null;
      const statsIn = typeof j?.stats === "object" && j?.stats ? j.stats : null;

      const slots: ItemStack[] = Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })) as any;
      if (slotsIn) {
        for (let i = 0; i < Math.min(this.INV_SLOTS, slotsIn.length); i++) {
          const s = slotsIn[i];
          const id = toInt(clamp(Number(s?.id ?? 0), 0, 999999));
          const count = toInt(clamp(Number(s?.count ?? 0), 0, 999999));
          const durRaw = Number(s?.dur ?? 0);
          const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
          slots[i] = id > 0 && count > 0 ? dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any) : ({ id: 0, count: 0 } as any);
        }
      }

      const cId = toInt(clamp(Number((cursorIn as any)?.id ?? 0), 0, 999999));
      const cCount = toInt(clamp(Number((cursorIn as any)?.count ?? 0), 0, 999999));
      const cDurRaw = Number((cursorIn as any)?.dur ?? 0);
      const cDur = Number.isFinite(cDurRaw) ? toInt(clamp(cDurRaw, 0, 999999)) : 0;
      const cursor: ItemStack = cId > 0 && cCount > 0 ? cDur > 0 ? ({ id: cId, count: cCount, dur: cDur } as any) : ({ id: cId, count: cCount } as any) : ({ id: 0, count: 0 } as any);

      const defaultMaxHp = this.DEFAULT_HEARTS * this.HP_PER_HEART;
      const defaultMaxMana = this.DEFAULT_MANA_CONTAINERS * this.MANA_PER_CONTAINER;
      
      const maxHp = toInt(clamp(Number((statsIn as any)?.maxHp ?? defaultMaxHp), 2, 9999));
      const hp = toInt(clamp(Number((statsIn as any)?.hp ?? maxHp), 0, maxHp));
      const maxMana = toInt(clamp(Number((statsIn as any)?.maxMana ?? defaultMaxMana), 0, 999999));
      const mana = toInt(clamp(Number((statsIn as any)?.mana ?? maxMana), 0, maxMana));

      const auraArchetype = String((statsIn as any)?.auraArchetype ?? "BASIC");

      return { slots, cursor, stats: { hp, maxHp, mana, maxMana, auraArchetype } };
    } catch (e) {
      return null;
    }
  }

  private writeInvToDisk(userId: string, inv: InvState): void {
    const fp = this.invFilePath(userId);
    const tmp = fp + ".tmp";
    const safe = {
      slots: inv.slots.map((s) => ({ id: toInt((s as any).id || 0), count: toInt((s as any).count || 0), dur: toInt((s as any).dur || 0) })),
      cursor: { id: toInt((inv.cursor as any).id || 0), count: toInt((inv.cursor as any).count || 0), dur: toInt((inv.cursor as any).dur || 0) },
      stats: { 
        hp: toInt(inv.stats.hp), 
        maxHp: toInt(inv.stats.maxHp), 
        mana: toInt(inv.stats.mana), 
        maxMana: toInt(inv.stats.maxMana),
        auraArchetype: String(inv.stats.auraArchetype),
      }
    };
    fs.writeFileSync(tmp, JSON.stringify(safe));
    fs.renameSync(tmp, fp);
  }

  private getOrLoadInventory(userId: string): InvState {
    const cached = this.inventories.get(userId);
    if (cached) return cached;

    const fromDisk = this.readInvFromDisk(userId);
    if (fromDisk) {
      this.inventories.set(userId, fromDisk);
      return fromDisk;
    }

    const defaultMaxHp = this.DEFAULT_HEARTS * this.HP_PER_HEART;
    const defaultMaxMana = this.DEFAULT_MANA_CONTAINERS * this.MANA_PER_CONTAINER;
    const inv: InvState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })) as any,
      cursor: { id: 0, count: 0 } as any,
      stats: { 
        hp: defaultMaxHp, 
        maxHp: defaultMaxHp, 
        mana: defaultMaxMana, 
        maxMana: defaultMaxMana,
        auraArchetype: "BASIC"
      }
    };

    inv.slots[0] = { id: Items.WOOD_LOG, count: 4 } as any;
    inv.slots[1] = { id: Items.STONE_SHADOW, count: 1 } as any; 
    inv.slots[2] = { id: Items.STONE_IRON, count: 1 } as any; 

    this.inventories.set(userId, inv);
    this.saveInventory(userId, inv);
    return inv;
  }

  private saveInventory(userId: string, inv: InvState): void {
    this.inventories.set(userId, inv);
    try { this.writeInvToDisk(userId, inv); } catch (e) {}
  }

  private sendInvStateToClient(client: Client, inv: InvState): void {
    client.send("invState", { slots: inv.slots, cursor: inv.cursor, stats: inv.stats });
  }

  // =========================
  // World internals
  // =========================
  private idx(i: number, j: number, k: number): number {
    const CS = this.chunkSize;
    return i + CS * (j + CS * k);
  }

  private hash3i(x: number, y: number, z: number): number {
    const seed = this.worldSeed | 0;
    let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  private hash2i(x: number, z: number, salt = 0): number {
    const seed = (this.worldSeed + (salt | 0)) | 0;
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

  private getBiome(worldX: number, worldZ: number): number {
    const dx = worldX - this.TOWN_CENTER_X; const dz = worldZ - this.TOWN_CENTER_Z;
    if (dx * dx + dz * dz <= (this.SAFE_RADIUS + 10) * (this.SAFE_RADIUS + 10)) return this.BIOME_FOREST;
    const temp = this.fbm2(worldX, worldZ, 320, 3, 10000);
    const moist = this.fbm2(worldX, worldZ, 260, 3, 20000);
    if (temp < 0.36) return this.BIOME_SNOW;
    if (temp > 0.66 && moist < 0.46) return this.BIOME_DESERT;
    return this.BIOME_FOREST;
  }

  private heightAt(worldX: number, worldZ: number): number {
    const biome = this.getBiome(worldX, worldZ);
    const macro = Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6;
    if (biome === this.BIOME_DESERT) return this.baseHeight + Math.floor(macro * 0.45 + Math.sin(worldX / 34) * 2 + Math.cos(worldZ / 31) * 2);
    if (biome === this.BIOME_SNOW) return this.baseHeight + 4 + Math.floor(macro * 0.85 + (Math.sin(worldX / 22) * 4 + Math.cos(worldZ / 19) * 4) * 0.75);
    return this.baseHeight + Math.floor(macro * 0.9);
  }

  // =========================
  // Trees (biome dependent)
  // =========================
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

  // =========================
  // Helpers
  // =========================
  private isCombatAllowedHere(x: number, z: number): boolean { return !this.isInSafeZoneXZ(toInt(x), toInt(z)); }
  private isInSafeZoneXZ(worldX: number, worldZ: number): boolean {
    const dx = worldX - this.TOWN_CENTER_X; const dz = worldZ - this.TOWN_CENTER_Z;
    return dx * dx + dz * dz <= this.SAFE_RADIUS * this.SAFE_RADIUS;
  }

  // =========================
  // POIs (region grid, stamped per chunk)
  // =========================
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
    const wood = this.WOOD_ID; const stone = this.STONE_ID; const leaves = this.LEAVES_ID;

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
    const CS = this.chunkSize;
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
          if (vox[ii] === this.BEDROCK_ID || op.id === this.AIR_ID) continue;
          vox[ii] = clamp(toInt(op.id), 0, 255);
        }
      }
    }
  }

  private stampTownIntoChunk(vox: Uint8Array, cx: number, cy: number, cz: number): void {
    const CS = this.chunkSize;
    const chunkMinX = cx * CS; const chunkMinY = cy * CS; const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1; const chunkMaxY = chunkMinY + CS - 1; const chunkMaxZ = chunkMinZ + CS - 1;

    const closestX = clamp(this.TOWN_CENTER_X, chunkMinX, chunkMaxX);
    const closestZ = clamp(this.TOWN_CENTER_Z, chunkMinZ, chunkMaxZ);
    const r = this.SAFE_RADIUS + 2;
    if ((closestX - this.TOWN_CENTER_X) ** 2 + (closestZ - this.TOWN_CENTER_Z) ** 2 > r * r) return;

    // Define Shrine Centers
    const shrines = [
      { hx: this.TOWN_CENTER_X + 13, hz: this.TOWN_CENTER_Z + 13 },
      { hx: this.TOWN_CENTER_X - 13, hz: this.TOWN_CENTER_Z + 13 },
      { hx: this.TOWN_CENTER_X + 13, hz: this.TOWN_CENTER_Z - 13 },
      { hx: this.TOWN_CENTER_X - 13, hz: this.TOWN_CENTER_Z - 13 },
    ];

    // Define Ring Pillars
    const pillars = [
      { px: 56, pz: 0 }, { px: -56, pz: 0 }, { px: 0, pz: 56 }, { px: 0, pz: -56 },
      { px: 40, pz: 40 }, { px: -40, pz: 40 }, { px: 40, pz: -40 }, { px: -40, pz: -40 }
    ];

    for (let lx = 0; lx < CS; lx++) {
      for (let lz = 0; lz < CS; lz++) {
        const wx = chunkMinX + lx; const wz = chunkMinZ + lz;
        const dx = wx - this.TOWN_CENTER_X; const dz = wz - this.TOWN_CENTER_Z;
        const d2 = dx * dx + dz * dz;
        const dist = Math.sqrt(d2);

        if (dist > this.TOWN_RING_RADIUS + 3) continue;

        // Base surface computation
        const townY = this.baseHeight + 2; // Flatten the town exactly at baseHeight+2 to make a smooth plaza
        
        const inPlaza = dist <= this.TOWN_PLAZA_RADIUS + 2;
        const inTown = dist <= this.TOWN_RING_RADIUS;
        const inRingWall = dist >= this.TOWN_RING_RADIUS && dist <= this.TOWN_RING_RADIUS + 1.5;
        const inPath = (Math.abs(dz) <= this.TOWN_PATH_HALF_W && dist <= this.TOWN_RING_RADIUS) || 
                       (Math.abs(dx) <= this.TOWN_PATH_HALF_W && dist <= this.TOWN_RING_RADIUS);

        // Find if we are in a shrine
        let shrineLocal: { ox: number; oz: number } | null = null;
        for (const c of shrines) {
          const ox = wx - c.hx; const oz = wz - c.hz;
          if (Math.abs(ox) <= 2 && Math.abs(oz) <= 2) { shrineLocal = { ox, oz }; break; }
        }

        // Find if we are in a pillar
        let pillarLocal: { ox: number; oz: number } | null = null;
        for (const p of pillars) {
          const ox = dx - p.px; const oz = dz - p.pz;
          if (Math.abs(ox) <= 1 && Math.abs(oz) <= 1) { pillarLocal = { ox, oz }; break; }
        }

        for (let ly = 0; ly < CS; ly++) {
          const wy = chunkMinY + ly;
          const ii = this.idx(lx, ly, lz);

          if (vox[ii] === this.BEDROCK_ID) continue;

          // CLEAR AIR ABOVE TOWN
          if (wy > townY && wy <= townY + this.TOWN_CLEAR_HEIGHT) vox[ii] = this.AIR_ID;
          
          // BUILD SOLID GROUND UNDER TOWN
          if (inTown && wy < townY) {
             // Foundation
             vox[ii] = wy < townY - 2 ? this.DIRT_ID : this.DEEPSLATE_ID;
          }

          // --- PLAZA FLOOR ---
          if (inTown && wy === townY) {
            if (inPath) {
               vox[ii] = this.DIRT_ID; // Dirt path
            } else if (inPlaza) {
               // Grand mosaic center
               const checker = (Math.abs(wx) + Math.abs(wz)) % 2 === 0;
               vox[ii] = checker ? this.STONE_ID : this.TUFF_ID;
            } else {
               // General plaza floor (grass with occasional moss/stone)
               const r = this.hash2i(wx, wz, 999);
               vox[ii] = r < 0.1 ? this.MOSS_ID : r < 0.2 ? this.MOSSY_STONE_ID : this.GRASS_ID;
            }
          }

          // --- OUTER RING WALL ---
          if (inRingWall && wy >= townY && wy <= townY + 3 && !inPath) { // Leave paths open
             if (wy === townY || wy === townY + 1) vox[ii] = this.MOSSY_STONE_ID;
             if (wy === townY + 2 || wy === townY + 3) vox[ii] = this.LEAVES_ID;
          }

          // --- GRAND PILLARS ---
          if (pillarLocal && wy >= townY && wy <= townY + 6) {
             if (wy === townY + 6) {
               if (pillarLocal.ox === 0 && pillarLocal.oz === 0) vox[ii] = this.CRYSTAL_ID;
               else vox[ii] = this.AIR_ID;
             } else if (wy === townY) {
               vox[ii] = this.STONE_ID;
             } else {
               // Deepslate pillar trunk
               if (Math.abs(pillarLocal.ox) + Math.abs(pillarLocal.oz) <= 1) vox[ii] = this.DEEPSLATE_ID;
               else vox[ii] = this.AIR_ID;
             }
          }

          // --- AWAKENING SHRINES ---
          if (shrineLocal && wy >= townY && wy <= townY + 6) {
            const ox = shrineLocal.ox; const oz = shrineLocal.oz;
            const isCorner = Math.abs(ox) === 2 && Math.abs(oz) === 2;
            const isCenter = ox === 0 && oz === 0;
            const distToCenter = Math.max(Math.abs(ox), Math.abs(oz));

            if (wy === townY) {
              vox[ii] = this.DEEPSLATE_ID; // Shrine base
            } else if (wy > townY && wy <= townY + 3) {
              if (isCorner) vox[ii] = this.WOOD_ID; // Corner pillars
              else if (isCenter && wy === townY + 1) vox[ii] = this.TUFF_ID; // Pedestal
              else if (isCenter && wy === townY + 2) vox[ii] = this.CRYSTAL_ID; // Glowing crystal
              else vox[ii] = this.AIR_ID; // Open air for the rest
            } else if (wy === townY + 4) {
              // Outer roof lip
              if (distToCenter === 2) vox[ii] = this.STONE_ID;
              else vox[ii] = this.AIR_ID;
            } else if (wy === townY + 5) {
              // Inner roof
              if (distToCenter === 1) vox[ii] = this.STONE_ID;
              else vox[ii] = this.AIR_ID;
            } else if (wy === townY + 6) {
              // Roof tip
              if (isCenter) vox[ii] = this.STONE_ID;
              else vox[ii] = this.AIR_ID;
            }
          }
        }
      }
    }

    // Structure stamping for Town Hall (must be shifted to new townY)
    if (this.townHall) {
      const townY = this.baseHeight + 2;
      const baseY = townY + 1; // Start building on top of the plaza floor
      const worldX = this.TOWN_CENTER_X - this.townHall.anchor.x;
      const worldY = baseY - this.townHall.anchor.y;
      const worldZ = this.TOWN_CENTER_Z - this.townHall.anchor.z;
      this.stampStructureIntoChunk(vox, cx, cy, cz, this.townHall, worldX, worldY, worldZ);
    }

    // STAMP LOOT CHEST
    const chestX = this.TOWN_CENTER_X + 2;
    const chestZ = this.TOWN_CENTER_Z + 2;
    
    // Check if this chest falls in current chunk
    // Use previously declared bounds (chunkMinX, etc.)
    
    if (chestX >= chunkMinX && chestX <= chunkMaxX && chestZ >= chunkMinZ && chestZ <= chunkMaxZ) {
        const townY = this.baseHeight + 2;
        const chestY = townY + 2;
        const cyMin = cy * CS; const cyMax = cyMin + CS - 1;
        
        if (chestY >= cyMin && chestY <= cyMax) {
            const ii = this.idx(chestX - chunkMinX, chestY - cyMin, chestZ - chunkMinZ);
            vox[ii] = this.CHEST_ID;
            
            console.log(`[CHEST DEBUG] 📦 Loot Chest physically stamped into chunk voxels at World XYZ: ${chestX}, ${chestY}, ${chestZ}`);
            
            // Register Loot (Idempotent: map.set overwrites)
            const key = `${chestX},${chestY},${chestZ}`;
            if (!this.chestLoot.has(key)) {
                console.log(`[CHEST DEBUG] 💎 Loot registered for chest at ${key}`);
                this.chestLoot.set(key, [
                    { id: Items.STONE_SWORD, count: 1 },
                    { id: Items.COAL, count: 5 }
                ]);
            }
        }
    }
  }

  // =========================
  // In-Memory Massive Town Hall Builder
  // =========================
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

    // 1. Fill entire volume with Air to hollow out the inside and overwrite anything else
    fill(0, 1, 0, w - 1, h - 1, d - 1, this.AIR_ID);

    // 2. Floor
    fill(0, 0, 0, w - 1, 0, d - 1, this.DEEPSLATE_ID);
    
    // 3. Outer Walls
    fill(0, 1, 0, w - 1, h - 2, 0, this.STONE_ID); // Front
    fill(0, 1, d - 1, w - 1, h - 2, d - 1, this.STONE_ID); // Back
    fill(0, 1, 0, 0, h - 2, d - 1, this.STONE_ID); // Left
    fill(w - 1, 1, 0, w - 1, h - 2, d - 1, this.STONE_ID); // Right

    // 4. Main Entrance (Front center)
    fill(22, 1, 0, 28, 4, 0, this.AIR_ID);

    // 5. Roof
    fill(0, h - 1, 0, w - 1, h - 1, d - 1, this.WOOD_ID);

    // 6. Central Lobby Carpet (Tuff)
    fill(22, 1, 1, 28, 1, d - 2, this.TUFF_ID);

    // =====================================
    // WEST WING: GAMBLING DEN
    // =====================================
    // Wall separator
    fill(15, 1, 1, 15, h - 2, 6, this.STONE_ID);
    fill(15, 1, d - 7, 15, h - 2, d - 2, this.STONE_ID);
    // Archway
    fill(15, 1, 7, 15, 5, d - 8, this.AIR_ID);

    const makeTable = (tx: number, tz: number) => {
      fill(tx, 1, tz, tx + 2, 1, tz + 2, this.WOOD_ID); // Table base
      fill(tx, 2, tz, tx + 2, 2, tz + 2, this.MOSS_ID); // Green felt
      // Stools
      add(tx - 1, 1, tz + 1, this.WOOD_ID);
      add(tx + 3, 1, tz + 1, this.WOOD_ID);
      add(tx + 1, 1, tz - 1, this.WOOD_ID);
      add(tx + 1, 1, tz + 3, this.WOOD_ID);
    };
    
    makeTable(3, 4);
    makeTable(9, 4);
    makeTable(3, 12);
    makeTable(9, 12);
    makeTable(3, 20);
    makeTable(9, 20);

    // =====================================
    // EAST WING: MARKET & STORES
    // =====================================
    // Wall separator
    fill(35, 1, 1, 35, h - 2, 6, this.STONE_ID);
    fill(35, 1, d - 7, 35, h - 2, d - 2, this.STONE_ID);
    // Archway
    fill(35, 1, 7, 35, 5, d - 8, this.AIR_ID);

    const makeStall = (sx: number, sz: number) => {
      fill(sx, 1, sz, sx + 4, 1, sz, this.WOOD_ID); // Front counter
      fill(sx, 1, sz + 1, sx, 1, sz + 3, this.WOOD_ID); // Side
      fill(sx + 4, 1, sz + 1, sx + 4, 1, sz + 3, this.WOOD_ID); // Side
      
      add(sx + 1, 2, sz, this.CHEST_ID); // Chest on counter
      add(sx + 3, 2, sz, this.CHEST_ID); // Chest on counter
      
      fill(sx, 4, sz - 1, sx + 4, 4, sz + 3, this.LEAVES_ID); // Awning
      
      add(sx, 2, sz, this.WOOD_ID); add(sx, 3, sz, this.WOOD_ID); // Pillars
      add(sx + 4, 2, sz, this.WOOD_ID); add(sx + 4, 3, sz, this.WOOD_ID);
    };

    makeStall(38, 4);
    makeStall(38, 12);
    makeStall(38, 20);

    return {
      name: "massive_town_hall",
      size: { w, h, d },
      anchor: { x: Math.floor(w / 2), y: 0, z: Math.floor(d / 2) },
      blocks
    };
  }

  // =========================
  // Path B: Structure stamping (seam-safe per chunk)
  // =========================
  private stampStructureIntoChunk(
    vox: Uint8Array, cx: number, cy: number, cz: number,
    s: { size: { w: number; h: number; d: number }; blocks: Array<{ x: number; y: number; z: number; id: number }> },
    worldX: number, worldY: number, worldZ: number
  ): void {
    const CS = this.chunkSize;
    const chunkMinX = cx * CS; const chunkMinY = cy * CS; const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1; const chunkMaxY = chunkMinY + CS - 1; const chunkMaxZ = chunkMinZ + CS - 1;
    if (worldX + s.size.w - 1 < chunkMinX || worldX > chunkMaxX || worldY + s.size.h - 1 < chunkMinY || worldY > chunkMaxY || worldZ + s.size.d - 1 < chunkMinZ || worldZ > chunkMaxZ) return;

    for (const b of s.blocks) {
      const wx = worldX + b.x; const wy = worldY + b.y; const wz = worldZ + b.z;
      if (wx < chunkMinX || wx > chunkMaxX || wy < chunkMinY || wy > chunkMaxY || wz < chunkMinZ || wz > chunkMaxZ) continue;
      const ii = this.idx(wx - chunkMinX, wy - chunkMinY, wz - chunkMinZ);
      if (vox[ii] === this.BEDROCK_ID) continue;
      vox[ii] = clamp(toInt(b.id), 0, 255);
    }
  }

  // =========================
  // Cave Generation Utilities
  // =========================
  private pickCaveBiome(y: number, biomeNoise: number): CaveBiome {
    if (y < 18) return "DEEP_DARKISH";
    if (biomeNoise > 0.55) return "DRIPSTONE";
    if (biomeNoise < -0.55) return "LUSH";
    if (y > 25 && biomeNoise > 0.35 && biomeNoise < 0.45) return "CRYSTAL";
    if (biomeNoise < -0.2 && biomeNoise > -0.35) return "TUFFY";
    return "DEEP_DARKISH";
  }

  private baseStoneForDepth(y: number): number { return y < 18 ? this.DEEPSLATE_ID : this.STONE_ID; }

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
      if (x >= 0 && x < this.chunkSize && y >= 0 && y < this.chunkSize && z >= 0 && z < this.chunkSize) {
        const idx = this.idx(x, y, z);
        const current = vox[idx];
        if (current === this.STONE_ID || current === this.DEEPSLATE_ID || current === this.TUFF_ID) vox[idx] = oreId;
      }
      const r = rand();
      if (r < 0.25) x++; else if (r < 0.5) x--; else if (r < 0.7) z++; else if (r < 0.9) z--; else y += rand() < 0.5 ? 1 : -1;
    }
  }

  // =========================
  // Chunk generation
  // =========================
  private generateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const CS = this.chunkSize;
    const vox = new Uint8Array(CS * CS * CS);

    // 1. Base Terrain
    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i; const worldZ = cz * CS + k;
        const biome = this.getBiome(worldX, worldZ);
        const height = this.heightAt(worldX, worldZ);
        const surfaceId = biome === this.BIOME_DESERT ? this.SAND_ID : biome === this.BIOME_SNOW ? this.SNOW_ID : this.GRASS_ID;
        const subsurfaceId = biome === this.BIOME_DESERT ? this.SAND_ID : this.DIRT_ID;

        for (let j = 0; j < CS; j++) {
          const worldY = cy * CS + j;
          const idx = this.idx(i, j, k);

          if (worldY <= 4 && this.hash3i(worldX, worldY, worldZ) < 0.95 - worldY * 0.18) { vox[idx] = this.BEDROCK_ID; continue; }
          if (worldY > height) { vox[idx] = this.AIR_ID; continue; }
          if (worldY === height) { vox[idx] = surfaceId; continue; }
          if (worldY > height - 4) { vox[idx] = subsurfaceId; continue; }

          let block = this.baseStoneForDepth(worldY);
          if (worldY < height - 5 && worldY > 5 && this.fbm3(worldX, worldY, worldZ, 24, 2, 8888) < 0.45) block = this.AIR_ID;
          vox[idx] = block;
        }
      }
    }

    // 2. Cave Skinning
    const skinnedVox = new Uint8Array(vox);
    for (let x = 0; x < CS; x++) {
      for (let y = 0; y < CS; y++) {
        for (let z = 0; z < CS; z++) {
          const idx = this.idx(x, y, z);
          const current = vox[idx];
          if (current === this.STONE_ID || current === this.DEEPSLATE_ID) {
            const worldX = cx * CS + x; const worldY = cy * CS + y; const worldZ = cz * CS + z;
            const up = y < CS - 1 ? vox[this.idx(x, y + 1, z)] : this.AIR_ID;
            const down = y > 0 ? vox[this.idx(x, y - 1, z)] : this.STONE_ID;
            const left = x > 0 ? vox[this.idx(x - 1, y, z)] : this.STONE_ID;
            const right = x < CS - 1 ? vox[this.idx(x + 1, y, z)] : this.STONE_ID;
            const front = z > 0 ? vox[this.idx(x, y, z - 1)] : this.STONE_ID;
            const back = z < CS - 1 ? vox[this.idx(x, y, z + 1)] : this.STONE_ID;

            const isCeil = down === this.AIR_ID;
            const isFloor = up === this.AIR_ID;
            const isWall = !isCeil && !isFloor && (left === this.AIR_ID || right === this.AIR_ID || front === this.AIR_ID || back === this.AIR_ID);

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

    // 3. Ores
    let oreSalt = 0;
    for (let x = 0; x < CS; x++) {
      for (let y = 0; y < CS; y++) {
        for (let z = 0; z < CS; z++) {
          const idx = this.idx(x, y, z);
          if (vox[idx] === this.STONE_ID || vox[idx] === this.DEEPSLATE_ID || vox[idx] === this.TUFF_ID) {
            const worldY = cy * CS + y;
            const rand = () => this.hash3i(cx * CS + x, worldY, cz * CS + z + oreSalt++);
            const oreId = this.chooseOreForY(worldY, rand);
            if (oreId) {
              const def = this.ORES.find((o) => o.id === oreId);
              if (def) this.carveVein(vox, x, y, z, oreId, Math.floor(def.veinSize[0] + (def.veinSize[1] - def.veinSize[0] + 1) * rand()), rand);
            }
          }
        }
      }
    }

    // 4. Trees
    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i; const worldZ = cz * CS + k;
        const biome = this.getBiome(worldX, worldZ);
        if (this.shouldPlaceTreeAt(worldX, worldZ, biome) && biome !== this.BIOME_DESERT) {
          const height = this.heightAt(worldX, worldZ);
          const tH = this.treeHeight(worldX, worldZ, biome);
          for (let j = 0; j < CS; j++) {
            const worldY = cy * CS + j; const idx = this.idx(i, j, k);
            if (worldY >= height + 1 && worldY <= height + tH) { vox[idx] = this.WOOD_ID; } 
            else if (worldY >= height + tH - 1 && worldY <= height + tH + 2) {
              if (this.hash3i(worldX, worldY, worldZ) > (biome === this.BIOME_SNOW ? 0.42 : 0.22) && vox[idx] === this.AIR_ID) vox[idx] = this.LEAVES_ID;
            }
          }
        }
      }
    }

    // 5. Structures & Town
    this.stampPoiIntoChunk(vox, cx, cy, cz);
    this.stampTownIntoChunk(vox, cx, cy, cz);

    return vox;
  }

  // =========================
  // OPTION B: upgrade loaded chunks
  // =========================
  private getOrCreateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);
    const cached = this.chunks.get(key);
    if (cached) return cached;

    const fromDisk = this.readChunkFromDisk(cx, cy, cz);
    if (fromDisk) {
      try {
        this.stampTownIntoChunk(fromDisk, cx, cy, cz);
        this.writeChunkToDisk(cx, cy, cz, fromDisk);
      } catch (e) {}
      this.chunks.set(key, fromDisk);
      return fromDisk;
    }

    const gen = this.generateChunk(cx, cy, cz);
    this.chunks.set(key, gen);
    return gen;
  }

  private getBlockAt(x: number, y: number, z: number): number {
    const CS = this.chunkSize;
    return this.getOrCreateChunk(floorDiv(x, CS), floorDiv(y, CS), floorDiv(z, CS))[this.idx(mod(x, CS), mod(y, CS), mod(z, CS))] | 0;
  }

  private setBlockAuthoritative(x: number, y: number, z: number, id: number): void {
    const CS = this.chunkSize;
    const cx = floorDiv(x, CS); const cy = floorDiv(y, CS); const cz = floorDiv(z, CS);
    const chunk = this.getOrCreateChunk(cx, cy, cz);
    const v = clamp(toInt(id), 0, 255);
    chunk[this.idx(mod(x, CS), mod(y, CS), mod(z, CS))] = v;

    try { this.writeChunkToDisk(cx, cy, cz, chunk); } catch (e) {}
    this.broadcast("blockUpdate", { x, y, z, id: v });
  }

  // =========================
  // Drops internals
  // =========================
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
    if (blockId === this.SAND_ID) return (Items as any).SAND ?? 0;
    if (blockId === this.SNOW_ID) return (Items as any).SNOW ?? 0;
    if (blockId === this.COAL_ORE_ID) return Items.COAL;
    if (blockId === this.IRON_ORE_ID) return Items.RAW_IRON;
    if (blockId === this.GOLD_ORE_ID) return Items.RAW_GOLD;
    if (blockId === this.DIAMOND_ORE_ID) return Items.DIAMOND;
    return 0;
  }

  // =========================
  // Mining helpers (tiers + durability)
  // =========================
  private isStoneLike(blockId: number): boolean { return (blockId === this.STONE_ID || blockId === this.COAL_ORE_ID || blockId === this.IRON_ORE_ID || blockId === this.GOLD_ORE_ID || blockId === this.DIAMOND_ORE_ID || blockId === this.DEEPSLATE_ID || blockId === this.TUFF_ID || blockId === this.MOSSY_STONE_ID || blockId === this.DRIPSTONE_BLOCK_ID); }
  private getToolDef(itemId: number) { return ITEM_DEFS[itemId]?.tool ?? null; }
  private isToolItem(itemId: number): boolean { return !!ITEM_DEFS[itemId]?.tool || this.maxStackFor(itemId) === 1; }
  private cloneStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999)); const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999)); const durRaw = Number((s as any)?.dur ?? 0); const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  private choosePickStack(inv: InvState, heldSlot: number): { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<MyRoom["getToolDef"]>> } | null {
    if (heldSlot >= 0 && heldSlot < this.HOTBAR_SLOTS) {
      const s = inv.slots[heldSlot];
      if (s && (s as any).id > 0 && (s as any).count > 0 && this.getToolDef((s as any).id)?.kind === "pick") return { slotIndex: heldSlot, stack: s, tool: this.getToolDef((s as any).id)! };
    }
    let best: { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<MyRoom["getToolDef"]>> } | null = null;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      if (!s || (s as any).id <= 0 || (s as any).count <= 0) continue;
      const tool = this.getToolDef((s as any).id);
      if (!tool || tool.kind !== "pick") continue;
      if (!best || tool.tier > best.tool.tier) best = { slotIndex: i, stack: s, tool };
    }
    return best;
  }

  private requiredPickTierForDrops(blockId: number): number {
    if (blockId === this.STONE_ID || blockId === this.COAL_ORE_ID || blockId === this.IRON_ORE_ID || blockId === this.DEEPSLATE_ID || blockId === this.TUFF_ID) return 1;
    if (blockId === this.GOLD_ORE_ID || blockId === this.DIAMOND_ORE_ID) return 3;
    return 0;
  }

  private canBlockDropWithTool(blockId: number, inv: InvState | null, heldSlot = -1): boolean {
    if (blockId === this.BEDROCK_ID) return false;
    const reqTier = this.requiredPickTierForDrops(blockId);
    if (reqTier <= 0) return true;
    if (!inv) return false;
    const picked = this.choosePickStack(inv, heldSlot);
    return picked ? picked.tool.tier >= reqTier : false;
  }

  private computeBreakTimeMs(blockId: number, inv: InvState, heldSlot = -1): number {
    let base = 450;
    if (blockId === this.LEAVES_ID) base = 180; else if (blockId === this.GRASS_ID || blockId === this.DIRT_ID) base = 420; else if (blockId === this.SAND_ID || blockId === this.SNOW_ID) base = 360; else if (blockId === this.WOOD_ID) base = 950; else if (blockId === this.STONE_ID) base = 1250; else if (blockId === this.TUFF_ID) base = 1350; else if (blockId === this.COAL_ORE_ID) base = 1400; else if (blockId === this.IRON_ORE_ID) base = 1650; else if (blockId === this.DEEPSLATE_ID) base = 1800; else if (blockId === this.GOLD_ORE_ID) base = 2200; else if (blockId === this.DIAMOND_ORE_ID) base = 2850; else if (blockId === this.BEDROCK_ID) return 999999999;
    
    const picked = this.choosePickStack(inv, heldSlot);
    if (this.isStoneLike(blockId)) base = picked ? Math.floor(base * picked.tool.speedMul) : Math.floor(base * 2.8);
    else if (blockId === this.WOOD_ID && picked) base = Math.floor(base * 0.92);

    return clamp(base, 80, 12000);
  }

  private damageTool(inv: InvState, slotIndex: number): void {
    const s = inv.slots[slotIndex];
    if (!s || (s as any).id <= 0 || (s as any).count <= 0) return;
    const tool = this.getToolDef((s as any).id);
    if (!tool) return;
    const next = toInt(clamp(Number((s as any).dur ?? tool.maxDurability), 0, 999999)) - 1;
    if (next <= 0) inv.slots[slotIndex] = { id: 0, count: 0 } as any; else (s as any).dur = next;
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

      const inv = this.getOrLoadInventory(st.userId);
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
          const picked = this.choosePickStack(inv, st.heldSlot);
          const canDrop = this.canBlockDropWithTool(currentId, inv, st.heldSlot);

          this.setBlockAuthoritative(st.x, st.y, st.z, this.AIR_ID);
          if (canDrop) {
            const dropItem = this.blockIdToDropItemId(currentId);
            if (dropItem > 0) this.spawnDrop(dropItem, 1, st.x + 0.5, st.y + 0.65, st.z + 0.5);
          }

          if (picked && this.isStoneLike(currentId)) {
            this.damageTool(inv, picked.slotIndex);
            this.saveInventory(st.userId, inv);
            this.sendInvStateToClient(client, inv);
          }

          msg.done = true; client.send("mineProgress", msg); this.mining.delete(sid);
        } else {
          client.send("mineProgress", msg);
        }
      }
    }
  }

  // =========================
  // Inventory helpers
  // =========================
  private normalizeStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999)); const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999)); const durRaw = Number((s as any)?.dur ?? 0); const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  private maxStackFor(itemId: number): number { return clamp(toInt(ITEM_DEFS[itemId]?.maxStack ?? 64), 1, 999999); }
  private inventoryCountSlots(inv: InvState, itemId: number): number {
    let n = 0;
    for (const s of inv.slots) if ((s as any).id === itemId && (s as any).count > 0) n += (s as any).count;
    return n;
  }

  private inventoryCanFit(inv: InvState, itemId: number, count: number): boolean {
    const maxS = this.maxStackFor(itemId); let remaining = clamp(toInt(count), 1, 999999);
    for (const s of inv.slots as any[]) if (s.id === itemId && s.count > 0 && maxS - s.count > 0) if ((remaining -= Math.min(maxS - s.count, remaining)) <= 0) return true;
    for (const s of inv.slots as any[]) if (s.id === 0 || s.count <= 0) if ((remaining -= Math.min(maxS, remaining)) <= 0) return true;
    return remaining <= 0;
  }

  private inventoryAdd(inv: InvState, stack: ItemStack): number {
    const s = this.normalizeStack(stack);
    if ((s as any).id <= 0 || (s as any).count <= 0) return 0;
    const id = (s as any).id | 0; const maxS = this.maxStackFor(id);
    let remaining = (s as any).count | 0; let accepted = 0;

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === id && slot.count > 0 && maxS - slot.count > 0) {
        const take = Math.min(maxS - slot.count, remaining);
        slot.count += take; remaining -= take; accepted += take;
        if (remaining <= 0) return accepted;
      }
    }

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === 0 || slot.count <= 0) {
        const def = ITEM_DEFS[id];
        if (!!def?.tool) { inv.slots[i] = { id, count: 1, dur: def!.tool!.maxDurability } as any; remaining -= 1; accepted += 1; } 
        else { const take = Math.min(maxS, remaining); inv.slots[i] = { id, count: take } as any; remaining -= take; accepted += take; }
        if (remaining <= 0) return accepted;
      }
    }
    return accepted;
  }

  private inventoryRemoveSlots(inv: InvState, itemId: number, count: number): number {
    let remaining = clamp(toInt(count), 1, 999999); let removed = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i] as any;
      if (s.id === itemId && s.count > 0) {
        const take = Math.min(s.count, remaining);
        s.count -= take; remaining -= take; removed += take;
        if (s.count <= 0) inv.slots[i] = { id: 0, count: 0 } as any;
        if (remaining <= 0) break;
      }
    }
    return removed;
  }

  // =========================
  // Inventory click logic
  // =========================
  private applyInvClick(inv: InvState, slotIndex: number, button: "L" | "R", shift: boolean): void {
    inv.cursor = this.normalizeStack(inv.cursor); inv.slots[slotIndex] = this.normalizeStack(inv.slots[slotIndex]);
    const cursor = inv.cursor as any; const slot = inv.slots[slotIndex] as any;
    const cursorIsTool = cursor.id > 0 && cursor.count > 0 && this.isToolItem(cursor.id);
    const slotIsTool = slot.id > 0 && slot.count > 0 && this.isToolItem(slot.id);

    if (shift && button === "L") {
      if (slot.id <= 0 || slot.count <= 0) return;
      const isHotbar = slotIndex < this.HOTBAR_SLOTS;
      if (this.moveStackBetweenRanges(inv, slotIndex, isHotbar ? this.HOTBAR_SLOTS : 0, isHotbar ? this.INV_SLOTS : this.HOTBAR_SLOTS)) return;
      return;
    }

    if (button === "L") {
      if (cursor.id <= 0 || cursor.count <= 0) { inv.cursor = this.cloneStack(slot) as any; inv.slots[slotIndex] = { id: 0, count: 0 } as any; return; }
      if (slot.id <= 0 || slot.count <= 0) { inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = { id: 0, count: 0 } as any; return; }
      if (slot.id === cursor.id) {
        const space = this.maxStackFor(slot.id) - slot.count;
        if (space > 0) {
          const take = Math.min(space, cursor.count);
          slot.count += take; cursor.count -= take;
          inv.slots[slotIndex] = slot as any; inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
        }
        return;
      }
      inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    if (cursor.id <= 0 || cursor.count <= 0) {
      if (slot.id <= 0 || slot.count <= 0) return;
      if (slotIsTool) { inv.cursor = this.cloneStack(slot) as any; inv.slots[slotIndex] = { id: 0, count: 0 } as any; return; }
      const take = Math.ceil(slot.count / 2); inv.cursor = { id: slot.id, count: take } as any; slot.count -= take;
      inv.slots[slotIndex] = slot.count > 0 ? (slot as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (cursorIsTool) {
      if (slot.id <= 0 || slot.count <= 0) { inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = { id: 0, count: 0 } as any; return; }
      inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    if (slot.id <= 0 || slot.count <= 0) {
      inv.slots[slotIndex] = { id: cursor.id, count: 1 } as any; cursor.count -= 1;
      inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (slot.id === cursor.id) {
      if (slot.count < this.maxStackFor(slot.id)) {
        slot.count += 1; cursor.count -= 1;
        inv.slots[slotIndex] = slot as any; inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      }
      return;
    }
  }

  private moveStackBetweenRanges(inv: InvState, fromIndex: number, toStart: number, toEnd: number): boolean {
    inv.slots[fromIndex] = this.normalizeStack(inv.slots[fromIndex]);
    const from = inv.slots[fromIndex] as any;
    if (from.id <= 0 || from.count <= 0) return false;

    const maxS = this.maxStackFor(from.id);
    if (this.isToolItem(from.id) || maxS === 1) {
      for (let i = toStart; i < toEnd; i++) {
        const s = this.normalizeStack(inv.slots[i]) as any;
        if (s.id <= 0 || s.count <= 0) { inv.slots[i] = this.cloneStack(from) as any; inv.slots[fromIndex] = { id: 0, count: 0 } as any; return true; }
      }
      return false;
    }

    let remaining = from.count;
    for (let i = toStart; i < toEnd; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id === from.id && s.count > 0 && maxS - s.count > 0) {
        const take = Math.min(maxS - s.count, remaining);
        s.count += take; remaining -= take; inv.slots[i] = s as any;
        if (remaining <= 0) break;
      }
    }

    for (let i = toStart; i < toEnd && remaining > 0; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id <= 0 || s.count <= 0) {
        const take = Math.min(maxS, remaining);
        inv.slots[i] = { id: from.id, count: take } as any; remaining -= take;
      }
    }

    const moved = from.count - remaining;
    if (moved <= 0) return false;
    inv.slots[fromIndex] = remaining > 0 ? ({ id: from.id, count: remaining } as any) : ({ id: 0, count: 0 } as any);
    return true;
  }
}