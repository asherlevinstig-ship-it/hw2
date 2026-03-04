// server/src/rooms/EventArenaRoom.ts
// FULL FILE - No Omits, All Logic

import { BaseEventRoom } from "./BaseEventRoom.js";
import { Client } from "@colyseus/core";

export class EventArenaRoom extends BaseEventRoom {
  // Let's make it 30 seconds for quick testing
  protected durationMs = 30_000; 

  protected setupEvent() {
    console.log("[Arena] Setting up flat platform...");
    // Future logic: Set up a flat non-chunk platform, spawn mobs, or setup PvP teams
    
    this.onMessage("attack", (client: Client, message: any) => {
        // Handle arena combat
    });
  }

  protected checkWinLose() {
    // Basic arena logic: Event ends early if only 1 person is left standing
    // (Adding a 5 second grace period so it doesn't end immediately while people load in)
    if (this.clients.length <= 1 && Date.now() - this.startedAt > 5000) {
      return { done: true, reason: "last_man_standing" };
    }
    
    return { done: false };
  }

  onJoin(client: Client, options: any) {
    console.log(`[Arena] Player ${client.sessionId} joined the bloodbath.`);
    client.send("eventStart", { 
        mode: "arena", 
        rules: "Survive the arena! Last player standing wins.", 
        timer: this.durationMs 
    });
  }
}