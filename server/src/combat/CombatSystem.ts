// server/src/combat/CombatSystem.ts
// Server-authoritative combat engine: players + mobs share the same pipeline.
// NodeNext-friendly ESM imports use ".js" extensions.

import { AttackDefs, type AttackDefId } from "./defs/attacks.js";
import { StatusDefs, type StatusDefId } from "./defs/status.js";
import { clamp01, clampInt, nowMs } from "./math/curves.js";
import { coneQuery, type ConeQueryInput } from "./math/cone.js";
import { voxelRaycast, type VoxelRaycastInput } from "./math/occlusion.js";
import {
  add,
  length2,
  normalize,
  scale,
  sub,
  type Vec3,
  yawPitchToDir,
} from "./math/vec.js";

import { CooldownComponent } from "./components/CooldownComponent.js";
import { EquipmentComponent } from "./components/EquipmentComponent.js";
import { HealthComponent } from "./components/HealthComponent.js";
import { AuraComponent } from "./components/AuraComponent.js";
import { ResourceComponent } from "./components/ResourceComponent.js";
import { StateComponent, type CombatState } from "./components/StateComponent.js";
import { StatusComponent } from "./components/StatusComponent.js";

// --------------------
// Shared Types
// --------------------
export type EntityId = string;

export type Faction = "PLAYER" | "MOB" | "NEUTRAL";

export type DamageType = "BLUNT" | "SLASH" | "PIERCE" | "ARCANE" | "FIRE" | "ICE";

export type HitResultKind = "MISS" | "HIT" | "BLOCK" | "DODGE" | "IMMUNE";

export type AttackRequest = {
  attackId?: AttackDefId; // default chosen by equipment if omitted
  heldSlot?: number;      // weapon selection helper (optional)
  yaw?: number;           // if omitted, use combatant yaw
  pitch?: number;         // if omitted, assume 0
};

export type CombatEvent =
  | { type: "ATTACK_START"; attackerId: EntityId; attackId: AttackDefId }
  | { type: "ATTACK_PHASE"; attackerId: EntityId; phase: "WINDUP" | "ACTIVE" | "RECOVERY"; tLeftMs: number }
  | { type: "HIT"; attackerId: EntityId; targetId: EntityId; attackId: AttackDefId; kind: HitResultKind; damage: number; damageType: DamageType; crit: boolean; poiseDamage: number; knockback?: Vec3 }
  | { type: "STATUS_APPLY"; sourceId: EntityId; targetId: EntityId; statusId: StatusDefId; stacks: number; durationMs: number }
  | { type: "STAGGER"; sourceId: EntityId; targetId: EntityId; durationMs: number }
  | { type: "DEATH"; sourceId: EntityId; targetId: EntityId }
  | { type: "RESOURCE"; id: EntityId; hp?: number; maxHp?: number; mana?: number; maxMana?: number; aura?: number; maxAura?: number; burnout?: number; intensity?: number; tier?: number }
  | { type: "AURA_STATE"; id: EntityId; intensity: number; tier: number; burnout: number; berserk: boolean } // <-- Added this line
  | { type: "DODGE"; id: EntityId; dir: Vec3 }
  | { type: "BLOCK"; id: EntityId; active: boolean }
  | { type: "COMBAT_LOG"; msg: string; data?: any };

export type CombatSnapshot = {
  id: EntityId;
  faction: Faction;

  pos: Vec3;
  yaw: number;

  // collider
  radius: number;
  height: number;

  // state
  state: CombatState;

  // primary resources
  hp: number;
  maxHp: number;

  mana: number;
  maxMana: number;

  // aura model
  aura: number;
  maxAura: number;
  auraTier: number;       // 0+
  auraIntensity: number;  // 0..1
  burnout: number;        // 0..1

  // poise/stagger
  poise: number;
  maxPoise: number;

  // defenses
  armor: number;                 // 0..?
  resist: Partial<Record<DamageType, number>>; // -0.5..0.8 recommended
  blockAngleDeg: number;         // frontal block arc
  blockMitigation: number;       // 0..1
  dodgeIframesMs: number;

  // offense
  critChance: number; // 0..1
  critMult: number;   // e.g. 1.5

  // move
  moveSpeedMul: number;

  // flags
  invulnUntil: number; // ms
};

export type Combatant = {
  id: EntityId;
  faction: Faction;

  // transform
  pos: Vec3;
  yaw: number;

  // capsule/collider
  radius: number;
  height: number;

  // comps
  health: HealthComponent;
  resources: ResourceComponent;
  aura: AuraComponent;
  status: StatusComponent;
  cooldowns: CooldownComponent;
  state: StateComponent;
  equipment: EquipmentComponent;

  // defensive/offensive base stats
  armor: number;
  resist: Partial<Record<DamageType, number>>;
  critChance: number;
  critMult: number;

  maxPoise: number;
  poise: number;

  blockAngleDeg: number;
  blockMitigation: number;

  dodgeIframesMs: number;

  moveSpeedMul: number;

  invulnUntil: number;

  // called by system to synchronize to persistence or room player state
  onSync?: (snapshot: CombatSnapshot) => void;

  snapshot(): CombatSnapshot;
};

// --------------------
// Context hooks (MyRoom provides these)
// --------------------
export type CombatSystemHooks = {
  // world queries
  isSafeZoneXZ: (x: number, z: number) => boolean;

  // voxel query for occlusion; return blockId at integer world coords
  getBlockAt: (x: number, y: number, z: number) => number;

  // policy: can entities fight here?
  isCombatAllowedXZ: (x: number, z: number) => boolean;

  // broadcast events to clients
  emit: (e: CombatEvent) => void;

  // entity lookups for spatial queries
  getAllCombatants: () => Combatant[];

  // constants / ids
  AIR_ID: number;
};

type ScheduledAttack = {
  attackerId: EntityId;
  attackId: AttackDefId;
  startedAt: number;
  // phase timings
  windupEndAt: number;
  activeEndAt: number;
  recoveryEndAt: number;
  resolved: boolean; // ensure we resolve hit once per attack
  yaw: number;
  pitch: number;
};

type ScheduledDodge = {
  id: EntityId;
  startedAt: number;
  endsAt: number;
  dir: Vec3;
};

// --------------------
// CombatSystem
// --------------------
export class CombatSystem {
  private hooks: CombatSystemHooks;

  private attacks = new Map<EntityId, ScheduledAttack>(); // one active attack per entity
  private dodges = new Map<EntityId, ScheduledDodge>();   // dodge iframes

  // cadence controls (server)
  private readonly TICK_LOG_EVERY_MS = 4000;
  private lastLogAt = 0;

  constructor(hooks: CombatSystemHooks) {
    this.hooks = hooks;
  }

  // --- API: called by Room on inputs ---
  requestAttack(attackerId: EntityId, req: AttackRequest): void {
    const now = nowMs();

    const a = this.find(attackerId);
    if (!a) return;

    // gate: safe zone / combat allowed
    if (!this.hooks.isCombatAllowedXZ(a.pos.x, a.pos.z)) {
      this.hooks.emit({ type: "COMBAT_LOG", msg: "attack blocked (safe/combat disabled)", data: { attackerId } });
      return;
    }

    // dead/staggered/casting etc.
    if (!a.state.canStartAttack()) return;

    // choose attack def
    const chosen = a.equipment.chooseAttackDef(req.attackId, req.heldSlot);
    const def = AttackDefs[chosen];
    if (!def) return;

    // cooldown
    if (!a.cooldowns.ready(def.id, now)) return;

    // resources cost (mana/aura)
    const auraMods = a.aura.computeCombatMods();
    const manaCost = Math.ceil((def.manaCost ?? 0) * auraMods.costMul);
    const auraCost = Math.ceil((def.auraCost ?? 0) * auraMods.costMul);

    if (!a.resources.canPay(manaCost, auraCost)) return;

    // pay immediately (prevents spamming)
    a.resources.pay(manaCost, auraCost);
    this.hooks.emit({
      type: "RESOURCE",
      id: a.id,
      mana: a.resources.mana,
      aura: a.resources.aura,
      burnout: a.aura.burnout,
      intensity: a.aura.intensity,
      tier: a.aura.tier,
    });

    // schedule attack windows
    const yaw = Number.isFinite(req.yaw as any) ? Number(req.yaw) : a.yaw;
    const pitch = Number.isFinite(req.pitch as any) ? Number(req.pitch) : 0;

    const startedAt = now;
    const windupEndAt = startedAt + def.windupMs;
    const activeEndAt = windupEndAt + def.activeMs;
    const recoveryEndAt = activeEndAt + def.recoveryMs;

    a.cooldowns.set(def.id, now + def.cooldownMs);

    a.state.setAttackTimeline(startedAt, windupEndAt, activeEndAt, recoveryEndAt);

    const sch: ScheduledAttack = {
      attackerId,
      attackId: def.id,
      startedAt,
      windupEndAt,
      activeEndAt,
      recoveryEndAt,
      resolved: false,
      yaw,
      pitch,
    };

    this.attacks.set(attackerId, sch);

    this.hooks.emit({ type: "ATTACK_START", attackerId, attackId: def.id });
  }

  requestDodge(id: EntityId, dir: Vec3): void {
    const now = nowMs();
    const a = this.find(id);
    if (!a) return;
    if (!a.state.canStartDodge()) return;
    if (!this.hooks.isCombatAllowedXZ(a.pos.x, a.pos.z)) return;

    // simple aura-based dodge cost (tunable)
    const auraMods = a.aura.computeCombatMods();
    const auraCost = Math.ceil(6 * auraMods.costMul);
    if (!a.resources.canPay(0, auraCost)) return;
    a.resources.pay(0, auraCost);

    // start iframes + state
    const n = normalize(dir);
    const endsAt = now + a.dodgeIframesMs;

    this.dodges.set(id, { id, startedAt: now, endsAt, dir: n });
    a.state.startDodge(now, endsAt);

    this.hooks.emit({ type: "DODGE", id, dir: n });
    this.hooks.emit({ type: "RESOURCE", id, mana: a.resources.mana, aura: a.resources.aura });
  }

  setBlocking(id: EntityId, active: boolean): void {
    const a = this.find(id);
    if (!a) return;
    if (active) a.state.startBlock();
    else a.state.stopBlock();
    this.hooks.emit({ type: "BLOCK", id, active });
  }

  // --- Tick: called by Room clock ---
  tick(dtMs: number): void {
    const now = nowMs();

    // status ticks + aura ticks (burnout/regen)
    for (const c of this.hooks.getAllCombatants()) {
      c.status.tick(now, dtMs, (e) => this.hooks.emit(e), StatusDefs);
      c.aura.tick(now, dtMs, (e) => this.hooks.emit(e));
      c.resources.tick(now, dtMs, (e) => this.hooks.emit(e), c.aura.computeCombatMods());
      c.state.tick(now);
      this.sync(c);
    }

    // expire dodges
    for (const [id, d] of this.dodges.entries()) {
      if (now >= d.endsAt) this.dodges.delete(id);
    }

    // drive attacks through phases + resolve during active
    for (const [id, atk] of this.attacks.entries()) {
      const a = this.find(id);
      if (!a) {
        this.attacks.delete(id);
        continue;
      }

      const def = AttackDefs[atk.attackId];
      if (!def) {
        this.attacks.delete(id);
        continue;
      }

      if (now < atk.windupEndAt) {
        this.hooks.emit({
          type: "ATTACK_PHASE",
          attackerId: id,
          phase: "WINDUP",
          tLeftMs: Math.max(0, atk.windupEndAt - now),
        });
        continue;
      }

      if (now >= atk.windupEndAt && now < atk.activeEndAt) {
        this.hooks.emit({
          type: "ATTACK_PHASE",
          attackerId: id,
          phase: "ACTIVE",
          tLeftMs: Math.max(0, atk.activeEndAt - now),
        });

        // resolve once per attack during active window
        if (!atk.resolved) {
          atk.resolved = true;
          this.resolveAttack(a, def, atk.yaw, atk.pitch, now);
        }
        continue;
      }

      if (now >= atk.activeEndAt && now < atk.recoveryEndAt) {
        this.hooks.emit({
          type: "ATTACK_PHASE",
          attackerId: id,
          phase: "RECOVERY",
          tLeftMs: Math.max(0, atk.recoveryEndAt - now),
        });
        continue;
      }

      // done
      this.attacks.delete(id);
    }

    // debug heartbeat
    if (now - this.lastLogAt > this.TICK_LOG_EVERY_MS) {
      this.lastLogAt = now;
      this.hooks.emit({ type: "COMBAT_LOG", msg: "combat tick", data: { combatants: this.hooks.getAllCombatants().length } });
    }
  }

  // --------------------
  // Attack resolution pipeline
  // --------------------
  private resolveAttack(attacker: Combatant, def: (typeof AttackDefs)[AttackDefId], yaw: number, pitch: number, now: number): void {
    // re-check zone
    if (!this.hooks.isCombatAllowedXZ(attacker.pos.x, attacker.pos.z)) return;
    if (!attacker.state.canResolveAttack()) return;

    const dir = yawPitchToDir(yaw, pitch);

    const eye = { x: attacker.pos.x, y: attacker.pos.y + 1.55, z: attacker.pos.z };

    // query candidates by cone
    const query: ConeQueryInput = {
      origin: eye,
      dir,
      range: def.reach,
      arcDeg: def.arcDeg,
      maxTargets: def.maxTargets ?? 1,
      includeSelf: false,
    };

    const all = this.hooks.getAllCombatants();
    const candidates = coneQuery(query, all.map((c) => c.snapshot()));

    if (candidates.length <= 0) {
      // miss is implicitly "no HIT events"
      return;
    }

    const auraMods = attacker.aura.computeCombatMods();
    const baseDamage = def.baseDamage * auraMods.damageMul;
    const basePoise = def.poiseDamage * auraMods.poiseMul;

    for (const tId of candidates) {
      const target = this.find(tId);
      if (!target) continue;
      if (target.id === attacker.id) continue;
      if (target.health.isDead()) continue;

      // enforce PvP/PvE logic by faction (still allow PvE always outside town)
      if (!this.isValidFactionHit(attacker.faction, target.faction)) continue;

      // target safe zone gate
      if (!this.hooks.isCombatAllowedXZ(target.pos.x, target.pos.z)) continue;

      // invuln window
      if (now < target.invulnUntil) {
        this.hooks.emit({
          type: "HIT",
          attackerId: attacker.id,
          targetId: target.id,
          attackId: def.id,
          kind: "IMMUNE",
          damage: 0,
          damageType: def.damageType,
          crit: false,
          poiseDamage: 0,
        });
        continue;
      }

      // occlusion (optional)
      if (def.requireLoS) {
        const los: VoxelRaycastInput = {
          from: eye,
          to: { x: target.pos.x, y: target.pos.y + 1.0, z: target.pos.z },
          step: 0.25,
          maxSteps: 200,
        };
        const hit = voxelRaycast(los, (x, y, z) => this.hooks.getBlockAt(x, y, z), this.hooks.AIR_ID);
        if (hit.blocked) continue;
      }

      // dodge i-frames
      if (this.isDodging(target.id, now)) {
        this.hooks.emit({
          type: "HIT",
          attackerId: attacker.id,
          targetId: target.id,
          attackId: def.id,
          kind: "DODGE",
          damage: 0,
          damageType: def.damageType,
          crit: false,
          poiseDamage: 0,
        });
        continue;
      }

      // block check
      const blocked = this.isBlocked(attacker, target, dir);
      const kind: HitResultKind = blocked ? "BLOCK" : "HIT";

      // damage calc
      const crit = def.canCrit ? this.rollCrit(attacker, def) : false;

      const dmgPreMit = crit ? baseDamage * attacker.critMult : baseDamage;
      const dmg = this.applyMitigation(dmgPreMit, def.damageType, target, blocked);

      // poise damage -> stagger
      const poiseDamage = blocked ? basePoise * 0.35 : basePoise;

      const kb = this.computeKnockback(def, dir, blocked);

      // apply results
      if (kind === "HIT" || kind === "BLOCK") {
        target.health.applyDamage(dmg);
        target.poise = Math.max(0, target.poise - poiseDamage);

        if (kb) {
          // only adjust position here if you want; many games just send kb for client prediction
          // keep authoritative push small; you can integrate with your movement authority later
          target.pos = add(target.pos, kb);
        }

        // stagger if poise broken
        if (target.poise <= 0 && !target.state.isStaggered() && !target.health.isDead()) {
          const dur = def.staggerMs ?? 450;
          target.state.startStagger(now, now + dur);
          target.poise = target.maxPoise; // reset on break (classic)
          this.hooks.emit({ type: "STAGGER", sourceId: attacker.id, targetId: target.id, durationMs: dur });
        }

        // on-hit status
        if (def.onHitStatus) {
          const sd = StatusDefs[def.onHitStatus.id];
          if (sd) {
            const rr = Math.random();
            if (rr < clamp01(def.onHitStatus.chance)) {
              target.status.apply(def.onHitStatus.id, def.onHitStatus.durationMs, def.onHitStatus.stacks ?? 1, attacker.id, now);
              this.hooks.emit({
                type: "STATUS_APPLY",
                sourceId: attacker.id,
                targetId: target.id,
                statusId: def.onHitStatus.id,
                stacks: def.onHitStatus.stacks ?? 1,
                durationMs: def.onHitStatus.durationMs,
              });
            }
          }
        }

        // aura feedback: high intensity increases burnout a bit on hit
        attacker.aura.onDealtHit(now);
        target.aura.onTookHit(now);

        this.hooks.emit({
          type: "HIT",
          attackerId: attacker.id,
          targetId: target.id,
          attackId: def.id,
          kind,
          damage: dmg,
          damageType: def.damageType,
          crit,
          poiseDamage,
          knockback: kb ?? undefined,
        });

        // death
        if (target.health.isDead()) {
          target.state.setDead();
          this.hooks.emit({ type: "DEATH", sourceId: attacker.id, targetId: target.id });
        }

        this.sync(target);
        this.sync(attacker);
      }
    }
  }

  // --------------------
  // Helpers
  // --------------------
  private find(id: EntityId): Combatant | null {
    const all = this.hooks.getAllCombatants();
    for (const c of all) if (c.id === id) return c;
    return null;
  }

  private sync(c: Combatant): void {
    c.onSync?.(c.snapshot());
  }

  private isValidFactionHit(a: Faction, b: Faction): boolean {
    if (a === "PLAYER" && b === "PLAYER") return true; // PVP
    if (a === "PLAYER" && b === "MOB") return true;    // PVE
    if (a === "MOB" && b === "PLAYER") return true;    // PVE
    // mobs can fight mobs if you ever want (optional)
    return false;
  }

  private isDodging(id: EntityId, now: number): boolean {
    const d = this.dodges.get(id);
    return !!d && now < d.endsAt;
  }

  private isBlocked(attacker: Combatant, target: Combatant, attackDir: Vec3): boolean {
    if (!target.state.isBlocking()) return false;

    // block is frontal: compare target forward to incoming direction
    const targetForward = yawPitchToDir(target.yaw, 0);
    const incoming = scale(attackDir, -1); // direction from target to attacker approx
    const dot = targetForward.x * incoming.x + targetForward.z * incoming.z;
    const ang = Math.acos(clamp01((dot + 1) * 0.5)) * (180 / Math.PI) * 2; // crude map; okay for gating
    return ang <= target.blockAngleDeg;
  }

  private rollCrit(attacker: Combatant, def: (typeof AttackDefs)[AttackDefId]): boolean {
    const auraMods = attacker.aura.computeCombatMods();
    const p = clamp01(attacker.critChance + (def.critBonus ?? 0) + auraMods.critBonus);
    return Math.random() < p;
  }

  private applyMitigation(dmg: number, type: DamageType, target: Combatant, blocked: boolean): number {
    // resist first
    const r = target.resist?.[type] ?? 0;
    let out = dmg * (1 - clamp01(r));

    // armor curve (soft cap)
    //  armor 0 => 1.0
    //  armor 50 => ~0.67
    //  armor 100 => ~0.50
    const armor = Math.max(0, target.armor);
    const armorMul = 1 / (1 + armor / 100);
    out *= armorMul;

    // block mitigation
    if (blocked) out *= (1 - clamp01(target.blockMitigation));

    return Math.max(0, Math.floor(out));
  }

  private computeKnockback(def: (typeof AttackDefs)[AttackDefId], dir: Vec3, blocked: boolean): Vec3 | null {
    if (!def.knockback) return null;
    const s = blocked ? def.knockback.strength * 0.35 : def.knockback.strength;
    const lift = blocked ? def.knockback.lift * 0.35 : def.knockback.lift;
    if (s <= 0 && lift <= 0) return null;
    return { x: dir.x * s, y: lift, z: dir.z * s };
  }
}
