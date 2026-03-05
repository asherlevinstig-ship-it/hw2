// server/src/rooms/EventArenaRoom.ts
// FULL FILE - No Omits, All Logic

import { BaseEventRoom } from "./BaseEventRoom.js";
import { Client } from "colyseus";

export class EventArenaRoom extends BaseEventRoom {
  // 30 seconds for quick testing
  protected durationMs = 30_000; 

  protected setupEvent() {
    console.log("[Arena] Setting up flat platform...");
    
    this.onMessage("attack", (client: Client, message: any) => {
        // Handle arena combat
    });

    // The Arena MUST serve chunks, or the client will fall into the void!
    this.onMessage("worldDataNeeded", (client: Client, data: any) => {
        const { id, chunkSize, x, y, z } = data;
        const expectedLen = chunkSize * chunkSize * chunkSize;
        const chunkData = new Uint16Array(expectedLen);
        
        // Generate a 1-block thick stone platform at Y=8
        const cy = Math.floor(y / chunkSize);
        if (cy === 0) { 
            let i = 0;
            for (let lz = 0; lz < chunkSize; lz++) {
                for (let ly = 0; ly < chunkSize; ly++) {
                    for (let lx = 0; lx < chunkSize; lx++) {
                        const globalY = cy * chunkSize + ly;
                        // Stone platform from X/Z -64 to 64
                        const globalX = (data.x / chunkSize) * chunkSize + lx;
                        const globalZ = (data.z / chunkSize) * chunkSize + lz;
                        
                        if (globalY === 8 && globalX > -64 && globalX < 64 && globalZ > -64 && globalZ < 64) {
                            chunkData[i] = 3; // Stone ID
                        } else {
                            chunkData[i] = 0; // Air
                        }
                        i++;
                    }
                }
            }
        }
        
        client.send("chunkData", { id, chunkSize, voxels: chunkData.buffer });
    });
  }

  protected checkWinLose() {
    // End early if only 1 person is left standing (5s grace period)
    if (this.clients.length <= 1 && Date.now() - this.startedAt > 5000) {
      return { done: true, reason: "last_man_standing" };
    }
    return { done: false };
  }

  onJoin(client: Client, options: any) {
    console.log(`[Arena] Player ${client.sessionId} joined the bloodbath.`);
    
    // CRITICAL: We must feed the client the initialization packets it expects!
    client.send("safeZone", { cx: 0, cz: 0, r: 0, name: "The Arena" }); // No safe zones in the arena
    client.send("worldTime", { time: 0.5 }); // High noon visibility
    client.send("statsUpdate", { hp: 20, maxHp: 20, mana: 50, maxMana: 50 });
    
    // Spawn them slightly above the stone platform
    client.send("youJoined", { x: 0, y: 10, z: 0 });

    client.send("eventStart", { 
        mode: "arena", 
        rules: "Survive the arena! Last player standing wins.", 
        timer: this.durationMs 
    });
  }
}