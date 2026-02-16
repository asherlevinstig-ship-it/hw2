// server/src/rooms/MyRoom.ts
// FULL FILE - paste exactly as-is
//
// Path B (server authoritative chunks) + multiplayer + persistence
//
// ✅ FIXES "world resets on refresh":
// - NOA requests chunks using chunk ORIGIN coords (multiples of chunkSize), e.g. x = -32
// - Server storage/generation needs CHUNK INDICES, e.g. cx = -1
// - This file normalizes request coords -> indices for storage, but echoes original coords
//   back to the client (so pendingChunks match).
//
// ✅ Adds Minecraft-ish mineral generation + bedrock:
// - Bedrock randomized thickness in lowest layers
// - Coal / Iron / Gold / Diamond ores (deterministic hash noise, no libs)
// - Ores only replace stone and depend on depth
//
// ✅ Survival loop hooks (inventory + drops + crafting):
// - Server-authoritative inventory (hotbar + backpack) persisted per userId
// - Mining spawns item drops (server authoritative drop entities)
// - Pickup collects drops into inventory
// - Placing consumes inventory from specified hotbar slot
// - Inventory clicks: left/right/shift (cursor-based)
// - Crafting: simple recipe list (wood -> planks -> sticks -> picks)
//
// ✅ Option A Mining (HOLD-TO-MINE, tool speed, progress messages):
// - Client sends startMine {x,y,z,heldSlot?} repeatedly while held; server is authoritative.
// - Server computes break time based on block + tool tier/speed.
// - Server sends mineProgress {x,y,z,progress,stage,done?} to the mining client.
// - When done, server edits the world (persistent) and broadcasts blockUpdate.
// - Server also sends mineCancelled when mining is interrupted.
//
// ✅ Better mining rules (NEW):
// - Proper tool tiers (wood/stone/iron picks) from shared/items.ts
// - Correct “needs pick” per ore for DROPS (coal/iron require >=1; gold/diamond require >=3)
// - Optional tool durability: damage 1 on successful stone-like break; break tool at 0
//
// ✅ Drops cleanup (NEW):
// - Drops expire after DROP_TTL_MS to prevent world clutter
// - Periodic cleanup broadcasts dropDespawn
//
// ✅ Deterministic world seed (NEW):
// - Loads/creates world/meta.json { seed: number }
// - hash2i/hash3i include worldSeed so biomes/POIs/ores are repeatable per event seed
//
// ✅ Hazard 2 fix (NEW): tool durability + cursor/right-click handling mismatch
// - Cursor/slot move/copy rules now PRESERVE dur for tools
// - Right-click never "splits" tools; tools (maxStack=1) move as whole items
// - Shift-move preserves dur for tools
//
// Persistence:
// - Saves chunk files keyed by CHUNK INDEX: c_<cx>_<cy>_<cz>.bin
// - Saves player inventories keyed by userId: inv_<userId>.json
// - Loads from disk first, else generates
//
// Also:
// - autoDispose = false so room isn't destroyed when last client disconnects
// - loud logs for saves/loads/requests
//
// IMPORTANT:
// - This file imports Items/defs/recipes from shared/items.ts
// - Node16/NodeNext module resolution requires explicit ".js" extensions in server TS imports.

import { Room, Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";

// ✅ Shared items (single source of truth)
import {
  Items,
  ITEM_DEFS,
  RECIPES,
  type ItemStack as SharedItemStack,
} from "../shared/items.js";

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  id: string;
  chunkSize: number;
  x: number; // NOA chunk coord (often chunk origin in world units)
  y: number;
  z: number;
};

type ChunkDataMsg = {
  id: string;
  chunkSize: number;
  // IMPORTANT: echo these exactly as requested so client pending check passes
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
  slots: ItemStack[]; // length = HOTBAR_SLOTS + BACKPACK_SLOTS
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
  fromSlot?: number; // hotbar slot index to consume from
};

type StartMineMsg = { x: number; y: number; z: number; heldSlot?: number };
type CancelMineMsg = { reason?: string };

type MineProgressMsg = {
  x: number;
  y: number;
  z: number;
  progress: number; // 0..1
  stage: number; // 0..9
  done?: boolean;
  reason?: string;
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

export class MyRoom extends Room {
  // =========================
  // Constants
  // =========================
  private readonly chunkSize = 32; // MUST match client
  private readonly baseHeight = 12;

  // Inventory layout (MUST match client)
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

  // Minerals + bedrock
  private readonly BEDROCK_ID = 6;
  private readonly COAL_ORE_ID = 7;
  private readonly IRON_ORE_ID = 8;
  private readonly GOLD_ORE_ID = 9;
  private readonly DIAMOND_ORE_ID = 10;

  // Drops cleanup (NEW)
  private readonly DROP_TTL_MS = 3 * 60 * 1000; // 3 minutes
  private readonly DROP_CLEANUP_EVERY_MS = 5000;

  // =========================
  // Players
  // =========================
  private players = new Map<string, PlayerInfo>();

  private readonly minMoveIntervalMs = 60;
  private readonly snapshotIntervalMs = 500;

  private readonly maxAbsCoord = 100000;
  private readonly maxSpeedBlocksPerSec = 18;

  private lastMoveLogAt = 0;
  private lastSnapshotLogAt = 0;

  // =========================
  // World
  // =========================
  private chunks = new Map<string, Uint8Array>();

  // =========================
  // Drops (server authoritative)
  // =========================
  private drops = new Map<string, Drop>();
  private nextDropSeq = 1;

  // =========================
  // Mining (Option A)
  // =========================
  private mining = new Map<string, MiningState>(); // by sessionId
  private readonly mineTickMs = 50;
  private readonly mineHeartbeatTimeoutMs = 450; // if client stops sending startMine, cancel
  private readonly mineReach = 6.0; // max distance to mine
  private readonly mineProgressSendMinMs = 80; // throttle progress messages per client

  // =========================
  // Persistence
  // =========================
  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");
  private readonly invDir = path.join(this.worldDir, "inventories");

  // NEW: world meta (seed lives here)
  private readonly metaPath = path.join(this.worldDir, "meta.json");

  // NEW: deterministic seed
  private worldSeed = 0;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Keep room alive when empty (refresh disconnect won't dispose)
    this.autoDispose = false;

    this.ensureDirs();
    this.worldSeed = this.loadOrCreateWorldSeed(options);
    console.log("[WORLD] persistence dirs:", { chunks: this.chunksDir, inventories: this.invDir });
    console.log("[WORLD] seed:", this.worldSeed);

    // Periodic snapshot
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
        console.log("[SNAPSHOT]", { count: all.length, ids: all.map((p) => p.id).slice(0, 5) });
      }
    }, this.snapshotIntervalMs);

    // Mining tick loop
    this.clock.setInterval(() => {
      this.tickMining();
    }, this.mineTickMs);

    // Drops cleanup loop (NEW)
    this.clock.setInterval(() => {
      this.cleanupDrops();
    }, this.DROP_CLEANUP_EVERY_MS);

    // =========================
    // Chunk streaming
    // =========================
    this.onMessage("worldDataNeeded", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<WorldDataNeededMsg>;

      if (typeof p.id !== "string" || p.id.length < 1) return;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      // Clamp incoming NOA coords (could be origins or indices)
      const rx = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const ry = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const rz = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      // ✅ Normalize to CHUNK INDICES for storage/generation
      const { cx, cy, cz } = this.normalizeChunkRequestToIndex(rx, ry, rz);

      const CS = this.chunkSize;
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: CS,
        // ✅ Echo EXACT request coords so client pending check passes
        x: rx,
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

      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord);
      const y = clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord);
      const z = clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord);
      const yaw = isFiniteNumber(maybe.yaw) ? maybe.yaw : pl.yaw;

      const dtSec = Math.max(0.001, (now - Math.max(0, pl.lastMoveAt)) / 1000);
      const maxDist = this.maxSpeedBlocksPerSec * dtSec;

      const dx = x - pl.x;
      const dy = y - pl.y;
      const dz = z - pl.z;

      // allow a bit of burst due to network jitter; still clamp egregious teleports
      if (dx * dx + dy * dy + dz * dz > (maxDist * maxDist) * 9) return;

      pl.x = x;
      pl.y = y;
      pl.z = z;
      pl.yaw = yaw;
      pl.lastMoveAt = now;

      this.broadcast("playerTransformOther", { id: client.sessionId, x, y, z, yaw }, { except: client });

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
    // Mining (Option A): hold-to-mine
    // =========================
    this.onMessage("startMine", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<StartMineMsg>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      const x = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      // ✅ IMPORTANT: heldSlot comes from client selected hotbar slot
      const heldSlot = isFiniteNumber((p as any).heldSlot) ? toInt((p as any).heldSlot) : -1;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      // reach check
      const dx = x + 0.5 - pl.x;
      const dy = y + 0.5 - pl.y;
      const dz = z + 0.5 - pl.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > this.mineReach * this.mineReach) {
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

      // If already mining same block, update heartbeat only
      const cur = this.mining.get(client.sessionId);
      const now = Date.now();

      if (cur && cur.x === x && cur.y === y && cur.z === z) {
        cur.lastHeartbeatAt = now;
        cur.heldSlot = heldSlot;

        // If block changed under them, cancel
        const nowBlock = this.getBlockAt(x, y, z);
        if (nowBlock !== cur.lastBlockId) {
          this.cancelMiningFor(client, "block_changed");
          return;
        }
        return;
      }

      // starting a new target: cancel any previous
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

      // send immediate first progress update (0%)
      const msg: MineProgressMsg = { x, y, z, progress: 0, stage: 0 };
      client.send("mineProgress", msg);

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
        tool: picked ? { id: picked.stack.id, tier: picked.tool.tier, slot: picked.slotIndex } : null,
      });
    });

    this.onMessage("cancelMine", (client: Client, payload: unknown) => {
      const reason =
        typeof (payload as any)?.reason === "string"
          ? String((payload as any).reason).slice(0, 60)
          : "client_cancel";
      this.cancelMiningFor(client, reason);
    });

    // Legacy instant mine (if still sent by old clients)
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      const oldId = this.getBlockAt(x, y, z);
      if (oldId === this.AIR_ID) return;
      if (oldId === this.BEDROCK_ID) return;

      const pl = this.players.get(client.sessionId);
      const inv = pl ? this.getOrLoadInventory(pl.userId) : null;

      // legacy has no heldSlot; we’ll just pick best tool anywhere
      const canDrop = this.canBlockDropWithTool(oldId, inv, -1);

      console.log("[EDIT mineBlock legacy]", { by: client.sessionId, x, y, z, oldId, canDrop });

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);

      if (canDrop) {
        const dropItem = this.blockIdToDropItemId(oldId);
        if (dropItem > 0) this.spawnDrop(dropItem, 1, x + 0.5, y + 0.65, z + 0.5);
      }
    });

    // =========================
    // Block placing (authoritative + persistent)
    // =========================
    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;

      const maybe = payload as Partial<PlaceBlockMsg>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;
      if (!isFiniteNumber(maybe.id)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));
      const blockId = toInt(clamp(maybe.id, 0, 255));

      // cannot place bedrock
      if (blockId === this.BEDROCK_ID) return;

      const oldId = this.getBlockAt(x, y, z);
      if (oldId !== this.AIR_ID) return; // only place into air

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const inv = this.getOrLoadInventory(pl.userId);

      // require fromSlot to be a valid hotbar slot
      const fromSlot = isFiniteNumber(maybe.fromSlot) ? toInt(maybe.fromSlot) : -1;
      if (fromSlot < 0 || fromSlot >= this.HOTBAR_SLOTS) return;

      const stack = inv.slots[fromSlot];
      if (!stack || stack.id <= 0 || stack.count <= 0) return;

      // item must be placeable and match blockId
      const def = ITEM_DEFS[stack.id];
      if (!def || typeof def.placeBlockId !== "number") return;
      if (def.placeBlockId !== blockId) return;

      console.log("[EDIT placeBlock]", {
        by: client.sessionId,
        x,
        y,
        z,
        blockId,
        fromSlot,
        itemId: stack.id,
      });

      // consume 1
      stack.count -= 1;
      if (stack.count <= 0) inv.slots[fromSlot] = { id: 0, count: 0 } as any;

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);

      // placing cancels mining if they were mining that spot
      const ms = this.mining.get(client.sessionId);
      if (ms && ms.x === x && ms.y === y && ms.z === z) this.cancelMiningFor(client, "placed_on_target");

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

      // expiry check (NEW)
      if (Date.now() - drop.createdAt > this.DROP_TTL_MS) {
        this.drops.delete(dropId);
        this.broadcast("dropDespawn", { dropId });
        return;
      }

      // distance check (server authoritative)
      const dx = drop.x - pl.x;
      const dy = drop.y - pl.y;
      const dz = drop.z - pl.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > 2.6 * 2.6) return;

      const inv = this.getOrLoadInventory(pl.userId);
      const accepted = this.inventoryAdd(inv, { id: drop.itemId, count: drop.count });

      if (accepted <= 0) return; // inventory full/no space

      // consume whole drop
      this.drops.delete(dropId);
      this.broadcast("dropDespawn", { dropId });

      this.saveInventory(pl.userId, inv);
      this.sendInvStateToClient(client, inv);

      console.log("[DROP pickup]", { by: client.sessionId, dropId, itemId: drop.itemId, count: drop.count });
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
        client.send("craftResult", { ok: false, recipeId, crafted: 0, reason: "unknown_recipe" });
        return;
      }

      const wantMax = !!p.max;
      const timesReq = isFiniteNumber(p.times) ? clamp(toInt(p.times), 1, 999) : 1;

      // ✅ IMPORTANT: crafting should use SLOTS ONLY (not cursor),
      // otherwise cursor becomes an unintended ingredient source/sink.
      const craftableByInputs = () => {
        for (const req of recipe.inputs) {
          if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        }
        return true;
      };

      const tryCraftOnce = (): boolean => {
        // check inputs (SLOTS ONLY)
        for (const req of recipe.inputs) {
          if (this.inventoryCountSlots(inv, req.id) < req.count) return false;
        }
        // check output space
        const canFit = this.inventoryCanFit(inv, recipe.output.id, recipe.output.count);
        if (!canFit) return false;

        // consume inputs (SLOTS ONLY)
        for (const req of recipe.inputs) this.inventoryRemoveSlots(inv, req.id, req.count);

        // add output (inventoryAdd will initialize tool durability if applicable)
        this.inventoryAdd(inv, { id: recipe.output.id, count: recipe.output.count });

        return true;
      };

      let crafted = 0;

      if (wantMax) {
        // craft until you can't
        while (crafted < 999 && craftableByInputs()) {
          const ok = tryCraftOnce();
          if (!ok) break;
          crafted++;
        }
      } else {
        for (let i = 0; i < timesReq; i++) {
          const ok = tryCraftOnce();
          if (!ok) break;
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

    // =========================
    // Ping
    // =========================
    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  // =========================
  // Join/Leave
  // =========================
  onJoin(client: Client, options: any) {
    const userId = safeUserId(options?.userId);
    console.log("➕ onJoin", { sessionId: client.sessionId, userId, options });

    const spacing = 6;

    let spawnX = 0;
    let spawnZ = 0;

    let slot = 0;
    while (true) {
      const sx = (slot % 4) * spacing;
      const sz = Math.floor(slot / 4) * spacing;

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

    // Ensure inventory exists
    const inv = this.getOrLoadInventory(userId);

    // Send inv state to joining client
    this.sendInvStateToClient(client, inv);

    // Send existing drops to joining client
    for (const d of this.drops.values()) {
      // skip expired (NEW)
      if (Date.now() - d.createdAt > this.DROP_TTL_MS) continue;
      client.send("dropSpawn", d);
    }

    const existingPlayers = Array.from(this.players.values())
      .filter((pl) => pl.id !== client.sessionId)
      .map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw }));

    client.send("existingPlayers", existingPlayers);

    this.broadcast(
      "playerJoined",
      { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw },
      { except: client }
    );

    client.send("youJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw });

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
    // keep chunks/drops maps as-is? room disposed means process exit, so doesn't matter.
  }

  // =========================
  // Chunk coord normalization (THE FIX)
  // =========================
  private normalizeChunkRequestToIndex(rx: number, ry: number, rz: number): { cx: number; cy: number; cz: number } {
    const CS = this.chunkSize;

    // If NOA provides origins (multiples of CS), convert to index.
    // If it provides indices, keep them.
    const toIndex = (v: number) => {
      // origins are typically exact multiples of CS (…,-64,-32,0,32,64,…)
      if (v !== 0 && v % CS === 0) return toInt(v / CS);
      // also handle 0 (ambiguous) by treating as index 0
      return toInt(v);
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
  // Persistence: meta (seed)
  // =========================
  private loadOrCreateWorldSeed(options: any): number {
    // 1) explicit seed passed in room options (optional)
    const optSeed =
      typeof options?.worldSeed === "number" && Number.isFinite(options.worldSeed) ? (options.worldSeed | 0) : null;

    // 2) env var override (optional)
    const envSeedRaw = process.env.WORLD_SEED;
    const envSeed = envSeedRaw != null && envSeedRaw !== "" ? Number.parseInt(String(envSeedRaw), 10) : NaN;

    // Priority: options > env > meta.json > generate new
    const preferred = optSeed != null ? optSeed : Number.isFinite(envSeed) ? (envSeed | 0) : null;

    if (preferred != null) {
      this.writeMeta({ seed: preferred, updatedAt: Date.now() });
      return preferred | 0;
    }

    // meta.json
    try {
      if (fs.existsSync(this.metaPath)) {
        const raw = fs.readFileSync(this.metaPath, "utf8");
        const j = JSON.parse(raw);
        const s = Number(j?.seed);
        if (Number.isFinite(s)) return (s | 0);
      }
    } catch (e) {
      console.warn("[WORLD] meta read failed:", this.metaPath, e);
    }

    const seed = this.generateSeed32();
    this.writeMeta({ seed, createdAt: Date.now() });
    return seed;
  }

  private writeMeta(patch: any): void {
    try {
      let existing: any = {};
      if (fs.existsSync(this.metaPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(this.metaPath, "utf8"));
        } catch {
          existing = {};
        }
      }
      const next = { ...existing, ...patch };
      const tmp = this.metaPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, this.metaPath);
    } catch (e) {
      console.warn("[WORLD] meta write failed:", this.metaPath, e);
    }
  }

  private generateSeed32(): number {
    const t = Date.now() | 0;
    const r = (Math.random() * 0xffffffff) | 0;
    return (t ^ r) | 0;
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
        console.warn("[WORLD] chunk file wrong size, ignoring:", fp, { got: buf.byteLength, expected });
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

  private inventories = new Map<string, InvState>();

  private getOrLoadInventory(userId: string): InvState {
    const cached = this.inventories.get(userId);
    if (cached) return cached;

    const fromDisk = this.readInvFromDisk(userId);
    if (fromDisk) {
      this.inventories.set(userId, fromDisk);
      return fromDisk;
    }

    // new inventory: give starter wood (optional)
    const inv: InvState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 } as any)),
      cursor: { id: 0, count: 0 } as any,
    };

    // Starter kit (tweak as you like)
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
    // ✅ includes dur fields when present
    client.send("invState", { slots: inv.slots, cursor: inv.cursor });
  }

  // =========================
  // World internals
  // =========================
  private idx(i: number, j: number, k: number): number {
    const CS = this.chunkSize;
    return i + CS * (j + CS * k);
  }

  private heightAt(worldX: number, worldZ: number): number {
    return this.baseHeight + Math.floor(Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6);
  }

  // deterministic hash -> [0,1) (SEEDED)
  private hash3i(x: number, y: number, z: number): number {
    const seed = this.worldSeed | 0;

    // include seed with a large odd constant
    let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  // deterministic 2D hash -> [0,1) (SEEDED) for future biomes/POIs
  private hash2i(x: number, z: number): number {
    const seed = this.worldSeed | 0;

    let h = x * 374761393 + z * 668265263 + seed * 1597334677;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  private veinNoise(x: number, y: number, z: number): number {
    const a = this.hash3i(x, y, z);
    const b = this.hash3i(x + 17, y - 11, z + 23);
    const c = this.hash3i(x - 31, y + 7, z - 19);
    return a * 0.6 + b * 0.25 + c * 0.15;
  }

  private generateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const CS = this.chunkSize;
    const vox = new Uint8Array(CS * CS * CS);

    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const worldX = cx * CS + i;
        const worldZ = cz * CS + k;
        const height = this.heightAt(worldX, worldZ);

        for (let j = 0; j < CS; j++) {
          const worldY = cy * CS + j;

          // Default terrain
          let id = this.AIR_ID;
          if (worldY > height) id = this.AIR_ID;
          else if (worldY === height) id = this.GRASS_ID;
          else if (worldY > height - 4) id = this.DIRT_ID;
          else id = this.STONE_ID;

          // Bedrock bottom: randomized thickness in worldY 0..4
          if (worldY <= 4) {
            const r = this.hash3i(worldX, worldY, worldZ);
            const threshold = 0.95 - worldY * 0.18; // y=0 ~0.95 (almost always), y=4 ~0.23
            if (r < threshold) {
              vox[this.idx(i, j, k)] = this.BEDROCK_ID;
              continue;
            }
          }

          // Ores: only replace stone, depth-based thresholds
          if (id === this.STONE_ID) {
            const n = this.veinNoise(worldX, worldY, worldZ);

            // Diamond: deep + rare
            if (worldY <= 16 && n > 0.985) id = this.DIAMOND_ORE_ID;
            // Gold
            else if (worldY <= 32 && n > 0.975) id = this.GOLD_ORE_ID;
            // Iron
            else if (worldY <= 64 && n > 0.965) id = this.IRON_ORE_ID;
            // Coal
            else if (worldY <= 128 && n > 0.955) id = this.COAL_ORE_ID;
          }

          vox[this.idx(i, j, k)] = id;
        }
      }
    }

    console.log("[WORLD] generated chunk:", { cx, cy, cz });
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

    console.log("[DROP] cleanup", { expired: expired.length, remaining: this.drops.size });
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

    if (blockId === this.COAL_ORE_ID) return Items.COAL;
    if (blockId === this.IRON_ORE_ID) return Items.RAW_IRON;
    if (blockId === this.GOLD_ORE_ID) return Items.RAW_GOLD;
    if (blockId === this.DIAMOND_ORE_ID) return Items.DIAMOND;

    // bedrock + unknowns drop nothing
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

  // Choose the tool stack we actually use for mining:
  // 1) held hotbar slot if it's a pick
  // 2) otherwise best pick found in inventory slots (anywhere)
  private choosePickStack(
    inv: InvState,
    heldSlot: number
  ): { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<MyRoom["getToolDef"]>> } | null {
    // held slot priority
    if (heldSlot >= 0 && heldSlot < this.HOTBAR_SLOTS) {
      const s = inv.slots[heldSlot];
      if (s && (s as any).id > 0 && (s as any).count > 0) {
        const tool = this.getToolDef((s as any).id);
        if (tool?.kind === "pick") return { slotIndex: heldSlot, stack: s, tool };
      }
    }

    // find best pick by tier
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

  // Ore/tool gating rules (Minecraft-ish):
  // - Stone-like blocks: require pick to DROP anything.
  // - Coal/Iron/Stone: need tier >= 1 (wood+)
  // - Gold/Diamond: need tier >= 3 (iron+)
  private requiredPickTierForDrops(blockId: number): number {
    if (blockId === this.STONE_ID) return 1;
    if (blockId === this.COAL_ORE_ID) return 1;
    if (blockId === this.IRON_ORE_ID) return 1;
    if (blockId === this.GOLD_ORE_ID) return 3;
    if (blockId === this.DIAMOND_ORE_ID) return 3;
    return 0; // grass/dirt/wood/leaves etc
  }

  // Tool gating + drops rule
  private canBlockDropWithTool(blockId: number, inv: InvState | null, heldSlot = -1): boolean {
    // bedrock never drops
    if (blockId === this.BEDROCK_ID) return false;

    const reqTier = this.requiredPickTierForDrops(blockId);
    if (reqTier <= 0) return true;

    if (!inv) return false;

    const picked = this.choosePickStack(inv, heldSlot);
    if (!picked) return false;

    return picked.tool.tier >= reqTier;
  }

  // Compute break time based on block + tool tier/speed
  private computeBreakTimeMs(blockId: number, inv: InvState, heldSlot = -1): number {
    // base times (ms) tuned for feel
    let base = 450;

    if (blockId === this.LEAVES_ID) base = 180;
    else if (blockId === this.GRASS_ID) base = 420;
    else if (blockId === this.DIRT_ID) base = 420;
    else if (blockId === this.WOOD_ID) base = 950;
    else if (blockId === this.STONE_ID) base = 1250;
    else if (blockId === this.COAL_ORE_ID) base = 1400;
    else if (blockId === this.IRON_ORE_ID) base = 1650;
    else if (blockId === this.GOLD_ORE_ID) base = 2200;
    else if (blockId === this.DIAMOND_ORE_ID) base = 2850;
    else if (blockId === this.BEDROCK_ID) return 999999999;

    const picked = this.choosePickStack(inv, heldSlot);

    // Tool multipliers:
    // - Pick speeds up stone-like blocks; other blocks mostly unchanged
    if (this.isStoneLike(blockId)) {
      if (picked) base = Math.floor(base * picked.tool.speedMul);
      else base = Math.floor(base * 2.8); // painful by hand
    } else {
      // small bonus with pick on wood (optional)
      if (blockId === this.WOOD_ID && picked) base = Math.floor(base * 0.92);
    }

    // clamp to sane range
    return clamp(base, 80, 12000);
  }

  // Optional durability: damage chosen tool by 1 on successful stone-like break
  private damageTool(inv: InvState, slotIndex: number): void {
    const s = inv.slots[slotIndex];
    if (!s || (s as any).id <= 0 || (s as any).count <= 0) return;

    const tool = this.getToolDef((s as any).id);
    if (!tool) return;

    const cur = toInt(clamp(Number((s as any).dur ?? tool.maxDurability), 0, 999999));
    const next = cur - 1;

    if (next <= 0) {
      // break tool
      inv.slots[slotIndex] = { id: 0, count: 0 } as any;
    } else {
      (s as any).dur = next;
    }
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

      // heartbeat timeout (client released LMB or lost focus)
      if (now - st.lastHeartbeatAt > this.mineHeartbeatTimeoutMs) {
        this.cancelMiningFor(client, "timeout");
        continue;
      }

      // reach check
      const dx = st.x + 0.5 - pl.x;
      const dy = st.y + 0.5 - pl.y;
      const dz = st.z + 0.5 - pl.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > this.mineReach * this.mineReach) {
        this.cancelMiningFor(client, "too_far");
        continue;
      }

      // block still exists and same id?
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

      // recompute break time occasionally (tool could have changed mid-mine)
      const inv = this.getOrLoadInventory(st.userId);
      const newBreak = this.computeBreakTimeMs(currentId, inv, st.heldSlot);
      if (newBreak !== st.breakTimeMs) {
        // keep progress proportionally similar
        const elapsed = Math.max(0, now - st.startedAt);
        const p = st.breakTimeMs > 0 ? elapsed / st.breakTimeMs : 0;
        st.breakTimeMs = newBreak;
        st.startedAt = now - Math.floor(p * st.breakTimeMs);
      }

      const elapsedMs = Math.max(0, now - st.startedAt);
      const progress01 = clamp(elapsedMs / Math.max(1, st.breakTimeMs), 0, 1);

      const stage = clamp(Math.floor(progress01 * 10), 0, 9);

      const shouldSend =
        stage !== st.lastStageSent || now - st.lastProgressSentAt >= this.mineProgressSendMinMs || progress01 >= 1;

      if (shouldSend) {
        st.lastStageSent = stage;
        st.lastProgressSentAt = now;

        const msg: MineProgressMsg = {
          x: st.x,
          y: st.y,
          z: st.z,
          progress: progress01,
          stage,
        };

        // if done, mine completes now
        if (progress01 >= 1) {
          // Choose tool (to know tier + which slot to damage)
          const picked = this.choosePickStack(inv, st.heldSlot);

          // Finish: remove block + drops (authoritative + persistent)
          const canDrop = this.canBlockDropWithTool(currentId, inv, st.heldSlot);

          this.setBlockAuthoritative(st.x, st.y, st.z, this.AIR_ID);

          if (canDrop) {
            const dropItem = this.blockIdToDropItemId(currentId);
            if (dropItem > 0) this.spawnDrop(dropItem, 1, st.x + 0.5, st.y + 0.65, st.z + 0.5);
          }

          // Optional durability: damage tool only for stone-like blocks
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
  }

  // =========================
  // Inventory helpers
  // =========================
  private normalizeStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999));
    const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999));
    const durRaw = Number((s as any)?.dur ?? 0);
    const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;

    if (id > 0 && count > 0) {
      // keep dur if present (>0)
      return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    }
    return { id: 0, count: 0 } as any;
  }

  private isToolItem(itemId: number): boolean {
    const def = ITEM_DEFS[itemId];
    return !!def?.tool;
  }

  private cloneStackPreserveDur(s: ItemStack): ItemStack {
    const ns = this.normalizeStack(s) as any;
    if (ns.id <= 0 || ns.count <= 0) return { id: 0, count: 0 } as any;

    // Ensure tools always carry dur if present; normalizeStack already keeps dur>0.
    // We also allow carrying dur=0 through moves for safety (shouldn't happen unless corrupted).
    const def = ITEM_DEFS[ns.id];
    const isTool = !!def?.tool;

    if (isTool) {
      const dRaw = Number((s as any)?.dur ?? (ns as any)?.dur ?? def!.tool!.maxDurability);
      const d = Number.isFinite(dRaw) ? toInt(clamp(dRaw, 0, 999999)) : def!.tool!.maxDurability;
      return { id: ns.id, count: 1, dur: d } as any;
    }

    return { id: ns.id, count: ns.count } as any;
  }

  private maxStackFor(itemId: number): number {
    const def = ITEM_DEFS[itemId];
    return def ? clamp(toInt(def.maxStack), 1, 999999) : 64;
  }

  // Count in slots + cursor (useful for "has tool anywhere" rules)
  private inventoryCountAny(inv: InvState, itemId: number): number {
    let n = 0;
    for (const s of inv.slots) if ((s as any).id === itemId && (s as any).count > 0) n += (s as any).count;
    if ((inv.cursor as any).id === itemId && (inv.cursor as any).count > 0) n += (inv.cursor as any).count;
    return n;
  }

  private inventoryHasAny(inv: InvState, itemId: number): boolean {
    return this.inventoryCountAny(inv, itemId) > 0;
  }

  // ✅ SLOTS ONLY (used for crafting inputs)
  private inventoryCountSlots(inv: InvState, itemId: number): number {
    let n = 0;
    for (const s of inv.slots) if ((s as any).id === itemId && (s as any).count > 0) n += (s as any).count;
    return n;
  }

  private inventoryCanFit(inv: InvState, itemId: number, count: number): boolean {
    const want = clamp(toInt(count), 1, 999999);
    const maxS = this.maxStackFor(itemId);

    let remaining = want;

    // fill existing stacks
    for (const s of inv.slots) {
      if ((s as any).id === itemId && (s as any).count > 0) {
        const space = maxS - (s as any).count;
        if (space > 0) {
          const take = Math.min(space, remaining);
          remaining -= take;
          if (remaining <= 0) return true;
        }
      }
    }

    // use empty slots
    for (const s of inv.slots) {
      if ((s as any).id === 0 || (s as any).count <= 0) {
        const take = Math.min(maxS, remaining);
        remaining -= take;
        if (remaining <= 0) return true;
      }
    }

    return remaining <= 0;
  }

  // returns how many items were accepted (0..stack.count)
  // NOTE: tools (maxStack=1) get initialized durability when placed into a slot
  private inventoryAdd(inv: InvState, stack: ItemStack): number {
    const s = this.normalizeStack(stack);
    if ((s as any).id <= 0 || (s as any).count <= 0) return 0;

    const id = (s as any).id | 0;
    const maxS = this.maxStackFor(id);
    let remaining = (s as any).count | 0;
    let accepted = 0;

    // fill existing stacks first (only meaningful for stackables)
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

    // then fill empty slots
    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === 0 || slot.count <= 0) {
        const take = Math.min(maxS, remaining);

        const def = ITEM_DEFS[id];
        const isTool = !!def?.tool;

        // tools: initialize durability at max
        if (isTool) {
          inv.slots[i] = { id, count: 1, dur: def!.tool!.maxDurability } as any;
          remaining -= 1;
          accepted += 1;
        } else {
          inv.slots[i] = { id, count: take } as any;
          remaining -= take;
          accepted += take;
        }

        if (remaining <= 0) return accepted;
      }
    }

    return accepted;
  }

  // remove up to count; returns removed (slots first, then cursor)
  private inventoryRemoveAny(inv: InvState, itemId: number, count: number): number {
    const want = clamp(toInt(count), 1, 999999);
    let remaining = want;
    let removed = 0;

    // remove from slots first
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i] as any;
      if (s.id === itemId && s.count > 0) {
        const take = Math.min(s.count, remaining);
        s.count -= take;
        remaining -= take;
        removed += take;
        if (s.count <= 0) inv.slots[i] = { id: 0, count: 0 } as any;
        if (remaining <= 0) return removed;
      }
    }

    // then cursor
    const cur = inv.cursor as any;
    if (cur.id === itemId && cur.count > 0 && remaining > 0) {
      const take = Math.min(cur.count, remaining);
      cur.count -= take;
      remaining -= take;
      removed += take;
      if (cur.count <= 0) inv.cursor = { id: 0, count: 0 } as any;
    }

    return removed;
  }

  // ✅ remove up to count; SLOTS ONLY; returns removed
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
  // Inventory click logic (Hazard 2 fix: preserve dur)
  // =========================
  private applyInvClick(inv: InvState, slotIndex: number, button: "L" | "R", shift: boolean): void {
    // normalize state (keeps dur>0)
    inv.cursor = this.normalizeStack(inv.cursor);
    inv.slots[slotIndex] = this.normalizeStack(inv.slots[slotIndex]);

    const cursor = inv.cursor as any;
    const slot = inv.slots[slotIndex] as any;

    const cursorIsTool = cursor.id > 0 && this.isToolItem(cursor.id);
    const slotIsTool = slot.id > 0 && this.isToolItem(slot.id);

    // Quick move: Shift + Left (move between hotbar/backpack)
    if (shift && button === "L") {
      if (slot.id <= 0 || slot.count <= 0) return;

      const isHotbar = slotIndex < this.HOTBAR_SLOTS;
      const targetStart = isHotbar ? this.HOTBAR_SLOTS : 0;
      const targetEnd = isHotbar ? this.INV_SLOTS : this.HOTBAR_SLOTS;

      // attempt to move entire stack into target region
      const moved = this.moveStackBetweenRanges(inv, slotIndex, targetStart, targetEnd);
      if (moved) return;

      return;
    }

    if (button === "L") {
      // LEFT CLICK:
      // - if cursor empty: pick up slot
      // - else if slot empty: place cursor
      // - else if same id: stack into slot (no tool stacking)
      // - else: swap (preserve dur)
      if (cursor.id <= 0 || cursor.count <= 0) {
        // pick up slot (preserve dur if tool)
        inv.cursor = this.cloneStackPreserveDur(slot) as any;
        inv.slots[slotIndex] = { id: 0, count: 0 } as any;
        return;
      }

      if (slot.id <= 0 || slot.count <= 0) {
        // place cursor (preserve dur if tool)
        inv.slots[slotIndex] = this.cloneStackPreserveDur(cursor) as any;
        inv.cursor = { id: 0, count: 0 } as any;
        return;
      }

      if (slot.id === cursor.id) {
        // tools can't stack
        if (cursorIsTool || slotIsTool) return;

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

      // swap (preserve dur)
      const newSlot = this.cloneStackPreserveDur(cursor);
      const newCursor = this.cloneStackPreserveDur(slot);
      inv.slots[slotIndex] = newSlot as any;
      inv.cursor = newCursor as any;
      return;
    }

    // RIGHT CLICK:
    // - if cursor empty and slot not empty: take half (ceil)
    //   - tools: take whole tool (dur preserved)
    // - else if cursor not empty:
    //   - if slot empty: place one (stackables) / place whole tool (dur preserved)
    //   - else if same id and slot not full: place one (stackables only)
    //   - else: do nothing

    if (cursor.id <= 0 || cursor.count <= 0) {
      if (slot.id <= 0 || slot.count <= 0) return;

      if (slotIsTool) {
        // tools: take whole with dur
        inv.cursor = this.cloneStackPreserveDur(slot) as any; // count=1, dur preserved
        inv.slots[slotIndex] = { id: 0, count: 0 } as any;
        return;
      }

      const take = Math.ceil(slot.count / 2);
      inv.cursor = { id: slot.id, count: take } as any;
      slot.count -= take;
      inv.slots[slotIndex] = slot.count > 0 ? (slot as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    // cursor has items
    if (cursorIsTool) {
      // place whole tool only into empty slot (preserve dur)
      if (slot.id <= 0 || slot.count <= 0) {
        inv.slots[slotIndex] = this.cloneStackPreserveDur(cursor) as any; // count=1 + dur
        inv.cursor = { id: 0, count: 0 } as any;
      }
      // else: do nothing (can't stack / overwrite with RMB)
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
      // stacking only for non-tools
      if (slotIsTool) return;

      const maxS = this.maxStackFor(slot.id);
      if (slot.count >= maxS) return;

      slot.count += 1;
      cursor.count -= 1;
      inv.slots[slotIndex] = slot as any;
      inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    // different item: do nothing on right-click
  }

  private moveStackBetweenRanges(inv: InvState, fromIndex: number, toStart: number, toEnd: number): boolean {
    inv.slots[fromIndex] = this.normalizeStack(inv.slots[fromIndex]);
    const from = inv.slots[fromIndex] as any;
    if (from.id <= 0 || from.count <= 0) return false;

    const isTool = this.isToolItem(from.id);

    // Tools (maxStack=1): move whole item preserving dur into first empty target slot
    if (isTool) {
      let empty = -1;
      for (let i = toStart; i < toEnd; i++) {
        const s = this.normalizeStack(inv.slots[i]) as any;
        if (s.id <= 0 || s.count <= 0) {
          empty = i;
          break;
        }
      }
      if (empty < 0) return false;

      inv.slots[empty] = this.cloneStackPreserveDur(from) as any;
      inv.slots[fromIndex] = { id: 0, count: 0 } as any;
      return true;
    }

    const maxS = this.maxStackFor(from.id);
    let remaining = from.count;

    // 1) fill existing stacks in target range
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

    // 2) fill empty slots in target range
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

    // update from slot
    const newCount = from.count - moved;
    inv.slots[fromIndex] = newCount > 0 ? ({ id: from.id, count: newCount } as any) : ({ id: 0, count: 0 } as any);
    return true;
  }
}
