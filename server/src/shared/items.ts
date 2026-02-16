// shared/items.ts
// Copy into BOTH projects for now (client + server)
//
// Single source of truth for:
// - Item ids
// - Stack sizes
// - Which items place which block ids
// - Simple recipe list (shapeless for now)
//
// IMPORTANT:
// - Block IDs must match your NOA registry (client) + server constants.
// - Item IDs must match any drop mappings you use on the server.
//
// id=0 means "empty"

export type ItemId = number;

export const Items = {
  // Block-like items (placeable)
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  // Crafted
  PLANK: 10,
  STICK: 11,
  WOOD_PICK: 20,

  // Minerals (drops from ores)
  COAL: 30,
  RAW_IRON: 31,
  RAW_GOLD: 32,
  DIAMOND: 33,
} as const;

export type ItemDef = {
  id: ItemId;
  name: string;
  maxStack: number;
  placeBlockId?: number; // if this item places a block
};

// Block IDs (must match client/server block registry)
const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD: 4,
  LEAVES: 5,
} as const;

export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  // Placeable blocks
  [Items.GRASS]: { id: Items.GRASS, name: "Grass", maxStack: 64, placeBlockId: BLOCK.GRASS },
  [Items.DIRT]: { id: Items.DIRT, name: "Dirt", maxStack: 64, placeBlockId: BLOCK.DIRT },
  [Items.STONE]: { id: Items.STONE, name: "Stone", maxStack: 64, placeBlockId: BLOCK.STONE },
  [Items.WOOD_LOG]: { id: Items.WOOD_LOG, name: "Wood", maxStack: 64, placeBlockId: BLOCK.WOOD },
  [Items.LEAVES]: { id: Items.LEAVES, name: "Leaves", maxStack: 64, placeBlockId: BLOCK.LEAVES },

  // Crafted
  [Items.PLANK]: { id: Items.PLANK, name: "Planks", maxStack: 64 },
  [Items.STICK]: { id: Items.STICK, name: "Stick", maxStack: 64 },
  [Items.WOOD_PICK]: { id: Items.WOOD_PICK, name: "Wood Pick", maxStack: 1 },

  // Minerals
  [Items.COAL]: { id: Items.COAL, name: "Coal", maxStack: 64 },
  [Items.RAW_IRON]: { id: Items.RAW_IRON, name: "Raw Iron", maxStack: 64 },
  [Items.RAW_GOLD]: { id: Items.RAW_GOLD, name: "Raw Gold", maxStack: 64 },
  [Items.DIAMOND]: { id: Items.DIAMOND, name: "Diamond", maxStack: 64 },
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
  {
    id: "planks_from_log",
    name: "Planks",
    inputs: [{ id: Items.WOOD_LOG, count: 1 }],
    output: { id: Items.PLANK, count: 4 },
  },
  {
    id: "sticks_from_planks",
    name: "Sticks",
    inputs: [{ id: Items.PLANK, count: 2 }],
    output: { id: Items.STICK, count: 4 },
  },
  {
    id: "wood_pick",
    name: "Wood Pick",
    inputs: [
      { id: Items.PLANK, count: 3 },
      { id: Items.STICK, count: 2 },
    ],
    output: { id: Items.WOOD_PICK, count: 1 },
  },
];
