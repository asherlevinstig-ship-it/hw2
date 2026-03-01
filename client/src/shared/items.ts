// server/src/shared/items.ts
// FULL FILE - No Omits
// Shared items/defs/recipes (single source of truth for server).
//
// Includes:
// - All Terrain & Cave Blocks
// - Loot Chest (ID 8)
// - Wooden Sign (ID 9)
// - Tools (Picks) & Weapons (Swords, Axes)
// - Minerals & Crafting Materials
// - Awakening Stones & Virtual Skills
// - Full Recipe Registry

export const Items = {
  // --- BLOCKS (Placeable) ---
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,
  SAND: 6,
  SNOW: 7,
  CHEST: 8, // Interactive Container
  SIGN: 9,  // Text-based Signage

  // --- CAVE BIOME BLOCKS ---
  DEEPSLATE: 90,
  TUFF: 91,
  MOSS: 92,
  MOSSY_STONE: 93,
  DRIPSTONE: 94,        // Pointed
  DRIPSTONE_BLOCK: 95,  // Solid
  GLOW_SHROOM: 96,
  CRYSTAL: 97,

  // --- CRAFTING MATERIALS ---
  PLANK: 10,
  STICK: 11,

  // --- TOOLS (Pickaxes) ---
  WOOD_PICK: 20,
  STONE_PICK: 21,
  IRON_PICK: 22,
  DIAMOND_PICK: 23,

  // --- WEAPONS (Swords) ---
  WOOD_SWORD: 40,
  STONE_SWORD: 41,
  IRON_SWORD: 42,
  DIAMOND_SWORD: 43,

  // --- WEAPONS (Axes) ---
  WOOD_AXE: 50,
  STONE_AXE: 51,
  IRON_AXE: 52,
  DIAMOND_AXE: 53,

  // --- MINERALS ---
  COAL: 30,
  RAW_IRON: 31,
  RAW_GOLD: 32,
  DIAMOND: 33,

  // --- AWAKENING STONES (Class Changers) ---
  STONE_IRON: 200,   // Vanguard
  STONE_SHADOW: 201, // Nightblade
  STONE_BLOOD: 202,  // Bloodrager
  STONE_ASTRAL: 203, // Spellblade

  // --- VIRTUAL SKILLS (Not dropped, used in UI/Logic) ---
  SKILL_AURA_SLASH: 1001,
  SKILL_AURA_HEAVY: 1002,
  SKILL_AURA_THRUST: 1003,
  SKILL_NATURE_GRASP: 1004,
} as const;

export type ItemStack = { id: number; count: number; dur?: number };

export type ToolKind = "pick" | "sword" | "axe";

export type ToolDef = {
  kind: ToolKind;
  tier: number;       // 1=Wood, 2=Stone, 3=Iron, 4=Diamond
  maxDurability: number; 
  speedMul: number;   // Mining speed multiplier (higher is faster)
};

export type ItemDef = {
  id: number;
  name: string;
  icon: string;       // Full URL to SVG icon (Iconify)
  fallback: string;   // Emoji fallback
  color: string;      // Hex color for UI borders/text
  maxStack: number;
  placeBlockId?: number; // If set, placing this item creates this block ID
  tool?: ToolDef;     // If set, item functions as a tool/weapon
};

// --- CLIENT BLOCK ID MAPPING ---
// These must match the IDs registered in the client's NOA registry
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;
const SAND_ID = 11;
const SNOW_ID = 12;
const CHEST_ID = 8;
const SIGN_ID = 9;

const DEEPSLATE_ID = 90;
const TUFF_ID = 91;
const MOSS_ID = 92;
const MOSSY_STONE_ID = 93;
const DRIPSTONE_ID = 94;        
const DRIPSTONE_BLOCK_ID = 95;  
const GLOW_SHROOM_ID = 96;      
const CRYSTAL_ID = 97;

// Iconify Game Icons Collection (Stable CDN)
const ICON_BASE = "https://api.iconify.design/game-icons";

export const ITEM_DEFS: Record<number, ItemDef> = {
  // --- BLOCKS ---
  1: { id: 1, name: "Grass", icon: `${ICON_BASE}/grass.svg`, fallback: "🌿", color: "#4CAF50", maxStack: 64, placeBlockId: GRASS_ID },
  2: { id: 2, name: "Dirt", icon: `${ICON_BASE}/ground-sprout.svg`, fallback: "🟫", color: "#795548", maxStack: 64, placeBlockId: DIRT_ID },
  3: { id: 3, name: "Stone", icon: `${ICON_BASE}/stone-block.svg`, fallback: "🌑", color: "#9E9E9E", maxStack: 64, placeBlockId: STONE_ID },
  4: { id: 4, name: "Wood", icon: `${ICON_BASE}/wood-beam.svg`, fallback: "🪵", color: "#8D6E63", maxStack: 64, placeBlockId: WOOD_ID },
  5: { id: 5, name: "Leaves", icon: `${ICON_BASE}/vine-leaf.svg`, fallback: "🍃", color: "#66BB6A", maxStack: 64, placeBlockId: LEAVES_ID },
  6: { id: 6, name: "Sand", icon: `${ICON_BASE}/dust-cloud.svg`, fallback: "🏜️", color: "#FFF59D", maxStack: 64, placeBlockId: SAND_ID },
  7: { id: 7, name: "Snow", icon: `${ICON_BASE}/snowflake-2.svg`, fallback: "❄️", color: "#E0F7FA", maxStack: 64, placeBlockId: SNOW_ID },
  8: { id: 8, name: "Loot Chest", icon: `${ICON_BASE}/locked-chest.svg`, fallback: "🧳", color: "#FFB74D", maxStack: 64, placeBlockId: CHEST_ID },
  9: { id: 9, name: "Wooden Sign", icon: `${ICON_BASE}/wooden-sign.svg`, fallback: "🪧", color: "#8D6E63", maxStack: 16, placeBlockId: SIGN_ID },

  // --- CAVE BLOCKS ---
  90: { id: 90, name: "Deepslate", icon: `${ICON_BASE}/rock.svg`, fallback: "⬛", color: "#37474F", maxStack: 64, placeBlockId: DEEPSLATE_ID },
  91: { id: 91, name: "Tuff", icon: `${ICON_BASE}/pumice.svg`, fallback: "🌪️", color: "#78909C", maxStack: 64, placeBlockId: TUFF_ID },
  92: { id: 92, name: "Moss", icon: `${ICON_BASE}/mossy-stone.svg`, fallback: "🟢", color: "#69F0AE", maxStack: 64, placeBlockId: MOSS_ID },
  93: { id: 93, name: "Mossy Stone", icon: `${ICON_BASE}/stone-pile.svg`, fallback: "🦠", color: "#4DB6AC", maxStack: 64, placeBlockId: MOSSY_STONE_ID },
  94: { id: 94, name: "Pointed Dripstone", icon: `${ICON_BASE}/stalactites.svg`, fallback: "🔻", color: "#8D6E63", maxStack: 64, placeBlockId: DRIPSTONE_ID },
  95: { id: 95, name: "Dripstone Block", icon: `${ICON_BASE}/stone-wall.svg`, fallback: "🟤", color: "#5D4037", maxStack: 64, placeBlockId: DRIPSTONE_BLOCK_ID },
  96: { id: 96, name: "Glow Shroom", icon: `${ICON_BASE}/mushroom.svg`, fallback: "🍄", color: "#00E5FF", maxStack: 64, placeBlockId: GLOW_SHROOM_ID },
  97: { id: 97, name: "Cave Crystal", icon: `${ICON_BASE}/crystal-growth.svg`, fallback: "💠", color: "#D500F9", maxStack: 64, placeBlockId: CRYSTAL_ID },

  // --- CRAFTING MATERIALS ---
  10: { id: 10, name: "Planks", icon: `${ICON_BASE}/wooden-crate.svg`, fallback: "🪜", color: "#A1887F", maxStack: 64 },
  11: { id: 11, name: "Stick", icon: `${ICON_BASE}/bo.svg`, fallback: "🥢", color: "#8D6E63", maxStack: 64 },

  // --- PICKAXES ---
  20: { id: 20, name: "Wood Pick", icon: `${ICON_BASE}/pick-of-destiny.svg`, fallback: "⛏️", color: "#8D6E63", maxStack: 1, tool: { kind: "pick", tier: 1, maxDurability: 60, speedMul: 0.65 } },
  21: { id: 21, name: "Stone Pick", icon: `${ICON_BASE}/miner.svg`, fallback: "⛏️", color: "#BDBDBD", maxStack: 1, tool: { kind: "pick", tier: 2, maxDurability: 132, speedMul: 0.48 } },
  22: { id: 22, name: "Iron Pick", icon: `${ICON_BASE}/mining.svg`, fallback: "⛏️", color: "#ECEFF1", maxStack: 1, tool: { kind: "pick", tier: 3, maxDurability: 251, speedMul: 0.34 } },
  23: { id: 23, name: "Diamond Pick", icon: `${ICON_BASE}/mining.svg`, fallback: "⛏️", color: "#00E5FF", maxStack: 1, tool: { kind: "pick", tier: 4, maxDurability: 1561, speedMul: 0.2 } },

  // --- SWORDS ---
  40: { id: 40, name: "Wood Sword", icon: `${ICON_BASE}/wood-club.svg`, fallback: "🗡️", color: "#8D6E63", maxStack: 1, tool: { kind: "sword", tier: 1, maxDurability: 60, speedMul: 1.0 } },
  41: { id: 41, name: "Stone Sword", icon: `${ICON_BASE}/stone-sword.svg`, fallback: "🗡️", color: "#BDBDBD", maxStack: 1, tool: { kind: "sword", tier: 2, maxDurability: 132, speedMul: 1.0 } },
  42: { id: 42, name: "Iron Sword", icon: `${ICON_BASE}/broadsword.svg`, fallback: "🗡️", color: "#ECEFF1", maxStack: 1, tool: { kind: "sword", tier: 3, maxDurability: 251, speedMul: 1.0 } },
  43: { id: 43, name: "Diamond Sword", icon: `${ICON_BASE}/crystal-sword.svg`, fallback: "🗡️", color: "#00E5FF", maxStack: 1, tool: { kind: "sword", tier: 4, maxDurability: 1561, speedMul: 1.0 } },

  // --- AXES ---
  50: { id: 50, name: "Wood Axe", icon: `${ICON_BASE}/wood-axe.svg`, fallback: "🪓", color: "#8D6E63", maxStack: 1, tool: { kind: "axe", tier: 1, maxDurability: 60, speedMul: 0.65 } },
  51: { id: 51, name: "Stone Axe", icon: `${ICON_BASE}/stone-axe.svg`, fallback: "🪓", color: "#BDBDBD", maxStack: 1, tool: { kind: "axe", tier: 2, maxDurability: 132, speedMul: 0.48 } },
  52: { id: 52, name: "Iron Axe", icon: `${ICON_BASE}/battle-axe.svg`, fallback: "🪓", color: "#ECEFF1", maxStack: 1, tool: { kind: "axe", tier: 3, maxDurability: 251, speedMul: 0.34 } },
  53: { id: 53, name: "Diamond Axe", icon: `${ICON_BASE}/battered-axe.svg`, fallback: "🪓", color: "#00E5FF", maxStack: 1, tool: { kind: "axe", tier: 4, maxDurability: 1561, speedMul: 0.2 } },

  // --- MINERALS ---
  30: { id: 30, name: "Coal", icon: `${ICON_BASE}/ember-shot.svg`, fallback: "⚫", color: "#212121", maxStack: 64 },
  31: { id: 31, name: "Raw Iron", icon: `${ICON_BASE}/iron-ingot.svg`, fallback: "🧱", color: "#D7CCC8", maxStack: 64 },
  32: { id: 32, name: "Raw Gold", icon: `${ICON_BASE}/gold-nugget.svg`, fallback: "🟡", color: "#FFD54F", maxStack: 64 },
  33: { id: 33, name: "Diamond", icon: `${ICON_BASE}/diamond-hard.svg`, fallback: "💎", color: "#00E5FF", maxStack: 64 },

  // --- AWAKENING STONES ---
  200: { id: 200, name: "Iron Awakening Stone", icon: `${ICON_BASE}/shield-bash.svg`, fallback: "🛡️", color: "#B0BEC5", maxStack: 10 },
  201: { id: 201, name: "Shadow Awakening Stone", icon: `${ICON_BASE}/hooded-figure.svg`, fallback: "🌚", color: "#7E57C2", maxStack: 10 },
  202: { id: 202, name: "Blood Awakening Stone", icon: `${ICON_BASE}/droplets.svg`, fallback: "🩸", color: "#EF5350", maxStack: 10 },
  203: { id: 203, name: "Astral Awakening Stone", icon: `${ICON_BASE}/runes.svg`, fallback: "✨", color: "#29B6F6", maxStack: 10 },

  // --- SKILLS ---
  1001: { id: 1001, name: "[Skill] Aura Slash", icon: `${ICON_BASE}/swords-power.svg`, fallback: "🗡️", color: "#00E676", maxStack: 1 },
  1002: { id: 1002, name: "[Skill] Aura Heavy", icon: `${ICON_BASE}/hammer-drop.svg`, fallback: "🔨", color: "#FFA726", maxStack: 1 },
  1003: { id: 1003, name: "[Skill] Aura Thrust", icon: `${ICON_BASE}/piercing-sword.svg`, fallback: "📍", color: "#29B6F6", maxStack: 1 },
  1004: { id: 1004, name: "[Skill] Nature Grasp", icon: `${ICON_BASE}/vine-whip.svg`, fallback: "🌿", color: "#66BB6A", maxStack: 1 },
};

export type Recipe = {
  id: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

export const RECIPES: Recipe[] = [
  // Basics
  { id: "planks_from_log", inputs: [{ id: Items.WOOD_LOG, count: 1 }], output: { id: Items.PLANK, count: 4 } },
  { id: "sticks_from_planks", inputs: [{ id: Items.PLANK, count: 2 }], output: { id: Items.STICK, count: 4 } },
  { id: "wooden_sign", inputs: [{ id: Items.PLANK, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.SIGN, count: 1 } },

  // Picks
  { id: "wood_pick", inputs: [{ id: Items.PLANK, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_PICK, count: 1 } },
  { id: "stone_pick", inputs: [{ id: Items.STONE, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.STONE_PICK, count: 1 } },
  { id: "iron_pick", inputs: [{ id: Items.RAW_IRON, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.IRON_PICK, count: 1 } },
  { id: "diamond_pick", inputs: [{ id: Items.DIAMOND, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.DIAMOND_PICK, count: 1 } },

  // Swords
  { id: "wood_sword", inputs: [{ id: Items.PLANK, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.WOOD_SWORD, count: 1 } },
  { id: "stone_sword", inputs: [{ id: Items.STONE, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.STONE_SWORD, count: 1 } },
  { id: "iron_sword", inputs: [{ id: Items.RAW_IRON, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.IRON_SWORD, count: 1 } },
  { id: "diamond_sword", inputs: [{ id: Items.DIAMOND, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.DIAMOND_SWORD, count: 1 } },

  // Axes
  { id: "wood_axe", inputs: [{ id: Items.PLANK, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_AXE, count: 1 } },
  { id: "stone_axe", inputs: [{ id: Items.STONE, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.STONE_AXE, count: 1 } },
  { id: "iron_axe", inputs: [{ id: Items.RAW_IRON, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.IRON_AXE, count: 1 } },
  { id: "diamond_axe", inputs: [{ id: Items.DIAMOND, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.DIAMOND_AXE, count: 1 } },
];