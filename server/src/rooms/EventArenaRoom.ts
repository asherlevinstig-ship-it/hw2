// server/src/rooms/EventArenaRoom.ts
// FULL FILE - No Omits, All Logic

import { BaseEventRoom } from "./BaseEventRoom.js";
import { Client } from "colyseus";

type ArenaPlayer = { 
    id: string, 
    x: number, 
    y: number, 
    z: number, 
    yaw: number, 
    hp: number, 
    maxHp: number 
};

export class EventArenaRoom extends BaseEventRoom {
  // 60 seconds for testing
  protected durationMs = 60_000; 

  // Offset the arena 10,000 blocks away so it never overlaps with the Hub terrain
  private ARENA_OFFSET = 10000;
  
  // Track players specifically for the Arena so we can send snapshots
  private arenaPlayers = new Map<string, ArenaPlayer>();

  protected setupEvent() {
    console.log("[Arena] Setting up flat platform...");
    
    // Broadcast snapshots so clients can see each other and the HUD unfreezes!
    this.clock.setInterval(() => {
        const snapshot: any[] = [];
        this.arenaPlayers.forEach(p => snapshot.push(p));
        this.broadcast("playersSnapshot", snapshot);
    }, 50);

    this.onMessage("attack", (client: Client, message: any) => {
        // Handle arena combat
    });

    this.onMessage("playerMove", (client: Client, data: any) => {
        const p = this.arenaPlayers.get(client.sessionId);
        if (p) {
            p.x = data.x; 
            p.y = data.y; 
            p.z = data.z; 
            p.yaw = data.yaw;
        }
    });

    this.onMessage("worldDataNeeded", (client: Client, data: any) => {
        const { id, chunkSize, x, y, z } = data;
        const expectedLen = chunkSize * chunkSize * chunkSize;
        
        const chunkData = new Uint8Array(expectedLen);
        
        let i = 0;
        for (let lz = 0; lz < chunkSize; lz++) {
            for (let ly = 0; ly < chunkSize; ly++) {
                for (let lx = 0; lx < chunkSize; lx++) {
                    const globalX = x + lx;
                    const globalY = y + ly;
                    const globalZ = z + lz;
                    
                    // Generate a 128x128 Stone platform centered perfectly on the Offset at Y=30
                    if (globalY === 30 && 
                        globalX >= this.ARENA_OFFSET - 64 && globalX <= this.ARENA_OFFSET + 64 && 
                        globalZ >= this.ARENA_OFFSET - 64 && globalZ <= this.ARENA_OFFSET + 64) {
                        chunkData[i] = 3; // Stone ID
                    } else {
                        chunkData[i] = 0; // Air
                    }
                    i++;
                }
            }
        }
        
        client.send("chunkData", { id, chunkSize, voxels: chunkData.buffer });
    });
  }

  protected checkWinLose() {
    // End early if only 1 person is left standing (15s grace period so you can look around!)
    if (this.clients.length <= 1 && Date.now() - this.startedAt > 15000) {
      return { done: true, reason: "last_man_standing" };
    }
    return { done: false };
  }

  onJoin(client: Client, options: any) {
    console.log(`[Arena] Player ${client.sessionId} joined the bloodbath.`);
    
    const spawnX = this.ARENA_OFFSET;
    const spawnY = 40; 
    const spawnZ = this.ARENA_OFFSET;

    this.arenaPlayers.set(client.sessionId, {
        id: client.sessionId, x: spawnX, y: spawnY, z: spawnZ, yaw: 0, hp: 20, maxHp: 20
    });

    client.send("safeZone", { cx: spawnX, cz: spawnZ, r: 0, name: "The Arena" }); 
    client.send("worldTime", { time: 0.5 });
    client.send("statsUpdate", { hp: 20, maxHp: 20, mana: 50, maxMana: 50 });
    client.send("youJoined", { x: spawnX, y: spawnY, z: spawnZ });

    const remaining = Math.max(0, this.durationMs - (Date.now() - this.startedAt));

    client.send("eventStart", { 
        mode: "arena", 
        rules: "Survive the arena! Last player standing wins.", 
        timer: remaining 
    });
  }

  async onLeave(client: Client, code?: number) {
    if (this.isEventOver) return;

    const consented = (code === 1000);
    const playerState = this.arenaPlayers.get(client.sessionId);
    
    this.arenaPlayers.delete(client.sessionId);
    this.broadcast("playerLeft", { id: client.sessionId });

    if (!consented) {
        try {
            const reconnectedClient = await this.allowReconnection(client, 30);
            console.log(`[Arena] Player ${reconnectedClient.sessionId} reconnected!`);
            
            if (playerState) {
                this.arenaPlayers.set(reconnectedClient.sessionId, playerState);
            }
            
            // FIX: Delay sending state so the client has time to attach 'onMessage' handlers!
            setTimeout(() => {
                const remaining = Math.max(0, this.durationMs - (Date.now() - this.startedAt));
                reconnectedClient.send("safeZone", { cx: this.ARENA_OFFSET, cz: this.ARENA_OFFSET, r: 0, name: "The Arena" }); 
                reconnectedClient.send("worldTime", { time: 0.5 });
                reconnectedClient.send("statsUpdate", { hp: playerState?.hp || 20, maxHp: 20, mana: 50, maxMana: 50 });
                reconnectedClient.send("eventStart", { 
                    mode: "arena", 
                    rules: "Survive the arena! Last player standing wins.", 
                    timer: remaining 
                });
                reconnectedClient.send("youJoined", { 
                    x: playerState?.x || this.ARENA_OFFSET, 
                    y: playerState?.y || 40, 
                    z: playerState?.z || this.ARENA_OFFSET 
                });
            }, 500);

        } catch (e) {
            console.log(`[Arena] Player ${client.sessionId} failed to reconnect in time.`);
        }
    }
  }
}