// server/src/combat/components/AuraComponent.ts
import type { CombatEvent } from "../CombatSystem.js";
import { clamp01, clampInt } from "../math/curves.js";
import { AuraDefs, type AuraArchetypeId, type AuraModsOut } from "../defs/aura.js";

export class AuraComponent {
  archetypeId: AuraArchetypeId;
  tier: number;        // progression tier 0+
  intensity: number;   // 0..1
  burnout: number;     // 0..1
  berserk = false;

  constructor(archetypeId: AuraArchetypeId = "BASIC", tier: number, intensity: number, burnout: number) {
    this.archetypeId = archetypeId;
    this.tier = clampInt(tier, 0, 99);
    this.intensity = clamp01(intensity);
    this.burnout = clamp01(burnout);
  }

  // Swap to a new essence archetype
  setArchetype(id: AuraArchetypeId): void {
    if (AuraDefs[id]) {
      this.archetypeId = id;
    }
  }

  // Delegate the math completely to the Archetype definition
  computeCombatMods(): AuraModsOut {
    const def = AuraDefs[this.archetypeId] ?? AuraDefs["BASIC"];
    return def.computeMods(this.tier, this.intensity, this.burnout);
  }

  setIntensity(v: number): void {
    this.intensity = clamp01(v);
  }

  setTier(v: number): void {
    this.tier = clampInt(v, 0, 99);
  }

  tick(now: number, dtMs: number, emit: (e: CombatEvent) => void): void {
    const dt = dtMs / 1000;
    const def = AuraDefs[this.archetypeId] ?? AuraDefs["BASIC"];

    // passive intensity decay (unless berserk)
    if (!this.berserk) {
      this.intensity = clamp01(this.intensity - def.intensityDecayPerSec * dt);
    }

    // burnout build/decay driven by the specific archetype
    const buildRate = this.berserk ? def.berserkBurnoutPerSec : def.burnoutBuildPerSecAtMax;
    const build = buildRate * (this.intensity * this.intensity) * dt;
    const decay = def.burnoutDecayPerSec * (1 - this.intensity) * dt;

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