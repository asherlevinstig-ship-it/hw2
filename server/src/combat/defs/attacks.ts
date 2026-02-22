// server/src/combat/defs/attacks.ts
import type { DamageType } from "../CombatSystem.js";

export type AttackDefId =
  | "UNARMED"
  | "PICK_WOOD"
  | "PICK_STONE"
  | "PICK_IRON"
  | "AURA_SLASH"
  | "AURA_HEAVY"
  | "AURA_THRUST"
  | "NATURE_GRASP";

export type AttackDef = {
  id: AttackDefId;
  kind: "MELEE" | "RANGED" | "SKILL";

  cooldownMs: number;

  windupMs: number;
  activeMs: number;
  recoveryMs: number;

  reach: number;
  arcDeg: number;
  maxTargets?: number;

  baseDamage: number;
  damageType: DamageType;

  poiseDamage: number;
  staggerMs?: number;

  manaCost?: number;
  auraCost?: number;

  canCrit: boolean;
  critBonus?: number;

  requireLoS?: boolean;

  onHitStatus?: {
    id: import("./status.js").StatusDefId;
    chance: number;
    durationMs: number;
    stacks?: number;
  };

  knockback?: { strength: number; lift: number };
};

export const AttackDefs: Record<AttackDefId, AttackDef> = {
  UNARMED: {
    id: "UNARMED",
    kind: "MELEE",
    cooldownMs: 450,
    windupMs: 120,
    activeMs: 80,
    recoveryMs: 250,
    reach: 3.0,
    arcDeg: 60,
    maxTargets: 1,
    baseDamage: 4,
    damageType: "BLUNT",
    poiseDamage: 10,
    staggerMs: 420,
    canCrit: true,
    critBonus: 0,
    knockback: { strength: 0.9, lift: 0.12 },
  },

  PICK_WOOD: {
    id: "PICK_WOOD",
    kind: "MELEE",
    cooldownMs: 520,
    windupMs: 170,
    activeMs: 90,
    recoveryMs: 290,
    reach: 3.15,
    arcDeg: 70,
    baseDamage: 4,
    damageType: "BLUNT",
    poiseDamage: 14,
    staggerMs: 450,
    canCrit: true,
    critBonus: 0.01,
    knockback: { strength: 1.05, lift: 0.14 },
  },

  PICK_STONE: {
    id: "PICK_STONE",
    kind: "MELEE",
    cooldownMs: 540,
    windupMs: 175,
    activeMs: 95,
    recoveryMs: 305,
    reach: 3.2,
    arcDeg: 72,
    baseDamage: 5,
    damageType: "BLUNT",
    poiseDamage: 18,
    staggerMs: 470,
    canCrit: true,
    critBonus: 0.015,
    knockback: { strength: 1.15, lift: 0.15 },
  },

  PICK_IRON: {
    id: "PICK_IRON",
    kind: "MELEE",
    cooldownMs: 560,
    windupMs: 180,
    activeMs: 100,
    recoveryMs: 320,
    reach: 3.25,
    arcDeg: 75,
    baseDamage: 6,
    damageType: "BLUNT",
    poiseDamage: 22,
    staggerMs: 520,
    canCrit: true,
    critBonus: 0.02,
    knockback: { strength: 1.25, lift: 0.16 },
  },

  // Aura kit (meta-defining)
  AURA_SLASH: {
    id: "AURA_SLASH",
    kind: "SKILL",
    cooldownMs: 900,
    windupMs: 120,
    activeMs: 120,
    recoveryMs: 320,
    reach: 3.6,
    arcDeg: 95,
    maxTargets: 2,
    baseDamage: 7,
    damageType: "SLASH",
    poiseDamage: 20,
    staggerMs: 480,
    auraCost: 10,
    canCrit: true,
    critBonus: 0.03,
    onHitStatus: { id: "BLEED", chance: 0.25, durationMs: 2600, stacks: 1 },
    knockback: { strength: 1.1, lift: 0.1 },
  },

  AURA_HEAVY: {
    id: "AURA_HEAVY",
    kind: "SKILL",
    cooldownMs: 1400,
    windupMs: 260,
    activeMs: 120,
    recoveryMs: 480,
    reach: 3.2,
    arcDeg: 80,
    maxTargets: 2,
    baseDamage: 10,
    damageType: "ARCANE",
    poiseDamage: 40,
    staggerMs: 760,
    auraCost: 18,
    canCrit: false,
    requireLoS: false,
    onHitStatus: { id: "WEAKEN", chance: 0.35, durationMs: 3000, stacks: 1 },
    knockback: { strength: 1.5, lift: 0.22 },
  },

  AURA_THRUST: {
    id: "AURA_THRUST",
    kind: "SKILL",
    cooldownMs: 1100,
    windupMs: 160,
    activeMs: 90,
    recoveryMs: 360,
    reach: 4.0,
    arcDeg: 35,
    maxTargets: 1,
    baseDamage: 9,
    damageType: "PIERCE",
    poiseDamage: 26,
    staggerMs: 520,
    auraCost: 14,
    canCrit: true,
    critBonus: 0.02,
    onHitStatus: { id: "CHILL", chance: 0.30, durationMs: 2400, stacks: 1 },
    knockback: { strength: 1.0, lift: 0.08 },
  },

  // Nature kit (The Warden)
  NATURE_GRASP: {
    id: "NATURE_GRASP",
    kind: "SKILL",
    cooldownMs: 1200,
    windupMs: 200,
    activeMs: 150,
    recoveryMs: 400,
    reach: 5.0,
    arcDeg: 45,
    maxTargets: 3,
    baseDamage: 6,
    damageType: "PIERCE",
    poiseDamage: 35,
    staggerMs: 800,
    auraCost: 15,
    canCrit: true,
    critBonus: 0.05,
    onHitStatus: { id: "CRIPPLE", chance: 0.50, durationMs: 3000, stacks: 1 },
    knockback: { strength: 0.2, lift: 0.5 },
  },
};