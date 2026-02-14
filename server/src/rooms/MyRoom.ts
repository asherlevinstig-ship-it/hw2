// server/src/rooms/MyRoom.ts
// FULL FILE - paste exactly as-is
//
// Path B (server authoritative chunks) + multiplayer:
// - Server generates & stores chunks (Uint8Array) and streams them to clients on demand
// - Chunk streaming is BINARY (Uint8Array) (Colyseus will msgpack it efficiently)
// - Block edits mutate stored chunks and broadcast "blockUpdate" to everyone
// - Player movement is relayed to others via "playerTransformOther"
// - Periodic "playersSnapshot" for robustness
// - Deterministic spawn spacing so players don't spawn on top of each other
// - Spawn Y computed from SAME terrain function (so nobody spawns underground)
//
// Extra hardening/debug in this version:
// - On join: send an immediate playersSnapshot to the joiner
// - Optional join-broadcast snapshot removed (periodic snapshot already converges state)
// - Throttled debug logs for moves and snapshots
// - Movement anti-teleport: rejects impossible speed jumps
// - Block edit reach validation: rejects edits too far from player's last known position
// - Chunk request hardening: validates payload + clamps coords
//
// NOTE: Keep your server room name as "my_room" in defineServer config.

import { Room, Client } from "colyseus";

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
  voxels: Uint8Array; // BINARY (preferred)
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

  // Movement packet rate limiting
  private readonly minMoveIntervalMs = 60;

  // Periodic full snapshot
  private readonly snapshotIntervalMs = 500;

  // Sanity bounds
  private readonly maxAbsCoord = 100000;

  // Anti-teleport / speed cap
  private readonly maxSpeedBlocksPerSec = 12;

  // Block edit reach cap
  private readonly maxEditDistance = 8;

  // Debug throttles
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

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Robust periodic snapshot
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
      const chunk = this.getOrCreateChunk(cx, cy, cz);

      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: CS,
        x: cx,
        y: cy,
        z: cz,
        voxels: chunk, // ✅ binary
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

      // Rate limit
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

      // Allow some slack for jitter (factor 2)
      if (dx * dx + dy * dy + dz * dz > (maxDist * maxDist) * 4) {
        return;
      }

      pl.x = x;
      pl.y = y;
      pl.z = z;
      pl.yaw = yaw;
      pl.lastMoveAt = now;

      // others only
      this.broadcast("playerTransformOther", { id: client.sessionId, x, y, z, yaw }, { except: client });

      // Throttled debug
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
    // Block edits (authoritative)
    // =========================
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      // Reach validation
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

      // Reach validation
      if (!this.isWithinEditRange(client, x, y, z)) return;

      this.setBlockAuthoritative(x, y, z, id);
    });

    // Optional ping/pong
    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  // =========================
  // Join/Leave
  // =========================
  onJoin(client: Client, options: any) {
    console.log("➕ onJoin", client.sessionId, options);

    // Deterministic spawn grid but choose first free slot (no overlap if others remain)
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
      if (slot > 4096) break; // safety
    }

    // compute ground height using the SAME terrain function (surface Y)
    const surfaceY = this.heightAt(spawnX, spawnZ);

    // spawn above surface (player will fall onto ground)
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

    // Send existing players to new client
    const existingPlayers = Array.from(this.players.values())
      .filter((pl) => pl.id !== client.sessionId)
      .map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw }));

    client.send("existingPlayers", existingPlayers);

    // Notify others about this join
    this.broadcast(
      "playerJoined",
      { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw },
      { except: client }
    );

    // Tell joiner their own spawn
    client.send("youJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw });

    // ✅ Hardening: immediately send a full snapshot to the joiner (authoritative state)
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
    this.players.clear();

    // If you want world to persist across room lifecycle, DO NOT clear.
    // If you want it reset each time, uncomment:
    // this.chunks.clear();
  }

  // =========================
  // Validation helpers
  // =========================
  private isWithinEditRange(client: Client, x: number, y: number, z: number): boolean {
    const p = this.players.get(client.sessionId);
    if (!p) return false;
    const dx = x - p.x;
    const dy = y - p.y;
    const dz = z - p.z;
    return dx * dx + dy * dy + dz * dz <= this.maxEditDistance * this.maxEditDistance;
  }

  // =========================
  // World internals
  // =========================
  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  // Packing must match client unpack loop:
  // n increments in order: for k, for j, for i
  // idx = i + CS*(j + CS*k)
  private idx(i: number, j: number, k: number): number {
    const CS = this.chunkSize;
    return i + CS * (j + CS * k);
  }

  private heightAt(worldX: number, worldZ: number): number {
    const h = this.baseHeight + Math.floor(Math.sin(worldX / 15) * 6 + Math.cos(worldZ / 15) * 6);
    return h;
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

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

    this.chunks.set(key, vox);
    return vox;
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

    this.broadcast("blockUpdate", { x, y, z, id: v });
  }
}
