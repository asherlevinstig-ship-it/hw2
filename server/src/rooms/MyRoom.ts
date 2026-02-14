// server/src/rooms/MyRoom.ts
import { Room, Client } from "colyseus";

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  id: string; // IMPORTANT: client-generated chunk id from noa
  chunkSize: number;
  x: number; // chunk coord
  y: number; // chunk coord
  z: number; // chunk coord
};

type ChunkDataMsg = {
  id: string; // echo back so client can resolve pending request
  chunkSize: number;
  x: number;
  y: number;
  z: number;
  voxels: number[]; // flat array length = chunkSize^3, values are block IDs
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

// floor division for negatives
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// mod that works for negatives (result 0..b-1)
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export class MyRoom extends Room {
  private players = new Map<string, PlayerInfo>();

  // ---- World / chunk settings ----
  private readonly chunkSize = 32; // enforce on server for consistency
  private readonly maxAbsCoord = 100000;

  // block ids (match your client)
  private readonly AIR_ID = 0;
  private readonly GRASS_ID = 1;
  private readonly DIRT_ID = 2;
  private readonly STONE_ID = 3;

  // store chunks in memory (later you can persist to DB/disk)
  // key = `${cx},${cy},${cz}`
  private chunks = new Map<string, Uint8Array>();

  // Movement packet rate limiting (~16 per second)
  private readonly minMoveIntervalMs = 60;

  // Periodic full snapshot to reduce "I can't see someone" issues during early dev
  private readonly snapshotIntervalMs = 500;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Periodically broadcast a full player list to everyone.
    this.clock.setInterval(() => {
      const all = Array.from(this.players.values()).map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
      }));
      this.broadcast("playersSnapshot", all);
    }, this.snapshotIntervalMs);

    // =========================
    // Path B: Chunk Streaming
    // =========================
    this.onMessage("worldDataNeeded", (client: Client, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<WorldDataNeededMsg>;

      if (typeof p.id !== "string" || p.id.length < 1) return;

      // server-enforced chunk size (ignore client request if different)
      const CS = this.chunkSize;

      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return;

      const cx = toInt(clamp(p.x, -this.maxAbsCoord, this.maxAbsCoord));
      const cy = toInt(clamp(p.y, -this.maxAbsCoord, this.maxAbsCoord));
      const cz = toInt(clamp(p.z, -this.maxAbsCoord, this.maxAbsCoord));

      const chunk = this.getOrCreateChunk(cx, cy, cz, CS);

      // Send chunk only to requester (not broadcast)
      const msg: ChunkDataMsg = {
        id: p.id,
        chunkSize: CS,
        x: cx,
        y: cy,
        z: cz,
        voxels: Array.from(chunk), // JSON-friendly; optimize later
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

      const id = toInt(clamp(maybe.id, 0, 255)); // keep simple; clamp to byte

      this.setBlockAuthoritative(x, y, z, id);
    });

    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  onJoin(client: Client, options: any) {
    console.log("➕ onJoin", client.sessionId, options);

    const spawn: PlayerInfo = {
      id: client.sessionId,
      x: 0,
      y: 20,
      z: 0,
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
  }

  onLeave(client: Client, code?: number) {
    console.log("➖ onLeave", client.sessionId, "code:", code);

    const existed = this.players.delete(client.sessionId);
    if (existed) this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");
    this.players.clear();
    // keep chunks if you want world to persist beyond room lifetime; otherwise clear:
    // this.chunks.clear();
  }

  // =========================
  // World internals
  // =========================

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private idx(i: number, j: number, k: number, CS: number): number {
    // same iteration order we’ll use on client fill: i + CS*(j + CS*k)
    return i + CS * (j + CS * k);
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number, CS: number): Uint8Array {
    const key = this.chunkKey(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    const vox = new Uint8Array(CS * CS * CS);

    // Your hills formula, but server-side:
    const baseHeight = 12;

    for (let i = 0; i < CS; i++) {
      for (let k = 0; k < CS; k++) {
        const globalX = cx * CS + i;
        const globalZ = cz * CS + k;

        const height =
          baseHeight +
          Math.floor(Math.sin(globalX / 15) * 6 + Math.cos(globalZ / 15) * 6);

        for (let j = 0; j < CS; j++) {
          const globalY = cy * CS + j;

          let id = this.AIR_ID;
          if (globalY > height) id = this.AIR_ID;
          else if (globalY === height) id = this.GRASS_ID;
          else if (globalY > height - 4) id = this.DIRT_ID;
          else id = this.STONE_ID;

          vox[this.idx(i, j, k, CS)] = id;
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

    const chunk = this.getOrCreateChunk(cx, cy, cz, CS);
    chunk[this.idx(lx, ly, lz, CS)] = clamp(toInt(id), 0, 255);

    // Broadcast edit to everyone (including sender)
    this.broadcast("blockUpdate", { x, y, z, id: clamp(toInt(id), 0, 255) });
  }
}
