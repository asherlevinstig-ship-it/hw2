import fs from "fs";
import path from "path";
import { Room, Client } from "@colyseus/core";
import { Schematic } from "prismarine-schematic";
import { Vec3 } from "vec3";

/*
  MyRoom.ts (FULL FILE - paste as-is)

  Server authoritative:
  - Chunk streaming for noa-engine client (worldDataNeeded -> chunkData)
  - Block place / mine sync
  - Inventory + crafting + drops (server authoritative)
  - Tower stamping from a prismarine-schematic (.schem) into generated chunks
  - Safe Zone (cornucopia) prevention for mine/place
  - Debug logging for tower load + stamping, and for chunk requests

  Client protocol expected:
  - client -> server:
      worldDataNeeded { id, chunkSize, x, y, z }
      playerMove { x,y,z,yaw }
      placeBlock { x,y,z,id,fromSlot }
      startMine { x,y,z,heldSlot }
      cancelMine { reason }
      invClick { slot, button:'L'|'R', shift:boolean }
      craft { recipeId, max:boolean, times?:number }
      pickupDrop { dropId }

  - server -> client:
      chunkData { id, chunkSize, voxels }
      blockUpdate { x,y,z,id }
      safeZone { x,z,r }
      mineProgress { x,y,z,progress,stage,done?,reason? }
      mineCancelled { }
      invState { slots:[{id,count,dur?}...], cursor:{id,count,dur?} }
      dropSpawn { dropId,itemId,count,x,y,z,createdAt }
      dropDespawn { dropId }
      youJoined { x,y,z }
      existingPlayers [ { id,x,y,z,yaw? }... ]
      playerJoined { id,x,y,z,yaw? }
      playerLeft { id }
      playerTransformOther { id,x,y,z,yaw? }
      playersSnapshot [ { id,x,y,z,yaw? }... ]
*/

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function nowMs() {
  return Date.now();
}

function chunkIdFromCoords(cx: number, cy: number, cz: number) {
  return `${cx}|${cy}|${cz}`;
}

function floorDiv(n: number, d: number) {
  // floor division that works for negatives
  const q = Math.trunc(n / d);
  if (n >= 0 || n % d === 0) return q;
  return q - 1;
}

function mod(n: number, m: number) {
  return ((n % m) + m) % m;
}

function idx3(x: number, y: number, z: number, CS: number) {
  return x + CS * (y + CS * z);
}

type Player = {
  id: string;
  userId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  lastMoveAt: number;
};

type ItemStack = { id: number; count: number; dur?: number };

type InvState = {
  slots: ItemStack[];
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

type MineState = {
  x: number;
  y: number;
  z: number;
  blockId: number;
  startedAt: number;
  breakTimeMs: number;
  lastProgressSentAt: number;
  heldSlot: number;
};

type Recipe = {
  id: string;
  inputs: { id: number; count: number }[];
  output: { id: number; count: number };
};

export class MyRoom extends Room {
  /* ---------- world config ---------- */
  private readonly CS = 32;
  private readonly WORLD_MIN_Y = 0;
  private readonly WORLD_MAX_Y = 128;

  // Spawn
  private readonly SPAWN_X = 0;
  private readonly SPAWN_Y = 20;
  private readonly SPAWN_Z = 0;

  // Safe zone (cornucopia)
  private readonly SAFE_X = 0;
  private readonly SAFE_Z = 0;
  private readonly SAFE_R = 18;

  /* ---------- block ids (MUST match client) ---------- */
  public readonly GRASS_ID = 1;
  public readonly DIRT_ID = 2;
  public readonly STONE_ID = 3;
  public readonly WOOD_ID = 4;
  public readonly LEAVES_ID = 5;

  public readonly BEDROCK_ID = 6;
  public readonly COAL_ORE_ID = 7;
  public readonly IRON_ORE_ID = 8;
  public readonly GOLD_ORE_ID = 9;
  public readonly DIAMOND_ORE_ID = 10;

  public readonly SAND_ID = 11;
  public readonly SNOW_ID = 12;

  /* ---------- item ids (match your client shared/items) ---------- */
  // If your project already defines Items elsewhere, replace these to match.
  private readonly Items = {
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    WOOD_LOG: 4,
    LEAVES: 5,

    COAL: 21,
    RAW_IRON: 22,
    RAW_GOLD: 23,
    DIAMOND: 24,

    WOOD_PICK: 101,
    STONE_PICK: 102,
    IRON_PICK: 103,
    GOLD_PICK: 104,
    DIAMOND_PICK: 105,
  } as const;

  /* ---------- inventory config ---------- */
  private readonly HOTBAR_SLOTS = 5;
  private readonly BACKPACK_SLOTS = 20;
  private readonly INV_SLOTS = this.HOTBAR_SLOTS + this.BACKPACK_SLOTS;

  /* ---------- runtime state ---------- */
  private players = new Map<string, Player>();
  private mining = new Map<string, MineState>();
  private drops = new Map<string, Drop>();

  private chunks = new Map<string, Uint8Array>();

  /* ---------- tower schematic ---------- */
  private towerSchemPath = "";
  private towerSchem: any | null = null;
  private towerLoaded = false;
  private towerOrigin = { x: 0, y: 0, z: 0 };
  private towerSize = { x: 0, y: 0, z: 0 };
  private towerUniqueNames: string[] = [];

  /* ---------- recipes (replace with your real ones if needed) ---------- */
  private RECIPES: Recipe[] = [
    {
      id: "wood_pick",
      inputs: [
        { id: this.Items.WOOD_LOG, count: 3 },
        { id: this.Items.WOOD_LOG, count: 2 },
      ],
      output: { id: this.Items.WOOD_PICK, count: 1 },
    },
  ];

  /* ===============================
     Room lifecycle
  ================================ */
  override onCreate(options: any) {
    this.setPatchRate(50);

    const envPath = process.env.TOWER_SCHEM_PATH;
    this.towerSchemPath =
      typeof options?.towerSchemPath === "string"
        ? options.towerSchemPath
        : typeof envPath === "string" && envPath.trim()
        ? envPath
        : path.resolve(process.cwd(), "assets", "tower.schem");

    // Stamp near spawn (offset a bit)
    this.towerOrigin = {
      x: this.SPAWN_X + 6,
      y: this.SPAWN_Y - 2,
      z: this.SPAWN_Z + 6,
    };

    this.loadTowerSchematicSafe();

    this.onMessage("worldDataNeeded", (client, req: any) => {
      this.handleWorldDataNeeded(client, req);
    });

    this.onMessage("playerMove", (client, msg: any) => {
      this.handlePlayerMove(client, msg);
    });

    this.onMessage("placeBlock", (client, msg: any) => {
      this.handlePlaceBlock(client, msg);
    });

    this.onMessage("startMine", (client, msg: any) => {
      this.handleStartMine(client, msg);
    });

    this.onMessage("cancelMine", (client, msg: any) => {
      this.cancelMiningFor(client.sessionId, msg?.reason ?? "client_cancel");
    });

    this.onMessage("invClick", (client, msg: any) => {
      this.applyInvClick(client, msg);
    });

    this.onMessage("craft", (client, msg: any) => {
      this.handleCraft(client, msg);
    });

    this.onMessage("pickupDrop", (client, msg: any) => {
      this.handlePickupDrop(client, msg);
    });

    // Tick loop
    this.setSimulationInterval(() => {
      this.tickMining();
      this.tickSnapshots();
      this.tickDropCleanup();
    }, 50);

    console.log("[ROOM] created", {
      towerSchemPath: this.towerSchemPath,
      towerOrigin: this.towerOrigin,
      safeZone: { x: this.SAFE_X, z: this.SAFE_Z, r: this.SAFE_R },
    });
  }

  override onJoin(client: Client, options: any) {
    const userId = typeof options?.userId === "string" ? options.userId : "";

    const p: Player = {
      id: client.sessionId,
      userId: userId || client.sessionId,
      x: this.SPAWN_X,
      y: this.SPAWN_Y,
      z: this.SPAWN_Z,
      yaw: 0,
      lastMoveAt: nowMs(),
    };

    this.players.set(client.sessionId, p);

    // Safe zone info
    client.send("safeZone", { x: this.SAFE_X, z: this.SAFE_Z, r: this.SAFE_R });

    // Inventory init + push
    const inv = this.ensureInv(client.sessionId);
    this.sendInvState(client, inv);

    // Spawn position sync
    client.send("youJoined", { x: p.x, y: p.y, z: p.z });

    // Existing players to this client
    const existing = Array.from(this.players.values())
      .filter((pp) => pp.id !== client.sessionId)
      .map((pp) => ({ id: pp.id, x: pp.x, y: pp.y, z: pp.z, yaw: pp.yaw }));
    client.send("existingPlayers", existing);

    // Notify others
    this.broadcast(
      "playerJoined",
      { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw },
      { except: client }
    );

    console.log("[NET] join", { sid: client.sessionId, userId });
  }

  override onLeave(client: Client) {
    this.players.delete(client.sessionId);
    this.mining.delete(client.sessionId);

    this.broadcast("playerLeft", { id: client.sessionId });

    console.log("[NET] leave", { sid: client.sessionId });
  }

  /* ===============================
     Safe Zone
  ================================ */
  private isInSafeZoneXZ(x: number, z: number) {
    const dx = x + 0.5 - this.SAFE_X;
    const dz = z + 0.5 - this.SAFE_Z;
    return dx * dx + dz * dz <= this.SAFE_R * this.SAFE_R;
  }

  /* ===============================
     Players
  ================================ */
  private handlePlayerMove(client: Client, msg: any) {
    const p = this.players.get(client.sessionId);
    if (!p) return;

    const x = Number(msg?.x);
    const y = Number(msg?.y);
    const z = Number(msg?.z);
    const yaw = Number(msg?.yaw ?? 0);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return;

    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = Number.isFinite(yaw) ? yaw : 0;
    p.lastMoveAt = nowMs();

    this.broadcast(
      "playerTransformOther",
      { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw },
      { except: client }
    );
  }

  private lastSnapshotAt = 0;
  private tickSnapshots() {
    const now = nowMs();
    if (now - this.lastSnapshotAt < 1800) return;
    this.lastSnapshotAt = now;

    const snap = Array.from(this.players.values()).map((pp) => ({
      id: pp.id,
      x: pp.x,
      y: pp.y,
      z: pp.z,
      yaw: pp.yaw,
    }));

    this.broadcast("playersSnapshot", snap);
  }

  /* ===============================
     Chunk streaming
  ================================ */
  private handleWorldDataNeeded(client: Client, req: any) {
    const id = typeof req?.id === "string" ? req.id : "";
    const chunkSize = Number(req?.chunkSize ?? this.CS);
    const x = Number(req?.x);
    const y = Number(req?.y);
    const z = Number(req?.z);

    if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return;

    const CS =
      Number.isFinite(chunkSize) && chunkSize > 0 ? (chunkSize | 0) : this.CS;

    const cx = x | 0;
    const cy = y | 0;
    const cz = z | 0;

    const vox = this.getOrCreateChunk(cx, cy, cz, CS);

    client.send("chunkData", { id, chunkSize: CS, voxels: Array.from(vox) });
  }

  private getOrCreateChunk(
    cx: number,
    cy: number,
    cz: number,
    CS: number
  ): Uint8Array {
    const key = chunkIdFromCoords(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    const chunk = this.generateChunk(cx, cy, cz, CS);
    this.chunks.set(key, chunk);
    return chunk;
  }

  private generateChunk(cx: number, cy: number, cz: number, CS: number) {
    const out = new Uint8Array(CS * CS * CS);

    const baseX = cx * CS;
    const baseY = cy * CS;
    const baseZ = cz * CS;

    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;

        const h =
          10 +
          Math.floor(Math.sin(wx * 0.04) * 2 + Math.cos(wz * 0.04) * 2);

        const sandBand = wz > 80 && wz < 110;
        const snowBand = wz < -120;

        for (let ly = 0; ly < CS; ly++) {
          const wy = baseY + ly;

          let id = 0;

          if (wy <= 0) id = this.BEDROCK_ID;
          else if (wy < h - 4) id = this.STONE_ID;
          else if (wy < h - 1) id = this.DIRT_ID;
          else if (wy === h - 1) {
            if (snowBand) id = this.SNOW_ID;
            else if (sandBand) id = this.SAND_ID;
            else id = this.GRASS_ID;
          }

          out[idx3(lx, ly, lz, CS)] = id;
        }
      }
    }

    // Stamp tower
    this.stampTowerIntoChunk(out, cx, cy, cz, CS);

    return out;
  }

  private getBlockAt(wx: number, wy: number, wz: number) {
    const CS = this.CS;
    const cx = floorDiv(wx, CS);
    const cy = floorDiv(wy, CS);
    const cz = floorDiv(wz, CS);

    const chunk = this.getOrCreateChunk(cx, cy, cz, CS);

    const lx = mod(wx, CS);
    const ly = mod(wy, CS);
    const lz = mod(wz, CS);

    return chunk[idx3(lx, ly, lz, CS)] | 0;
  }

  private setBlockAt(wx: number, wy: number, wz: number, id: number) {
    const CS = this.CS;
    const cx = floorDiv(wx, CS);
    const cy = floorDiv(wy, CS);
    const cz = floorDiv(wz, CS);

    const chunk = this.getOrCreateChunk(cx, cy, cz, CS);

    const lx = mod(wx, CS);
    const ly = mod(wy, CS);
    const lz = mod(wz, CS);

    chunk[idx3(lx, ly, lz, CS)] = id & 0xff;
  }

  /* ===============================
     Place / Mine
  ================================ */
  private handlePlaceBlock(client: Client, msg: any) {
    const x = Number(msg?.x);
    const y = Number(msg?.y);
    const z = Number(msg?.z);
    const id = Number(msg?.id);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(id)
    )
      return;

    if (this.isInSafeZoneXZ(x, z)) return;
    if (y < this.WORLD_MIN_Y || y >= this.WORLD_MAX_Y) return;

    const existing = this.getBlockAt(x, y, z);
    if (existing === this.BEDROCK_ID) return;

    this.setBlockAt(x, y, z, id | 0);
    this.broadcast("blockUpdate", { x, y, z, id: id | 0 });
  }

  private handleStartMine(client: Client, msg: any) {
    const x = Number(msg?.x);
    const y = Number(msg?.y);
    const z = Number(msg?.z);
    const heldSlot = Number(msg?.heldSlot ?? -1);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return;

    if (this.isInSafeZoneXZ(x, z)) {
      this.cancelMiningFor(client.sessionId, "safe_zone");
      return;
    }

    const blockId = this.getBlockAt(x, y, z);
    if (blockId <= 0) {
      this.cancelMiningFor(client.sessionId, "air");
      return;
    }
    if (blockId === this.BEDROCK_ID) {
      this.cancelMiningFor(client.sessionId, "bedrock");
      return;
    }

    const inv = this.ensureInv(client.sessionId);
    const breakTimeMs = this.computeBreakTimeMs(blockId, inv, heldSlot);

    const existing = this.mining.get(client.sessionId);
    if (existing && existing.x === x && existing.y === y && existing.z === z) {
      existing.heldSlot = heldSlot;
      return;
    }

    this.mining.set(client.sessionId, {
      x,
      y,
      z,
      blockId,
      startedAt: nowMs(),
      breakTimeMs,
      lastProgressSentAt: 0,
      heldSlot,
    });

    client.send("mineProgress", { x, y, z, progress: 0, stage: 0 });
  }

  private tickMining() {
    const now = nowMs();

    for (const [sid, ms] of this.mining.entries()) {
      const client = this.clients.find((c) => c.sessionId === sid);
      if (!client) {
        this.mining.delete(sid);
        continue;
      }

      const cur = this.getBlockAt(ms.x, ms.y, ms.z);
      if (cur !== ms.blockId) {
        this.cancelMiningFor(sid, "block_changed");
        continue;
      }

      const t = clamp(
        (now - ms.startedAt) / Math.max(1, ms.breakTimeMs),
        0,
        1
      );
      const stage = clamp(Math.floor(t * 10), 0, 9);

      const shouldSend = now - ms.lastProgressSentAt > 80 || t >= 1;
      if (shouldSend) {
        ms.lastProgressSentAt = now;
        client.send("mineProgress", {
          x: ms.x,
          y: ms.y,
          z: ms.z,
          progress: t,
          stage,
          done: t >= 1,
        });
      }

      if (t >= 1) {
        this.setBlockAt(ms.x, ms.y, ms.z, 0);
        this.broadcast("blockUpdate", { x: ms.x, y: ms.y, z: ms.z, id: 0 });

        this.spawnDropsForBlock(
          ms.blockId,
          ms.x,
          ms.y,
          ms.z,
          sid,
          ms.heldSlot
        );

        this.mining.delete(sid);
      }
    }
  }

  private cancelMiningFor(sessionId: string, reason = "cancel") {
    this.mining.delete(sessionId);
    const client = this.clients.find((c) => c.sessionId === sessionId);
    if (client) {
      client.send("mineCancelled", { reason });
    }
  }

  /* ===============================
     Drops + pickup
  ================================ */
  private nextDropId() {
    return `d_${Date.now().toString(16)}_${Math.random()
      .toString(16)
      .slice(2, 10)}`;
  }

  private spawnDrop(itemId: number, count: number, x: number, y: number, z: number) {
    const dropId = this.nextDropId();
    const d: Drop = {
      dropId,
      itemId,
      count,
      x: x + 0.5,
      y: y + 0.2,
      z: z + 0.5,
      createdAt: nowMs(),
    };
    this.drops.set(dropId, d);
    this.broadcast("dropSpawn", d);
  }

  private tickDropCleanup() {
    const now = nowMs();
    const TTL = 3 * 60 * 1000;
    for (const [id, d] of this.drops.entries()) {
      if (now - d.createdAt > TTL) {
        this.drops.delete(id);
        this.broadcast("dropDespawn", { dropId: id });
      }
    }
  }

  private handlePickupDrop(client: Client, msg: any) {
    const id = typeof msg?.dropId === "string" ? msg.dropId : "";
    if (!id) return;

    const d = this.drops.get(id);
    if (!d) return;

    const p = this.players.get(client.sessionId);
    if (!p) return;

    const dx = d.x - p.x;
    const dy = d.y - p.y;
    const dz = d.z - p.z;
    if (dx * dx + dy * dy + dz * dz > 2.6 * 2.6) return;

    const inv = this.ensureInv(client.sessionId);
    const added = this.inventoryAdd(inv, { id: d.itemId, count: d.count });
    if (!added) return;

    this.drops.delete(id);
    this.broadcast("dropDespawn", { dropId: id });
    this.sendInvState(client, inv);
  }

  private spawnDropsForBlock(
    blockId: number,
    x: number,
    y: number,
    z: number,
    sessionId: string,
    heldSlot: number
  ) {
    const inv = this.ensureInv(sessionId);

    const canDrop = this.canBlockDropWithTool(blockId, inv, heldSlot);
    if (!canDrop) return;

    if (blockId === this.GRASS_ID) this.spawnDrop(this.Items.DIRT, 1, x, y, z);
    else if (blockId === this.DIRT_ID) this.spawnDrop(this.Items.DIRT, 1, x, y, z);
    else if (blockId === this.STONE_ID) this.spawnDrop(this.Items.STONE, 1, x, y, z);
    else if (blockId === this.WOOD_ID) this.spawnDrop(this.Items.WOOD_LOG, 1, x, y, z);
    else if (blockId === this.LEAVES_ID) this.spawnDrop(this.Items.LEAVES, 1, x, y, z);
    else if (blockId === this.COAL_ORE_ID) this.spawnDrop(this.Items.COAL, 1, x, y, z);
    else if (blockId === this.IRON_ORE_ID) this.spawnDrop(this.Items.RAW_IRON, 1, x, y, z);
    else if (blockId === this.GOLD_ORE_ID) this.spawnDrop(this.Items.RAW_GOLD, 1, x, y, z);
    else if (blockId === this.DIAMOND_ORE_ID) this.spawnDrop(this.Items.DIAMOND, 1, x, y, z);
  }

  /* ===============================
     Inventory
  ================================ */
  private invByPlayer = new Map<string, InvState>();

  private ensureInv(sessionId: string): InvState {
    const existing = this.invByPlayer.get(sessionId);
    if (existing) return existing;

    const inv: InvState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })),
      cursor: { id: 0, count: 0 },
    };

    inv.slots[0] = { id: this.Items.WOOD_LOG, count: 16 };
    inv.slots[1] = { id: this.Items.STONE, count: 16 };
    inv.slots[2] = { id: this.Items.WOOD_PICK, count: 1, dur: 80 };

    this.invByPlayer.set(sessionId, inv);
    return inv;
  }

  private sendInvState(client: Client, inv: InvState) {
    client.send("invState", {
      slots: inv.slots.map((s) => ({
        id: s.id | 0,
        count: s.count | 0,
        dur: s.dur ?? 0,
      })),
      cursor: {
        id: inv.cursor.id | 0,
        count: inv.cursor.count | 0,
        dur: inv.cursor.dur ?? 0,
      },
    });
  }

  private maxStackFor(itemId: number) {
    if (itemId >= 100 && itemId < 200) return 1; // tools
    return 99;
  }

  private stackIsEmpty(s: ItemStack) {
    return !s || s.id <= 0 || s.count <= 0;
  }

  private cloneStack(s: ItemStack): ItemStack {
    return { id: s.id | 0, count: s.count | 0, dur: s.dur };
  }

  private inventoryCountSlots(inv: InvState, itemId: number) {
    let n = 0;
    for (const s of inv.slots) if (s.id === itemId && s.count > 0) n += s.count;
    return n;
  }

  private inventoryCanFit(inv: InvState, add: ItemStack) {
    if (this.stackIsEmpty(add)) return true;
    const max = this.maxStackFor(add.id);

    let left = add.count;

    for (const s of inv.slots) {
      if (left <= 0) break;
      if (this.stackIsEmpty(s)) {
        left -= Math.min(left, max);
      } else if (s.id === add.id && this.maxStackFor(s.id) > 1) {
        const space = max - s.count;
        if (space > 0) left -= Math.min(space, left);
      }
    }

    return left <= 0;
  }

  private inventoryAdd(inv: InvState, add: ItemStack) {
    if (this.stackIsEmpty(add)) return true;
    if (!this.inventoryCanFit(inv, add)) return false;

    const max = this.maxStackFor(add.id);
    let left = add.count;

    // fill existing stacks first
    for (const s of inv.slots) {
      if (left <= 0) break;
      if (s.id === add.id && this.maxStackFor(s.id) > 1) {
        const space = max - s.count;
        if (space > 0) {
          const put = Math.min(space, left);
          s.count += put;
          left -= put;
        }
      }
    }

    // then fill empty
    for (const s of inv.slots) {
      if (left <= 0) break;
      if (this.stackIsEmpty(s)) {
        const put = Math.min(max, left);
        s.id = add.id;
        s.count = put;
        if (add.dur && add.dur > 0) s.dur = add.dur;
        else delete (s as any).dur;
        left -= put;
      }
    }

    return left <= 0;
  }

  private inventoryRemoveSlots(inv: InvState, reqs: { id: number; count: number }[]) {
    for (const r of reqs) {
      if (this.inventoryCountSlots(inv, r.id) < r.count) return false;
    }

    for (const r of reqs) {
      let left = r.count;
      for (const s of inv.slots) {
        if (left <= 0) break;
        if (s.id !== r.id || s.count <= 0) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) {
          s.id = 0;
          s.count = 0;
          delete (s as any).dur;
        }
      }
    }

    return true;
  }

  private applyInvClick(client: Client, msg: any) {
    const inv = this.ensureInv(client.sessionId);

    const slot = Number(msg?.slot);
    const button = msg?.button === "R" ? "R" : "L";
    const shift = !!msg?.shift;

    if (!Number.isFinite(slot) || slot < 0 || slot >= inv.slots.length) return;

    const cursor = inv.cursor;
    const target = inv.slots[slot];

    const max = (id: number) => this.maxStackFor(id);

    const pickAll = () => {
      inv.cursor = this.cloneStack(target);
      target.id = 0;
      target.count = 0;
      delete (target as any).dur;
    };

    const placeAll = () => {
      inv.slots[slot] = this.cloneStack(cursor);
      inv.cursor = { id: 0, count: 0 };
    };

    const swap = () => {
      const t = this.cloneStack(target);
      inv.slots[slot] = this.cloneStack(cursor);
      inv.cursor = t;
    };

    const mergeFromCursor = (amount: number) => {
      if (this.stackIsEmpty(cursor)) return;

      if (this.stackIsEmpty(target)) {
        const put = Math.min(amount, cursor.count);
        target.id = cursor.id;
        target.count = put;
        if (cursor.dur && cursor.dur > 0) target.dur = cursor.dur;
        cursor.count -= put;
        if (cursor.count <= 0) inv.cursor = { id: 0, count: 0 };
        return;
      }

      if (target.id !== cursor.id) return;
      if (max(target.id) <= 1) return;

      const space = max(target.id) - target.count;
      const put = Math.min(space, amount, cursor.count);
      if (put <= 0) return;

      target.count += put;
      cursor.count -= put;
      if (cursor.count <= 0) inv.cursor = { id: 0, count: 0 };
    };

    const splitHalfToCursor = () => {
      if (!this.stackIsEmpty(cursor)) return;
      if (this.stackIsEmpty(target)) return;
      const half = Math.ceil(target.count / 2);
      inv.cursor = { id: target.id, count: half, dur: target.dur };
      target.count -= half;
      if (target.count <= 0) {
        target.id = 0;
        target.count = 0;
        delete (target as any).dur;
      }
    };

    const quickMove = () => {
      if (this.stackIsEmpty(target)) return;

      const fromHotbar = slot < this.HOTBAR_SLOTS;
      const [start, end] = fromHotbar
        ? [this.HOTBAR_SLOTS, inv.slots.length]
        : [0, this.HOTBAR_SLOTS];

      const moving = this.cloneStack(target);
      if (this.tryAddIntoRange(inv, moving, start, end)) {
        target.id = 0;
        target.count = 0;
        delete (target as any).dur;
      }
    };

    if (shift && button === "L") {
      quickMove();
      this.sendInvState(client, inv);
      return;
    }

    if (button === "L") {
      if (this.stackIsEmpty(cursor) && !this.stackIsEmpty(target)) pickAll();
      else if (!this.stackIsEmpty(cursor) && this.stackIsEmpty(target)) placeAll();
      else if (!this.stackIsEmpty(cursor) && !this.stackIsEmpty(target)) {
        if (cursor.id === target.id && max(cursor.id) > 1) mergeFromCursor(cursor.count);
        else swap();
      }
    } else {
      if (this.stackIsEmpty(cursor) && !this.stackIsEmpty(target)) splitHalfToCursor();
      else if (!this.stackIsEmpty(cursor)) {
        if (this.stackIsEmpty(target)) mergeFromCursor(1);
        else if (target.id === cursor.id && max(target.id) > 1) mergeFromCursor(1);
        else swap();
      }
    }

    this.sendInvState(client, inv);
  }

  private tryAddIntoRange(inv: InvState, stack: ItemStack, start: number, end: number) {
    if (this.stackIsEmpty(stack)) return true;

    const max = this.maxStackFor(stack.id);

    if (max > 1) {
      for (let i = start; i < end; i++) {
        const s = inv.slots[i];
        if (s.id === stack.id && s.count > 0) {
          const space = max - s.count;
          if (space <= 0) continue;
          const put = Math.min(space, stack.count);
          s.count += put;
          stack.count -= put;
          if (stack.count <= 0) return true;
        }
      }
    }

    for (let i = start; i < end; i++) {
      const s = inv.slots[i];
      if (this.stackIsEmpty(s)) {
        const put = Math.min(max, stack.count);
        s.id = stack.id;
        s.count = put;
        if (stack.dur && stack.dur > 0) s.dur = stack.dur;
        stack.count -= put;
        if (stack.count <= 0) return true;
      }
    }

    return false;
  }

  /* ===============================
     Crafting
  ================================ */
  private handleCraft(client: Client, msg: any) {
    const recipeId = typeof msg?.recipeId === "string" ? msg.recipeId : "";
    const craftMax = !!msg?.max;
    const times = Number(msg?.times ?? 1);

    const recipe = this.RECIPES.find((r) => r.id === recipeId);
    if (!recipe) {
      client.send("craftResult", { ok: false, recipeId, crafted: 0, reason: "no_recipe" });
      return;
    }

    const inv = this.ensureInv(client.sessionId);

    const doOnce = () => {
      if (!this.inventoryRemoveSlots(inv, recipe.inputs)) return false;
      if (!this.inventoryAdd(inv, { id: recipe.output.id, count: recipe.output.count })) return false;
      return true;
    };

    let crafted = 0;

    if (craftMax) {
      for (let i = 0; i < 999; i++) {
        if (!doOnce()) break;
        crafted += recipe.output.count;
      }
    } else {
      const n = Number.isFinite(times) ? clamp(times | 0, 1, 99) : 1;
      for (let i = 0; i < n; i++) {
        if (!doOnce()) break;
        crafted += recipe.output.count;
      }
    }

    client.send("craftResult", {
      ok: crafted > 0,
      recipeId,
      crafted,
      reason: crafted > 0 ? "" : "missing_items_or_space",
    });

    this.sendInvState(client, inv);
  }

  /* ===============================
     Tools & mining speed
  ================================ */
  private getToolDef(itemId: number): { kind: "pick"; tier: number; speedMul: number } | null {
    if (itemId === this.Items.WOOD_PICK) return { kind: "pick", tier: 1, speedMul: 1.0 };
    if (itemId === this.Items.STONE_PICK) return { kind: "pick", tier: 2, speedMul: 0.82 };
    if (itemId === this.Items.IRON_PICK) return { kind: "pick", tier: 3, speedMul: 0.68 };
    if (itemId === this.Items.GOLD_PICK) return { kind: "pick", tier: 3, speedMul: 0.55 };
    if (itemId === this.Items.DIAMOND_PICK) return { kind: "pick", tier: 4, speedMul: 0.5 };
    return null;
  }

  private isStoneLike(blockId: number) {
    return (
      blockId === this.STONE_ID ||
      blockId === this.COAL_ORE_ID ||
      blockId === this.IRON_ORE_ID ||
      blockId === this.GOLD_ORE_ID ||
      blockId === this.DIAMOND_ORE_ID
    );
  }

  private choosePickStack(inv: InvState, heldSlot = -1) {
    const slots = inv.slots;

    if (heldSlot >= 0 && heldSlot < slots.length) {
      const s = slots[heldSlot];
      const tool = this.getToolDef(s.id);
      if (tool && tool.kind === "pick") return { slotIndex: heldSlot, stack: s, tool };
    }

    let best: any = null;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || s.id <= 0 || s.count <= 0) continue;
      const tool = this.getToolDef(s.id);
      if (!tool) continue;
      if (!best || tool.tier > best.tool.tier) best = { slotIndex: i, stack: s, tool };
    }
    return best;
  }

  private requiredPickTierForDrops(blockId: number) {
    if (blockId === this.STONE_ID) return 1;
    if (blockId === this.COAL_ORE_ID) return 1;
    if (blockId === this.IRON_ORE_ID) return 1;
    if (blockId === this.GOLD_ORE_ID) return 3;
    if (blockId === this.DIAMOND_ORE_ID) return 3;
    return 0;
  }

  private canBlockDropWithTool(blockId: number, inv: InvState | null, heldSlot = -1) {
    if (blockId === this.BEDROCK_ID) return false;
    const reqTier = this.requiredPickTierForDrops(blockId);
    if (reqTier <= 0) return true;
    if (!inv) return false;
    const picked = this.choosePickStack(inv, heldSlot);
    if (!picked) return false;
    return picked.tool.tier >= reqTier;
  }

  private computeBreakTimeMs(blockId: number, inv: InvState, heldSlot = -1) {
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

  /* ===============================
     Tower schematic
  ================================ */
  private async loadTowerSchematicSafe() {
    try {
      await this.loadTowerSchematic();
    } catch (e) {
      console.error("[TOWER] load failed", e);
      this.towerSchem = null;
      this.towerLoaded = false;
    }
  }

  private async loadTowerSchematic() {
    const p = this.towerSchemPath;

    if (!p) throw new Error("towerSchemPath is empty");
    if (!fs.existsSync(p)) {
      console.error("[TOWER] file not found", p);
      throw new Error(`Tower schematic not found: ${p}`);
    }

    const buf = fs.readFileSync(p);
    const schem = await (Schematic as any).read(buf);

    this.towerSchem = schem;
    this.towerLoaded = true;

    const sx = Number(schem?.size?.x ?? 0);
    const sy = Number(schem?.size?.y ?? 0);
    const sz = Number(schem?.size?.z ?? 0);

    this.towerSize = { x: sx | 0, y: sy | 0, z: sz | 0 };

    // Debug sample of names
    const names = new Map<string, number>();
    const sampleStep = Math.max(1, Math.floor((sx * sy * sz) / 15000));
    let c = 0;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          c++;
          if (c % sampleStep !== 0) continue;
          const b = schem.getBlock(new Vec3(x, y, z));
          const name = (b?.name as string) ?? "minecraft:air";
          names.set(name, (names.get(name) ?? 0) + 1);
        }
      }
    }

    this.towerUniqueNames = Array.from(names.keys()).slice(0, 80);

    console.log("[TOWER] loaded", {
      path: p,
      size: this.towerSize,
      origin: this.towerOrigin,
      uniqueNamesSample: this.towerUniqueNames.slice(0, 20),
    });
  }

  private blockMapFromName(name: string) {
    const n = name.startsWith("minecraft:") ? name : `minecraft:${name}`;

    switch (n) {
      case "minecraft:air":
      case "minecraft:cave_air":
      case "minecraft:void_air":
        return 0;

      case "minecraft:grass_block":
      case "minecraft:grass":
        return this.GRASS_ID;

      case "minecraft:dirt":
      case "minecraft:coarse_dirt":
        return this.DIRT_ID;

      case "minecraft:stone":
      case "minecraft:cobblestone":
      case "minecraft:andesite":
      case "minecraft:diorite":
      case "minecraft:granite":
        return this.STONE_ID;

      case "minecraft:oak_log":
      case "minecraft:spruce_log":
      case "minecraft:birch_log":
      case "minecraft:jungle_log":
      case "minecraft:acacia_log":
      case "minecraft:dark_oak_log":
      case "minecraft:oak_planks":
      case "minecraft:spruce_planks":
      case "minecraft:birch_planks":
      case "minecraft:jungle_planks":
      case "minecraft:acacia_planks":
      case "minecraft:dark_oak_planks":
      case "minecraft:oak_wood":
        return this.WOOD_ID;

      case "minecraft:oak_leaves":
      case "minecraft:spruce_leaves":
      case "minecraft:birch_leaves":
      case "minecraft:jungle_leaves":
      case "minecraft:acacia_leaves":
      case "minecraft:dark_oak_leaves":
        return this.LEAVES_ID;

      case "minecraft:bedrock":
        return this.BEDROCK_ID;

      case "minecraft:coal_ore":
      case "minecraft:deepslate_coal_ore":
        return this.COAL_ORE_ID;

      case "minecraft:iron_ore":
      case "minecraft:deepslate_iron_ore":
        return this.IRON_ORE_ID;

      case "minecraft:gold_ore":
      case "minecraft:deepslate_gold_ore":
        return this.GOLD_ORE_ID;

      case "minecraft:diamond_ore":
      case "minecraft:deepslate_diamond_ore":
        return this.DIAMOND_ORE_ID;

      case "minecraft:sand":
      case "minecraft:red_sand":
        return this.SAND_ID;

      case "minecraft:snow":
      case "minecraft:snow_block":
        return this.SNOW_ID;

      default:
        return 0;
    }
  }

  private stampTowerIntoChunk(chunk: Uint8Array, cx: number, cy: number, cz: number, CS: number) {
    if (!this.towerLoaded || !this.towerSchem) return;

    const ox = this.towerOrigin.x;
    const oy = this.towerOrigin.y;
    const oz = this.towerOrigin.z;

    const sx = this.towerSize.x;
    const sy = this.towerSize.y;
    const sz = this.towerSize.z;

    if (sx <= 0 || sy <= 0 || sz <= 0) return;

    const chunkMinX = cx * CS;
    const chunkMinY = cy * CS;
    const chunkMinZ = cz * CS;

    const chunkMaxX = chunkMinX + CS;
    const chunkMaxY = chunkMinY + CS;
    const chunkMaxZ = chunkMinZ + CS;

    const towerMinX = ox;
    const towerMinY = oy;
    const towerMinZ = oz;

    const towerMaxX = ox + sx;
    const towerMaxY = oy + sy;
    const towerMaxZ = oz + sz;

    const ix0 = Math.max(chunkMinX, towerMinX);
    const iy0 = Math.max(chunkMinY, towerMinY);
    const iz0 = Math.max(chunkMinZ, towerMinZ);

    const ix1 = Math.min(chunkMaxX, towerMaxX);
    const iy1 = Math.min(chunkMaxY, towerMaxY);
    const iz1 = Math.min(chunkMaxZ, towerMaxZ);

    if (ix1 <= ix0 || iy1 <= iy0 || iz1 <= iz0) return;

    let wrote = 0;
    let unmapped = 0;

    for (let wx = ix0; wx < ix1; wx++) {
      for (let wy = iy0; wy < iy1; wy++) {
        for (let wz = iz0; wz < iz1; wz++) {
          const sxp = wx - ox;
          const syp = wy - oy;
          const szp = wz - oz;

          // CRITICAL: Vec3 so prismarine-schematic can do pos.minus()
          const b = this.towerSchem.getBlock(new Vec3(sxp, syp, szp));
          const name = (b?.name as string) ?? "minecraft:air";
          const bid = this.blockMapFromName(name);

          if (bid === 0) {
            if (name !== "minecraft:air" && name !== "air") unmapped++;
            continue;
          }

          const lx = wx - chunkMinX;
          const ly = wy - chunkMinY;
          const lz = wz - chunkMinZ;

          chunk[idx3(lx, ly, lz, CS)] = bid & 0xff;
          wrote++;
        }
      }
    }

    if (wrote > 0 && Math.random() < 0.02) {
      console.log("[TOWER] stamped chunk", {
        cx,
        cy,
        cz,
        wrote,
        unmapped,
        origin: this.towerOrigin,
        size: this.towerSize,
      });
      if (unmapped > 0) {
        console.log("[TOWER] schematic block-name sample", this.towerUniqueNames.slice(0, 30));
      }
    }
  }
}
