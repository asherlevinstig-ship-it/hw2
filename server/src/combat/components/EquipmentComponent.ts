// server/src/combat/components/EquipmentComponent.ts
import { Items } from "../../shared/items.js";
import { AttackDefs, type AttackDefId } from "../defs/attacks.js";

export class EquipmentComponent {
  // Your inventory lives elsewhere; this is just a selector hook.
  // Provide the current hotbar item id if you have it.
  private getHeldItemId: (heldSlot?: number) => number;

  constructor(getHeldItemId: (heldSlot?: number) => number) {
    this.getHeldItemId = getHeldItemId;
  }

  chooseAttackDef(requested?: AttackDefId, heldSlot?: number): AttackDefId {
    if (requested && AttackDefs[requested]) return requested;

    const itemId = this.getHeldItemId(heldSlot);

    // Map tools/weapons -> attack defs
    if (itemId === Items.WOOD_PICK) return "PICK_WOOD";
    if (itemId === Items.STONE_PICK) return "PICK_STONE";
    if (itemId === Items.IRON_PICK) return "PICK_IRON";

    return "UNARMED";
  }
}
