// server/src/shared/items.ts
// FULL FILE - paste exactly as-is
//
// Shared items/defs/recipes (single source of truth for server).
// Client can mirror these IDs/defs (or you can import them if you share across packages).

export const Items = {
  // Blocks as items
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  // Basic crafted
  PLANK: 10,
  STICK: 11,

  // Tools
  WOOD_PICK: 20,
  STONE_PICK: 21,
  IRON_PICK: 22,

  // Minerals
  COAL: 30,
  RAW_IRON: 31,
  RAW_GOLD: 32,
  DIAMOND: 33,
} as const;

export type ItemStack = { id: number; count: number; dur?: number };

export type ToolKind = "pick";

export type ToolDef = {
  kind: ToolKind;
  tier: number;          // 1 wood, 2 stone, 3 iron...
  maxDurability: number; // durability points
  speedMul: number;      // lower break time multiplier
};

export type ItemDef = {
  id: number;
  name: string;
  maxStack: number;
  placeBlockId?: number;

  // If present => tool behavior
  tool?: ToolDef;
};

// Server uses placeBlockId rules; these IDs must match your client block IDs.
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;

export const ITEM_DEFS: Record<number, ItemDef> = {
  // Blocks
  1: { id: 1, name: "Grass", maxStack: 64, placeBlockId: GRASS_ID },
  2: { id: 2, name: "Dirt", maxStack: 64, placeBlockId: DIRT_ID },
  3: { id: 3, name: "Stone", maxStack: 64, placeBlockId: STONE_ID },
  4: { id: 4, name: "Wood", maxStack: 64, placeBlockId: WOOD_ID },
  5: { id: 5, name: "Leaves", maxStack: 64, placeBlockId: LEAVES_ID },

  // Crafted
  10: { id: 10, name: "Planks", maxStack: 64 },
  11: { id: 11, name: "Stick", maxStack: 64 },

  // Tools (maxStack=1)
  20: {
    id: 20,
    name: "Wood Pick",
    maxStack: 1,
    tool: { kind: "pick", tier: 1, maxDurability: 60, speedMul: 0.65 },
  },
  21: {
    id: 21,
    name: "Stone Pick",
    maxStack: 1,
    tool: { kind: "pick", tier: 2, maxDurability: 132, speedMul: 0.48 },
  },
  22: {
    id: 22,
    name: "Iron Pick",
    maxStack: 1,
    tool: { kind: "pick", tier: 3, maxDurability: 251, speedMul: 0.34 },
  },

  // Minerals
  30: { id: 30, name: "Coal", maxStack: 64 },
  31: { id: 31, name: "Raw Iron", maxStack: 64 },
  32: { id: 32, name: "Raw Gold", maxStack: 64 },
  33: { id: 33, name: "Diamond", maxStack: 64 },
};

export type Recipe = {
  id: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

export const RECIPES: Recipe[] = [
  { id: "planks_from_log", inputs: [{ id: Items.WOOD_LOG, count: 1 }], output: { id: Items.PLANK, count: 4 } },
  { id: "sticks_from_planks", inputs: [{ id: Items.PLANK, count: 2 }], output: { id: Items.STICK, count: 4 } },

  // Wood pick
  {
    id: "wood_pick",
    inputs: [
      { id: Items.PLANK, count: 3 },
      { id: Items.STICK, count: 2 },
    ],
    output: { id: Items.WOOD_PICK, count: 1 },
  },

  // Stone pick (uses STONE item as "cobble" for now)
  {
    id: "stone_pick",
    inputs: [
      { id: Items.STONE, count: 3 },
      { id: Items.STICK, count: 2 },
    ],
    output: { id: Items.STONE_PICK, count: 1 },
  },

  // Iron pick (uses RAW_IRON as ingot substitute until smelting exists)
  {
    id: "iron_pick",
    inputs: [
      { id: Items.RAW_IRON, count: 3 },
      { id: Items.STICK, count: 2 },
    ],
    output: { id: Items.IRON_PICK, count: 1 },
  },
];
