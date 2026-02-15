// shared/items.ts (copy into both projects for now)
export type ItemId = number;

export const Items = {
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  PLANK: 10,
  STICK: 11,
  WOOD_PICK: 20,
} as const;

export type ItemDef = {
  id: ItemId;
  name: string;
  maxStack: number;
  placeBlockId?: number; // if this item places a block
};

export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  [Items.GRASS]: { id: Items.GRASS, name: "Grass", maxStack: 64, placeBlockId: 1 },
  [Items.DIRT]: { id: Items.DIRT, name: "Dirt", maxStack: 64, placeBlockId: 2 },
  [Items.STONE]: { id: Items.STONE, name: "Stone", maxStack: 64, placeBlockId: 3 },
  [Items.WOOD_LOG]: { id: Items.WOOD_LOG, name: "Wood", maxStack: 64, placeBlockId: 4 },
  [Items.LEAVES]: { id: Items.LEAVES, name: "Leaves", maxStack: 64, placeBlockId: 5 },

  [Items.PLANK]: { id: Items.PLANK, name: "Planks", maxStack: 64 },
  [Items.STICK]: { id: Items.STICK, name: "Stick", maxStack: 64 },
  [Items.WOOD_PICK]: { id: Items.WOOD_PICK, name: "Wood Pick", maxStack: 1 },
};

export type ItemStack = { id: ItemId; count: number }; // id=0 means empty
export const EMPTY: ItemStack = { id: 0, count: 0 };

// Simple recipe list (shapeless to start)
export type Recipe = {
  id: string;
  name: string;
  inputs: Array<{ id: ItemId; count: number }>;
  output: { id: ItemId; count: number };
};

export const RECIPES: Recipe[] = [
  { id: "planks_from_log", name: "Planks", inputs: [{ id: Items.WOOD_LOG, count: 1 }], output: { id: Items.PLANK, count: 4 } },
  { id: "sticks_from_planks", name: "Sticks", inputs: [{ id: Items.PLANK, count: 2 }], output: { id: Items.STICK, count: 4 } },
  { id: "wood_pick", name: "Wood Pick", inputs: [{ id: Items.PLANK, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_PICK, count: 1 } },
];
