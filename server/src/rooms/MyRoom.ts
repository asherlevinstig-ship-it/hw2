// server/src/rooms/MyRoom.ts
// FULL FILE - No Omits, All Logic

import { Room, Client, matchMaker } from "@colyseus/core";
import { Schema, MapSchema, type } from "@colyseus/schema";
import fs from "fs";
import path from "path";

// --- SCHEMAS ---
export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 40;
  @type("number") z: number = 0;
  @type("number") yaw: number = 0;
  @type("number") hp: number = 20;
  @type("number") maxHp: number = 20;
  @type("number") mana: number = 50;
  @type("number") maxMana: number = 50;
  @type("string") classId: string = "";
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

// --- CONSTANTS & TYPES ---
const CHUNK_SIZE = 32;
const HOTBAR_SLOTS = 5;
const BACKPACK_SLOTS = 20;
const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

type Drop = {
  dropId: string;
  itemId: number;
  count: number;
  x: number;
  y: number;
  z: number;
  createdAt: number;
};

type InventorySlot = { id: number; count: number; dur?: number };

class PlayerInventory {
  slots: InventorySlot[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
  cursor: InventorySlot = { id: 0, count: 0 };
}

const EVENT_ROOM_NAMES = [
  "event_arena"
] as const;

interface StructureDef {
  blocks: { x: number; y: number; z: number; id: number }[];
}

export class MyRoom extends Room<any> {
  state!: MyRoomState;

  private chunks = new Map<string, Uint16Array>();
  private drops = new Map<string, Drop>();
  private inventories = new Map<string, PlayerInventory>();
  private miningTasks = new Map<string, NodeJS.Timeout>();
  
  private worldTime: number = 0.26; 
  private worldTimeTick: NodeJS.Timeout | null = null;
  private eventTimer: NodeJS.Timeout | null = null;

  private townStructure: StructureDef | null = null;

  onCreate(options: any) {
    console.log("[MyRoom] Hub Room Created");
    this.maxClients = 50;
    this.setState(new MyRoomState());
    
    this.loadTownStructure();

    this.setSimulationInterval((dt) => this.onTick(dt), 50);

    this.startDayNightCycle();
    this.startEventScheduler(180_000); 

    // --- MOVEMENT & SYNC ---
    this.onMessage("playerMove", (client: Client, data: any) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.x = data.x;
        player.y = data.y;
        player.z = data.z;
        player.yaw = data.yaw;
      }
    });

    this.onMessage("selectClass", (client: Client, data: any) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.classId = data.classId;
        player.hp = player.maxHp;
        player.mana = player.maxMana;
        
        client.send("statsUpdate", { 
          hp: player.hp, maxHp: player.maxHp, 
          mana: player.mana, maxMana: player.maxMana 
        });
        
        client.send("chatMessage", { msg: `You have selected class: ${data.classId}` });
      }
    });

    // --- WORLD STREAMING ---
    this.onMessage("worldDataNeeded", (client: Client, data: any) => {
      const { id, chunkSize, x, y, z } = data;
      const expectedLen = chunkSize * chunkSize * chunkSize;
      
      let chunkData = this.chunks.get(id);
      if (!chunkData) {
        chunkData = new Uint16Array(expectedLen);
        this.generateChunk(chunkData, chunkSize, x, y, z);
        this.chunks.set(id, chunkData);
      }

      client.send("chunkData", {
        id,
        chunkSize,
        voxels: chunkData.buffer
      });
    });

    // --- COMBAT ---
    this.onMessage("attack", (client: Client, data: any) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker) return;

      this.broadcast("playerSwing", {
        id: client.sessionId,
        attackId: data.attackId,
        yaw: data.yaw,
        pitch: data.pitch
      }, { except: client });

      let hitSomeone = false;
      this.state.players.forEach((target: Player, targetId: string) => {
        if (targetId === client.sessionId) return;
        
        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const dz = target.z - attacker.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        if (dist < 4.0) { 
          target.hp -= 2; 
          hitSomeone = true;

          this.broadcast("playerHit", {
            targetId: targetId,
            attackerId: client.sessionId,
            hpLeft: target.hp,
            maxHp: target.maxHp
          });

          if (target.hp <= 0) {
            target.hp = target.maxHp;
            const targetClient = this.clients.find(c => c.sessionId === targetId);
            if (targetClient) {
               targetClient.send("playerRespawn", { id: targetId, hp: target.hp, maxHp: target.maxHp, x: 0, y: 40, z: 0 });
               this.broadcast("chatMessage", { msg: `Player ${targetId} was slain.` });
            }
          }
        }
      });

      client.send("attackResult", { ok: hitSomeone });
    });

    // --- MINING & PLACING ---
    this.onMessage("startMine", (client: Client, data: any) => {
      const { x, y, z, heldSlot } = data;
      
      if (this.isInSafeZone(x, z)) return;

      if (this.miningTasks.has(client.sessionId)) {
        clearTimeout(this.miningTasks.get(client.sessionId)!);
      }

      client.send("mineProgress", { x, y, z, progress: 0.5, stage: 1 });

      const task = setTimeout(() => {
         client.send("mineProgress", { x, y, z, progress: 1.0, stage: 3, done: true });
         this.broadcast("blockUpdate", { id: 0, x, y, z }); 

         const dropId = `drop_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
         const drop: Drop = {
            dropId,
            itemId: 14, 
            count: 1,
            x: x + 0.5,
            y: y + 0.5,
            z: z + 0.5,
            createdAt: Date.now()
         };
         this.drops.set(dropId, drop);
         this.broadcast("dropSpawn", drop);
         
         this.miningTasks.delete(client.sessionId);
      }, 500);

      this.miningTasks.set(client.sessionId, task);
    });

    this.onMessage("cancelMine", (client: Client, data: any) => {
      if (this.miningTasks.has(client.sessionId)) {
        clearTimeout(this.miningTasks.get(client.sessionId)!);
        this.miningTasks.delete(client.sessionId);
        client.send("mineCancelled", { reason: data.reason });
      }
    });

    this.onMessage("placeBlock", (client: Client, data: any) => {
      const { x, y, z, id, fromSlot } = data;
      if (this.isInSafeZone(x, z)) return;

      const inv = this.inventories.get(client.sessionId);
      if (inv && inv.slots[fromSlot] && inv.slots[fromSlot].count > 0 && inv.slots[fromSlot].id === id) {
        inv.slots[fromSlot].count--;
        if (inv.slots[fromSlot].count <= 0) inv.slots[fromSlot].id = 0;
        
        this.broadcast("blockUpdate", { id, x, y, z });
        this.syncInventory(client);
      }
    });

    // --- INVENTORY & DROPS ---
    this.onMessage("pickupDrop", (client: Client, data: any) => {
      const drop = this.drops.get(data.dropId);
      if (drop) {
        this.drops.delete(data.dropId);
        this.broadcast("dropDespawn", { dropId: data.dropId });

        const inv = this.inventories.get(client.sessionId);
        if (inv) {
          let placed = false;
          for (let i = 0; i < INV_SLOTS; i++) {
            if (inv.slots[i].id === drop.itemId || inv.slots[i].id === 0) {
               inv.slots[i].id = drop.itemId;
               inv.slots[i].count += drop.count;
               placed = true;
               break;
            }
          }
          this.syncInventory(client);
        }
      }
    });

    this.onMessage("invClick", (client: Client, data: any) => {
      const { area, index, button, shift } = data;
      const inv = this.inventories.get(client.sessionId);
      if (!inv) return;

      const actualIndex = area === "hotbar" ? index : index + HOTBAR_SLOTS;
      const slot = inv.slots[actualIndex];
      const cursor = inv.cursor;

      if (button === "L") {
         const tempId = slot.id;
         const tempCount = slot.count;
         slot.id = cursor.id;
         slot.count = cursor.count;
         cursor.id = tempId;
         cursor.count = tempCount;
      }
      this.syncInventory(client);
    });

    this.onMessage("craft", (client: Client, data: any) => {
      client.send("craftResult", { ok: false, recipeId: data.recipeId, reason: "Server crafting validation not linked yet" });
    });

    this.onMessage("devTpCave", (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
         player.y = 8; 
         client.send("playerRespawn", { id: client.sessionId, hp: player.hp, maxHp: player.maxHp, x: player.x, y: player.y, z: player.z });
      }
    });
  }

  onJoin(client: Client, options: any) {
    console.log(`[MyRoom] Player ${client.sessionId} joined.`);
    
    const player = new Player();
    player.x = 0;
    player.y = 40;
    player.z = 0;
    this.state.players.set(client.sessionId, player);

    this.inventories.set(client.sessionId, new PlayerInventory());

    const inv = this.inventories.get(client.sessionId)!;
    inv.slots[0] = { id: 3, count: 1 }; 
    inv.slots[1] = { id: 6, count: 1 }; 

    client.send("safeZone", { cx: 0, cz: 0, radius: 25, name: "Town of Beginnings" });
    client.send("worldTime", { time: this.worldTime });
    client.send("youJoined", { x: player.x, y: player.y, z: player.z });
    this.syncInventory(client);

    this.broadcast("playerJoined", {
      id: client.sessionId,
      x: player.x,
      y: player.y,
      z: player.z,
      hp: player.hp,
      maxHp: player.maxHp
    }, { except: client });

    const existing: any[] = [];
    this.state.players.forEach((p: Player, id: string) => {
      if (id !== client.sessionId) existing.push({ id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, maxHp: p.maxHp });
    });
    client.send("existingPlayers", existing);
    
    this.drops.forEach(drop => client.send("dropSpawn", drop));
  }

  onLeave(client: Client, code?: number) {
    console.log(`[MyRoom] Player ${client.sessionId} left.`);
    this.state.players.delete(client.sessionId);
    this.inventories.delete(client.sessionId);
    if (this.miningTasks.has(client.sessionId)) {
        clearTimeout(this.miningTasks.get(client.sessionId)!);
        this.miningTasks.delete(client.sessionId);
    }
    this.broadcast("playerLeft", { id: client.sessionId });
  }

  onDispose() {
    console.log("[MyRoom] Disposing Hub Room");
    if (this.worldTimeTick) clearInterval(this.worldTimeTick);
    if (this.eventTimer) clearInterval(this.eventTimer);
  }

  private onTick(dt: number) {
    const snapshot: any[] = [];
    this.state.players.forEach((p: Player, id: string) => {
      snapshot.push({ id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, maxHp: p.maxHp });
    });
    this.broadcast("playersSnapshot", snapshot);
  }

  private startDayNightCycle() {
    this.worldTimeTick = setInterval(() => {
       this.worldTime = (this.worldTime + (1 / 1200)) % 1; 
       this.broadcast("worldMeta", { worldTime: this.worldTime });
    }, 1000);
  }

  private startEventScheduler(intervalMs: number) {
    this.eventTimer = setInterval(async () => {
      if (this.clients.length === 0) return; 

      const randomEvent = EVENT_ROOM_NAMES[Math.floor(Math.random() * EVENT_ROOM_NAMES.length)];
      console.log(`[Hub] Spawning random event: ${randomEvent}`);
      
      this.broadcast("chatMessage", { msg: `Event starting! Teleporting to ${randomEvent} in 5 seconds...` });

      const nextEventAt = Date.now() + 5000;
      this.broadcast("nextEventTime", { time: nextEventAt });

      setTimeout(async () => {
          try {
            const eventRoom = await matchMaker.createRoom(randomEvent, {});

            for (const client of this.clients) {
              const player = this.state.players.get(client.sessionId);
              const reservation = await matchMaker.reserveSeatFor(eventRoom, {
                 userId: (client as any).userId,
                 classId: player?.classId
              });
              client.send("joinEvent", reservation);
            }
          } catch (e) {
            console.error("[Hub] Failed to create event room:", e);
          }
      }, 5000);
    }, intervalMs);
  }

  private syncInventory(client: Client) {
    const inv = this.inventories.get(client.sessionId);
    if (!inv) return;
    
    const player = this.state.players.get(client.sessionId);
    client.send("invState", {
      slots: inv.slots,
      cursor: inv.cursor,
      stats: player ? { hp: player.hp, maxHp: player.maxHp, mana: player.mana, maxMana: player.maxMana } : {}
    });
  }

  private isInSafeZone(x: number, z: number): boolean {
    const safeCx = 0;
    const safeCz = 0;
    const safeR = 25;
    const dx = x + 0.5 - safeCx;
    const dz = z + 0.5 - safeCz;
    return dx * dx + dz * dz <= safeR * safeR;
  }

  private loadTownStructure() {
    try {
      const townPath = path.resolve(process.cwd(), "town_of_beginnings.json");
      if (fs.existsSync(townPath)) {
        const raw = fs.readFileSync(townPath, "utf-8");
        this.townStructure = JSON.parse(raw);
        console.log(`[MyRoom] Loaded town_of_beginnings.json with ${this.townStructure?.blocks?.length || 0} blocks.`);
      } else {
        console.warn(`[MyRoom] Warning: town_of_beginnings.json not found at ${townPath}`);
      }
    } catch (e) {
      console.error("[MyRoom] Error parsing town_of_beginnings.json:", e);
    }
  }

  private generateChunk(data: Uint16Array, size: number, cx: number, cy: number, cz: number) {
    let i = 0;
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const globalX = cx * size + x;
          const globalY = cy * size + y;
          const globalZ = cz * size + z;

          const surfaceY = Math.floor(30 + Math.sin(globalX / 15) * 3 + Math.cos(globalZ / 15) * 3);

          if (globalY < surfaceY) {
             data[i] = 1; 
          } else if (globalY === surfaceY) {
             data[i] = 2; 
          } else {
             data[i] = 0; 
          }
          i++;
        }
      }
    }

    if (this.townStructure && this.townStructure.blocks) {
       for (const b of this.townStructure.blocks) {
         if (b.x >= cx * size && b.x < (cx + 1) * size &&
             b.y >= cy * size && b.y < (cy + 1) * size &&
             b.z >= cz * size && b.z < (cz + 1) * size) {
             
             const localX = b.x - cx * size;
             const localY = b.y - cy * size;
             const localZ = b.z - cz * size;
             
             const idx = localX + localY * size + localZ * size * size;
             if (idx >= 0 && idx < data.length) {
                 data[idx] = b.id;
             }
         }
       }
    }
  }
}