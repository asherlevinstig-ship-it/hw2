// server/src/shared/items.ts
// FULL FILE - No Omits
// Shared items/defs/recipes (single source of truth for server).
//
// Includes:
// - All Terrain & Cave Blocks
// - Interior Town Blocks (Planks, Stone Bricks, Carpet, Glass, Lantern)
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

  // --- INTERIOR BLOCKS ---
  PLANKS: 40,
  STONE_BRICKS: 41,
  CARPET: 42,
  GLASS: 43,
  LANTERN: 44,

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
  STICK: 11,

  // --- TOOLS (Pickaxes) ---
  WOOD_PICK: 20,
  STONE_PICK: 21,
  IRON_PICK: 22,
  DIAMOND_PICK: 23,

  // --- WEAPONS (Swords) ---
  WOOD_SWORD: 400, // Shifted ID to avoid collision with PLANKS
  STONE_SWORD: 410,
  IRON_SWORD: 420,
  DIAMOND_SWORD: 430,

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
// These must match the IDs registered in the client's block registry
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;
const SAND_ID = 11;
const SNOW_ID = 12;
const CHEST_ID = 8;
const SIGN_ID = 9;

const PLANKS_ID = 40;
const STONE_BRICKS_ID = 41;
const CARPET_ID = 42;
const GLASS_ID = 43;
const LANTERN_ID = 44;

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
  [Items.GRASS]: { id: Items.GRASS, name: "Grass", icon: `${ICON_BASE}/grass.svg`, fallback: "🌿", color: "#4CAF50", maxStack: 64, placeBlockId: GRASS_ID },
  [Items.DIRT]: { id: Items.DIRT, name: "Dirt", icon: `${ICON_BASE}/ground-sprout.svg`, fallback: "🟫", color: "#795548", maxStack: 64, placeBlockId: DIRT_ID },
  [Items.STONE]: { id: Items.STONE, name: "Stone", icon: `${ICON_BASE}/stone-block.svg`, fallback: "🌑", color: "#9E9E9E", maxStack: 64, placeBlockId: STONE_ID },
  [Items.WOOD_LOG]: { id: Items.WOOD_LOG, name: "Wood", icon: `${ICON_BASE}/wood-beam.svg`, fallback: "🪵", color: "#8D6E63", maxStack: 64, placeBlockId: WOOD_ID },
  [Items.LEAVES]: { id: Items.LEAVES, name: "Leaves", icon: `${ICON_BASE}/vine-leaf.svg`, fallback: "🍃", color: "#66BB6A", maxStack: 64, placeBlockId: LEAVES_ID },
  [Items.SAND]: { id: Items.SAND, name: "Sand", icon: `${ICON_BASE}/dust-cloud.svg`, fallback: "🏜️", color: "#FFF59D", maxStack: 64, placeBlockId: SAND_ID },
  [Items.SNOW]: { id: Items.SNOW, name: "Snow", icon: `${ICON_BASE}/snowflake-2.svg`, fallback: "❄️", color: "#E0F7FA", maxStack: 64, placeBlockId: SNOW_ID },
  [Items.CHEST]: { id: Items.CHEST, name: "Loot Chest", icon: `${ICON_BASE}/locked-chest.svg`, fallback: "🧳", color: "#FFB74D", maxStack: 64, placeBlockId: CHEST_ID },
  [Items.SIGN]: { id: Items.SIGN, name: "Wooden Sign", icon: `${ICON_BASE}/wooden-sign.svg`, fallback: "🪧", color: "#8D6E63", maxStack: 16, placeBlockId: SIGN_ID },

  // --- INTERIOR BLOCKS ---
  [Items.PLANKS]: { id: Items.PLANKS, name: "Planks", icon: `${ICON_BASE}/wooden-crate.svg`, fallback: "🪜", color: "#A1887F", maxStack: 64, placeBlockId: PLANKS_ID },
  [Items.STONE_BRICKS]: { id: Items.STONE_BRICKS, name: "Stone Bricks", icon: `${ICON_BASE}/brick-wall.svg`, fallback: "🧱", color: "#9E9E9E", maxStack: 64, placeBlockId: STONE_BRICKS_ID },
  [Items.CARPET]: { id: Items.CARPET, name: "Carpet", icon: `${ICON_BASE}/magic-carpet.svg`, fallback: "🟥", color: "#E53935", maxStack: 64, placeBlockId: CARPET_ID },
  [Items.GLASS]: { id: Items.GLASS, name: "Glass", icon: `${ICON_BASE}/cube.svg`, fallback: "🧊", color: "#81D4FA", maxStack: 64, placeBlockId: GLASS_ID },
  [Items.LANTERN]: { id: Items.LANTERN, name: "Lantern", icon: `${ICON_BASE}/lantern.svg`, fallback: "🏮", color: "#FFCA28", maxStack: 64, placeBlockId: LANTERN_ID },

  // --- CAVE BLOCKS ---
  [Items.DEEPSLATE]: { id: Items.DEEPSLATE, name: "Deepslate", icon: `${ICON_BASE}/rock.svg`, fallback: "⬛", color: "#37474F", maxStack: 64, placeBlockId: DEEPSLATE_ID },
  [Items.TUFF]: { id: Items.TUFF, name: "Tuff", icon: `${ICON_BASE}/pumice.svg`, fallback: "🌪️", color: "#78909C", maxStack: 64, placeBlockId: TUFF_ID },
  [Items.MOSS]: { id: Items.MOSS, name: "Moss", icon: `${ICON_BASE}/mossy-stone.svg`, fallback: "🟢", color: "#69F0AE", maxStack: 64, placeBlockId: MOSS_ID },
  [Items.MOSSY_STONE]: { id: Items.MOSSY_STONE, name: "Mossy Stone", icon: `${ICON_BASE}/stone-pile.svg`, fallback: "🦠", color: "#4DB6AC", maxStack: 64, placeBlockId: MOSSY_STONE_ID },
  [Items.DRIPSTONE]: { id: Items.DRIPSTONE, name: "Pointed Dripstone", icon: `${ICON_BASE}/stalactites.svg`, fallback: "🔻", color: "#8D6E63", maxStack: 64, placeBlockId: DRIPSTONE_ID },
  [Items.DRIPSTONE_BLOCK]: { id: Items.DRIPSTONE_BLOCK, name: "Dripstone Block", icon: `${ICON_BASE}/stone-wall.svg`, fallback: "🟤", color: "#5D4037", maxStack: 64, placeBlockId: DRIPSTONE_BLOCK_ID },
  [Items.GLOW_SHROOM]: { id: Items.GLOW_SHROOM, name: "Glow Shroom", icon: `${ICON_BASE}/mushroom.svg`, fallback: "🍄", color: "#00E5FF", maxStack: 64, placeBlockId: GLOW_SHROOM_ID },
  [Items.CRYSTAL]: { id: Items.CRYSTAL, name: "Cave Crystal", icon: `${ICON_BASE}/crystal-growth.svg`, fallback: "💠", color: "#D500F9", maxStack: 64, placeBlockId: CRYSTAL_ID },

  // --- CRAFTING MATERIALS ---
  [Items.STICK]: { id: Items.STICK, name: "Stick", icon: `${ICON_BASE}/bo.svg`, fallback: "🥢", color: "#8D6E63", maxStack: 64 },

  // --- PICKAXES ---
  [Items.WOOD_PICK]: { id: Items.WOOD_PICK, name: "Wood Pick", icon: `${ICON_BASE}/pick-of-destiny.svg`, fallback: "⛏️", color: "#8D6E63", maxStack: 1, tool: { kind: "pick", tier: 1, maxDurability: 60, speedMul: 0.65 } },
  [Items.STONE_PICK]: { id: Items.STONE_PICK, name: "Stone Pick", icon: `${ICON_BASE}/miner.svg`, fallback: "⛏️", color: "#BDBDBD", maxStack: 1, tool: { kind: "pick", tier: 2, maxDurability: 132, speedMul: 0.48 } },
  [Items.IRON_PICK]: { id: Items.IRON_PICK, name: "Iron Pick", icon: `${ICON_BASE}/mining.svg`, fallback: "⛏️", color: "#ECEFF1", maxStack: 1, tool: { kind: "pick", tier: 3, maxDurability: 251, speedMul: 0.34 } },
  [Items.DIAMOND_PICK]: { id: Items.DIAMOND_PICK, name: "Diamond Pick", icon: `${ICON_BASE}/mining.svg`, fallback: "⛏️", color: "#00E5FF", maxStack: 1, tool: { kind: "pick", tier: 4, maxDurability: 1561, speedMul: 0.2 } },

  // --- SWORDS ---
  [Items.WOOD_SWORD]: { id: Items.WOOD_SWORD, name: "Wood Sword", icon: `${ICON_BASE}/wood-club.svg`, fallback: "🗡️", color: "#8D6E63", maxStack: 1, tool: { kind: "sword", tier: 1, maxDurability: 60, speedMul: 1.0 } },
  [Items.STONE_SWORD]: { id: Items.STONE_SWORD, name: "Stone Sword", icon: `${ICON_BASE}/stone-sword.svg`, fallback: "🗡️", color: "#BDBDBD", maxStack: 1, tool: { kind: "sword", tier: 2, maxDurability: 132, speedMul: 1.0 } },
  [Items.IRON_SWORD]: { id: Items.IRON_SWORD, name: "Iron Sword", icon: `${ICON_BASE}/broadsword.svg`, fallback: "🗡️", color: "#ECEFF1", maxStack: 1, tool: { kind: "sword", tier: 3, maxDurability: 251, speedMul: 1.0 } },
  [Items.DIAMOND_SWORD]: { id: Items.DIAMOND_SWORD, name: "Diamond Sword", icon: `${ICON_BASE}/crystal-sword.svg`, fallback: "🗡️", color: "#00E5FF", maxStack: 1, tool: { kind: "sword", tier: 4, maxDurability: 1561, speedMul: 1.0 } },

  // --- AXES ---
  [Items.WOOD_AXE]: { id: Items.WOOD_AXE, name: "Wood Axe", icon: `${ICON_BASE}/wood-axe.svg`, fallback: "🪓", color: "#8D6E63", maxStack: 1, tool: { kind: "axe", tier: 1, maxDurability: 60, speedMul: 0.65 } },
  [Items.STONE_AXE]: { id: Items.STONE_AXE, name: "Stone Axe", icon: `${ICON_BASE}/stone-axe.svg`, fallback: "🪓", color: "#BDBDBD", maxStack: 1, tool: { kind: "axe", tier: 2, maxDurability: 132, speedMul: 0.48 } },
  [Items.IRON_AXE]: { id: Items.IRON_AXE, name: "Iron Axe", icon: `${ICON_BASE}/battle-axe.svg`, fallback: "🪓", color: "#ECEFF1", maxStack: 1, tool: { kind: "axe", tier: 3, maxDurability: 251, speedMul: 0.34 } },
  [Items.DIAMOND_AXE]: { id: Items.DIAMOND_AXE, name: "Diamond Axe", icon: `${ICON_BASE}/battered-axe.svg`, fallback: "🪓", color: "#00E5FF", maxStack: 1, tool: { kind: "axe", tier: 4, maxDurability: 1561, speedMul: 0.2 } },

  // --- MINERALS ---
  [Items.COAL]: { id: Items.COAL, name: "Coal", icon: `${ICON_BASE}/ember-shot.svg`, fallback: "⚫", color: "#212121", maxStack: 64 },
  [Items.RAW_IRON]: { id: Items.RAW_IRON, name: "Raw Iron", icon: `${ICON_BASE}/iron-ingot.svg`, fallback: "🧱", color: "#D7CCC8", maxStack: 64 },
  [Items.RAW_GOLD]: { id: Items.RAW_GOLD, name: "Raw Gold", icon: `${ICON_BASE}/gold-nugget.svg`, fallback: "🟡", color: "#FFD54F", maxStack: 64 },
  [Items.DIAMOND]: { id: Items.DIAMOND, name: "Diamond", icon: `${ICON_BASE}/diamond-hard.svg`, fallback: "💎", color: "#00E5FF", maxStack: 64 },

  // --- AWAKENING STONES ---
  [Items.STONE_IRON]: { id: Items.STONE_IRON, name: "Iron Awakening Stone", icon: `${ICON_BASE}/shield-bash.svg`, fallback: "🛡️", color: "#B0BEC5", maxStack: 10 },
  [Items.STONE_SHADOW]: { id: Items.STONE_SHADOW, name: "Shadow Awakening Stone", icon: `${ICON_BASE}/hooded-figure.svg`, fallback: "🌚", color: "#7E57C2", maxStack: 10 },
  [Items.STONE_BLOOD]: { id: Items.STONE_BLOOD, name: "Blood Awakening Stone", icon: `${ICON_BASE}/droplets.svg`, fallback: "🩸", color: "#EF5350", maxStack: 10 },
  [Items.STONE_ASTRAL]: { id: Items.STONE_ASTRAL, name: "Astral Awakening Stone", icon: `${ICON_BASE}/runes.svg`, fallback: "✨", color: "#29B6F6", maxStack: 10 },

  // --- SKILLS ---
  [Items.SKILL_AURA_SLASH]: { id: Items.SKILL_AURA_SLASH, name: "[Skill] Aura Slash", icon: `${ICON_BASE}/swords-power.svg`, fallback: "🗡️", color: "#00E676", maxStack: 1 },
  [Items.SKILL_AURA_HEAVY]: { id: Items.SKILL_AURA_HEAVY, name: "[Skill] Aura Heavy", icon: `${ICON_BASE}/hammer-drop.svg`, fallback: "🔨", color: "#FFA726", maxStack: 1 },
  [Items.SKILL_AURA_THRUST]: { id: Items.SKILL_AURA_THRUST, name: "[Skill] Aura Thrust", icon: `${ICON_BASE}/piercing-sword.svg`, fallback: "📍", color: "#29B6F6", maxStack: 1 },
  [Items.SKILL_NATURE_GRASP]: { id: Items.SKILL_NATURE_GRASP, name: "[Skill] Nature Grasp", icon: `${ICON_BASE}/vine-whip.svg`, fallback: "🌿", color: "#66BB6A", maxStack: 1 },
};

export type Recipe = {
  id: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

export const RECIPES: Recipe[] = [
  // Basics
  { id: "planks_from_log", inputs: [{ id: Items.WOOD_LOG, count: 1 }], output: { id: Items.PLANKS, count: 4 } },
  { id: "sticks_from_planks", inputs: [{ id: Items.PLANKS, count: 2 }], output: { id: Items.STICK, count: 4 } },
  { id: "wooden_sign", inputs: [{ id: Items.PLANKS, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.SIGN, count: 1 } },

  // Picks
  { id: "wood_pick", inputs: [{ id: Items.PLANKS, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_PICK, count: 1 } },
  { id: "stone_pick", inputs: [{ id: Items.STONE, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.STONE_PICK, count: 1 } },
  { id: "iron_pick", inputs: [{ id: Items.RAW_IRON, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.IRON_PICK, count: 1 } },
  { id: "diamond_pick", inputs: [{ id: Items.DIAMOND, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.DIAMOND_PICK, count: 1 } },

  // Swords
  { id: "wood_sword", inputs: [{ id: Items.PLANKS, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.WOOD_SWORD, count: 1 } },
  { id: "stone_sword", inputs: [{ id: Items.STONE, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.STONE_SWORD, count: 1 } },
  { id: "iron_sword", inputs: [{ id: Items.RAW_IRON, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.IRON_SWORD, count: 1 } },
  { id: "diamond_sword", inputs: [{ id: Items.DIAMOND, count: 2 }, { id: Items.STICK, count: 1 }], output: { id: Items.DIAMOND_SWORD, count: 1 } },

  // Axes
  { id: "wood_axe", inputs: [{ id: Items.PLANKS, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_AXE, count: 1 } },
  { id: "stone_axe", inputs: [{ id: Items.STONE, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.STONE_AXE, count: 1 } },
  { id: "iron_axe", inputs: [{ id: Items.RAW_IRON, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.IRON_AXE, count: 1 } },
  { id: "diamond_axe", inputs: [{ id: Items.DIAMOND, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.DIAMOND_AXE, count: 1 } },
];