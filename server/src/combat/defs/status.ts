// server/src/combat/defs/status.ts
import type { CombatEvent } from "../CombatSystem.js";

export type StatusDefId = "BLEED" | "CHILL" | "WEAKEN" | "BURN" | "CRIPPLE";

export type StatusDef = {
  id: StatusDefId;
  tickEveryMs: number; // 0 = no ticking
  onTick?: (stacks: number, now: number, emit: (e: CombatEvent) => void) => void;

  // snapshot modifiers: Combatant.snapshot() should apply these
  mods?: {
    moveSpeedMul?: (stacks: number) => number;
    damageTakenMul?: (stacks: number) => number;
    damageDealMul?: (stacks: number) => number;
    blockMul?: (stacks: number) => number;
  };
};

// NOTE: component emits are generic; Combatant will translate RESOURCE/HP events properly in MyRoom integration.
// The onTick hooks here are intentionally “stateless”; your StatusComponent owns timers.

export const StatusDefs: Record<StatusDefId, StatusDef> = {
  BLEED: {
    id: "BLEED",
    tickEveryMs: 650,
    onTick: (stacks, now, emit) => {
      // damage is applied by CombatSystem via target.health, not here.
      // In this baseline, just emit a marker event. If you want DOT damage,
      // wire StatusComponent into a CombatContext that can apply HP deltas.
      emit({ type: "COMBAT_LOG", msg: "BLEED tick (wire DOT in Combatant adapter)", data: { stacks } });
    },
    mods: {
      damageTakenMul: (s) => 1 + Math.min(0.20, 0.06 * s),
    },
  },

  CHILL: {
    id: "CHILL",
    tickEveryMs: 0,
    mods: {
      moveSpeedMul: (s) => Math.max(0.60, 1 - 0.12 * s),
    },
  },

  WEAKEN: {
    id: "WEAKEN",
    tickEveryMs: 0,
    mods: {
      damageDealMul: (s) => Math.max(0.70, 1 - 0.10 * s),
    },
  },

  BURN: {
    id: "BURN",
    tickEveryMs: 700,
    onTick: (stacks, now, emit) => {
      emit({ type: "COMBAT_LOG", msg: "BURN tick (wire DOT in Combatant adapter)", data: { stacks } });
    },
    mods: {
      damageTakenMul: (s) => 1 + Math.min(0.15, 0.04 * s),
    },
  },

  CRIPPLE: {
    id: "CRIPPLE",
    tickEveryMs: 0,
    mods: {
      moveSpeedMul: (s) => Math.max(0.50, 1 - 0.18 * s),
      blockMul: (s) => Math.max(0.75, 1 - 0.10 * s),
    },
  },
};
