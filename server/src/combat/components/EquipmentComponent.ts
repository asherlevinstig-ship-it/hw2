// server/src/combat/components/EquipmentComponent.ts
import { Items } from "../../shared/items.js";
import { AttackDefs, type AttackDefId } from "../defs/attacks.js";

export class EquipmentComponent {
  private getHeldItemId: (heldSlot?: number) => number;

  constructor(getHeldItemId: (heldSlot?: number) => number) {
    this.getHeldItemId = getHeldItemId;
  }

  chooseAttackDef(requested?: AttackDefId, heldSlot?: number): AttackDefId {
    if (requested && AttackDefs[requested]) return requested;

    const itemId = this.getHeldItemId(heldSlot);

    // Map equipped hotbar skills directly to their combat logic
    if (itemId === Items.SKILL_AURA_SLASH) return "AURA_SLASH";
    if (itemId === Items.SKILL_AURA_HEAVY) return "AURA_HEAVY";
    if (itemId === Items.SKILL_AURA_THRUST) return "AURA_THRUST";
    
    // The Warden's new ability
    if (itemId === Items.SKILL_NATURE_GRASP) return "NATURE_GRASP";

    // Standard physical tool/weapon fallback
    if (itemId === Items.WOOD_PICK) return "PICK_WOOD";
    if (itemId === Items.STONE_PICK) return "PICK_STONE";
    if (itemId === Items.IRON_PICK) return "PICK_IRON";

    return "UNARMED";
  }
}