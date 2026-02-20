// server/src/combat/defs/aura.ts
import { clamp01 } from "../math/curves.js";

export type AuraArchetypeId = "BASIC" | "IRON" | "SHADOW" | "BLOOD" | "ASTRAL";

export type AuraModsOut = {
  damageMul: number;
  costMul: number;
  poiseMul: number;
  takenMul: number;
  critBonus: number;
  regenMul: number;
};

export type AuraDef = {
  id: AuraArchetypeId;
  name: string;
  
  // Dynamics: How fast the aura flares up and burns out
  intensityDecayPerSec: number;
  burnoutBuildPerSecAtMax: number; 
  burnoutDecayPerSec: number;
  berserkBurnoutPerSec: number;

  // The scaling curve: How Tier, Intensity (0..1), and Burnout (0..1) affect stats
  computeMods: (tier: number, intensity: number, burnout: number) => AuraModsOut;
};

export const AuraDefs: Record<AuraArchetypeId, AuraDef> = {
  // ------------------------------------------------------------------------
  // BASIC: The default, balanced risk/reward curve
  // ------------------------------------------------------------------------
  BASIC: {
    id: "BASIC",
    name: "Unattuned Aura",
    intensityDecayPerSec: 0.04,
    burnoutBuildPerSecAtMax: 0.14,
    burnoutDecayPerSec: 0.08,
    berserkBurnoutPerSec: 0.28,
    computeMods: (t, i, b) => {
      const burnoutPenalty = 1 - 0.35 * b; // 0.65..1
      return {
        damageMul: (1 + 0.35 * i + Math.min(0.18, t * 0.02)) * burnoutPenalty,
        poiseMul: (1 + 0.25 * i) * burnoutPenalty,
        costMul: 1 + 0.50 * i,           // Costs rise as you flare
        takenMul: 1 + 0.20 * i,          // Take more damage at high intensity
        critBonus: Math.min(0.06, t * 0.006) + 0.04 * i,
        regenMul: Math.max(0, (1 - 0.40 * i) * (1 - 0.50 * b)),
      };
    },
  },

  // ------------------------------------------------------------------------
  // IRON (Tank / Juggernaut)
  // Intensity makes you an immovable wall, but slows your regen heavily.
  // ------------------------------------------------------------------------
  IRON: {
    id: "IRON",
    name: "Iron Essence",
    intensityDecayPerSec: 0.03,        // Holds intensity easier
    burnoutBuildPerSecAtMax: 0.10,     // Burns out slower
    burnoutDecayPerSec: 0.06,
    berserkBurnoutPerSec: 0.20,
    computeMods: (t, i, b) => {
      const burnoutPenalty = 1 - 0.20 * b; // Less punished by burnout
      
      // UNIQUE: Intensity REDUCES damage taken, but Burnout adds it back
      const mitigation = Math.max(0.3, 1 - (0.40 * i) - (t * 0.01)); 
      const takenMul = mitigation + (0.35 * b);

      return {
        damageMul: (1 + 0.15 * i + Math.min(0.10, t * 0.01)) * burnoutPenalty, // Low damage scaling
        poiseMul: (1 + 0.80 * i + Math.min(0.30, t * 0.03)) * burnoutPenalty,  // Massive poise scaling
        costMul: 1 + 0.25 * i, 
        takenMul: takenMul, 
        critBonus: Math.min(0.03, t * 0.003), // Negligible crit
        regenMul: Math.max(0, (1 - 0.60 * i) * (1 - 0.30 * b)), // Flaring heavily stunts regen
      };
    },
  },

  // ------------------------------------------------------------------------
  // SHADOW (Burst / Assassin)
  // Massive spikes in damage and crit, but incredibly fragile and burns fast.
  // ------------------------------------------------------------------------
  SHADOW: {
    id: "SHADOW",
    name: "Shadow Essence",
    intensityDecayPerSec: 0.08,        // Drops intensity rapidly when out of combat
    burnoutBuildPerSecAtMax: 0.25,     // Burns out extremely fast
    burnoutDecayPerSec: 0.12,          // Recovers fast in the shadows
    berserkBurnoutPerSec: 0.45,
    computeMods: (t, i, b) => {
      const burnoutPenalty = 1 - 0.50 * b; // Highly punished by burnout
      return {
        damageMul: (1 + 0.65 * i + Math.min(0.25, t * 0.03)) * burnoutPenalty,
        poiseMul: 1.0, // No poise benefit
        costMul: 1 + 0.80 * i,           // Skills cost a ton at peak
        takenMul: 1 + 0.50 * i,          // VERY fragile when flared
        critBonus: Math.min(0.10, t * 0.01) + 0.25 * i, // Massive crit chance
        regenMul: Math.max(0, (1 - 0.20 * i) * (1 - 0.80 * b)),
      };
    },
  },

  // ------------------------------------------------------------------------
  // BLOOD (Sustain / Bruiser)
  // Flaring hurts you, but greatly amplifies regeneration. Thrives on the edge.
  // ------------------------------------------------------------------------
  BLOOD: {
    id: "BLOOD",
    name: "Blood Essence",
    intensityDecayPerSec: 0.05,
    burnoutBuildPerSecAtMax: 0.15,
    burnoutDecayPerSec: 0.15,          // Blood clears burnout very efficiently
    berserkBurnoutPerSec: 0.30,
    computeMods: (t, i, b) => {
      const burnoutPenalty = 1 - 0.30 * b; 
      return {
        damageMul: (1 + 0.30 * i + Math.min(0.20, t * 0.02)) * burnoutPenalty,
        poiseMul: (1 + 0.30 * i) * burnoutPenalty,
        costMul: 1 + 0.40 * i,
        takenMul: 1 + 0.10 * i, 
        critBonus: Math.min(0.05, t * 0.005) + 0.05 * i,
        // UNIQUE: Intensity INCREASES regeneration multipliers instead of lowering them
        regenMul: Math.max(0, (1 + 1.20 * i + (t * 0.02)) * (1 - 0.20 * b)),
      };
    },
  },
};