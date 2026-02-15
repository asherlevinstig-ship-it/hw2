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
// Persistence (WORLD):
// - Saves chunk files keyed by CHUNK INDEX: c_<cx>_<cy>_<cz>.bin
// - Loads from disk first, else generates
//
// Persistence (PLAYERS):
// - Saves inventory keyed by a stable userId (client should send options.userId on join)
// - File: world/players/p_<userId>.json
// - If userId missing, falls back to sessionId (won't persist across refresh)
//
// Added gameplay loop (server authoritative):
// ✅ Inventory (hotbar+backpack) with stack rules
// ✅ TRUE server cursor + invClick (Minecraft-like pick/place/split/place-one)
// ✅ Shift-click quick move between hotbar/backpack
// ✅ Block drops: mining spawns pickup drops
// ✅ Pickup validation: radius check + inventory capacity
// ✅ Placing consumes inventory (authoritative)
// ✅ Crafting (recipe list) + craftResult feedback + craft max support
// ✅ Minimal tool progression: Stone drops require a pick (wood pick) in hotbar
// ✅ autoDispose = false so room isn't destroyed when last client disconnects
//
// Messages handled:
// - worldDataNeeded -> chunkData
// - playerMove -> playerTransformOther + snapshots
// - mineBlock -> authoritative edit + drop spawn
// - placeBlock -> authoritative edit + consume 1 from inventory
// - pickupDrop -> validate + add to inventory + despawn drop
// - invClick -> server cursor interactions (L/R + shift)
// - craft -> recipe crafting + feedback
//
// Messages emitted:
// - chunkData
// - blockUpdate
// - playersSnapshot
// - playerJoined / playerLeft / playerTransformOther / existingPlayers / youJoined
// - invState { slots, cursor }
// - craftResult { ok, recipeId, crafted, reason? }
// - dropSpawn / dropDespawn

import { Room, Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";

/* =========================
   Types
========================= */

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
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  lastMoveAt: number;
  joinedAt: number;
};

type ItemStack = { id: number; count: number };

type InventoryState = {
  slots: ItemStack[]; // fixed length INV_SLOTS
  cursor: ItemStack; // server cursor
};

type InvClickMsg = {
  slot: number;
  button: "L" | "R";
  shift?: boolean;
};

type PickupDropMsg = {
  dropId: string;
};

type CraftMsg = {
  recipeId: string;
  times?: number; // default 1
  max?: boolean; // if true, crafts as many as possible
};

type PlaceBlockMsg = {
  x: number;
  y: number;
  z: number;
  id: number; // blockId to place (same as your block ids)
  fromSlot?: number; // inventory slot to consume from (recommended)
};

type MineBlockMsg = {
  x: number;
  y: number;
  z: number;
};

type Recipe = {
  id: string;
  name: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

type ItemDef = {
  id: number;
  name: string;
  maxStack: number;
  placeBlockId?: number;
  isTool?: boolean;
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

function distSq(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/* =========================
   Room
========================= */

export class MyRoom extends Room {
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
  private readonly chunkSize = 32; // MUST match client
  private readonly baseHeight = 12;

  // Block IDs (must align with client)
  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;
  private readonly WOOD_ID = 4;
  private readonly LEAVES_ID = 5;

  private chunks = new Map<string, Uint8Array>();

  // =========================
  // Persistence (world + players)
  // =========================
  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");

  private readonly playersDir = path.join(this.worldDir, "players");

  // sessionId -> stable userId
  private sessionToUserId = new Map<string, string>();

  // =========================
  // Inventory (server authoritative)
  // =========================
  private readonly HOTBAR_SLOTS = 5;
  private readonly BACKPACK_SLOTS = 20;
  private readonly INV_SLOTS = this.HOTBAR_SLOTS + this.BACKPACK_SLOTS;

  // userId -> inventory
  private inventories = new Map<string, InventoryState>();

  // Items
  private readonly Items = {
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    WOOD_LOG: 4,
    LEAVES: 5,

    PLANK: 10,
    STICK: 11,
    WOOD_PICK: 20,
  } as const;

  private readonly ITEM_DEFS: Record<number, ItemDef> = {
    1: { id: 1, name: "Grass", maxStack: 64, placeBlockId: 1 },
    2: { id: 2, name: "Dirt", maxStack: 64, placeBlockId: 2 },
    3: { id: 3, name: "Stone", maxStack: 64, placeBlockId: 3 },
    4: { id: 4, name: "Wood", maxStack: 64, placeBlockId: 4 },
    5: { id: 5, name: "Leaves", maxStack: 64, placeBlockId: 5 },

    10: { id: 10, name: "Planks", maxStack: 64 },
    11: { id: 11, name: "Stick", maxStack: 64 },
    20: { id: 20, name: "Wood Pick", maxStack: 1, isTool: true },
  };

  // Recipes (shapeless)
  private readonly RECIPES: Recipe[] = [
    {
      id: "planks_from_log",
      name: "Planks",
      inputs: [{ id: 4, count: 1 }],
      output: { id: 10, count: 4 },
    },
    {
      id: "sticks_from_planks",
      name: "Sticks",
      inputs: [{ id: 10, count: 2 }],
      output: { id: 11, count: 4 },
    },
    {
      id: "wood_pick",
      name: "Wood Pick",
      inputs: [
        { id: 10, count: 3 },
        { id: 11, count: 2 },
      ],
      output: { id: 20, count: 1 },
    },
  ];

  // =========================
  // Drops (server authoritative)
  // =========================
  private drops = new Map<string, Drop>();
  private dropSeq = 0;

  private readonly DROP_PICKUP_RADIUS = 2.25; // blocks
  private readonly DROP_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes
  private readonly dropCleanupIntervalMs = 2500;

  // =========================
  // Gameplay validation
  // =========================
  private readonly MAX_INTERACT_DISTANCE = 6.0; // mining/placing
  private readonly MAX_INTERACT_DISTANCE_SQ = this.MAX_INTERACT_DISTANCE * this.MAX_INTERACT_DISTANCE;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;
    this.autoDispose = false;

    this.ensureDirs();
    console.log("[WORLD] chunk dir:", this.chunksDir);
    console.log("[WORLD] player dir:", this.playersDir);

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
        console.log("[SNAPSHOT]", { count: all.length, ids: all.map((p) => p.id).slice(0, 8) });
      }
    }, this.snapshotIntervalMs);

    // Drop cleanup
    this.clock.setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];
      for (const [id, d] of this.drops.entries()) {
        if (now - d.createdAt > this.DROP_LIFETIME_MS) expired.push(id);
      }
      if (expired.length) {
        for (const id of expired) this.drops.delete(id);
        for (const id of expired) this.broadcast("dropDespawn", { dropId: id });
        console.log("[DROP] cleanup", { removed: expired.length });
      }
    }, this.dropCleanupIntervalMs);

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

      const CS = this.chunkSize;
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: CS,
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
    // Mining (authoritative) + drops
    // =========================
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<MineBlockMsg>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      // distance validation (best effort)
      if (distSq(pl.x, pl.y, pl.z, x + 0.5, y + 0.5, z + 0.5) > this.MAX_INTERACT_DISTANCE_SQ) return;

      const oldId = this.getBlockIdAt(x, y, z);
      if (oldId === this.AIR_ID) return;

      // Minimal tool gating:
      // - Breaking stone without pick is allowed but yields no stone drop
      const userId = this.getUserIdForSession(client.sessionId);
      const inv = this.getOrCreateInventory(userId);

      const hasPickInHotbar = this.hasToolInHotbar(inv, this.Items.WOOD_PICK);

      console.log("[EDIT mineBlock]", {
        by: client.sessionId,
        userId,
        x,
        y,
        z,
        oldId,
        hasPickInHotbar,
      });

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);

      // Drops
      const dropItemId = this.blockIdToDropItemId(oldId);

      // Tool gate for stone drop
      if (oldId === this.STONE_ID && !hasPickInHotbar) {
        // breakable but no drop
        return;
      }

      if (dropItemId > 0) {
        this.spawnDrop(dropItemId, 1, x + 0.5, y + 0.7, z + 0.5);
      }
    });

    // =========================
    // Placing (authoritative) + inventory consume
    // =========================
    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<PlaceBlockMsg>;

      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;
      if (!isFiniteNumber(p.id)) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const x = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));
      const blockId = toInt(clamp(p.id, 0, 255));

      // distance validation
      if (distSq(pl.x, pl.y, pl.z, x + 0.5, y + 0.5, z + 0.5) > this.MAX_INTERACT_DISTANCE_SQ) return;

      // only place into air (simple)
      if (this.getBlockIdAt(x, y, z) !== this.AIR_ID) return;

      const userId = this.getUserIdForSession(client.sessionId);
      const inv = this.getOrCreateInventory(userId);

      // Determine consumption source slot
      let fromSlot = isFiniteNumber(p.fromSlot) ? toInt(p.fromSlot) : -1;

      const placeableItemId = this.findItemIdThatPlacesBlock(blockId);
      if (placeableItemId <= 0) return;

      if (!this.isValidSlot(fromSlot)) {
        // Backward-compatibility: if client didn't send fromSlot, search hotbar
        fromSlot = this.findFirstSlotWithItem(inv, placeableItemId, 0, this.HOTBAR_SLOTS);
        if (fromSlot < 0) return;
      }

      const s = inv.slots[fromSlot];
      if (!s || s.id !== placeableItemId || s.count <= 0) return;

      // Consume 1
      inv.slots[fromSlot] = s.count > 1 ? { id: s.id, count: s.count - 1 } : { id: 0, count: 0 };

      // Place block
      console.log("[EDIT placeBlock]", { by: client.sessionId, userId, x, y, z, blockId, fromSlot, itemId: placeableItemId });
      this.setBlockAuthoritative(x, y, z, blockId);

      // Persist + sync inventory to placer
      this.saveInventory(userId, inv);
      this.sendInv(client, inv);
    });

    // =========================
    // Drops: pickup
    // =========================
    this.onMessage("pickupDrop", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<PickupDropMsg>;
      if (typeof p.dropId !== "string" || p.dropId.length < 1) return;

      const drop = this.drops.get(p.dropId);
      if (!drop) return;

      const pl = this.players.get(client.sessionId);
      if (!pl) return;

      const d2 = distSq(pl.x, pl.y, pl.z, drop.x, drop.y, drop.z);
      const r2 = this.DROP_PICKUP_RADIUS * this.DROP_PICKUP_RADIUS;
      if (d2 > r2) return;

      const userId = this.getUserIdForSession(client.sessionId);
      const inv = this.getOrCreateInventory(userId);

      // Check capacity (simulate)
      const rem = this.addToInventory(inv.slots, { id: drop.itemId, count: drop.count }, true);
      if (rem > 0) return;

      // Commit insert
      this.addToInventory(inv.slots, { id: drop.itemId, count: drop.count }, false);

      // Remove drop
      this.drops.delete(drop.dropId);
      this.broadcast("dropDespawn", { dropId: drop.dropId });

      // Persist + sync inventory
      this.saveInventory(userId, inv);
      this.sendInv(client, inv);
    });

    // =========================
    // Inventory: server cursor click
    // =========================
    this.onMessage("invClick", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<InvClickMsg>;

      const slot = isFiniteNumber(p.slot) ? toInt(p.slot) : -1;
      const button = p.button;
      const shift = !!p.shift;

      if (!this.isValidSlot(slot)) return;
      if (button !== "L" && button !== "R") return;

      const userId = this.getUserIdForSession(client.sessionId);
      const inv = this.getOrCreateInventory(userId);

      if (shift && button === "L") {
        // Shift-left: quick move whole slot
        const changed = this.quickMove(inv, slot);
        if (changed) {
          this.saveInventory(userId, inv);
          this.sendInv(client, inv);
        }
        return;
      }

      let changed = false;
      if (button === "L") changed = this.invLeftClick(inv, slot);
      else changed = this.invRightClick(inv, slot);

      if (changed) {
        this.saveInventory(userId, inv);
        this.sendInv(client, inv);
      }
    });

    // =========================
    // Crafting (authoritative) + feedback
    // =========================
    this.onMessage("craft", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<CraftMsg>;

      if (typeof p.recipeId !== "string" || p.recipeId.length < 1) return;

      const recipe = this.RECIPES.find((r) => r.id === p.recipeId);
      if (!recipe) {
        client.send("craftResult", { ok: false, recipeId: p.recipeId, crafted: 0, reason: "unknown_recipe" });
        return;
      }

      const userId = this.getUserIdForSession(client.sessionId);
      const inv = this.getOrCreateInventory(userId);

      const wantMax = !!p.max;
      const times = wantMax ? 9999 : isFiniteNumber(p.times) ? clamp(toInt(p.times), 1, 99) : 1;

      let crafted = 0;

      for (let i = 0; i < times; i++) {
        if (!this.hasIngredients(inv.slots, recipe.inputs)) break;

        // Must have room for output (simulate)
        const outRem = this.addToInventory(inv.slots, { id: recipe.output.id, count: recipe.output.count }, true);
        if (outRem > 0) break;

        // Consume + add
        this.consumeIngredients(inv.slots, recipe.inputs);
        this.addToInventory(inv.slots, { id: recipe.output.id, count: recipe.output.count }, false);
        crafted++;
      }

      if (crafted <= 0) {
        // Determine best reason
        const hasIng = this.hasIngredients(inv.slots, recipe.inputs);
        const hasSpace = this.addToInventory(inv.slots, { id: recipe.output.id, count: recipe.output.count }, true) === 0;
        const reason = !hasIng ? "missing" : !hasSpace ? "no_space" : "unknown";
        client.send("craftResult", { ok: false, recipeId: recipe.id, crafted: 0, reason });
        return;
      }

      console.log("[CRAFT]", { by: client.sessionId, userId, recipeId: recipe.id, crafted });

      this.saveInventory(userId, inv);
      this.sendInv(client, inv);
      client.send("craftResult", { ok: true, recipeId: recipe.id, crafted });
    });

    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  /* =========================
     Join/Leave
  ========================= */

  onJoin(client: Client, options: any) {
    console.log("➕ onJoin", client.sessionId, options);

    // Stable userId (client should pass options.userId from localStorage)
    const userId = this.normalizeUserId(options?.userId ?? options?.uid ?? options?.user_id ?? null, client.sessionId);
    this.sessionToUserId.set(client.sessionId, userId);

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
      x: spawnX,
      y: spawnY,
      z: spawnZ,
      yaw: 0,
      lastMoveAt: 0,
      joinedAt: Date.now(),
    };

    this.players.set(client.sessionId, spawn);

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

    // Inventory: load or create + send snapshot
    const inv = this.loadOrCreateInventory(userId);
    this.sendInv(client, inv);

    // Send existing drops to joiner
    for (const d of this.drops.values()) {
      client.send("dropSpawn", {
        dropId: d.dropId,
        itemId: d.itemId,
        count: d.count,
        x: d.x,
        y: d.y,
        z: d.z,
        createdAt: d.createdAt,
      });
    }

    console.log("[JOIN STATE]", {
      joined: client.sessionId,
      userId,
      spawn: { x: spawnX, y: spawnY, z: spawnZ },
      players: this.players.size,
      invSlots: this.INV_SLOTS,
      drops: this.drops.size,
    });
  }

  onLeave(client: Client, code?: number) {
    const userId = this.sessionToUserId.get(client.sessionId) ?? client.sessionId;

    console.log("➖ onLeave", client.sessionId, "code:", code, "userId:", userId);

    const existed = this.players.delete(client.sessionId);
    if (existed) this.broadcast("playerLeft", { id: client.sessionId });

    // Persist inventory on leave (already saved on changes, but safe)
    const inv = this.inventories.get(userId);
    if (inv) this.saveInventory(userId, inv);

    this.sessionToUserId.delete(client.sessionId);
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");
    this.players.clear();
    this.sessionToUserId.clear();
    this.inventories.clear();
    this.drops.clear();
  }

  /* =========================
     Chunk coord normalization (THE FIX)
  ========================= */

  private normalizeChunkRequestToIndex(rx: number, ry: number, rz: number): { cx: number; cy: number; cz: number } {
    const CS = this.chunkSize;

    const toIndex = (v: number) => {
      if (v !== 0 && v % CS === 0) return toInt(v / CS);
      return toInt(v);
    };

    return { cx: toIndex(rx), cy: toIndex(ry), cz: toIndex(rz) };
  }

  /* =========================
     Persistence (dirs)
  ========================= */

  private ensureDirs(): void {
    if (!fs.existsSync(this.worldDir)) fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir)) fs.mkdirSync(this.chunksDir, { recursive: true });
    if (!fs.existsSync(this.playersDir)) fs.mkdirSync(this.playersDir, { recursive: true });
  }

  /* =========================
     World persistence
  ========================= */

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

  /* =========================
     World internals
  ========================= */

  private idx(i: number, j: number, k: number): number {
    const CS = this.chunkSize;
    return i + CS * (j + CS * k);
  }

  private heightAt(worldX: number, worldZ: number): number {
    return this.baseHeight + Math.floor(Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6);
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

          let id = this.AIR_ID;
          if (worldY > height) id = this.AIR_ID;
          else if (worldY === height) id = this.GRASS_ID;
          else if (worldY > height - 4) id = this.DIRT_ID;
          else id = this.STONE_ID;

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

  private getBlockIdAt(x: number, y: number, z: number): number {
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

  /* =========================
     Drops internals
  ========================= */

  private newDropId(): string {
    this.dropSeq++;
    return `${Date.now().toString(36)}_${this.dropSeq.toString(36)}`;
  }

  private spawnDrop(itemId: number, count: number, x: number, y: number, z: number): void {
    const id = this.newDropId();
    const drop: Drop = {
      dropId: id,
      itemId: clamp(toInt(itemId), 0, 255),
      count: clamp(toInt(count), 1, 9999),
      x,
      y,
      z,
      createdAt: Date.now(),
    };
    this.drops.set(id, drop);
    this.broadcast("dropSpawn", drop);
    console.log("[DROP] spawn", {
      dropId: id,
      itemId: drop.itemId,
      count: drop.count,
      x: +x.toFixed(2),
      y: +y.toFixed(2),
      z: +z.toFixed(2),
    });
  }

  private blockIdToDropItemId(blockId: number): number {
    if (blockId === this.GRASS_ID) return this.Items.GRASS;
    if (blockId === this.DIRT_ID) return this.Items.DIRT;
    if (blockId === this.STONE_ID) return this.Items.STONE;
    if (blockId === this.WOOD_ID) return this.Items.WOOD_LOG;
    if (blockId === this.LEAVES_ID) return this.Items.LEAVES;
    return 0;
  }

  /* =========================
     Inventory persistence (players)
  ========================= */

  private normalizeUserId(input: unknown, fallback: string): string {
    const raw = typeof input === "string" ? input : "";
    const trimmed = raw.trim();
    // Keep it filesystem-friendly
    const safe = trimmed.replace(/[^a-zA-Z0-9_\-]/g, "");
    if (safe.length >= 6) return safe;
    // fallback to sessionId (not persistent across refresh, but safe)
    return fallback;
  }

  private getUserIdForSession(sessionId: string): string {
    return this.sessionToUserId.get(sessionId) ?? sessionId;
  }

  private playerFilePath(userId: string): string {
    return path.join(this.playersDir, `p_${userId}.json`);
  }

  private loadInventoryFromDisk(userId: string): InventoryState | null {
    const fp = this.playerFilePath(userId);
    try {
      if (!fs.existsSync(fp)) return null;
      const txt = fs.readFileSync(fp, "utf8");
      const obj = JSON.parse(txt) as any;

      const slotsRaw = Array.isArray(obj?.slots) ? obj.slots : null;
      const cursorRaw = obj?.cursor ?? null;

      const slots: ItemStack[] = Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 }));
      if (slotsRaw) {
        for (let i = 0; i < Math.min(this.INV_SLOTS, slotsRaw.length); i++) {
          const s = slotsRaw[i];
          const id = toInt(Number(s?.id ?? 0));
          const count = toInt(Number(s?.count ?? 0));
          slots[i] = id > 0 && count > 0 ? { id: clamp(id, 0, 255), count: clamp(count, 1, 999999) } : { id: 0, count: 0 };
        }
      }

      const cId = toInt(Number(cursorRaw?.id ?? 0));
      const cCount = toInt(Number(cursorRaw?.count ?? 0));
      const cursor: ItemStack = cId > 0 && cCount > 0 ? { id: clamp(cId, 0, 255), count: clamp(cCount, 1, 999999) } : { id: 0, count: 0 };

      console.log("[PLAYER] loaded inventory:", { userId, fp });
      return { slots, cursor };
    } catch (e) {
      console.warn("[PLAYER] load failed:", { userId, fp }, e);
      return null;
    }
  }

  private saveInventory(userId: string, inv: InventoryState): void {
    const fp = this.playerFilePath(userId);
    const tmp = fp + ".tmp";
    try {
      const payload = JSON.stringify({ slots: inv.slots, cursor: inv.cursor }, null, 0);
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, fp);
      // loud log can be spammy; keep it but you can throttle later
      console.log("[PLAYER] saved inventory:", { userId, fp });
    } catch (e) {
      console.warn("[PLAYER] save failed:", { userId, fp }, e);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
    }
  }

  private loadOrCreateInventory(userId: string): InventoryState {
    const cached = this.inventories.get(userId);
    if (cached) return cached;

    const loaded = this.loadInventoryFromDisk(userId);
    if (loaded) {
      this.inventories.set(userId, loaded);
      return loaded;
    }

    const fresh: InventoryState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })),
      cursor: { id: 0, count: 0 },
    };

    // Optional starter kit (comment out if you want pure start)
    // fresh.slots[0] = { id: this.Items.WOOD_LOG, count: 6 };

    this.inventories.set(userId, fresh);
    this.saveInventory(userId, fresh);
    return fresh;
  }

  private getOrCreateInventory(userId: string): InventoryState {
    return this.loadOrCreateInventory(userId);
  }

  private sendInv(client: Client, inv: InventoryState): void {
    // Send full snapshot (simple + robust)
    client.send("invState", { slots: inv.slots, cursor: inv.cursor });
  }

  private isValidSlot(i: number): boolean {
    return Number.isFinite(i) && i >= 0 && i < this.INV_SLOTS;
  }

  private getMaxStack(itemId: number): number {
    const def = this.ITEM_DEFS[itemId];
    const ms = def ? (def.maxStack | 0) : 64;
    return ms > 0 ? ms : 64;
  }

  private isEmpty(s: ItemStack): boolean {
    return !s.id || s.count <= 0;
  }

  private findItemIdThatPlacesBlock(blockId: number): number {
    for (const k of Object.keys(this.ITEM_DEFS)) {
      const id = toInt(Number(k));
      const def = this.ITEM_DEFS[id];
      if (def?.placeBlockId === blockId) return id;
    }
    return 0;
  }

  private findFirstSlotWithItem(inv: InventoryState, itemId: number, start: number, end: number): number {
    for (let i = start; i < end; i++) {
      const s = inv.slots[i];
      if (s && s.id === itemId && s.count > 0) return i;
    }
    return -1;
  }

  private hasToolInHotbar(inv: InventoryState, toolItemId: number): boolean {
    for (let i = 0; i < this.HOTBAR_SLOTS; i++) {
      const s = inv.slots[i];
      if (s && s.id === toolItemId && s.count > 0) return true;
    }
    return false;
  }

  /* =========================
     Inventory add/consume helpers
  ========================= */

  private addToInventory(slots: ItemStack[], stack: ItemStack, simulate: boolean): number {
    const itemId = clamp(toInt(stack.id), 0, 255);
    let remaining = clamp(toInt(stack.count), 0, 999999);
    if (itemId <= 0 || remaining <= 0) return 0;

    const maxStack = this.getMaxStack(itemId);

    if (simulate) {
      const temp = slots.map((s) => ({ id: s.id, count: s.count }));
      return this.addToInventory(temp, stack, false);
    }

    // Fill existing stacks
    for (let i = 0; i < slots.length && remaining > 0; i++) {
      const s = slots[i];
      if (s.id !== itemId || s.count <= 0) continue;

      const space = Math.max(0, maxStack - s.count);
      if (space <= 0) continue;

      const moved = Math.min(space, remaining);
      slots[i] = { id: itemId, count: s.count + moved };
      remaining -= moved;
    }

    // Fill empty slots
    for (let i = 0; i < slots.length && remaining > 0; i++) {
      const s = slots[i];
      if (s.id !== 0 && s.count > 0) continue;

      const moved = Math.min(maxStack, remaining);
      slots[i] = { id: itemId, count: moved };
      remaining -= moved;
    }

    return remaining;
  }

  private countItem(slots: ItemStack[], itemId: number): number {
    let n = 0;
    for (const s of slots) if (s.id === itemId && s.count > 0) n += s.count;
    return n;
  }

  private hasIngredients(slots: ItemStack[], inputs: Array<{ id: number; count: number }>): boolean {
    for (const req of inputs) {
      const need = clamp(toInt(req.count), 1, 999999);
      if (this.countItem(slots, req.id) < need) return false;
    }
    return true;
  }

  private consumeIngredients(slots: ItemStack[], inputs: Array<{ id: number; count: number }>): void {
    for (const req of inputs) {
      let remaining = clamp(toInt(req.count), 1, 999999);
      const id = req.id;

      for (let i = 0; i < slots.length && remaining > 0; i++) {
        const s = slots[i];
        if (s.id !== id || s.count <= 0) continue;

        const take = Math.min(s.count, remaining);
        const left = s.count - take;
        remaining -= take;

        slots[i] = left > 0 ? { id, count: left } : { id: 0, count: 0 };
      }
    }
  }

  /* =========================
     Inventory click logic (server cursor)
  ========================= */

  private invLeftClick(inv: InventoryState, slotIndex: number): boolean {
    const slot = inv.slots[slotIndex];
    const cursor = inv.cursor;

    // Cursor empty -> pick up whole slot
    if (this.isEmpty(cursor)) {
      if (this.isEmpty(slot)) return false;
      inv.cursor = { id: slot.id, count: slot.count };
      inv.slots[slotIndex] = { id: 0, count: 0 };
      return true;
    }

    // Cursor has item
    if (this.isEmpty(slot)) {
      // place all
      inv.slots[slotIndex] = { id: cursor.id, count: cursor.count };
      inv.cursor = { id: 0, count: 0 };
      return true;
    }

    // slot occupied
    if (slot.id === cursor.id) {
      // stack into slot
      const maxStack = this.getMaxStack(slot.id);
      const space = Math.max(0, maxStack - slot.count);
      if (space <= 0) return false;

      const moved = Math.min(space, cursor.count);
      inv.slots[slotIndex] = { id: slot.id, count: slot.count + moved };
      const left = cursor.count - moved;
      inv.cursor = left > 0 ? { id: cursor.id, count: left } : { id: 0, count: 0 };
      return true;
    }

    // different item -> swap
    inv.slots[slotIndex] = { id: cursor.id, count: cursor.count };
    inv.cursor = { id: slot.id, count: slot.count };
    return true;
  }

  private invRightClick(inv: InventoryState, slotIndex: number): boolean {
    const slot = inv.slots[slotIndex];
    const cursor = inv.cursor;

    // Cursor empty -> take half (ceil) from slot
    if (this.isEmpty(cursor)) {
      if (this.isEmpty(slot)) return false;

      const take = Math.ceil(slot.count / 2);
      const left = slot.count - take;

      inv.cursor = { id: slot.id, count: take };
      inv.slots[slotIndex] = left > 0 ? { id: slot.id, count: left } : { id: 0, count: 0 };
      return true;
    }

    // Cursor has item
    if (this.isEmpty(slot)) {
      // place 1 into empty slot
      inv.slots[slotIndex] = { id: cursor.id, count: 1 };
      const left = cursor.count - 1;
      inv.cursor = left > 0 ? { id: cursor.id, count: left } : { id: 0, count: 0 };
      return true;
    }

    // slot occupied
    if (slot.id === cursor.id) {
      // place 1 into slot if space
      const maxStack = this.getMaxStack(slot.id);
      if (slot.count >= maxStack) return false;

      inv.slots[slotIndex] = { id: slot.id, count: slot.count + 1 };
      const left = cursor.count - 1;
      inv.cursor = left > 0 ? { id: cursor.id, count: left } : { id: 0, count: 0 };
      return true;
    }

    // Different item:
    // Minecraft usually does nothing on right-click here; keep it simple & predictable.
    return false;
  }

  private quickMove(inv: InventoryState, slotIndex: number): boolean {
    // If cursor not empty, do nothing (avoid complexity)
    if (!this.isEmpty(inv.cursor)) return false;

    const src = inv.slots[slotIndex];
    if (this.isEmpty(src)) return false;

    const isHotbar = slotIndex < this.HOTBAR_SLOTS;
    const destStart = isHotbar ? this.HOTBAR_SLOTS : 0;
    const destEnd = isHotbar ? this.INV_SLOTS : this.HOTBAR_SLOTS;

    let remaining = src.count;
    const itemId = src.id;
    const maxStack = this.getMaxStack(itemId);

    // 1) Fill existing stacks in destination
    for (let i = destStart; i < destEnd && remaining > 0; i++) {
      const d = inv.slots[i];
      if (d.id !== itemId || d.count <= 0) continue;

      const space = Math.max(0, maxStack - d.count);
      if (space <= 0) continue;

      const moved = Math.min(space, remaining);
      inv.slots[i] = { id: itemId, count: d.count + moved };
      remaining -= moved;
    }

    // 2) Fill empty slots in destination
    for (let i = destStart; i < destEnd && remaining > 0; i++) {
      const d = inv.slots[i];
      if (d.id !== 0 && d.count > 0) continue;

      const moved = Math.min(maxStack, remaining);
      inv.slots[i] = { id: itemId, count: moved };
      remaining -= moved;
    }

    // Update source
    inv.slots[slotIndex] = remaining > 0 ? { id: itemId, count: remaining } : { id: 0, count: 0 };

    // changed if anything moved
    return remaining !== src.count;
  }
}
