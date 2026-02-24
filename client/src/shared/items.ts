// server/src/shared/items.ts
// FULL FILE - Option B (server authoritative chunks) + multiplayer + persistence
// Shared items/defs/recipes (single source of truth for server).
//
// UPDATED: Replaced Emojis with high-quality Game-Icons.net SVG paths
// UPDATED: Added 'color' field for Rarity/UI borders
// Includes: All Biomes, Cave Blocks, Tools, Awakening Stones, and Skills

export const Items = {
  // Blocks as items
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  // Biome blocks as items
  SAND: 6,
  SNOW: 7,

  // Cave Biome Blocks
  DEEPSLATE: 90,
  TUFF: 91,
  MOSS: 92,
  MOSSY_STONE: 93,
  DRIPSTONE: 94,
  DRIPSTONE_BLOCK: 95,
  GLOW_SHROOM: 96,
  CRYSTAL: 97,

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

  // --- AWAKENING STONES ---
  STONE_IRON: 200,
  STONE_SHADOW: 201,
  STONE_BLOOD: 202,
  STONE_ASTRAL: 203,

  // --- VIRTUAL SKILLS ---
  SKILL_AURA_SLASH: 1001,
  SKILL_AURA_HEAVY: 1002,
  SKILL_AURA_THRUST: 1003,
  SKILL_NATURE_GRASP: 1004,
} as const;

export type ItemStack = { id: number; count: number; dur?: number };

export type ToolKind = "pick";

export type ToolDef = {
  kind: ToolKind;
  tier: number; // 1 wood, 2 stone, 3 iron...
  maxDurability: number; // durability points
  speedMul: number; // lower break time multiplier
};

export type ItemDef = {
  id: number;
  name: string;
  icon: string; // Full URL to SVG icon
  color: string; // Hex color for UI borders/text
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

// Biome surface blocks
const SAND_ID = 11;
const SNOW_ID = 12;

// Cave Biome Blocks (Must match server MyRoom generation & Client registry)
const DEEPSLATE_ID = 90;
const TUFF_ID = 91;
const MOSS_ID = 92;
const MOSSY_STONE_ID = 93;
const DRIPSTONE_ID = 94;        
const DRIPSTONE_BLOCK_ID = 95;  
const GLOW_SHROOM_ID = 96;      
const CRYSTAL_ID = 97;

// Base URL for Game-Icons.net assets (hosted via GitHub Raw for stability)
const ICON_BASE = "https://raw.githubusercontent.com/game-icons/icons/refs/heads/master";

export const ITEM_DEFS: Record<number, ItemDef> = {
  // Blocks
  1: { id: 1, name: "Grass", icon: `${ICON_BASE}/delapouite/transparent/1x1/grass.svg`, color: "#4CAF50", maxStack: 64, placeBlockId: GRASS_ID },
  2: { id: 2, name: "Dirt", icon: `${ICON_BASE}/lorc/transparent/1x1/ground-sprout.svg`, color: "#795548", maxStack: 64, placeBlockId: DIRT_ID },
  3: { id: 3, name: "Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/stone-block.svg`, color: "#9E9E9E", maxStack: 64, placeBlockId: STONE_ID },
  4: { id: 4, name: "Wood", icon: `${ICON_BASE}/lorc/transparent/1x1/wood-beam.svg`, color: "#8D6E63", maxStack: 64, placeBlockId: WOOD_ID },
  5: { id: 5, name: "Leaves", icon: `${ICON_BASE}/lorc/transparent/1x1/vine-leaf.svg`, color: "#66BB6A", maxStack: 64, placeBlockId: LEAVES_ID },

  // Biome blocks
  6: { id: 6, name: "Sand", icon: `${ICON_BASE}/lorc/transparent/1x1/dust-cloud.svg`, color: "#FFF59D", maxStack: 64, placeBlockId: SAND_ID },
  7: { id: 7, name: "Snow", icon: `${ICON_BASE}/lorc/transparent/1x1/snowflake-2.svg`, color: "#E0F7FA", maxStack: 64, placeBlockId: SNOW_ID },

  // Cave Biome Blocks
  90: { id: 90, name: "Deepslate", icon: `${ICON_BASE}/lorc/transparent/1x1/rock.svg`, color: "#37474F", maxStack: 64, placeBlockId: DEEPSLATE_ID },
  91: { id: 91, name: "Tuff", icon: `${ICON_BASE}/lorc/transparent/1x1/pumice.svg`, color: "#78909C", maxStack: 64, placeBlockId: TUFF_ID },
  92: { id: 92, name: "Moss", icon: `${ICON_BASE}/lorc/transparent/1x1/mossy-stone.svg`, color: "#69F0AE", maxStack: 64, placeBlockId: MOSS_ID },
  93: { id: 93, name: "Mossy Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/stone-pile.svg`, color: "#4DB6AC", maxStack: 64, placeBlockId: MOSSY_STONE_ID },
  94: { id: 94, name: "Pointed Dripstone", icon: `${ICON_BASE}/lorc/transparent/1x1/stalactites.svg`, color: "#8D6E63", maxStack: 64, placeBlockId: DRIPSTONE_ID },
  95: { id: 95, name: "Dripstone Block", icon: `${ICON_BASE}/lorc/transparent/1x1/stone-wall.svg`, color: "#5D4037", maxStack: 64, placeBlockId: DRIPSTONE_BLOCK_ID },
  96: { id: 96, name: "Glow Shroom", icon: `${ICON_BASE}/lorc/transparent/1x1/mushroom.svg`, color: "#00E5FF", maxStack: 64, placeBlockId: GLOW_SHROOM_ID },
  97: { id: 97, name: "Cave Crystal", icon: `${ICON_BASE}/lorc/transparent/1x1/crystal-growth.svg`, color: "#D500F9", maxStack: 64, placeBlockId: CRYSTAL_ID },

  // Crafted
  10: { id: 10, name: "Planks", icon: `${ICON_BASE}/lorc/transparent/1x1/wooden-crate.svg`, color: "#A1887F", maxStack: 64 },
  11: { id: 11, name: "Stick", icon: `${ICON_BASE}/lorc/transparent/1x1/bo.svg`, color: "#8D6E63", maxStack: 64 },

  // Tools (maxStack=1)
  20: {
    id: 20,
    name: "Wood Pick",
    icon: `${ICON_BASE}/lorc/transparent/1x1/pick-of-destiny.svg`,
    color: "#8D6E63",
    maxStack: 1,
    tool: { kind: "pick", tier: 1, maxDurability: 60, speedMul: 0.65 },
  },
  21: {
    id: 21,
    name: "Stone Pick",
    icon: `${ICON_BASE}/lorc/transparent/1x1/miner.svg`,
    color: "#BDBDBD",
    maxStack: 1,
    tool: { kind: "pick", tier: 2, maxDurability: 132, speedMul: 0.48 },
  },
  22: {
    id: 22,
    name: "Iron Pick",
    icon: `${ICON_BASE}/lorc/transparent/1x1/mining.svg`,
    color: "#ECEFF1",
    maxStack: 1,
    tool: { kind: "pick", tier: 3, maxDurability: 251, speedMul: 0.34 },
  },

  // Minerals
  30: { id: 30, name: "Coal", icon: `${ICON_BASE}/lorc/transparent/1x1/ember-shot.svg`, color: "#212121", maxStack: 64 },
  31: { id: 31, name: "Raw Iron", icon: `${ICON_BASE}/lorc/transparent/1x1/iron-ingot.svg`, color: "#D7CCC8", maxStack: 64 },
  32: { id: 32, name: "Raw Gold", icon: `${ICON_BASE}/lorc/transparent/1x1/gold-nugget.svg`, color: "#FFD54F", maxStack: 64 },
  33: { id: 33, name: "Diamond", icon: `${ICON_BASE}/lorc/transparent/1x1/diamond-hard.svg`, color: "#00E5FF", maxStack: 64 },

  // --- AWAKENING STONES ---
  200: { id: 200, name: "Iron Awakening Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/shield-bash.svg`, color: "#B0BEC5", maxStack: 10 },
  201: { id: 201, name: "Shadow Awakening Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/hooded-figure.svg`, color: "#7E57C2", maxStack: 10 },
  202: { id: 202, name: "Blood Awakening Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/droplets.svg`, color: "#EF5350", maxStack: 10 },
  203: { id: 203, name: "Astral Awakening Stone", icon: `${ICON_BASE}/lorc/transparent/1x1/runes.svg`, color: "#29B6F6", maxStack: 10 },

  // --- VIRTUAL SKILLS --- (Only stack to 1)
  1001: { id: 1001, name: "[Skill] Aura Slash", icon: `${ICON_BASE}/lorc/transparent/1x1/swords-power.svg`, color: "#00E676", maxStack: 1 },
  1002: { id: 1002, name: "[Skill] Aura Heavy", icon: `${ICON_BASE}/lorc/transparent/1x1/hammer-drop.svg`, color: "#FFA726", maxStack: 1 },
  1003: { id: 1003, name: "[Skill] Aura Thrust", icon: `${ICON_BASE}/lorc/transparent/1x1/piercing-sword.svg`, color: "#29B6F6", maxStack: 1 },
  1004: { id: 1004, name: "[Skill] Nature Grasp", icon: `${ICON_BASE}/lorc/transparent/1x1/vine-whip.svg`, color: "#66BB6A", maxStack: 1 },
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