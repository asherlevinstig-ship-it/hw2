// shared/items.ts

export type ItemStack = {
  id: number;
  count: number;
  dur?: number; // Optional durability for tools/weapons
};

export type ItemDef = {
  id: number;
  name: string;
  maxStack: number;
  placeBlockId?: number; // If set, this item places a block in the world
  tool?: {
    kind: string;
    tier: number;
    speedMul: number;
    maxDurability: number;
  };
};

export type Recipe = {
  id: string;
  inputs: { id: number; count: number }[];
  output: { id: number; count: number };
};

export const Items = {
  // -------------------------
  // Environment Blocks
  // -------------------------
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,
  BEDROCK: 6,
  SAND: 11,
  SNOW: 12,

  // -------------------------
  // Ore Blocks
  // -------------------------
  COAL_ORE: 30,
  IRON_ORE: 31,
  GOLD_ORE: 32,
  DIAMOND_ORE: 33,

  // -------------------------
  // Cave Biome Blocks
  // -------------------------
  DEEPSLATE: 90,
  TUFF: 91,
  MOSS: 92,
  MOSSY_STONE: 93,
  DRIPSTONE: 94,
  DRIPSTONE_BLOCK: 95,
  GLOW_SHROOM: 96,
  CRYSTAL: 97,

  // -------------------------
  // Materials / Drops
  // -------------------------
  COAL: 101,
  RAW_IRON: 102,
  RAW_GOLD: 103,
  DIAMOND: 104,

  // -------------------------
  // Tools & Equipment
  // -------------------------
  WOOD_PICK: 201,
  STONE_PICK: 202,
  IRON_PICK: 203,

  // -------------------------
  // Awakening Stones
  // -------------------------
  STONE_IRON: 501,
  STONE_SHADOW: 502,
  STONE_BLOOD: 503,
  STONE_ASTRAL: 504,

  // -------------------------
  // Skill Gems
  // -------------------------
  SKILL_AURA_SLASH: 1001,
  SKILL_AURA_HEAVY: 1002,
  SKILL_AURA_THRUST: 1003,
  SKILL_NATURE_GRASP: 1004,
};

export const ITEM_DEFS: Record<number, ItemDef> = {
  // -------------------------
  // Environment Blocks (Placeable)
  // -------------------------
  [Items.GRASS]: { id: Items.GRASS, name: "Grass Block", maxStack: 64, placeBlockId: 1 },
  [Items.DIRT]: { id: Items.DIRT, name: "Dirt", maxStack: 64, placeBlockId: 2 },
  [Items.STONE]: { id: Items.STONE, name: "Stone", maxStack: 64, placeBlockId: 3 },
  [Items.WOOD_LOG]: { id: Items.WOOD_LOG, name: "Wood Log", maxStack: 64, placeBlockId: 4 },
  [Items.LEAVES]: { id: Items.LEAVES, name: "Leaves", maxStack: 64, placeBlockId: 5 },
  [Items.BEDROCK]: { id: Items.BEDROCK, name: "Bedrock", maxStack: 64, placeBlockId: 6 },
  [Items.SAND]: { id: Items.SAND, name: "Sand", maxStack: 64, placeBlockId: 11 },
  [Items.SNOW]: { id: Items.SNOW, name: "Snow", maxStack: 64, placeBlockId: 12 },

  // -------------------------
  // Ore Blocks (Placeable)
  // -------------------------
  [Items.COAL_ORE]: { id: Items.COAL_ORE, name: "Coal Ore", maxStack: 64, placeBlockId: 30 },
  [Items.IRON_ORE]: { id: Items.IRON_ORE, name: "Iron Ore", maxStack: 64, placeBlockId: 31 },
  [Items.GOLD_ORE]: { id: Items.GOLD_ORE, name: "Gold Ore", maxStack: 64, placeBlockId: 32 },
  [Items.DIAMOND_ORE]: { id: Items.DIAMOND_ORE, name: "Diamond Ore", maxStack: 64, placeBlockId: 33 },

  // -------------------------
  // Cave Biome Blocks (Placeable)
  // -------------------------
  [Items.DEEPSLATE]: { id: Items.DEEPSLATE, name: "Deepslate", maxStack: 64, placeBlockId: 90 },
  [Items.TUFF]: { id: Items.TUFF, name: "Tuff", maxStack: 64, placeBlockId: 91 },
  [Items.MOSS]: { id: Items.MOSS, name: "Moss", maxStack: 64, placeBlockId: 92 },
  [Items.MOSSY_STONE]: { id: Items.MOSSY_STONE, name: "Mossy Stone", maxStack: 64, placeBlockId: 93 },
  [Items.DRIPSTONE]: { id: Items.DRIPSTONE, name: "Dripstone", maxStack: 64, placeBlockId: 94 },
  [Items.DRIPSTONE_BLOCK]: { id: Items.DRIPSTONE_BLOCK, name: "Dripstone Block", maxStack: 64, placeBlockId: 95 },
  [Items.GLOW_SHROOM]: { id: Items.GLOW_SHROOM, name: "Glow Shroom", maxStack: 64, placeBlockId: 96 },
  [Items.CRYSTAL]: { id: Items.CRYSTAL, name: "Crystal", maxStack: 64, placeBlockId: 97 },

  // -------------------------
  // Materials / Drops
  // -------------------------
  [Items.COAL]: { id: Items.COAL, name: "Coal", maxStack: 64 },
  [Items.RAW_IRON]: { id: Items.RAW_IRON, name: "Raw Iron", maxStack: 64 },
  [Items.RAW_GOLD]: { id: Items.RAW_GOLD, name: "Raw Gold", maxStack: 64 },
  [Items.DIAMOND]: { id: Items.DIAMOND, name: "Diamond", maxStack: 64 },

  // -------------------------
  // Tools
  // -------------------------
  [Items.WOOD_PICK]: { 
    id: Items.WOOD_PICK, 
    name: "Wooden Pickaxe", 
    maxStack: 1,
    tool: { kind: "pick", tier: 1, speedMul: 1.5, maxDurability: 60 }
  },
  [Items.STONE_PICK]: { 
    id: Items.STONE_PICK, 
    name: "Stone Pickaxe", 
    maxStack: 1,
    tool: { kind: "pick", tier: 2, speedMul: 3.0, maxDurability: 132 }
  },
  [Items.IRON_PICK]: { 
    id: Items.IRON_PICK, 
    name: "Iron Pickaxe", 
    maxStack: 1,
    tool: { kind: "pick", tier: 3, speedMul: 6.0, maxDurability: 250 }
  },

  // -------------------------
  // Awakening Stones
  // -------------------------
  [Items.STONE_IRON]: { id: Items.STONE_IRON, name: "Iron Awakening Stone", maxStack: 64 },
  [Items.STONE_SHADOW]: { id: Items.STONE_SHADOW, name: "Shadow Awakening Stone", maxStack: 64 },
  [Items.STONE_BLOOD]: { id: Items.STONE_BLOOD, name: "Blood Awakening Stone", maxStack: 64 },
  [Items.STONE_ASTRAL]: { id: Items.STONE_ASTRAL, name: "Astral Awakening Stone", maxStack: 64 },

  // -------------------------
  // Skill Gems
  // -------------------------
  [Items.SKILL_AURA_SLASH]: { id: Items.SKILL_AURA_SLASH, name: "Skill Gem: Aura Slash", maxStack: 1 },
  [Items.SKILL_AURA_HEAVY]: { id: Items.SKILL_AURA_HEAVY, name: "Skill Gem: Aura Heavy", maxStack: 1 },
  [Items.SKILL_AURA_THRUST]: { id: Items.SKILL_AURA_THRUST, name: "Skill Gem: Aura Thrust", maxStack: 1 },
  [Items.SKILL_NATURE_GRASP]: { id: Items.SKILL_NATURE_GRASP, name: "Skill Gem: Nature's Grasp", maxStack: 1 },
};

export const RECIPES: Recipe[] = [
  {
    id: "craft_wood_pick",
    inputs: [{ id: Items.WOOD_LOG, count: 2 }],
    output: { id: Items.WOOD_PICK, count: 1 }
  },
  {
    id: "craft_stone_pick",
    inputs: [
      { id: Items.WOOD_LOG, count: 1 },
      { id: Items.STONE, count: 3 }
    ],
    output: { id: Items.STONE_PICK, count: 1 }
  },
  {
    id: "craft_iron_pick",
    inputs: [
      { id: Items.WOOD_LOG, count: 1 },
      { id: Items.RAW_IRON, count: 3 }
    ],
    output: { id: Items.IRON_PICK, count: 1 }
  }
];