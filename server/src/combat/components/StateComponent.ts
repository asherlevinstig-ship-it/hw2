// server/src/combat/components/StateComponent.ts
import { clampInt, nowMs } from "../math/curves.js";

export type CombatState =
  | "IDLE"
  | "ATTACK_WINDUP"
  | "ATTACK_ACTIVE"
  | "ATTACK_RECOVERY"
  | "DODGING"
  | "BLOCKING"
  | "STAGGERED"
  | "DEAD"
  | "CASTING";

export class StateComponent {
  state: CombatState = "IDLE";

  // timelines
  private attackWindupEnd = 0;
  private attackActiveEnd = 0;
  private attackRecoveryEnd = 0;

  private dodgeEnd = 0;
  private staggerEnd = 0;

  isDead(): boolean {
    return this.state === "DEAD";
  }

  setDead(): void {
    this.state = "DEAD";
  }

  canStartAttack(): boolean {
    if (this.state === "DEAD") return false;
    if (this.state === "STAGGERED") return false;
    if (this.state === "DODGING") return false;
    if (this.state === "ATTACK_WINDUP" || this.state === "ATTACK_ACTIVE" || this.state === "ATTACK_RECOVERY") return false;
    return true;
  }

  canResolveAttack(): boolean {
    return this.state === "ATTACK_ACTIVE";
  }

  canStartDodge(): boolean {
    if (this.state === "DEAD") return false;
    if (this.state === "STAGGERED") return false;
    if (this.state === "ATTACK_ACTIVE") return false; // optional rule
    if (this.state === "DODGING") return false;
    return true;
  }

  isBlocking(): boolean {
    return this.state === "BLOCKING";
  }

  isStaggered(): boolean {
    return this.state === "STAGGERED";
  }

  setAttackTimeline(startedAt: number, windupEndAt: number, activeEndAt: number, recoveryEndAt: number): void {
    this.attackWindupEnd = windupEndAt;
    this.attackActiveEnd = activeEndAt;
    this.attackRecoveryEnd = recoveryEndAt;
    this.state = "ATTACK_WINDUP";
  }

  startDodge(now: number, endsAt: number): void {
    this.dodgeEnd = endsAt;
    this.state = "DODGING";
  }

  startBlock(): void {
    if (this.state === "DEAD" || this.state === "STAGGERED") return;
    // allow block during recovery if you want: keep simple for now
    if (this.state === "ATTACK_ACTIVE") return;
    this.state = "BLOCKING";
  }

  stopBlock(): void {
    if (this.state === "BLOCKING") this.state = "IDLE";
  }

  startStagger(now: number, endsAt: number): void {
    this.staggerEnd = endsAt;
    this.state = "STAGGERED";
  }

  tick(now = nowMs()): void {
    if (this.state === "DEAD") return;

    // stagger expiry
    if (this.state === "STAGGERED" && now >= this.staggerEnd) {
      this.state = "IDLE";
      return;
    }

    // dodge expiry
    if (this.state === "DODGING" && now >= this.dodgeEnd) {
      this.state = "IDLE";
      return;
    }

    // attack phase transitions
    if (this.state === "ATTACK_WINDUP" && now >= this.attackWindupEnd) {
      this.state = "ATTACK_ACTIVE";
      return;
    }
    if (this.state === "ATTACK_ACTIVE" && now >= this.attackActiveEnd) {
      this.state = "ATTACK_RECOVERY";
      return;
    }
    if (this.state === "ATTACK_RECOVERY" && now >= this.attackRecoveryEnd) {
      this.state = "IDLE";
      return;
    }
  }
}
