// server/src/combat/components/AuraComponent.ts
import type { CombatEvent } from "../CombatSystem.js";
import { clamp01, clampInt } from "../math/curves.js";

export type AuraModsOut = {
  damageMul: number;
  costMul: number;
  poiseMul: number;
  takenMul: number;
  critBonus: number;
  regenMul: number;
};

export class AuraComponent {
  tier: number;        // progression tier 0+
  intensity: number;   // 0..1
  burnout: number;     // 0..1
  berserk = false;

  // tuning knobs
  burnoutBuildPerSecAtMax = 0.14;   // at intensity=1
  burnoutDecayPerSec = 0.08;
  berserkBurnoutPerSec = 0.28;

  // intensity dynamics
  intensityDecayPerSec = 0.04;

  constructor(tier: number, intensity: number, burnout: number) {
    this.tier = clampInt(tier, 0, 99);
    this.intensity = clamp01(intensity);
    this.burnout = clamp01(burnout);
  }

  computeCombatMods(): AuraModsOut {
    const t = this.tier;
    const i = clamp01(this.intensity);
    const b = clamp01(this.burnout);

    // tier bonuses (small, steady)
    const tierDamage = Math.min(0.18, t * 0.02);
    const tierCrit = Math.min(0.06, t * 0.006);

    // burnout penalties
    const burnoutPenalty = 1 - 0.35 * b; // 0.65..1

    const damageMul = (1 + 0.35 * i + tierDamage) * burnoutPenalty;
    const poiseMul = (1 + 0.25 * i) * burnoutPenalty;

    // costs rise as you flare (risk)
    const costMul = 1 + 0.50 * i;

    // take more damage at high intensity (risk)
    const takenMul = 1 + 0.20 * i;

    // crit bonus: slightly higher when focused/flared
    const critBonus = tierCrit + 0.04 * i;

    // regen lower when flared + when burnt
    const regenMul = (1 - 0.40 * i) * (1 - 0.50 * b);

    return { damageMul, costMul, poiseMul, takenMul, critBonus, regenMul: Math.max(0, regenMul) };
  }

  setIntensity(v: number): void {
    this.intensity = clamp01(v);
  }

  setTier(v: number): void {
    this.tier = clampInt(v, 0, 99);
  }

  tick(now: number, dtMs: number, emit: (e: CombatEvent) => void): void {
    const dt = dtMs / 1000;

    // passive intensity decay (unless berserk)
    if (!this.berserk) {
      this.intensity = clamp01(this.intensity - this.intensityDecayPerSec * dt);
    }

    // burnout build/decay
    const build = (this.berserk ? this.berserkBurnoutPerSec : this.burnoutBuildPerSecAtMax) * (this.intensity * this.intensity) * dt;
    const decay = this.burnoutDecayPerSec * (1 - this.intensity) * dt;

    this.burnout = clamp01(this.burnout + build - decay);

    // auto-drop berserk if too burned
    if (this.berserk && this.burnout > 0.92) {
      this.berserk = false;
      this.intensity = Math.min(this.intensity, 0.35);
      emit({ type: "AURA_STATE", id: "" as any, intensity: this.intensity, tier: this.tier, burnout: this.burnout, berserk: this.berserk });
    }
  }

  onDealtHit(now: number): void {
    // micro-burnout when you land hits at high intensity
    this.burnout = clamp01(this.burnout + 0.01 * this.intensity);
  }

  onTookHit(now: number): void {
    // taking damage at high intensity is risky
    this.burnout = clamp01(this.burnout + 0.006 * this.intensity);
  }
}
