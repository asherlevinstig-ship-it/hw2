import { Room, Client } from "colyseus";

/**
 * MyRoom (message-based, no Schema yet)
 *
 * Supports:
 * - playerMove: store last known position, broadcast to others only (prevents self-jitter)
 * - mineBlock: validate distance against last known player position, broadcast blockUpdate (id=0 => air)
 * - ping/pong
 *
 * NOTE:
 * - This does NOT yet persist world state. It only broadcasts edits.
 *   Next step for MMO: maintain chunk store on server and send chunks on join/move.
 */

type Vec3 = { x: number; y: number; z: number };

type PlayerInfo = {
  id: string;
  x: number;
  y: number;
  z: number;
  lastMoveAt: number;
};

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export class MyRoom extends Room {
  private players = new Map<string, PlayerInfo>();

  // Movement packet rate limiting (~16 per second)
  private readonly minMoveIntervalMs = 60;

  // Sanity bounds
  private readonly maxAbsCoord = 100000;

  // Mining reach
  private readonly mineReach = 6;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

    /**
     * Client -> Server: playerMove { x, y, z }
     * Server stores last known position and broadcasts to others only.
     */
    this.onMessage("playerMove", (client: Client, payload: unknown) => {
      const now = Date.now();

      const p = this.players.get(client.sessionId);
      if (!p) return;

      // Rate limit
      if (now - p.lastMoveAt < this.minMoveIntervalMs) return;

      // Validate payload
      if (typeof payload !== "object" || payload === null) return;
      const maybe = payload as Partial<Vec3>;

      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord);
      const y = clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord);
      const z = clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord);

      p.x = x;
      p.y = y;
      p.z = z;
      p.lastMoveAt = now;

      // Broadcast to others (do NOT send back to sender to avoid jitter)
      this.broadcast(
        "playerTransformOther",
        { id: client.sessionId, x, y, z },
        { except: client }
      );
    });

    /**
     * Client -> Server: mineBlock { x, y, z }
     * Server validates reach and broadcasts blockUpdate { x,y,z,id:0 }.
     *
     * Later: validate block exists in server chunk store, tool checks, cooldowns, etc.
     */
    this.onMessage("mineBlock", (client: Client, payload: unknown) => {
      const p = this.players.get(client.sessionId);
      if (!p) return;

      if (typeof payload !== "object" || payload === null) return;

      const maybe = payload as Partial<Vec3>;
      if (!isFiniteNumber(maybe.x) || !isFiniteNumber(maybe.y) || !isFiniteNumber(maybe.z)) return;

      const x = Math.floor(clamp(maybe.x, -this.maxAbsCoord, this.maxAbsCoord));
      const y = Math.floor(clamp(maybe.y, -this.maxAbsCoord, this.maxAbsCoord));
      const z = Math.floor(clamp(maybe.z, -this.maxAbsCoord, this.maxAbsCoord));

      // Distance check (use squared distance)
      const dx = p.x - x;
      const dy = p.y - y;
      const dz = p.z - z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > this.mineReach * this.mineReach) return;

      // Broadcast the edit: set block to air (0)
      // (No persistence yet - just tells clients to remove it)
      this.broadcast("blockUpdate", { x, y, z, id: 0 });
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
      lastMoveAt: 0,
    };

    this.players.set(client.sessionId, spawn);

    // Send existing players to new client
    const existingPlayers = Array.from(this.players.values())
      .filter((pl) => pl.id !== client.sessionId)
      .map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, z: pl.z }));

    client.send("existingPlayers", existingPlayers);

    // Notify others that a new player joined
    this.broadcast(
      "playerJoined",
      { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z },
      { except: client }
    );

    // NOTE: We intentionally do NOT force-set the joining client's position.
    // If you want server-authoritative spawns, we'll add prediction + reconciliation.
  }

  onLeave(client: Client, code?: number) {
    console.log("➖ onLeave", client.sessionId, "code:", code);

    this.players.delete(client.sessionId);

    this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("🧹 MyRoom disposed");
    this.players.clear();
  }
}
