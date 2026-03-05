// server/src/rooms/BaseEventRoom.ts
// FULL FILE - No Omits, All Logic

import { Room } from "colyseus";

export abstract class BaseEventRoom extends Room<any> {
  protected durationMs = 60_000;
  protected startedAt = 0;
  protected hubRoomName = "my_room"; // Name of your main world room

  protected abstract setupEvent(): void;
  protected abstract checkWinLose(): { done: boolean; reason?: string };

  onCreate(options: any) {
    console.log(`[Event] ${this.roomName} created!`);
    this.startedAt = Date.now();
    
    this.setupEvent();

    // The universal event tick loop
    this.setSimulationInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      const state = this.checkWinLose();

      if (state.done || elapsed >= this.durationMs) {
        this.endEvent(state.reason ?? (elapsed >= this.durationMs ? "timeout" : "complete"));
      }
    }, 100);

    // CRITICAL FIX: Continuously sync the timer to all clients every 1 second
    this.clock.setInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      const remaining = Math.max(0, this.durationMs - elapsed);
      this.broadcast("syncEventTimer", { remainingMs: remaining });
    }, 1000);
  }

  protected endEvent(reason: string) {
    console.log(`[Event] ${this.roomName} ended. Reason: ${reason}`);
    
    // Announce the end to the players
    this.broadcast("eventEnd", { reason });

    // Tell clients to disconnect and join the Hub
    this.broadcast("returnToHub", { targetRoom: this.hubRoomName });

    // Sever the connections and dispose of this temporary room instance
    this.disconnect();
  }
}