// server/src/rooms/MyRoom.ts
// FULL FILE - paste exactly as-is
//
// Path B (server authoritative chunks) + multiplayer + PERSISTENCE:
// - Server generates & stores chunks (Uint8Array) and streams them to clients on demand
// - Block edits mutate stored chunks and broadcast "blockUpdate" to everyone
// - Player movement is relayed to others via "playerTransformOther"
// - Periodic "playersSnapshot" for robustness
// - Deterministic spawn slots so players don't overlap (first-free slot)
// - Spawn Y computed from SAME terrain function (so nobody spawns underground)
//
// ✅ Persistence in this version:
// - Chunks are saved to disk under: server/world/chunks/
// - On chunk request: server loads from disk if present; otherwise generates
// - On block edit: chunk is marked dirty and written (debounced)
// - This makes mined/placed blocks survive refresh AND server restart
//
// NOTE: Keep your server room name as "my_room" in defineServer config.

import { Room, Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  id: string; // noa chunk id
  chunkSize: number; // client requested (server may ignore)
  x: number; // chunk coord
  y: number; // chunk coord
  z: number; // chunk coord
};

type ChunkDataMsg = {
  id: string;
  chunkSize: number;
  x: number;
  y: number;
  z: number;
  voxels: Uint8Array; // binary
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

function toInt(n: number): number {
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export class MyRoom extends Room {
  // =========================
  // Players
  // =========================
  private players = new Map<string, PlayerInfo>();

  private readonly minMoveIntervalMs = 60;
  private readonly snapshotIntervalMs = 500;
  private readonly maxAbsCoord = 100000;

  private readonly maxSpeedBlocksPerSec = 12;

  // Block edit reach (MC-ish)
  private readonly maxEditHoriz = 6;
  private readonly maxEditVert = 12;

  private lastMoveLogAt = 0;
  private lastSnapshotLogAt = 0;

  // =========================
  // World settings (authoritative)
  // =========================
  private readonly chunkSize = 32; // MUST match client noa chunkSize
  private readonly baseHeight = 12;

  // Block IDs (must match client)
  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;

  // Stored chunks: key = "cx,cy,cz" -> Uint8Array length CS^3
  private chunks = new Map<string, Uint8Array>();

  // =========================
  // Persistence
  // =========================
  private readonly worldDir = path.join(process.cwd(), "server", "world");
  private readonly chunksDir = path.join(this.worldDir, "chunks");

  // Dirty chunk write batching
  private dirtyChunks = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushDelayMs = 300; // debounce writes

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Ensure dirs exist
    this.ensureDirs();

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

    // =========================
    // Path B: Chunk streaming
    // =========================
    this.onMessage("worldDataNeeded", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<WorldDataNeededMsg>;

      if (typeof p.id !== "string" || p.id.length < 1) return;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      const cx = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const cy = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const cz = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      const CS = this.chunkSize;

      // ✅ Load from disk or generate, then cache
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: CS,
        x: cx,
        y: cy,
        z: cz,
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

      // Anti-teleport / impossible speed
      const dtSec = Math.max(0.001, (now - Math.max(0, pl.lastMoveAt)) / 1000);
      const maxDist = this.maxSpeedBlocksPerSec * dtSec;

      const dx = x - pl.x;
      const dy = y - pl.y;
      const dz = z - pl.z;

      if (dx * dx + dy * dy + dz * dz > (maxDist * maxDist) * 4) {
        return;
      }

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
    // Block edits (authoritative + persistent)
    // =========================
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      if (!this.isWithinEditRange(client, x, y, z)) return;

      this.setBlockAuthoritative(x, y, z, this.AIR_ID);
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

      if (!this.isWithinEditRange(client, x, y, z)) return;

      this.setBlockAuthoritative(x, y, z, id);
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

    // First-free deterministic spawn slot
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

    console.log("[JOIN STATE]", {
      joined: client.sessionId,
      spawn: { x: spawnX, y: spawnY, z: spawnZ },
      players: this.players.size,
    });
  }

  onLeave(client: Client, code?: number) {
    console.log("➖ onLeave", client.sessionId, "code:", code);

    const existed = this.players.delete(client.sessionId);
    if (existed) {
      this.broadcast("playerLeft", { id: client.sessionId });
    }
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");

    // Flush pending chunk writes before shutdown
    try {
      this.flushDirtyChunksSync();
    } catch {}

    this.players.clear();

    // Keep world persistent: do NOT clear chunks.
    // this.chunks.clear();
  }

  // =========================
  // Validation helpers
  // =========================
  private isWithinEditRange(client: Client, x: number, y: number, z: number): boolean {
    const p = this.players.get(client.sessionId);
    if (!p) return false;

    const dx = x - p.x;
    const dz = z - p.z;
    const dy = y - p.y;

    const horiz = Math.sqrt(dx * dx + dz * dz);
    if (horiz > this.maxEditHoriz) return false;
    if (Math.abs(dy) > this.maxEditVert) return false;

    return true;
  }

  // =========================
  // Persistence helpers
  // =========================
  private ensureDirs(): void {
    if (!fs.existsSync(this.worldDir)) fs.mkdirSync(this.worldDir, { recursive: true });
    if (!fs.existsSync(this.chunksDir)) fs.mkdirSync(this.chunksDir, { recursive: true });
  }

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private chunkFilePath(cx: number, cy: number, cz: number): string {
    // safe file name
    return path.join(this.chunksDir, `c_${cx}_${cy}_${cz}.bin`);
  }

  private readChunkFromDisk(cx: number, cy: number, cz: number): Uint8Array | null {
    const fp = this.chunkFilePath(cx, cy, cz);
    try {
      if (!fs.existsSync(fp)) return null;
      const buf = fs.readFileSync(fp);
      // Ensure exact expected size
      const expected = this.chunkSize * this.chunkSize * this.chunkSize;
      if (buf.byteLength !== expected) return null;
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  private writeChunkToDisk(key: string, chunk: Uint8Array): void {
    const parts = key.split(",");
    if (parts.length !== 3) return;
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;

    const fp = this.chunkFilePath(cx, cy, cz);

    // Write atomic-ish: temp then rename
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(chunk));
    fs.renameSync(tmp, fp);
  }

  private markChunkDirty(cx: number, cy: number, cz: number): void {
    const key = this.chunkKey(cx, cy, cz);
    this.dirtyChunks.add(key);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushDirtyChunksAsync();
      }, this.flushDelayMs);
    }
  }

  private flushDirtyChunksAsync(): void {
    if (this.dirtyChunks.size === 0) return;

    const keys = Array.from(this.dirtyChunks);
    this.dirtyChunks.clear();

    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      try {
        this.writeChunkToDisk(key, chunk);
      } catch (e) {
        console.warn("[WORLD] failed write chunk", key, e);
      }
    }
  }

  private flushDirtyChunksSync(): void {
    if (this.dirtyChunks.size === 0) return;

    const keys = Array.from(this.dirtyChunks);
    this.dirtyChunks.clear();

    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      try {
        this.writeChunkToDisk(key, chunk);
      } catch {}
    }
  }

  // =========================
  // World internals
  // =========================
  // Packing must match client unpack loop:
  // n increments in order: for k, for j, for i
  // idx = i + CS*(j + CS*k)
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

    return vox;
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);

    const existing = this.chunks.get(key);
    if (existing) return existing;

    // ✅ Try disk first
    const fromDisk = this.readChunkFromDisk(cx, cy, cz);
    if (fromDisk) {
      // Make a copy to ensure it’s detached from Buffer view quirks
      const copy = new Uint8Array(fromDisk.length);
      copy.set(fromDisk);
      this.chunks.set(key, copy);
      return copy;
    }

    // Otherwise generate
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

    // ✅ Persist
    this.markChunkDirty(cx, cy, cz);

    // Broadcast edit
    this.broadcast("blockUpdate", { x, y, z, id: v });
  }
}
