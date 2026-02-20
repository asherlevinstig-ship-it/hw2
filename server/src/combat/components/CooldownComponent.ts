// server/src/combat/components/CooldownComponent.ts
import { nowMs } from "../math/curves.js";

export class CooldownComponent {
  private nextReady = new Map<string, number>();

  ready(key: string, now = nowMs()): boolean {
    const t = this.nextReady.get(key) ?? 0;
    return now >= t;
  }

  set(key: string, readyAt: number): void {
    this.nextReady.set(key, Math.max(0, readyAt | 0));
  }

  clear(key: string): void {
    this.nextReady.delete(key);
  }

  clearAll(): void {
    this.nextReady.clear();
  }
}
