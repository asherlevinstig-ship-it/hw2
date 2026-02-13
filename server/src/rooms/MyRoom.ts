import { Room, Client } from "colyseus";

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

  // Anti-spam: min milliseconds between accepted movement packets per client
  private readonly minMoveIntervalMs = 50; // 20 msgs/sec

  // Basic sanity bounds
  private readonly maxAbsCoord = 100000;

  onCreate(options: any) {
    console.log("✅ MyRoom created", options);

    this.maxClients = 32;

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

      // Echo back authoritative confirmation
      client.send("playerTransform", { x, y, z });

      // Broadcast to everyone else
      this.broadcast(
        "playerTransformOther",
        { id: client.sessionId, x, y, z },
        { except: client }
      );
    });

    // Optional ping/pong
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
      lastMoveAt: 0,
    };

    this.players.set(client.sessionId, spawn);

    // Send existing players to the new client
    const existingPlayers = Array.from(this.players.values())
      .filter((p) => p.id !== client.sessionId)
      .map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z }));

    client.send("existingPlayers", existingPlayers);

    // Send spawn position for this client
    client.send("playerTransform", { x: spawn.x, y: spawn.y, z: spawn.z });

    // Notify others that a new player joined
    this.broadcast(
      "playerJoined",
      { id: client.sessionId, x: spawn.x, y: spawn.y, z: spawn.z },
      { except: client }
    );
  }

  /**
   * Colyseus (your version) uses: onLeave(client, code?)
   * where code is a number (WebSocket close code) or undefined.
   */
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
