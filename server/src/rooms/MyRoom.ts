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
// Persistence:
// - Saves chunk files keyed by CHUNK INDEX: c_<cx>_<cy>_<cz>.bin
// - Loads from disk first, else generates
//
// Also:
// - autoDispose = false so room isn't destroyed when last client disconnects
// - loud logs for saves/loads/requests
//
// Added in this version:
// ✅ Server-authoritative inventory (hotbar + backpack) with stacking
// ✅ Block drops: mining spawns a pickup drop entity
// ✅ Pickup validation: distance check + inventory capacity check
// ✅ Crafting: simple shapeless recipes (wood -> planks -> sticks -> wood pick)
// ✅ Inventory move: server-validates slot moves (move/split, stack, swap)
// ✅ Drop cleanup: old drops expire to avoid memory growth

import { Room, Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";

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

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// NOTE: you already had this helper; keeping it unchanged
function toInt(n: number): number {
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/* =========================
   Inventory + Items + Recipes
========================= */

type ItemStack = { id: number; count: number };

type InvMoveMsg = {
  from: number;
  to: number;
  amount?: number; // if omitted or <=0 => move all possible
};

type PickupDropMsg = {
  dropId: string;
};

type CraftMsg = {
  recipeId: string;
  times?: number; // default 1
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
};

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

  // Block IDs
  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;
  private readonly WOOD_ID = 4;
  private readonly LEAVES_ID = 5;

  private chunks = new Map<string, Uint8Array>();

  // =========================
  // Persistence
  // =========================
  // Use build folder dir since your logs show you run from /server/build/*
  // (This is stable within your PM2 environment.)
  private readonly worldDir = path.join(process.cwd(), "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");

  // =========================
  // Inventory (server authoritative)
  // =========================
  private readonly HOTBAR_SLOTS = 5;
  private readonly BACKPACK_SLOTS = 20;
  private readonly INV_SLOTS = this.HOTBAR_SLOTS + this.BACKPACK_SLOTS;

  private inventories = new Map<string, ItemStack[]>();

  // Items / recipes (kept inline for now)
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
    20: { id: 20, name: "Wood Pick", maxStack: 1 },
  };

  private readonly RECIPES: Recipe[] = [
    {
      id: "planks_from_log",
      name: "Planks",
      inputs: [{ id: 4, count: 1 }], // wood -> planks
      output: { id: 10, count: 4 },
    },
    {
      id: "sticks_from_planks",
      name: "Sticks",
      inputs: [{ id: 10, count: 2 }], // planks -> sticks
      output: { id: 11, count: 4 },
    },
    {
      id: "wood_pick",
      name: "Wood Pick",
      inputs: [
        { id: 10, count: 3 }, // planks
        { id: 11, count: 2 }, // sticks
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

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Keep room alive when empty (refresh disconnect won't dispose)
    this.autoDispose = false;

    this.ensureDirs();
    console.log("[WORLD] persistence dir:", this.chunksDir);

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
    // Block edits (authoritative + persistent) + DROPS
    // =========================
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      const oldId = this.getBlockIdAt(x, y, z);
      if (oldId === this.AIR_ID) return;

      console.log("[EDIT mineBlock]", { by: client.sessionId, x, y, z, oldId });

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);

      // Spawn a drop for the mined block (simple 1:1 mapping)
      const itemId = this.blockIdToDropItemId(oldId);
      if (itemId > 0) {
        this.spawnDrop(itemId, 1, x + 0.5, y + 0.7, z + 0.5);
      }
    });

    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;

      const maybe = payload as Partial<Vec3> & { id?: unknown };

      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;
      if (!isFiniteNumber(maybe.id)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));
      const id = toInt(clamp(maybe.id, 0, 255));

      console.log("[EDIT placeBlock]", { by: client.sessionId, x, y, z, id });
      this.setBlockAuthoritative(x, y, z, id);
    });

    // =========================
    // Inventory: slot move (drag/drop)
    // =========================
    this.onMessage("invMove", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<InvMoveMsg>;

      if (!isFiniteNumber(p.from) || !isFiniteNumber(p.to)) return;

      const from = toInt(p.from);
      const to = toInt(p.to);
      if (!this.isValidSlot(from) || !this.isValidSlot(to)) return;
      if (from === to) return;

      const inv = this.getOrCreateInventory(client.sessionId);

      const src = inv[from];
      const dst = inv[to];

      if (!src || src.id === 0 || src.count <= 0) return;

      const amountRaw = isFiniteNumber(p.amount) ? toInt(p.amount) : 0;
      const want = amountRaw <= 0 ? src.count : clamp(amountRaw, 1, src.count);

      // Ensure defs exist; unknown items default to maxStack 64
      const srcMax = this.getMaxStack(src.id);
      const dstMax = dst && dst.id ? this.getMaxStack(dst.id) : 64;

      // 1) If destination empty: move "want" (possibly split)
      if (!dst || dst.id === 0 || dst.count <= 0) {
        inv[to] = { id: src.id, count: want };
        const left = src.count - want;
        inv[from] = left > 0 ? { id: src.id, count: left } : { id: 0, count: 0 };

        this.sendInv(client);
        return;
      }

      // 2) If same id: stack up to max
      if (dst.id === src.id) {
        const space = Math.max(0, srcMax - dst.count);
        if (space <= 0) return;

        const moved = Math.min(want, space);
        inv[to] = { id: dst.id, count: dst.count + moved };

        const left = src.count - moved;
        inv[from] = left > 0 ? { id: src.id, count: left } : { id: 0, count: 0 };

        this.sendInv(client);
        return;
      }

      // 3) Different items:
      // - only allow swap if moving the full source stack (want === src.count)
      // - partial move into a different item slot is rejected (prevents weird merges)
      if (want !== src.count) return;

      // Swap (but respect stack limits; if either stack exceeds max, reject)
      if (src.count > srcMax) return;
      if (dst.count > dstMax) return;

      inv[from] = { id: dst.id, count: dst.count };
      inv[to] = { id: src.id, count: src.count };

      this.sendInv(client);
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

      // distance check
      const dx = drop.x - pl.x;
      const dy = drop.y - pl.y;
      const dz = drop.z - pl.z;
      const r2 = this.DROP_PICKUP_RADIUS * this.DROP_PICKUP_RADIUS;
      if (dx * dx + dy * dy + dz * dz > r2) return;

      const inv = this.getOrCreateInventory(client.sessionId);

      // attempt full insert (deny if not enough space)
      const rem = this.addToInventory(inv, { id: drop.itemId, count: drop.count }, true);
      if (rem > 0) return;

      // success: remove drop
      this.drops.delete(drop.dropId);
      this.broadcast("dropDespawn", { dropId: drop.dropId });

      // send updated inventory
      this.sendInv(client);
    });

    // =========================
    // Crafting
    // =========================
    this.onMessage("craft", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<CraftMsg>;

      if (typeof p.recipeId !== "string" || p.recipeId.length < 1) return;

      const times = isFiniteNumber(p.times) ? clamp(toInt(p.times), 1, 99) : 1;

      const recipe = this.RECIPES.find((r) => r.id === p.recipeId);
      if (!recipe) return;

      const inv = this.getOrCreateInventory(client.sessionId);

      let crafted = 0;

      for (let t = 0; t < times; t++) {
        // Must have all inputs
        if (!this.hasIngredients(inv, recipe.inputs)) break;

        // Must have room for output (simulate insert first)
        const outRem = this.addToInventory(inv, { id: recipe.output.id, count: recipe.output.count }, true);
        if (outRem > 0) break;

        // Commit: remove inputs, then add output for real
        this.consumeIngredients(inv, recipe.inputs);
        this.addToInventory(inv, { id: recipe.output.id, count: recipe.output.count }, false);

        crafted++;
      }

      if (crafted > 0) {
        console.log("[CRAFT]", { by: client.sessionId, recipeId: recipe.id, crafted });
        this.sendInv(client);
      }
    });

    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  // =========================
  // Join/Leave
  // =========================
  onJoin(client: Client, options: any) {
    console.log("➕ onJoin", client.sessionId, options);

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

    // Inventory init + send snapshot
    this.getOrCreateInventory(client.sessionId);
    this.sendInv(client);

    // Send existing drops to new joiner
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
      spawn: { x: spawnX, y: spawnY, z: spawnZ },
      players: this.players.size,
      invSlots: this.INV_SLOTS,
      drops: this.drops.size,
    });
  }

  onLeave(client: Client, code?: number) {
    console.log("➖ onLeave", client.sessionId, "code:", code);
    const existed = this.players.delete(client.sessionId);
    if (existed) this.broadcast("playerLeft", { id: client.sessionId });

    // For now, remove inventory when leaving (no persistence for player inventory yet)
    // If you later want persistent player inventory, keep it and store to disk.
    this.inventories.delete(client.sessionId);
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");
    this.players.clear();
    this.inventories.clear();
    this.drops.clear();
  }

  // =========================
  // Chunk coord normalization (THE FIX)
  // =========================
  private normalizeChunkRequestToIndex(rx: number, ry: number, rz: number): { cx: number; cy: number; cz: number } {
    const CS = this.chunkSize;

    // If NOA provides origins (multiples of CS), convert to index.
    // If it provides indices, keep them.
    // (You said we'll fix/improve this later; leaving as-is.)
    const toIndex = (v: number) => {
      // origins are typically exact multiples of CS (…,-64,-32,0,32,64,…)
      if (v !== 0 && v % CS === 0) return toInt(v / CS);
      // also handle 0 (ambiguous) by treating as index 0
      return toInt(v);
    };

    return { cx: toIndex(rx), cy: toIndex(ry), cz: toIndex(rz) };
  }

  // =========================
  // Persistence
  // =========================
  private ensureDirs(): void {
    if (!fs.existsSync(this.worldDir)) fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir)) fs.mkdirSync(this.chunksDir, { recursive: true });
  }

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
  // World internals
  // =========================
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

  private blockIdToDropItemId(blockId: number): number {
    // For now, the mined blocks drop themselves as items
    // (Later you can make grass drop dirt, leaves drop saplings, etc.)
    if (blockId === this.GRASS_ID) return this.Items.GRASS;
    if (blockId === this.DIRT_ID) return this.Items.DIRT;
    if (blockId === this.STONE_ID) return this.Items.STONE;
    if (blockId === this.WOOD_ID) return this.Items.WOOD_LOG;
    if (blockId === this.LEAVES_ID) return this.Items.LEAVES;
    return 0;
  }

  // =========================
  // Drops internals
  // =========================
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
    console.log("[DROP] spawn", { dropId: id, itemId: drop.itemId, count: drop.count, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
  }

  // =========================
  // Inventory internals
  // =========================
  private isValidSlot(i: number): boolean {
    return Number.isFinite(i) && i >= 0 && i < this.INV_SLOTS;
  }

  private getMaxStack(itemId: number): number {
    const def = this.ITEM_DEFS[itemId];
    if (!def) return 64;
    const ms = def.maxStack | 0;
    return ms > 0 ? ms : 64;
  }

  private getOrCreateInventory(sessionId: string): ItemStack[] {
    const existing = this.inventories.get(sessionId);
    if (existing && Array.isArray(existing) && existing.length === this.INV_SLOTS) return existing;

    const inv: ItemStack[] = Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 }));

    // Optional starter kit (comment/uncomment as you like)
    // inv[0] = { id: this.Items.WOOD_LOG, count: 6 };
    // inv[1] = { id: this.Items.STONE, count: 16 };

    this.inventories.set(sessionId, inv);
    return inv;
  }

  private sendInv(client: Client): void {
    const inv = this.getOrCreateInventory(client.sessionId);
    // Send full snapshot (simple + robust)
    client.send("invState", { slots: inv });
  }

  private countItem(inv: ItemStack[], itemId: number): number {
    let n = 0;
    for (const s of inv) {
      if (s.id === itemId && s.count > 0) n += s.count;
    }
    return n;
  }

  private hasIngredients(inv: ItemStack[], inputs: Array<{ id: number; count: number }>): boolean {
    for (const req of inputs) {
      const need = clamp(toInt(req.count), 1, 999999);
      if (this.countItem(inv, req.id) < need) return false;
    }
    return true;
  }

  private consumeIngredients(inv: ItemStack[], inputs: Array<{ id: number; count: number }>): void {
    for (const req of inputs) {
      let remaining = clamp(toInt(req.count), 1, 999999);
      const id = req.id;

      for (let i = 0; i < inv.length && remaining > 0; i++) {
        const s = inv[i];
        if (s.id !== id || s.count <= 0) continue;

        const take = Math.min(s.count, remaining);
        const left = s.count - take;
        remaining -= take;

        inv[i] = left > 0 ? { id, count: left } : { id: 0, count: 0 };
      }
    }
  }

  /**
   * Add stack into inventory with stacking rules.
   *
   * @param inv inventory slots (mutated)
   * @param stack item stack to insert
   * @param simulate if true: do NOT mutate inv, just test capacity
   * @returns remaining count not inserted (0 means fully inserted)
   */
  private addToInventory(inv: ItemStack[], stack: ItemStack, simulate: boolean): number {
    const itemId = clamp(toInt(stack.id), 0, 255);
    let remaining = clamp(toInt(stack.count), 0, 999999);
    if (itemId <= 0 || remaining <= 0) return 0;

    const maxStack = this.getMaxStack(itemId);

    if (simulate) {
      // simulate by working on a shallow copy of stacks
      const temp = inv.map((s) => ({ id: s.id, count: s.count }));
      return this.addToInventory(temp, stack, false);
    }

    // 1) Fill existing stacks
    for (let i = 0; i < inv.length && remaining > 0; i++) {
      const s = inv[i];
      if (s.id !== itemId || s.count <= 0) continue;

      const space = Math.max(0, maxStack - s.count);
      if (space <= 0) continue;

      const moved = Math.min(space, remaining);
      inv[i] = { id: itemId, count: s.count + moved };
      remaining -= moved;
    }

    // 2) Fill empty slots
    for (let i = 0; i < inv.length && remaining > 0; i++) {
      const s = inv[i];
      if (s.id !== 0 && s.count > 0) continue;

      const moved = Math.min(maxStack, remaining);
      inv[i] = { id: itemId, count: moved };
      remaining -= moved;
    }

    return remaining;
  }
}
