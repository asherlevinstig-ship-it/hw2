// server/src/combat/components/HealthComponent.ts
import { clampInt } from "../math/curves.js";

export class HealthComponent {
  hp: number;
  maxHp: number;

  constructor(hp: number, maxHp: number) {
    this.maxHp = clampInt(maxHp, 1, 999999);
    this.hp = clampInt(hp, 0, this.maxHp);
  }

  isDead(): boolean {
    return this.hp <= 0;
  }

  heal(amount: number): void {
    const a = clampInt(amount, 0, 999999);
    this.hp = clampInt(this.hp + a, 0, this.maxHp);
  }

  applyDamage(amount: number): void {
    const a = clampInt(amount, 0, 999999);
    this.hp = clampInt(this.hp - a, 0, this.maxHp);
  }

  setMax(maxHp: number, fill = false): void {
    this.maxHp = clampInt(maxHp, 1, 999999);
    if (fill) this.hp = this.maxHp;
    else this.hp = clampInt(this.hp, 0, this.maxHp);
  }
}
