// server/src/rooms/BaseEventRoom.ts

import { Room } from "colyseus";

export abstract class BaseEventRoom extends Room<any> {
  protected durationMs = 60_000;
  protected startedAt = 0;
  protected hubRoomName = "my_room"; // Name of your main world room
  
  // NEW: Flag to prevent reconnections during shutdown
  public isEventOver = false; 

  protected abstract setupEvent(): void;
  protected abstract checkWinLose(): { done: boolean; reason?: string };

  onCreate(options: any) {
    console.log(`[Event] ${this.roomName} created!`);
    this.startedAt = Date.now();
    
    this.setupEvent();

    // Universal event logic tick
    this.setSimulationInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      const state = this.checkWinLose();

      if (state.done || elapsed >= this.durationMs) {
        this.endEvent(state.reason ?? (elapsed >= this.durationMs ? "timeout" : "complete"));
      }
    }, 100);

    // CRITICAL: Continuously sync the timer to all clients every 1 second to prevent UI desyncs
    this.clock.setInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      const remaining = Math.max(0, this.durationMs - elapsed);
      this.broadcast("syncEventTimer", { remainingMs: remaining });
    }, 1000);
  }

  protected endEvent(reason: string) {
    this.isEventOver = true; // Lockout new reconnections
    console.log(`[Event] ${this.roomName} ended. Reason: ${reason}`);
    
    // Announce the end to the players
    this.broadcast("eventEnd", { reason });

    // Tell clients to disconnect and join the Hub
    this.broadcast("returnToHub", { targetRoom: this.hubRoomName });

    // Give clients 2 seconds to gracefully process the returnToHub message before forcing them out
    this.clock.setTimeout(() => {
        this.disconnect();
    }, 2000);
  }
}