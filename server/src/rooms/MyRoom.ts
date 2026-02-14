import { Room, Client } from "colyseus";

/**
 * MyRoom (message-based, no Schema yet)
 *
 * Features:
 * - playerMove: stores last known position, broadcasts to others only (prevents self jitter)
 * - mineBlock: validates basic payload, broadcasts blockUpdate (id=0 => air)
 * - placeBlock: validates basic payload, broadcasts blockUpdate (id=block id)
 * - ping/pong
 * - (NEW) periodic snapshot: broadcasts all players to everyone (helps if any join/move packets are missed)
 *
 * NOTE:
 * - This version intentionally RELAXES validation (distance/world-state)
 *   so you can confirm the pipeline works end-to-end.
 * - Next step (MMO-ready): store chunk data on server, validate block exists,
 *   enforce reach/cooldowns/tools, and persist edits.
 */

type Vec3 = { x: number; y: number; z: number };

type PlayerInfo = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number; // optional for later; currently always 0 unless you add it from client
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
  // fast floor, consistent for negatives too
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}

export class MyRoom extends Room {
  private players = new Map<string, PlayerInfo>();

  // Movement packet rate limiting (~16 per second)
  private readonly minMoveIntervalMs = 60;

  // Sanity bounds for any incoming coords
  private readonly maxAbsCoord = 100000;

  // Allowed block ids for debug build (0=air, 1..5 from your client hotbar; keep 6 if you plan one more)
  private readonly minBlockId = 0;
  private readonly maxBlockId = 6;

  // Periodic full snapshot to reduce "I can't see someone" issues during early dev
  private readonly snapshotIntervalMs = 500;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    // Periodically broadcast a full player list to everyone.
    // This makes clients resilient if they miss a join/move packet early on.
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

    /**
     * Client -> Server: playerMove { x, y, z, yaw? }
     * Stores last known position and broadcasts to others only.
     */
    this.onMessage("playerMove", (client: Client, payload: unknown) => {
      const now = Date.now();

      const p = this.players.get(client.sessionId);
      if (!p) return;

      // Rate limit
      if (now - p.lastMoveAt < this.minMoveIntervalMs) return;

      // Validate payload
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3> & { yaw?: unknown };

      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord);
      const y = clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord);
      const z = clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord);

      // Optional yaw (safe default)
      const yaw = isFiniteNumber(maybe.yaw) ? maybe.yaw : p.yaw;

      p.x = x;
      p.y = y;
      p.z = z;
      p.yaw = yaw;
      p.lastMoveAt = now;

      // Broadcast to others (do NOT send back to sender to avoid jitter)
      this.broadcast("playerTransformOther", { id: client.sessionId, x, y, z, yaw }, { except: client });
    });

    /**
     * Client -> Server: mineBlock { x, y, z }
     *
     * Debug-friendly version:
     * - Logs the request
     * - Accepts the mine request (no reach/world validation yet)
     * - Broadcasts blockUpdate to everyone: set block to air (id=0)
     */
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      console.log("⛏ mineBlock from", client.sessionId, payload);

      if (typeof payload !== "object" || payload === null) return;

      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      // Broadcast the edit: set block to air (0)
      this.broadcast("blockUpdate", { x, y, z, id: 0 });
    });

    /**
     * Client -> Server: placeBlock { x, y, z, id }
     *
     * Debug-friendly version:
     * - Logs the request
     * - Validates basic payload (coords + id)
     * - Broadcasts blockUpdate to everyone: set block to id
     */
    this.onMessage("placeBlock", (client: Client, payload: unknown) => {
      console.log("🧱 placeBlock from", client.sessionId, payload);

      if (typeof payload !== "object" || payload === null) return;

      const maybe = payload as Partial<Vec3> & { id?: unknown };

      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;
      if (!isFiniteNumber(maybe.id)) return;

      const x = toInt(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = toInt(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = toInt(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      const id = toInt(clamp(maybe.id, this.minBlockId, this.maxBlockId));

      this.broadcast("blockUpdate", { x, y, z, id });
    });

    /**
     * Optional ping/pong
     */
    this.onMessage("ping", (client: Client, payload: unknown) => {
      client.send("pong", payload);
    });
  }

  onJoin(client: Client, options: any) {
    console.log("➕ onJoin", client.sessionId, options);

    const spawn: PlayerInfo = {
      id: client.sessionId,
      x: 0,
      y: 8,
      z: 0,
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

    // Notify others that a new player joined
    this.broadcast("playerJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw }, { except: client });

    // Also send the joiner their own spawn info (handy if client wants it)
    client.send("youJoined", { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw });
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
  }
}
