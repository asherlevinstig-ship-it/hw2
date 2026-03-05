// server/src/rooms/EventArenaRoom.ts
// FULL FILE - No Omits, All Logic

import { BaseEventRoom } from "./BaseEventRoom.js";
import { Client } from "colyseus";

export class EventArenaRoom extends BaseEventRoom {
  // 60 seconds for testing
  protected durationMs = 60_000; 

  // Offset the arena 10,000 blocks away so it never overlaps with the Hub terrain
  private ARENA_OFFSET = 10000;

  protected setupEvent() {
    console.log("[Arena] Setting up flat platform...");
    
    this.onMessage("attack", (client: Client, message: any) => {
        // Handle arena combat
    });

    this.onMessage("worldDataNeeded", (client: Client, data: any) => {
        const { id, chunkSize, x, y, z } = data;
        const expectedLen = chunkSize * chunkSize * chunkSize;
        const chunkData = new Uint16Array(expectedLen);
        
        let i = 0;
        for (let lz = 0; lz < chunkSize; lz++) {
            for (let ly = 0; ly < chunkSize; ly++) {
                for (let lx = 0; lx < chunkSize; lx++) {
                    const globalX = x + lx;
                    const globalY = y + ly;
                    const globalZ = z + lz;
                    
                    // Generate a 128x128 Stone platform centered perfectly on the Offset at Y=8
                    if (globalY === 8 && 
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
    // End early if only 1 person is left standing (Increased grace period to 15s so you can look around!)
    if (this.clients.length <= 1 && Date.now() - this.startedAt > 15000) {
      return { done: true, reason: "last_man_standing" };
    }
    return { done: false };
  }

  onJoin(client: Client, options: any) {
    console.log(`[Arena] Player ${client.sessionId} joined the bloodbath.`);
    
    client.send("safeZone", { cx: this.ARENA_OFFSET, cz: this.ARENA_OFFSET, r: 0, name: "The Arena" }); 
    client.send("worldTime", { time: 0.5 }); // High noon visibility
    client.send("statsUpdate", { hp: 20, maxHp: 20, mana: 50, maxMana: 50 });
    
    // Spawn them exactly in the middle of the new offset platform
    client.send("youJoined", { x: this.ARENA_OFFSET, y: 10, z: this.ARENA_OFFSET });

    client.send("eventStart", { 
        mode: "arena", 
        rules: "Survive the arena! Last player standing wins."
    });
  }
}