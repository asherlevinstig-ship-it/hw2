// server/src/rooms/MyRoom.ts
// FULL FILE - Option B (server authoritative chunks) + multiplayer + persistence
// Includes: biomes + biome terrain + biome trees + ores + bedrock + inventory + drops + crafting + hold-to-mine
// Deterministic REGION-grid POIs stamped per-chunk (no half-spawns)
// Town of Beginnings (central safe zone) stamped per-chunk (deterministic, seam-safe)
// Path B: Pre-expanded structure stamping (.blocks.json) seam-safe, deterministic anchor placement
// NOTE: No match phase yet (always-on safe zone rules)

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
};

type ItemStack = SharedItemStack;

type InvState = {
  slots: ItemStack[]; // HOTBAR + BACKPACK
  cursor: ItemStack;
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
  slot: number;
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
 *  POIs (region grid)
 *  ========================= */
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
  private readonly COAL_ORE_ID = 7;
  private readonly IRON_ORE_ID = 8;
  private readonly GOLD_ORE_ID = 9;
  private readonly DIAMOND_ORE_ID = 10;

  // Biome surface blocks (MUST match client)
  private readonly SAND_ID = 11;
  private readonly SNOW_ID = 12;

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
  // =========================
  private readonly TOWN_CENTER_X = 0;
  private readonly TOWN_CENTER_Z = 0;

  // Safe zone radius (horizontal distance)
  private readonly SAFE_RADIUS = 28;

  // Town “blueprint” dimensions (procedural)
  private readonly TOWN_PLAZA_RADIUS = 10;
  private readonly TOWN_RING_RADIUS = 24; // decorative ring/wall radius
  private readonly TOWN_PATH_HALF_W = 2; // path half-width (total ~5)
  private readonly TOWN_CLEAR_HEIGHT = 18; // clear above ground inside town (removes trees)

  // =========================
  // World meta / seed
  // =========================
  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");
  private readonly invDir = path.join(this.worldDir, "inventories");
  private readonly metaPath = path.join(this.worldDir, "meta.json");
  private worldSeed = 0;

  // =========================
  // Players
  // =========================
  private players = new Map<string, PlayerInfo>();

  // =========================
  // World
  // =========================
  private chunks = new Map<string, Uint8Array>();

  // =========================
  // Drops
  // =========================
  private drops = new Map<string, Drop>();
  private nextDropSeq = 1;

  // =========================
  // Mining state
  // =========================
  private mining = new Map<string, MiningState>(); // by sessionId

  // =========================
  // Inventory cache
  // =========================
  private inventories = new Map<string, InvState>();

  // =========================
  // Structures (Path B: pre-expanded blocks)
  // =========================
  private townHall: BlockStructure | null = null;

  // =========================
  // onCreate
  // =========================
  onCreate(options: any) {
    console.log("✅ MyRoom created", options);
    this.maxClients = 32;
    this.autoDispose = false;

    this.ensureDirs();
    console.log("[WORLD] persistence dirs:", {
      chunks: this.chunksDir,
      inventories: this.invDir,
    });

    this.worldSeed = this.loadOrCreateWorldSeed(options);
    console.log("[WORLD] worldSeed =", this.worldSeed);

    // Load pre-expanded structures (Path B)
    try {
      this.townHall = loadBlockStructure(
        "server/src/structures/town_hall.blocks.json"
      );
      console.log("[STRUCT] townHall loaded:", {
        name: this.townHall.name,
        blocks: this.townHall.blocks.length,
        size: this.townHall.size,
        anchor: this.townHall.anchor,
      });
    } catch (e) {
      console.warn("[STRUCT] townHall failed to load", e);
      this.townHall = null;
    }

    // players snapshot
    this.clock.setInterval(() => {
      const all = Array.from(this.players.values()).map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
      }));
      this.broadcast("playersSnapshot", all);

      const now = Date.now();
      if (now - this.lastSnapshotLogAt > 3000) {
        this.lastSnapshotLogAt = now;
        console.log("[SNAPSHOT]", {
          count: all.length,
          ids: all.map((p) => p.id).slice(0, 5),
        });
      }
    }, this.snapshotIntervalMs);

    // mining tick
    this.clock.setInterval(() => this.tickMining(), this.mineTickMs);

    // drops cleanup
    this.clock.setInterval(
      () => this.cleanupDrops(),
      this.DROP_CLEANUP_EVERY_MS
    );

    // =========================
    // Chunk streaming
    // =========================
    this.onMessage("worldDataNeeded", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<WorldDataNeededMsg>;
      if (typeof p.id !== "string" || p.id.length < 1) return;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z))
        return;

      const rx = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const ry = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const rz = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      // normalize to indices for storage/generation
      const { cx, cy, cz } = this.normalizeChunkRequestToIndex(rx, ry, rz);
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: this.chunkSize,
        x: rx, // echo exact request
        y: ry,
        z: rz,
        voxels: chunk,
      };

      client.send("chunkData", msg);
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
      if (
        !isFiniteNumber(maybe.x) ||
        !isFiniteNumber(maybe.y) ||
        !isFiniteNumber(maybe.z)
      )
        return;

      const x = clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord);
      const y = clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord);
      const z = clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord);
      const yaw = isFiniteNumber(maybe.yaw) ? maybe.yaw : pl.yaw;

      const dtSec = Math.max(
        0.001,
        (now - Math.max(0, pl.lastMoveAt)) / 1000
      );
      const maxDist = this.maxSpeedBlocksPerSec * dtSec;

      const dx = x - pl.x;
      const dy = y - pl.y;
      const dz = z - pl.z;

      // allow generous slack
      if (dx * dx + dy * dy + dz * dz > maxDist * maxDist * 9) return;

      pl.x = x;
      pl.y = y;
      pl.z = z;
      pl.yaw = yaw;
      pl.lastMoveAt = now;

      this.broadcast(
        "playerTransformOther",
        { id: client.sessionId, x, y, z, yaw },
        { except: client }
      );

      if (now - this.lastMoveLogAt > 2000) {
        this.lastMoveLogAt = now;
        console.log("[MOVE]", {
          id: client.sessionId,
          x: +x.toFixed(2),
          y: +y.toFixed(2),
          z: +z.toFixed(2),
          yaw: +yaw.toFixed(2),
        });
      }
    });

    // =========================
    // Mining: hold-to-mine
    // =========================
    this.onMessage("startMine", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<StartMineMsg>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z))
        return;

      const x = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));
      const heldSlot = isFiniteNumber((p as any).heldSlot)
        ? toInt((p as any).heldSlot)
        : -1;

      // Safe zone enforcement: NO MINING in Town of Beginnings
      if (this.isInSafeZoneXZ(x, z)) {
        this.cancelMiningFor(client, "safe_zone");
        return;
      }

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      // reach check
      const dx = x + 0.5 - pl.x;
      const dy = y + 0.5 - pl.y;
      const dz = z + 0.5 - pl.z;
      if (dx * dx + dy * dy + dz * dz > this.mineReach * this.mineReach) {
        this.cancelMiningFor(client, "too_far");
        return;
      }

      const blockId = this.getBlockAt(x, y, z);
      if (blockId === this.AIR_ID) {
        this.cancelMiningFor(client, "air");
        return;
      }
      if (blockId === this.BEDROCK_ID) {
        this.cancelMiningFor(client, "bedrock");
        return;
      }

      const userId = pl.userId;
      const inv = this.getOrLoadInventory(userId);

      const cur = this.mining.get(client.sessionId);
      const now = Date.now();

      // heartbeat / keep-alive on the same block
      if (cur && cur.x === x && cur.y === y && cur.z === z) {
        cur.lastHeartbeatAt = now;
        cur.heldSlot = heldSlot;

        const nowBlock = this.getBlockAt(x, y, z);
        if (nowBlock !== cur.lastBlockId)
          this.cancelMiningFor(client, "block_changed");
        return;
      }

      if (cur) this.cancelMiningFor(client, "retarget");

      const breakTimeMs = this.computeBreakTimeMs(blockId, inv, heldSlot);

      const st: MiningState = {
        sessionId: client.sessionId,
        userId,
        x,
        y,
        z,
        heldSlot,
        startedAt: now,
        lastHeartbeatAt: now,
        breakTimeMs,
        lastStageSent: -1,
        lastProgressSentAt: 0,
        lastBlockId: blockId,
      };

      this.mining.set(client.sessionId, st);
      client.send(
        "mineProgress",
        { x, y, z, progress: 0, stage: 0 } satisfies MineProgressMsg
      );

      const picked = this.choosePickStack(inv, heldSlot);
      console.log("[MINE start]", {
        by: client.sessionId,
        userId,
        x,
        y,
        z,
        blockId,
        breakTimeMs,
        heldSlot,
        tool: picked
          ? {
              id: (picked.stack as any).id,
              tier: picked.tool.tier,
              slot: picked.slotIndex,
            }
          : null,
      });
    });

    this.onMessage("cancelMine", (client: Client, payload: unknown) => {
      const reason =
        typeof (payload as any)?.reason === "string"
          ? String((payload as any).reason).slice(0, 60)
          : "client_cancel";
      this.cancelMiningFor(client, reason);
    });

    // legacy instant mine
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (
        !isFiniteNumber(maybe.x) ||
        !isFiniteNumber(maybe.y) ||
        !isFiniteNumber(maybe.z)
      )
        return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      // Safe zone enforcement: NO MINING in Town of Beginnings
      if (this.isInSafeZoneXZ(x, z)) return;

      const oldId = this.getBlockAt(x, y, z);
      if (oldId === this.AIR_ID) return;
      if (oldId === this.BEDROCK_ID) return;

      const pl = this.players.get(client.sessionId);
      const inv = pl ? this.getOrLoadInventory(pl.userId) : null;
      const canDrop = this.canBlockDropWithTool(oldId, inv, -1);

      console.log("[EDIT mineBlock legacy]", {
        by: client.sessionId,
        x,
        y,
        z,
        oldId,
        canDrop,
      });

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);

      if (canDrop) {
        const dropItem = this.blockIdToDropItemId(oldId);
        if (dropItem > 0)
          this.spawnDrop(dropItem, 1, x + 0.5, y + 0.65, z + 0.5);
      }
    });

    // =========================
    // Block placing (authoritative + persistent)
    // =========================
    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<PlaceBlockMsg>;
      if (
        !isFiniteNumber(maybe.x) ||
        !isFiniteNumber(maybe.y) ||
        !isFiniteNumber(maybe.z)
      )
        return;
      if (!isFiniteNumber(maybe.id)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));
      const blockId = toInt(clamp(maybe.id, 0, 255));

      if (blockId === this.BEDROCK_ID) return;

      // Safe zone enforcement: NO PLACING in Town of Beginnings
      if (this.isInSafeZoneXZ(x, z)) return;

      const oldId = this.getBlockAt(x, y, z);
      if (oldId !== this.AIR_ID) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.getOrLoadInventory(pl.userId);

      const fromSlot = isFiniteNumber(maybe.fromSlot)
        ? toInt(maybe.fromSlot)
        : -1;
      if (fromSlot < 0 || fromSlot >= this.HOTBAR_SLOTS) return;

      const stack = inv.slots[fromSlot];
      if (!stack || (stack as any).id <= 0 || (stack as any).count <= 0) return;

      const def = ITEM_DEFS[(stack as any).id];
      if (!def || typeof def.placeBlockId !== "number") return;
      if (def.placeBlockId !== blockId) return;

      console.log("[EDIT placeBlock]", {
        by: client.sessionId,
        x,
        y,
        z,
        blockId,
        fromSlot,
        itemId: (stack as any).id,
      });

      (stack as any).count -= 1;
      if ((stack as any).count <= 0)
        inv.slots[fromSlot] = { id: 0, count: 0 } as any;

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);

      const ms = this.mining.get(client.sessionId);
      if (ms && ms.x === x && ms.y === y && ms.z === z)
        this.cancelMiningFor(client, "placed_on_target");

      this.setBlockAuthoritative(x, y, z, blockId);
    });

    // =========================
    // Drops: pickup
    // =========================
    this.onMessage("pickupDrop", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as { dropId?: unknown };
      const dropId = typeof p.dropId === "string" ? p.dropId : "";
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

      const dx = drop.x - pl.x;
      const dy = drop.y - pl.y;
      const dz = drop.z - pl.z;
      if (dx * dx + dy * dy + dz * dz > 2.6 * 2.6) return;

      const inv = this.getOrLoadInventory(pl.userId);
      const accepted = this.inventoryAdd(inv, {
        id: drop.itemId,
        count: drop.count,
      });

      if (accepted <= 0) return;

      this.drops.delete(dropId);
      this.broadcast("dropDespawn", { dropId });

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);

      console.log("[DROP pickup]", {
        by: client.sessionId,
        dropId,
        itemId: drop.itemId,
        count: drop.count,
      });
    });

    // =========================
    // Inventory clicks (cursor-based)
    // =========================
    this.onMessage("invClick", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<InvClickMsg>;
      if (!isFiniteNumber(p.slot)) return;

      const slot = toInt(p.slot);
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

    // =========================
    // Crafting
    // =========================
    this.onMessage("craft", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<CraftMsg>;
      const recipeId = typeof p.recipeId === "string" ? p.recipeId : "";
      if (!recipeId) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.getOrLoadInventory(pl.userId);

      const recipe = RECIPES.find((r) => r.id === recipeId);
      if (!recipe) {
        client.send("craftResult", {
          ok: false,
          recipeId,
          crafted: 0,
          reason: "unknown_recipe",
        });
        return;
      }

      const wantMax = !!p.max;
      const timesReq = isFiniteNumber(p.times)
        ? clamp(toInt(p.times), 1, 999)
        : 1;

      const craftableByInputs = () => {
        for (const req of recipe.inputs) {
          if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        }
        return true;
      };

      const tryCraftOnce = (): boolean => {
        for (const req of recipe.inputs) {
          if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        }
        if (!this.inventoryCanFit(inv, recipe.output.id, recipe.output.count))
          return false;

        for (const req of recipe.inputs)
          this.inventoryRemoveSlots(inv, req.id, req.count);
        this.inventoryAdd(inv, {
          id: recipe.output.id,
          count: recipe.output.count,
        });
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
        client.send("craftResult", {
          ok: false,
          recipeId,
          crafted: 0,
          reason: "missing_inputs_or_space",
        });
      } else {
        this.saveInventory(pl.userId, inv);
        this.sendInvStateToClient(client, inv);
        client.send("craftResult", { ok: true, recipeId, crafted, reason: "" });
      }
    });

    // =========================
    // Ping
    // =========================
    this.onMessage("ping", (client: Client, payload: unknown) =>
      client.send("pong", payload)
    );
  }

  // =========================
  // Join/Leave
  // =========================
  onJoin(client: Client, options: any) {
    const userId = safeUserId(options?.userId);
    console.log("➕ onJoin", { sessionId: client.sessionId, userId });

    // spawn spacing (inside town)
    const spacing = 5;
    let spawnX = this.TOWN_CENTER_X;
    let spawnZ = this.TOWN_CENTER_Z;

    let slot = 0;
    while (true) {
      // spiral-ish grid around center
      const sx = this.TOWN_CENTER_X + (slot % 6) * spacing - 12;
      const sz = this.TOWN_CENTER_Z + Math.floor(slot / 6) * spacing - 12;

      // keep within safe radius inner area
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
          occupied = true;
          break;
        }
      }

      if (!occupied) {
        spawnX = sx;
        spawnZ = sz;
        break;
      }

      slot++;
      if (slot > 4096) break;
    }

    const surfaceY = this.heightAt(spawnX, spawnZ);
    const spawnY = surfaceY + 8;

    const spawn: PlayerInfo = {
      id: client.sessionId,
      userId,
      x: spawnX,
      y: spawnY,
      z: spawnZ,
      yaw: 0,
      lastMoveAt: 0,
      joinedAt: Date.now(),
    };

    this.players.set(client.sessionId, spawn);

    const inv = this.getOrLoadInventory(userId);
    this.sendInvStateToClient(client, inv);
    client.send("worldMeta", { worldSeed: this.worldSeed });

    // Tell client about safe zone (client may ignore if not implemented yet)
    client.send("safeZone", {
      cx: this.TOWN_CENTER_X,
      cz: this.TOWN_CENTER_Z,
      radius: this.SAFE_RADIUS,
      name: "Town of Beginnings",
    });

    for (const d of this.drops.values()) {
      if (Date.now() - d.createdAt > this.DROP_TTL_MS) continue;
      client.send("dropSpawn", d);
    }

    const existingPlayers = Array.from(this.players.values())
      .filter((pl) => pl.id !== client.sessionId)
      .map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw }));

    client.send("existingPlayers", existingPlayers);

    this.broadcast(
      "playerJoined",
      {
        id: client.sessionId,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: spawn.yaw,
      },
      { except: client }
    );
    client.send("youJoined", {
      id: client.sessionId,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: spawn.yaw,
    });

    const allNow = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
    }));
    client.send("playersSnapshot", allNow);

    console.log("[JOIN STATE]", {
      joined: client.sessionId,
      userId,
      spawn: { x: spawnX, y: spawnY, z: spawnZ },
      players: this.players.size,
    });
  }

  onLeave(client: Client, code?: number) {
    console.log("➖ onLeave", client.sessionId, "code:", code);
    this.cancelMiningFor(client, "leave");
    const existed = this.players.delete(client.sessionId);
    if (existed) this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");
    this.players.clear();
    this.mining.clear();
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
    if (!fs.existsSync(this.worldDir))
      fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir))
      fs.mkdirSync(this.chunksDir, { recursive: true });
    if (!fs.existsSync(this.invDir))
      fs.mkdirSync(this.invDir, { recursive: true });
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
    if (
      meta &&
      typeof meta.worldSeed === "number" &&
      Number.isFinite(meta.worldSeed)
    ) {
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

  private readWorldMeta(): { worldSeed?: number } | null {
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

  private writeWorldMeta(meta: { worldSeed: number }): void {
    try {
      const tmp = this.metaPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(meta));
      fs.renameSync(tmp, this.metaPath);
    } catch (e) {
      console.warn("[WORLD] meta write failed:", this.metaPath, e);
    }
  }

  // =========================
  // Persistence: chunks
  // =========================
  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }
  private chunkFilePath(cx: number, cy: number, cz: number): string {
    return path.join(this.chunksDir, `c_${cx}_${cy}_${cz}.bin`);
  }
  private readChunkFromDisk(cx: number, cy: number, cz: number): Uint8Array | null {
    const fp = this.chunkFilePath(cx, cy, cz);
    try {
      if (!fs.existsSync(fp)) return null;
      const buf = fs.readFileSync(fp);
      const expected = this.chunkSize * this.chunkSize * this.chunkSize;
      if (buf.byteLength !== expected) {
        console.warn("[WORLD] chunk file wrong size, ignoring:", fp, {
          got: buf.byteLength,
          expected,
        });
        return null;
      }
      const out = new Uint8Array(expected);
      out.set(buf);
      console.log("[WORLD] loaded chunk:", { cx, cy, cz, fp });
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
    console.log("[WORLD] saved chunk:", { cx, cy, cz, fp });
  }

  // =========================
  // Persistence: inventories
  // =========================
  private invFilePath(userId: string): string {
    return path.join(this.invDir, `inv_${userId}.json`);
  }

  private readInvFromDisk(userId: string): InvState | null {
    const fp = this.invFilePath(userId);
    try {
      if (!fs.existsSync(fp)) return null;
      const raw = fs.readFileSync(fp, "utf8");
      const j = JSON.parse(raw);

      const slotsIn = Array.isArray(j?.slots) ? j.slots : null;
      const cursorIn = typeof j?.cursor === "object" && j?.cursor ? j.cursor : null;

      const slots: ItemStack[] = Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 } as any));
      if (slotsIn) {
        for (let i = 0; i < Math.min(this.INV_SLOTS, slotsIn.length); i++) {
          const s = slotsIn[i];
          const id = toInt(clamp(Number(s?.id ?? 0), 0, 999999));
          const count = toInt(clamp(Number(s?.count ?? 0), 0, 999999));
          const durRaw = Number(s?.dur ?? 0);
          const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;

          slots[i] =
            id > 0 && count > 0
              ? dur > 0
                ? ({ id, count, dur } as any)
                : ({ id, count } as any)
              : ({ id: 0, count: 0 } as any);
        }
      }

      const cId = toInt(clamp(Number((cursorIn as any)?.id ?? 0), 0, 999999));
      const cCount = toInt(clamp(Number((cursorIn as any)?.count ?? 0), 0, 999999));
      const cDurRaw = Number((cursorIn as any)?.dur ?? 0);
      const cDur = Number.isFinite(cDurRaw) ? toInt(clamp(cDurRaw, 0, 999999)) : 0;

      const cursor: ItemStack =
        cId > 0 && cCount > 0
          ? cDur > 0
            ? ({ id: cId, count: cCount, dur: cDur } as any)
            : ({ id: cId, count: cCount } as any)
          : ({ id: 0, count: 0 } as any);

      console.log("[INV] loaded", { userId, fp });
      return { slots, cursor };
    } catch (e) {
      console.warn("[INV] read failed", { userId, fp, e });
      return null;
    }
  }

  private writeInvToDisk(userId: string, inv: InvState): void {
    const fp = this.invFilePath(userId);
    const tmp = fp + ".tmp";
    const safe = {
      slots: inv.slots.map((s) => ({
        id: toInt((s as any).id || 0),
        count: toInt((s as any).count || 0),
        dur: toInt((s as any).dur || 0),
      })),
      cursor: {
        id: toInt((inv.cursor as any).id || 0),
        count: toInt((inv.cursor as any).count || 0),
        dur: toInt((inv.cursor as any).dur || 0),
      },
    };
    fs.writeFileSync(tmp, JSON.stringify(safe));
    fs.renameSync(tmp, fp);
    console.log("[INV] saved", { userId, fp });
  }

  private getOrLoadInventory(userId: string): InvState {
    const cached = this.inventories.get(userId);
    if (cached) return cached;

    const fromDisk = this.readInvFromDisk(userId);
    if (fromDisk) {
      this.inventories.set(userId, fromDisk);
      return fromDisk;
    }

    const inv: InvState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 } as any)),
      cursor: { id: 0, count: 0 } as any,
    };

    // starter kit (tune as desired)
    inv.slots[0] = { id: Items.WOOD_LOG, count: 4 } as any;

    this.inventories.set(userId, inv);
    this.saveInventory(userId, inv);
    return inv;
  }

  private saveInventory(userId: string, inv: InvState): void {
    this.inventories.set(userId, inv);
    try {
      this.writeInvToDisk(userId, inv);
    } catch (e) {
      console.warn("[INV] write failed", { userId, e });
    }
  }

  private sendInvStateToClient(client: Client, inv: InvState): void {
    client.send("invState", { slots: inv.slots, cursor: inv.cursor });
  }

  // =========================
  // World internals
  // =========================
  private idx(i: number, j: number, k: number): number {
    const CS = this.chunkSize;
    return i + CS * (j + CS * k);
  }

  // deterministic hash -> [0,1)
  private hash3i(x: number, y: number, z: number): number {
    const seed = this.worldSeed | 0;
    let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  // deterministic 2D hash -> [0,1)
  private hash2i(x: number, z: number, salt = 0): number {
    const seed = (this.worldSeed + (salt | 0)) | 0;
    let h = x * 374761393 + z * 668265263 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  private smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
  }

  // 2D value noise
  private valueNoise2(x: number, z: number, cellSize: number, salt = 0): number {
    const cx = floorDiv(x, cellSize);
    const cz = floorDiv(z, cellSize);

    const fx = (x - cx * cellSize) / cellSize;
    const fz = (z - cz * cellSize) / cellSize;

    const sx = this.smoothstep(clamp(fx, 0, 1));
    const sz = this.smoothstep(clamp(fz, 0, 1));

    const v00 = this.hash2i(cx, cz, salt);
    const v10 = this.hash2i(cx + 1, cz, salt);
    const v01 = this.hash2i(cx, cz + 1, salt);
    const v11 = this.hash2i(cx + 1, cz + 1, salt);

    const ix0 = v00 + (v10 - v00) * sx;
    const ix1 = v01 + (v11 - v01) * sx;
    return ix0 + (ix1 - ix0) * sz;
  }

  private fbm2(x: number, z: number, baseCell: number, octaves: number, salt = 0): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let cell = baseCell;
    for (let i = 0; i < octaves; i++) {
      const n = this.valueNoise2(x, z, Math.max(4, cell), salt + i * 1013);
      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      cell = Math.floor(cell * 0.5);
    }
    return norm > 0 ? sum / norm : 0.5;
  }

  private getBiome(worldX: number, worldZ: number): number {
    // Bias town center area to FOREST for a pleasant hub look
    const dx = worldX - this.TOWN_CENTER_X;
    const dz = worldZ - this.TOWN_CENTER_Z;
    if (dx * dx + dz * dz <= (this.SAFE_RADIUS + 10) * (this.SAFE_RADIUS + 10)) {
      return this.BIOME_FOREST;
    }

    const temp = this.fbm2(worldX, worldZ, 320, 3, 10000);
    const moist = this.fbm2(worldX, worldZ, 260, 3, 20000);

    if (temp < 0.36) return this.BIOME_SNOW;
    if (temp > 0.66 && moist < 0.46) return this.BIOME_DESERT;
    return this.BIOME_FOREST;
  }

  // biome-aware terrain height
  private heightAt(worldX: number, worldZ: number): number {
    const biome = this.getBiome(worldX, worldZ);

    // base macro undulation
    const macro = Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6;

    if (biome === this.BIOME_DESERT) {
      const dunes = Math.sin(worldX / 34) * 2 + Math.cos(worldZ / 31) * 2;
      return this.baseHeight + Math.floor(macro * 0.45 + dunes);
    }

    if (biome === this.BIOME_SNOW) {
      const ridges = Math.sin(worldX / 22) * 4 + Math.cos(worldZ / 19) * 4;
      return this.baseHeight + 4 + Math.floor(macro * 0.85 + ridges * 0.75);
    }

    return this.baseHeight + Math.floor(macro * 0.9);
  }

  private veinNoise(x: number, y: number, z: number): number {
    const a = this.hash3i(x, y, z);
    const b = this.hash3i(x + 17, y - 11, z + 23);
    const c = this.hash3i(x - 31, y + 7, z - 19);
    return a * 0.6 + b * 0.25 + c * 0.15;
  }

  // =========================
  // Trees (biome dependent)
  // =========================
  private shouldPlaceTreeAt(worldX: number, worldZ: number, biome: number): boolean {
    // no trees inside Town safe zone
    if (this.isInSafeZoneXZ(worldX, worldZ)) return false;

    if (biome === this.BIOME_DESERT) return false;

    const cell = biome === this.BIOME_FOREST ? 6 : 9;
    const cx = floorDiv(worldX, cell);
    const cz = floorDiv(worldZ, cell);

    const r = this.hash2i(cx, cz, 33333);

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
  // Safe zone helpers
  // =========================
  private isInSafeZoneXZ(worldX: number, worldZ: number): boolean {
    const dx = worldX - this.TOWN_CENTER_X;
    const dz = worldZ - this.TOWN_CENTER_Z;
    return dx * dx + dz * dz <= this.SAFE_RADIUS * this.SAFE_RADIUS;
  }

  // =========================
  // POIs (region grid, stamped per chunk)
  // =========================
  private poiCandidateForRegion(rx: number, rz: number): PoiCandidate {
    const regionSize = this.REGION_SIZE;
    const roll = this.hash2i(rx, rz, 70001);
    if (roll >= this.POI_CHANCE) {
      return {
        exists: false,
        rx,
        rz,
        x0: 0,
        y0: 0,
        z0: 0,
        rot: 0,
        tier: "COMMON",
        type: "HUT",
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: -1,
        maxY: -1,
        maxZ: -1,
      };
    }

    const type: PoiType = "HUT";

    const tierRoll = this.hash2i(rx, rz, 70003);
    const tier: PoiTier =
      tierRoll < 0.84 ? "COMMON" : tierRoll < 0.97 ? "RARE" : "LEGENDARY";

    const rotRoll = this.hash2i(rx, rz, 70004);
    const rot: 0 | 90 | 180 | 270 =
      rotRoll < 0.25 ? 0 : rotRoll < 0.5 ? 90 : rotRoll < 0.75 ? 180 : 270;

    const pad = this.POI_EDGE_PAD;
    const ox = pad + Math.floor(this.hash2i(rx, rz, 70005) * (regionSize - pad * 2));
    const oz = pad + Math.floor(this.hash2i(rx, rz, 70006) * (regionSize - pad * 2));

    const worldX = rx * regionSize + ox;
    const worldZ = rz * regionSize + oz;

    // Avoid placing POIs inside the town safe zone (keep hub clean)
    if (this.isInSafeZoneXZ(worldX, worldZ)) {
      return {
        exists: false,
        rx,
        rz,
        x0: 0,
        y0: 0,
        z0: 0,
        rot: 0,
        tier: "COMMON",
        type: "HUT",
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: -1,
        maxY: -1,
        maxZ: -1,
      };
    }

    const ySurf = this.heightAt(worldX, worldZ);
    const y0 = ySurf + 1;

    const dims = this.poiDims(type, tier);
    const minX = worldX;
    const minY = y0;
    const minZ = worldZ;
    const maxX = worldX + dims.w - 1;
    const maxY = y0 + dims.h - 1;
    const maxZ = worldZ + dims.d - 1;

    return {
      exists: true,
      rx,
      rz,
      x0: worldX,
      y0,
      z0: worldZ,
      rot,
      tier,
      type,
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    };
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

    const wood = this.WOOD_ID;
    const stone = this.STONE_ID;
    const leaves = this.LEAVES_ID;

    if (type === "HUT") {
      const dims = this.poiDims(type, tier);
      const w = dims.w, d = dims.d, h = dims.h;

      // floor
      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) ops.push({ dx: x, dy: 0, dz: z, id: stone });

      // walls
      for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          ops.push({ dx: x, dy: y, dz: 0, id: wood });
          ops.push({ dx: x, dy: y, dz: d - 1, id: wood });
        }
        for (let z = 0; z < d; z++) {
          ops.push({ dx: 0, dy: y, dz: z, id: wood });
          ops.push({ dx: w - 1, dy: y, dz: z, id: wood });
        }
      }

      // roof
      const roofY = h - 1;
      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) ops.push({ dx: x, dy: roofY, dz: z, id: leaves });

      // doorway carve
      const doorX = Math.floor(w / 2);
      const filtered = ops.filter(
        (o) => !(o.id === wood && o.dz === 0 && o.dx === doorX && (o.dy === 1 || o.dy === 2))
      );
      return filtered;
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

    const chunkMinX = cx * CS;
    const chunkMinY = cy * CS;
    const chunkMinZ = cz * CS;

    const chunkMaxX = chunkMinX + CS - 1;
    const chunkMaxY = chunkMinY + CS - 1;
    const chunkMaxZ = chunkMinZ + CS - 1;

    const regMinX = floorDiv(chunkMinX, this.REGION_SIZE);
    const regMaxX = floorDiv(chunkMaxX, this.REGION_SIZE);
    const regMinZ = floorDiv(chunkMinZ, this.REGION_SIZE);
    const regMaxZ = floorDiv(chunkMaxZ, this.REGION_SIZE);

    for (let rx = regMinX; rx <= regMaxX; rx++) {
      for (let rz = regMinZ; rz <= regMaxZ; rz++) {
        const poi = this.poiCandidateForRegion(rx, rz);
        if (!poi.exists) continue;

        if (
          poi.maxX < chunkMinX ||
          poi.minX > chunkMaxX ||
          poi.maxY < chunkMinY ||
          poi.minY > chunkMaxY ||
          poi.maxZ < chunkMinZ ||
          poi.minZ > chunkMaxZ
        )
          continue;

        const dims = this.poiDims(poi.type, poi.tier);
        const ops = this.poiOps(poi.type, poi.tier);

        for (const op of ops) {
          const rotPos = this.rotateLocal(op.dx, op.dz, dims.w, dims.d, poi.rot);
          const wx = poi.x0 + rotPos.rx;
          const wy = poi.y0 + op.dy;
          const wz = poi.z0 + rotPos.rz;

          if (wx < chunkMinX || wx > chunkMaxX) continue;
          if (wy < chunkMinY || wy > chunkMaxY) continue;
          if (wz < chunkMinZ || wz > chunkMaxZ) continue;

          const lx = wx - chunkMinX;
          const ly = wy - chunkMinY;
          const lz = wz - chunkMinZ;

          const ii = this.idx(lx, ly, lz);

          if (vox[ii] === this.BEDROCK_ID) continue;
          if (op.id === this.AIR_ID) continue;

          vox[ii] = clamp(toInt(op.id), 0, 255);
        }
      }
    }
  }

  // =========================
  // Town of Beginnings stamping (procedural + structure stamping)
  // =========================
  private stampTownIntoChunk(vox: Uint8Array, cx: number, cy: number, cz: number): void {
    const CS = this.chunkSize;

    const chunkMinX = cx * CS;
    const chunkMinY = cy * CS;
    const chunkMinZ = cz * CS;

    const chunkMaxX = chunkMinX + CS - 1;
    const chunkMaxY = chunkMinY + CS - 1;
    const chunkMaxZ = chunkMinZ + CS - 1;

    // quick reject by horizontal distance from town center (chunk AABB vs circle)
    const closestX = clamp(this.TOWN_CENTER_X, chunkMinX, chunkMaxX);
    const closestZ = clamp(this.TOWN_CENTER_Z, chunkMinZ, chunkMaxZ);
    const dx0 = closestX - this.TOWN_CENTER_X;
    const dz0 = closestZ - this.TOWN_CENTER_Z;
    const r = this.SAFE_RADIUS + 2;
    if (dx0 * dx0 + dz0 * dz0 > r * r) return;

    // procedural town features
    for (let lx = 0; lx < CS; lx++) {
      for (let lz = 0; lz < CS; lz++) {
        const wx = chunkMinX + lx;
        const wz = chunkMinZ + lz;

        const dx = wx - this.TOWN_CENTER_X;
        const dz = wz - this.TOWN_CENTER_Z;
        const d2 = dx * dx + dz * dz;

        if (d2 > (this.TOWN_RING_RADIUS + 4) * (this.TOWN_RING_RADIUS + 4)) continue;

        const colSurface = this.heightAt(wx, wz);
        const colTownBase = colSurface + 1;

        const inPlaza = d2 <= this.TOWN_PLAZA_RADIUS * this.TOWN_PLAZA_RADIUS;

        const inPath =
          (Math.abs(dz) <= this.TOWN_PATH_HALF_W && Math.abs(dx) <= this.TOWN_RING_RADIUS) ||
          (Math.abs(dx) <= this.TOWN_PATH_HALF_W && Math.abs(dz) <= this.TOWN_RING_RADIUS);

        const ringR0 = this.TOWN_RING_RADIUS;
        const ringR1 = this.TOWN_RING_RADIUS + 1;
        const inRingBand = d2 >= ringR0 * ringR0 && d2 <= ringR1 * ringR1;

        const hutCenters: Array<{ hx: number; hz: number }> = [
          { hx: this.TOWN_CENTER_X + 16, hz: this.TOWN_CENTER_Z + 16 },
          { hx: this.TOWN_CENTER_X - 16, hz: this.TOWN_CENTER_Z + 16 },
          { hx: this.TOWN_CENTER_X + 16, hz: this.TOWN_CENTER_Z - 16 },
          { hx: this.TOWN_CENTER_X - 16, hz: this.TOWN_CENTER_Z - 16 },
        ];

        let hutLocal: { ox: number; oz: number; which: number } | null = null;
        for (let i = 0; i < hutCenters.length; i++) {
          const c = hutCenters[i];
          const ox = wx - c.hx;
          const oz = wz - c.hz;
          if (Math.abs(ox) <= 3 && Math.abs(oz) <= 3) {
            hutLocal = { ox, oz, which: i };
            break;
          }
        }

        const inFountainFoot = Math.abs(dx) <= 1 && Math.abs(dz) <= 1;

        for (let ly = 0; ly < CS; ly++) {
          const wy = chunkMinY + ly;
          const ii = this.idx(lx, ly, lz);

          if (vox[ii] === this.BEDROCK_ID) continue;

          // clear space above ground inside safe area
          if (this.isInSafeZoneXZ(wx, wz)) {
            const clearTop = Math.min(chunkMaxY, colSurface + this.TOWN_CLEAR_HEIGHT);
            if (wy > colSurface && wy <= clearTop) vox[ii] = this.AIR_ID;
          }

          // plaza/path paint + flatten-ish
          if (inPlaza || inPath) {
            const targetY = colSurface + 1;

            if (wy <= targetY && wy >= colSurface - 2) {
              if (wy === targetY) vox[ii] = this.STONE_ID;
              else if (wy >= targetY - 2) vox[ii] = this.DIRT_ID;
            }

            if (wy > targetY && wy <= targetY + 6) vox[ii] = this.AIR_ID;
          }

          // ring wall band
          if (inRingBand) {
            const wallY = colSurface + 2;
            if (wy === wallY) vox[ii] = this.STONE_ID;
            if (wy === wallY + 1) {
              const every = 5;
              const onPost =
                (mod(dx, every) === 0 && mod(dz, every) === 0) || this.hash2i(wx, wz, 91234) > 0.94;
              if (onPost) vox[ii] = this.LEAVES_ID;
            }
            if (wy > wallY + 1 && wy <= wallY + 5) vox[ii] = this.AIR_ID;
          }

          // fountain/totem
          if (inFountainFoot) {
            const baseY = colSurface + 1;
            if (wy === baseY) vox[ii] = this.STONE_ID;
            if (wy >= baseY + 1 && wy <= baseY + 5) vox[ii] = this.WOOD_ID;
            if (wy === baseY + 6) vox[ii] = this.LEAVES_ID;
            if (wy === baseY + 7 && (Math.abs(dx) + Math.abs(dz) === 1)) vox[ii] = this.LEAVES_ID;
          }

          // starter huts
          if (hutLocal) {
            const hutBaseY = colTownBase;

            const ox = hutLocal.ox;
            const oz = hutLocal.oz;

            const h = 5;
            const roofY = hutBaseY + (h - 1);

            if (wy === hutBaseY) vox[ii] = this.STONE_ID;

            const isEdge = Math.abs(ox) === 3 || Math.abs(oz) === 3;
            const wallY0 = hutBaseY + 1;
            const wallY1 = hutBaseY + (h - 2);

            let doorSide: "N" | "S" | "E" | "W" = "S";
            const hc = hutCenters[hutLocal.which];
            const towardX = hc.hx > this.TOWN_CENTER_X ? "W" : "E";
            const towardZ = hc.hz > this.TOWN_CENTER_Z ? "S" : "N";
            doorSide =
              Math.abs(hc.hx - this.TOWN_CENTER_X) >= Math.abs(hc.hz - this.TOWN_CENTER_Z)
                ? (towardX as any)
                : (towardZ as any);

            const doorX = 0;
            const doorY1 = hutBaseY + 1;
            const doorY2 = hutBaseY + 2;

            const isDoor =
              (doorSide === "N" && oz === 3 && ox === doorX && (wy === doorY1 || wy === doorY2)) ||
              (doorSide === "S" && oz === -3 && ox === doorX && (wy === doorY1 || wy === doorY2)) ||
              (doorSide === "E" && ox === 3 && oz === doorX && (wy === doorY1 || wy === doorY2)) ||
              (doorSide === "W" && ox === -3 && oz === doorX && (wy === doorY1 || wy === doorY2));

            if (wy >= wallY0 && wy <= wallY1 && isEdge) vox[ii] = isDoor ? this.AIR_ID : this.WOOD_ID;

            if (wy === roofY) vox[ii] = this.LEAVES_ID;

            if (wy > hutBaseY && wy <= roofY + 2 && !isEdge) vox[ii] = this.AIR_ID;
          }
        }
      }
    }

    // Stamp Town Hall structure LAST so it overrides plaza clearing and hut decoration.
    if (this.townHall) {
      const centerY = this.heightAt(this.TOWN_CENTER_X, this.TOWN_CENTER_Z);
      const baseY = centerY + 1;

      const worldX = this.TOWN_CENTER_X - this.townHall.anchor.x;
      const worldY = baseY - this.townHall.anchor.y;
      const worldZ = this.TOWN_CENTER_Z - this.townHall.anchor.z;

      this.stampStructureIntoChunk(vox, cx, cy, cz, this.townHall, worldX, worldY, worldZ);
    }
  }

  // =========================
  // Path B: Structure stamping (seam-safe per chunk)
  // =========================
  private stampStructureIntoChunk(
    vox: Uint8Array,
    cx: number,
    cy: number,
    cz: number,
    s: { size: { w: number; h: number; d: number }; blocks: Array<{ x: number; y: number; z: number; id: number }> },
    worldX: number,
    worldY: number,
    worldZ: number
  ): void {
    const CS = this.chunkSize;

    const chunkMinX = cx * CS;
    const chunkMinY = cy * CS;
    const chunkMinZ = cz * CS;
    const chunkMaxX = chunkMinX + CS - 1;
    const chunkMaxY = chunkMinY + CS - 1;
    const chunkMaxZ = chunkMinZ + CS - 1;

    const sMinX = worldX;
    const sMinY = worldY;
    const sMinZ = worldZ;
    const sMaxX = worldX + s.size.w - 1;
    const sMaxY = worldY + s.size.h - 1;
    const sMaxZ = worldZ + s.size.d - 1;

    if (sMaxX < chunkMinX || sMinX > chunkMaxX) return;
    if (sMaxY < chunkMinY || sMinY > chunkMaxY) return;
    if (sMaxZ < chunkMinZ || sMinZ > chunkMaxZ) return;

    for (const b of s.blocks) {
      const wx = worldX + b.x;
      const wy = worldY + b.y;
      const wz = worldZ + b.z;

      if (wx < chunkMinX || wx > chunkMaxX) continue;
      if (wy < chunkMinY || wy > chunkMaxY) continue;
      if (wz < chunkMinZ || wz > chunkMaxZ) continue;

      const lx = wx - chunkMinX;
      const ly = wy - chunkMinY;
      const lz = wz - chunkMinZ;

      const ii = this.idx(lx, ly, lz);

      if (vox[ii] === this.BEDROCK_ID) continue;

      vox[ii] = clamp(toInt(b.id), 0, 255);
    }
  }

  // =========================
  // Chunk generation (biomes + ores + bedrock + trees + POIs + Town)
  // =========================
  private generateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const CS = this.chunkSize;
    const vox = new Uint8Array(CS * CS * CS);

    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i;
        const worldZ = cz * CS + k;

        const biome = this.getBiome(worldX, worldZ);
        const height = this.heightAt(worldX, worldZ);

        const surfaceId =
          biome === this.BIOME_DESERT
            ? this.SAND_ID
            : biome === this.BIOME_SNOW
            ? this.SNOW_ID
            : this.GRASS_ID;

        const subsurfaceId = biome === this.BIOME_DESERT ? this.SAND_ID : this.DIRT_ID;

        const hasTree = this.shouldPlaceTreeAt(worldX, worldZ, biome);
        const tH = hasTree ? this.treeHeight(worldX, worldZ, biome) : 0;

        for (let j = 0; j < CS; j++) {
          const worldY = cy * CS + j;

          let id = this.AIR_ID;
          if (worldY > height) id = this.AIR_ID;
          else if (worldY === height) id = surfaceId;
          else if (worldY > height - 4) id = subsurfaceId;
          else id = this.STONE_ID;

          // bedrock at worldY <= 4
          if (worldY <= 4) {
            const rr = this.hash3i(worldX, worldY, worldZ);
            const threshold = 0.95 - worldY * 0.18;
            if (rr < threshold) {
              vox[this.idx(i, j, k)] = this.BEDROCK_ID;
              continue;
            }
          }

          // ores only replace stone
          if (id === this.STONE_ID) {
            const n = this.veinNoise(worldX, worldY, worldZ);

            if (worldY <= 16 && n > 0.985) id = this.DIAMOND_ORE_ID;
            else if (worldY <= 32 && n > 0.975) id = this.GOLD_ORE_ID;
            else if (worldY <= 64 && n > 0.965) id = this.IRON_ORE_ID;
            else if (worldY <= 128 && n > 0.955) id = this.COAL_ORE_ID;
          }

          // tree trunk + canopy
          if (hasTree && biome !== this.BIOME_DESERT) {
            const trunkBaseY = height + 1;
            const trunkTopY = height + tH;

            if (worldY >= trunkBaseY && worldY <= trunkTopY) {
              id = this.WOOD_ID;
            } else {
              const canopyY0 = trunkTopY - 1;
              const canopyY1 = trunkTopY + 2;

              if (worldY >= canopyY0 && worldY <= canopyY1) {
                const rr = this.hash3i(worldX, worldY, worldZ);
                const allow = rr > (biome === this.BIOME_SNOW ? 0.42 : 0.22);
                if (allow && id === this.AIR_ID) id = this.LEAVES_ID;
              }
            }
          }

          vox[this.idx(i, j, k)] = id;
        }
      }
    }

    this.stampPoiIntoChunk(vox, cx, cy, cz);

    // Town stamp LAST so it overrides terrain/trees/POIs near center
    this.stampTownIntoChunk(vox, cx, cy, cz);

    console.log("[WORLD] generated chunk:", { cx, cy, cz, seed: this.worldSeed });
    return vox;
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);
    const cached = this.chunks.get(key);
    if (cached) return cached;

    const fromDisk = this.readChunkFromDisk(cx, cy, cz);
    if (fromDisk) {
      this.chunks.set(key, fromDisk);
      return fromDisk;
    }

    const gen = this.generateChunk(cx, cy, cz);
    this.chunks.set(key, gen);
    return gen;
  }

  private getBlockAt(x: number, y: number, z: number): number {
    const CS = this.chunkSize;
    const cx = floorDiv(x, CS);
    const cy = floorDiv(y, CS);
    const cz = floorDiv(z, CS);

    const lx = mod(x, CS);
    const ly = mod(y, CS);
    const lz = mod(z, CS);

    const chunk = this.getOrCreateChunk(cx, cy, cz);
    return chunk[this.idx(lx, ly, lz)] | 0;
  }

  private setBlockAuthoritative(x: number, y: number, z: number, id: number): void {
    const CS = this.chunkSize;
    const cx = floorDiv(x, CS);
    const cy = floorDiv(y, CS);
    const cz = floorDiv(z, CS);

    const lx = mod(x, CS);
    const ly = mod(y, CS);
    const lz = mod(z, CS);

    const chunk = this.getOrCreateChunk(cx, cy, cz);
    const v = clamp(toInt(id), 0, 255);
    chunk[this.idx(lx, ly, lz)] = v;

    try {
      this.writeChunkToDisk(cx, cy, cz, chunk);
    } catch (e) {
      console.warn("[WORLD] write failed:", { cx, cy, cz }, e);
    }

    this.broadcast("blockUpdate", { x, y, z, id: v });
  }

  // =========================
  // Drops internals
  // =========================
  private cleanupDrops(): void {
    if (this.drops.size <= 0) return;

    const now = Date.now();
    const expired: string[] = [];

    for (const [id, d] of this.drops.entries()) {
      if (now - d.createdAt > this.DROP_TTL_MS) expired.push(id);
    }
    if (expired.length <= 0) return;

    for (const id of expired) {
      this.drops.delete(id);
      this.broadcast("dropDespawn", { dropId: id });
    }

    console.log("[DROP] cleanup", {
      expired: expired.length,
      remaining: this.drops.size,
    });
  }

  private spawnDrop(itemId: number, count: number, x: number, y: number, z: number): void {
    const id = `d_${Date.now().toString(16)}_${(this.nextDropSeq++).toString(16)}`;
    const drop: Drop = {
      dropId: id,
      itemId: clamp(toInt(itemId), 1, 999999),
      count: clamp(toInt(count), 1, 999999),
      x: clamp(Number(x), -this.maxAbsCoord, this.maxAbsCoord),
      y: clamp(Number(y), -this.maxAbsCoord, this.maxAbsCoord),
      z: clamp(Number(z), -this.maxAbsCoord, this.maxAbsCoord),
      createdAt: Date.now(),
    };
    this.drops.set(id, drop);
    this.broadcast("dropSpawn", drop);
    console.log("[DROP spawn]", drop);
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
  private isStoneLike(blockId: number): boolean {
    return (
      blockId === this.STONE_ID ||
      blockId === this.COAL_ORE_ID ||
      blockId === this.IRON_ORE_ID ||
      blockId === this.GOLD_ORE_ID ||
      blockId === this.DIAMOND_ORE_ID
    );
  }

  private getToolDef(itemId: number) {
    const def = ITEM_DEFS[itemId];
    return def?.tool ?? null;
  }

  private isToolItem(itemId: number): boolean {
    const def = ITEM_DEFS[itemId];
    return !!def?.tool || this.maxStackFor(itemId) === 1;
  }

  private cloneStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999));
    const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999));
    const durRaw = Number((s as any)?.dur ?? 0);
    const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  private choosePickStack(
    inv: InvState,
    heldSlot: number
  ): { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<MyRoom["getToolDef"]>> } | null {
    if (heldSlot >= 0 && heldSlot < this.HOTBAR_SLOTS) {
      const s = inv.slots[heldSlot];
      if (s && (s as any).id > 0 && (s as any).count > 0) {
        const tool = this.getToolDef((s as any).id);
        if (tool?.kind === "pick") return { slotIndex: heldSlot, stack: s, tool };
      }
    }

    let best:
      | { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<MyRoom["getToolDef"]>> }
      | null = null;

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
    if (blockId === this.STONE_ID) return 1;
    if (blockId === this.COAL_ORE_ID) return 1;
    if (blockId === this.IRON_ORE_ID) return 1;
    if (blockId === this.GOLD_ORE_ID) return 3;
    if (blockId === this.DIAMOND_ORE_ID) return 3;
    return 0;
  }

  private canBlockDropWithTool(blockId: number, inv: InvState | null, heldSlot = -1): boolean {
    if (blockId === this.BEDROCK_ID) return false;

    const reqTier = this.requiredPickTierForDrops(blockId);
    if (reqTier <= 0) return true;

    if (!inv) return false;
    const picked = this.choosePickStack(inv, heldSlot);
    if (!picked) return false;
    return picked.tool.tier >= reqTier;
  }

  private computeBreakTimeMs(blockId: number, inv: InvState, heldSlot = -1): number {
    let base = 450;

    if (blockId === this.LEAVES_ID) base = 180;
    else if (blockId === this.GRASS_ID) base = 420;
    else if (blockId === this.DIRT_ID) base = 420;
    else if (blockId === this.SAND_ID) base = 360;
    else if (blockId === this.SNOW_ID) base = 360;
    else if (blockId === this.WOOD_ID) base = 950;
    else if (blockId === this.STONE_ID) base = 1250;
    else if (blockId === this.COAL_ORE_ID) base = 1400;
    else if (blockId === this.IRON_ORE_ID) base = 1650;
    else if (blockId === this.GOLD_ORE_ID) base = 2200;
    else if (blockId === this.DIAMOND_ORE_ID) base = 2850;
    else if (blockId === this.BEDROCK_ID) return 999999999;

    const picked = this.choosePickStack(inv, heldSlot);

    if (this.isStoneLike(blockId)) {
      if (picked) base = Math.floor(base * picked.tool.speedMul);
      else base = Math.floor(base * 2.8);
    } else {
      if (blockId === this.WOOD_ID && picked) base = Math.floor(base * 0.92);
    }

    return clamp(base, 80, 12000);
  }

  private damageTool(inv: InvState, slotIndex: number): void {
    const s = inv.slots[slotIndex];
    if (!s || (s as any).id <= 0 || (s as any).count <= 0) return;

    const tool = this.getToolDef((s as any).id);
    if (!tool) return;

    const cur = toInt(clamp(Number((s as any).dur ?? tool.maxDurability), 0, 999999));
    const next = cur - 1;

    if (next <= 0) inv.slots[slotIndex] = { id: 0, count: 0 } as any;
    else (s as any).dur = next;
  }

  private cancelMiningFor(client: Client, reason: string): void {
    const st = this.mining.get(client.sessionId);
    if (!st) return;
    this.mining.delete(client.sessionId);
    client.send("mineCancelled", { reason });
    console.log("[MINE cancel]", {
      by: client.sessionId,
      reason,
      target: { x: st.x, y: st.y, z: st.z },
      blockId: st.lastBlockId,
    });
  }

  private tickMining(): void {
    const now = Date.now();

    for (const [sid, st] of this.mining.entries()) {
      const client = this.clients.find((c) => c.sessionId === sid);
      if (!client) {
        this.mining.delete(sid);
        continue;
      }

      const pl = this.players.get(sid);
      if (!pl) {
        this.cancelMiningFor(client, "no_player");
        continue;
      }

      if (now - st.lastHeartbeatAt > this.mineHeartbeatTimeoutMs) {
        this.cancelMiningFor(client, "timeout");
        continue;
      }

      if (this.isInSafeZoneXZ(st.x, st.z)) {
        this.cancelMiningFor(client, "safe_zone");
        continue;
      }

      const dx = st.x + 0.5 - pl.x;
      const dy = st.y + 0.5 - pl.y;
      const dz = st.z + 0.5 - pl.z;
      if (dx * dx + dy * dy + dz * dz > this.mineReach * this.mineReach) {
        this.cancelMiningFor(client, "too_far");
        continue;
      }

      const currentId = this.getBlockAt(st.x, st.y, st.z);
      if (currentId === this.AIR_ID) {
        this.cancelMiningFor(client, "air");
        continue;
      }
      if (currentId === this.BEDROCK_ID) {
        this.cancelMiningFor(client, "bedrock");
        continue;
      }
      if (currentId !== st.lastBlockId) {
        this.cancelMiningFor(client, "block_changed");
        continue;
      }

      const inv = this.getOrLoadInventory(st.userId);
      const newBreak = this.computeBreakTimeMs(currentId, inv, st.heldSlot);
      if (newBreak !== st.breakTimeMs) {
        const elapsed = Math.max(0, now - st.startedAt);
        const p = st.breakTimeMs > 0 ? elapsed / st.breakTimeMs : 0;
        st.breakTimeMs = newBreak;
        st.startedAt = now - Math.floor(p * st.breakTimeMs);
      }

      const elapsedMs = Math.max(0, now - st.startedAt);
      const progress01 = clamp(elapsedMs / Math.max(1, st.breakTimeMs), 0, 1);
      const stage = clamp(Math.floor(progress01 * 10), 0, 9);

      const shouldSend =
        stage !== st.lastStageSent ||
        now - st.lastProgressSentAt >= this.mineProgressSendMinMs ||
        progress01 >= 1;

      if (!shouldSend) continue;

      st.lastStageSent = stage;
      st.lastProgressSentAt = now;

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

        msg.done = true;
        client.send("mineProgress", msg);

        console.log("[MINE done]", {
          by: sid,
          userId: st.userId,
          x: st.x,
          y: st.y,
          z: st.z,
          blockId: currentId,
          canDrop,
          tool: picked
            ? {
                id: (picked.stack as any).id,
                tier: picked.tool.tier,
                slot: picked.slotIndex,
                dur: (inv.slots[picked.slotIndex] as any)?.dur ?? 0,
              }
            : null,
          breakTimeMs: st.breakTimeMs,
        });

        this.mining.delete(sid);
      } else {
        client.send("mineProgress", msg);
      }
    }
  }

  // =========================
  // Inventory helpers
  // =========================
  private normalizeStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999));
    const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999));
    const durRaw = Number((s as any)?.dur ?? 0);
    const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;

    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  private maxStackFor(itemId: number): number {
    const def = ITEM_DEFS[itemId];
    return def ? clamp(toInt(def.maxStack), 1, 999999) : 64;
  }

  private inventoryCountSlots(inv: InvState, itemId: number): number {
    let n = 0;
    for (const s of inv.slots) if ((s as any).id === itemId && (s as any).count > 0) n += (s as any).count;
    return n;
  }

  private inventoryCanFit(inv: InvState, itemId: number, count: number): boolean {
    const want = clamp(toInt(count), 1, 999999);
    const maxS = this.maxStackFor(itemId);
    let remaining = want;

    for (const s of inv.slots as any[]) {
      if (s.id === itemId && s.count > 0) {
        const space = maxS - s.count;
        if (space > 0) {
          const take = Math.min(space, remaining);
          remaining -= take;
          if (remaining <= 0) return true;
        }
      }
    }

    for (const s of inv.slots as any[]) {
      if (s.id === 0 || s.count <= 0) {
        const take = Math.min(maxS, remaining);
        remaining -= take;
        if (remaining <= 0) return true;
      }
    }

    return remaining <= 0;
  }

  private inventoryAdd(inv: InvState, stack: ItemStack): number {
    const s = this.normalizeStack(stack);
    if ((s as any).id <= 0 || (s as any).count <= 0) return 0;

    const id = (s as any).id | 0;
    const maxS = this.maxStackFor(id);
    let remaining = (s as any).count | 0;
    let accepted = 0;

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === id && slot.count > 0) {
        const space = maxS - slot.count;
        if (space > 0) {
          const take = Math.min(space, remaining);
          slot.count += take;
          remaining -= take;
          accepted += take;
          if (remaining <= 0) return accepted;
        }
      }
    }

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === 0 || slot.count <= 0) {
        const def = ITEM_DEFS[id];
        const isTool = !!def?.tool;

        if (isTool) {
          inv.slots[i] = { id, count: 1, dur: def!.tool!.maxDurability } as any;
          remaining -= 1;
          accepted += 1;
        } else {
          const take = Math.min(maxS, remaining);
          inv.slots[i] = { id, count: take } as any;
          remaining -= take;
          accepted += take;
        }

        if (remaining <= 0) return accepted;
      }
    }

    return accepted;
  }

  private inventoryRemoveSlots(inv: InvState, itemId: number, count: number): number {
    const want = clamp(toInt(count), 1, 999999);
    let remaining = want;
    let removed = 0;

    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i] as any;
      if (s.id === itemId && s.count > 0) {
        const take = Math.min(s.count, remaining);
        s.count -= take;
        remaining -= take;
        removed += take;
        if (s.count <= 0) inv.slots[i] = { id: 0, count: 0 } as any;
        if (remaining <= 0) break;
      }
    }
    return removed;
  }

  // =========================
  // Inventory click logic (durability-safe)
  // =========================
  private applyInvClick(inv: InvState, slotIndex: number, button: "L" | "R", shift: boolean): void {
    inv.cursor = this.normalizeStack(inv.cursor);
    inv.slots[slotIndex] = this.normalizeStack(inv.slots[slotIndex]);

    const cursor = inv.cursor as any;
    const slot = inv.slots[slotIndex] as any;

    const cursorIsTool = cursor.id > 0 && cursor.count > 0 && this.isToolItem(cursor.id);
    const slotIsTool = slot.id > 0 && slot.count > 0 && this.isToolItem(slot.id);

    // shift+L quick move between hotbar/backpack
    if (shift && button === "L") {
      if (slot.id <= 0 || slot.count <= 0) return;

      const isHotbar = slotIndex < this.HOTBAR_SLOTS;
      const targetStart = isHotbar ? this.HOTBAR_SLOTS : 0;
      const targetEnd = isHotbar ? this.INV_SLOTS : this.HOTBAR_SLOTS;

      if (this.moveStackBetweenRanges(inv, slotIndex, targetStart, targetEnd)) return;
      return;
    }

    if (button === "L") {
      if (cursor.id <= 0 || cursor.count <= 0) {
        inv.cursor = this.cloneStack(slot) as any;
        inv.slots[slotIndex] = { id: 0, count: 0 } as any;
        return;
      }

      if (slot.id <= 0 || slot.count <= 0) {
        inv.slots[slotIndex] = this.cloneStack(cursor) as any;
        inv.cursor = { id: 0, count: 0 } as any;
        return;
      }

      if (slot.id === cursor.id) {
        const maxS = this.maxStackFor(slot.id);
        const space = maxS - slot.count;
        if (space <= 0) return;

        const take = Math.min(space, cursor.count);
        slot.count += take;
        cursor.count -= take;

        inv.slots[slotIndex] = slot as any;
        inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
        return;
      }

      inv.slots[slotIndex] = this.cloneStack(cursor) as any;
      inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    // RIGHT CLICK
    if (cursor.id <= 0 || cursor.count <= 0) {
      if (slot.id <= 0 || slot.count <= 0) return;

      if (slotIsTool) {
        inv.cursor = this.cloneStack(slot) as any;
        inv.slots[slotIndex] = { id: 0, count: 0 } as any;
        return;
      }

      const take = Math.ceil(slot.count / 2);
      inv.cursor = { id: slot.id, count: take } as any;
      slot.count -= take;
      inv.slots[slotIndex] = slot.count > 0 ? (slot as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (cursorIsTool) {
      if (slot.id <= 0 || slot.count <= 0) {
        inv.slots[slotIndex] = this.cloneStack(cursor) as any;
        inv.cursor = { id: 0, count: 0 } as any;
        return;
      }
      inv.slots[slotIndex] = this.cloneStack(cursor) as any;
      inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    // cursor stackable
    if (slot.id <= 0 || slot.count <= 0) {
      inv.slots[slotIndex] = { id: cursor.id, count: 1 } as any;
      cursor.count -= 1;
      inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (slot.id === cursor.id) {
      const maxS = this.maxStackFor(slot.id);
      if (slot.count >= maxS) return;

      slot.count += 1;
      cursor.count -= 1;
      inv.slots[slotIndex] = slot as any;
      inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    // different item: do nothing on RMB for stackables
  }

  private moveStackBetweenRanges(inv: InvState, fromIndex: number, toStart: number, toEnd: number): boolean {
    inv.slots[fromIndex] = this.normalizeStack(inv.slots[fromIndex]);
    const from = inv.slots[fromIndex] as any;
    if (from.id <= 0 || from.count <= 0) return false;

    const maxS = this.maxStackFor(from.id);
    const isTool = this.isToolItem(from.id) || maxS === 1;

    if (isTool) {
      for (let i = toStart; i < toEnd; i++) {
        const s = this.normalizeStack(inv.slots[i]) as any;
        if (s.id <= 0 || s.count <= 0) {
          inv.slots[i] = this.cloneStack(from) as any;
          inv.slots[fromIndex] = { id: 0, count: 0 } as any;
          return true;
        }
      }
      return false;
    }

    let remaining = from.count;

    for (let i = toStart; i < toEnd; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id === from.id && s.count > 0) {
        const space = maxS - s.count;
        if (space > 0) {
          const take = Math.min(space, remaining);
          s.count += take;
          remaining -= take;
          inv.slots[i] = s as any;
          if (remaining <= 0) break;
        }
      }
    }

    for (let i = toStart; i < toEnd && remaining > 0; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id <= 0 || s.count <= 0) {
        const take = Math.min(maxS, remaining);
        inv.slots[i] = { id: from.id, count: take } as any;
        remaining -= take;
      }
    }

    const moved = from.count - remaining;
    if (moved <= 0) return false;

    const newCount = from.count - moved;
    inv.slots[fromIndex] = newCount > 0 ? ({ id: from.id, count: newCount } as any) : ({ id: 0, count: 0 } as any);
    return true;
  }
}
