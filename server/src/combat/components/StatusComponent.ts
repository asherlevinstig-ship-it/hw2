// server/src/combat/components/StatusComponent.ts
import type { CombatEvent, EntityId } from "../CombatSystem.js";
import { clampInt } from "../math/curves.js";
import type { StatusDefId, StatusDef } from "../defs/status.js";

type ActiveStatus = {
  id: StatusDefId;
  sourceId: EntityId;
  stacks: number;
  startedAt: number;
  expiresAt: number;
  nextTickAt: number;
};

export class StatusComponent {
  private active = new Map<StatusDefId, ActiveStatus>();

  apply(id: StatusDefId, durationMs: number, stacks: number, sourceId: EntityId, now: number): void {
    const d = clampInt(durationMs, 50, 60 * 60 * 1000);
    const s = clampInt(stacks, 1, 999);

    const cur = this.active.get(id);
    if (!cur) {
      this.active.set(id, {
        id,
        sourceId,
        stacks: s,
        startedAt: now,
        expiresAt: now + d,
        nextTickAt: now, // tick immediately if interval==0 or next tick check will handle
      });
      return;
    }

    // refresh + stack rules: simple add stacks then clamp (defs can override)
    cur.stacks = clampInt(cur.stacks + s, 1, 999);
    cur.expiresAt = Math.max(cur.expiresAt, now + d);
    cur.sourceId = sourceId;
  }

  has(id: StatusDefId): boolean {
    return this.active.has(id);
  }

  getStacks(id: StatusDefId): number {
    return this.active.get(id)?.stacks ?? 0;
  }

  clear(id: StatusDefId): void {
    this.active.delete(id);
  }

  clearAll(): void {
    this.active.clear();
  }

  tick(now: number, dtMs: number, emit: (e: CombatEvent) => void, defs: Record<StatusDefId, StatusDef>): void {
    for (const [id, st] of this.active.entries()) {
      const def = defs[id];
      if (!def) {
        this.active.delete(id);
        continue;
      }

      if (now >= st.expiresAt) {
        this.active.delete(id);
        continue;
      }

      // periodic tick
      if (def.tickEveryMs > 0 && now >= st.nextTickAt) {
        st.nextTickAt = now + def.tickEveryMs;
        def.onTick?.(st.stacks, now, emit);
      }
    }
  }

  // aggregate modifiers for snapshot-driven systems
  // (Combatant.snapshot() can use these)
  aggregateMods(defs: Record<StatusDefId, StatusDef>) {
    let moveSpeedMul = 1;
    let damageTakenMul = 1;
    let damageDealMul = 1;
    let blockMul = 1;

    for (const [id, st] of this.active.entries()) {
      const def = defs[id];
      if (!def?.mods) continue;
      const k = st.stacks;

      moveSpeedMul *= def.mods.moveSpeedMul?.(k) ?? 1;
      damageTakenMul *= def.mods.damageTakenMul?.(k) ?? 1;
      damageDealMul *= def.mods.damageDealMul?.(k) ?? 1;
      blockMul *= def.mods.blockMul?.(k) ?? 1;
    }

    return { moveSpeedMul, damageTakenMul, damageDealMul, blockMul };
  }
}
