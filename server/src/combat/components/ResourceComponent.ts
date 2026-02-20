// server/src/combat/components/ResourceComponent.ts
import type { CombatEvent } from "../CombatSystem.js";
import { clampInt } from "../math/curves.js";

export type AuraCombatMods = {
  costMul: number; // applied at call sites; included here for regen behaviors if you want
  regenMul: number;
};

export class ResourceComponent {
  mana: number;
  maxMana: number;

  aura: number;
  maxAura: number;

  // regen rates (tune)
  manaRegenPerSec = 3;
  auraRegenPerSec = 6;

  private _carryMana = 0;
  private _carryAura = 0;

  constructor(mana: number, maxMana: number, aura: number, maxAura: number) {
    this.maxMana = clampInt(maxMana, 0, 999999);
    this.mana = clampInt(mana, 0, this.maxMana);

    this.maxAura = clampInt(maxAura, 0, 999999);
    this.aura = clampInt(aura, 0, this.maxAura);
  }

  canPay(manaCost: number, auraCost: number): boolean {
    return this.mana >= manaCost && this.aura >= auraCost;
  }

  pay(manaCost: number, auraCost: number): void {
    this.mana = clampInt(this.mana - clampInt(manaCost, 0, 999999), 0, this.maxMana);
    this.aura = clampInt(this.aura - clampInt(auraCost, 0, 999999), 0, this.maxAura);
  }

  addMana(amount: number): void {
    this.mana = clampInt(this.mana + clampInt(amount, 0, 999999), 0, this.maxMana);
  }

  addAura(amount: number): void {
    this.aura = clampInt(this.aura + clampInt(amount, 0, 999999), 0, this.maxAura);
  }

  tick(now: number, dtMs: number, emit: (e: CombatEvent) => void, mods: AuraCombatMods): void {
    // integer regen with carry to keep deterministic-ish
    const dt = dtMs / 1000;
    const rm = Math.max(0, mods.regenMul);

    // mana
    if (this.mana < this.maxMana && this.manaRegenPerSec > 0) {
      this._carryMana += this.manaRegenPerSec * dt * rm;
      const whole = Math.floor(this._carryMana);
      if (whole > 0) {
        this._carryMana -= whole;
        const before = this.mana;
        this.addMana(whole);
        if (this.mana !== before) emit({ type: "RESOURCE", id: "" as any, mana: this.mana, maxMana: this.maxMana });
      }
    }

    // aura
    if (this.aura < this.maxAura && this.auraRegenPerSec > 0) {
      this._carryAura += this.auraRegenPerSec * dt * rm;
      const whole = Math.floor(this._carryAura);
      if (whole > 0) {
        this._carryAura -= whole;
        const before = this.aura;
        this.addAura(whole);
        if (this.aura !== before) emit({ type: "RESOURCE", id: "" as any, aura: this.aura, maxAura: this.maxAura });
      }
    }
  }
}
