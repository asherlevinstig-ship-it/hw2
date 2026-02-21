/* client/src/main.ts
 * FULL FILE - with Beacon, TS Fixes AND HUD FIX
 * UPDATED: Added Always-Visible Bottom Hotbar
 * UPDATED: Moved Stats HUD up to accommodate Hotbar
 * UPDATED: Cave Biome Blocks (90–97) fully supported client-side
 * UPDATED: Component-based Combat System Wiring
 * UPDATED: Awakening System (Double-click stones, Skill Gem styling, Chat Notifications)
 * UPDATED: Visual Effects (Cleaned of all debugs, rendering completely intact)
 * NEW: Procedural Deepslate Golem Mobs with Orbiting Crystals & Rage Mode
 */

import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core/Legacy/legacy";

/*
 * IMPORTANT:
 * Put your shared items file INSIDE client/src so Vite can resolve it:
 * client/src/shared/items.ts
 */
import {
  Items,
  ITEM_DEFS,
  RECIPES,
  type ItemStack,
  type ItemDef,
} from "./shared/items";

/* ===============================
   1. Colyseus Setup
================================ */
const ENDPOINT = import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";
const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

/* ===============================
   2. DOM & CSS Setup
================================ */
const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Missing <div id='app'></div> in index.html");

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";

appEl.style.position = "absolute";
appEl.style.top = "0";
appEl.style.bottom = "0";
appEl.style.left = "0";
appEl.style.right = "0";
appEl.style.zIndex = "1";

/* ===============================
   3. UI Overlay Setup
================================ */
const overlay = document.createElement("div");
overlay.style.position = "fixed";
overlay.style.left = "10px";
overlay.style.top = "10px";
overlay.style.color = "white";
overlay.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
overlay.style.padding = "10px";
overlay.style.borderRadius = "5px";
overlay.style.fontFamily = "monospace";
overlay.style.fontSize = "14px";
overlay.style.pointerEvents = "none";
overlay.style.userSelect = "none";
overlay.style.zIndex = "100";
document.body.appendChild(overlay);

const coordsHUD = document.createElement("div");
coordsHUD.style.position = "fixed";
coordsHUD.style.top = "12px";
coordsHUD.style.right = "12px";
coordsHUD.style.background = "rgba(0,0,0,0.6)";
coordsHUD.style.color = "white";
coordsHUD.style.padding = "8px 10px";
coordsHUD.style.borderRadius = "6px";
coordsHUD.style.fontFamily = "monospace";
coordsHUD.style.fontSize = "14px";
coordsHUD.style.pointerEvents = "none";
coordsHUD.style.userSelect = "none";
coordsHUD.style.zIndex = "150";
coordsHUD.textContent = "XYZ: ...";
document.body.appendChild(coordsHUD);

const statsHUD = document.createElement("div");
statsHUD.style.position = "fixed";
statsHUD.style.bottom = "90px"; 
statsHUD.style.left = "50%";
statsHUD.style.transform = "translateX(-50%)";
statsHUD.style.display = "flex";
statsHUD.style.flexDirection = "column";
statsHUD.style.gap = "6px";
statsHUD.style.alignItems = "center";
statsHUD.style.pointerEvents = "none";
statsHUD.style.userSelect = "none";
statsHUD.style.zIndex = "150";
document.body.appendChild(statsHUD);

const healthHUD = document.createElement("div");
healthHUD.style.display = "flex";
healthHUD.style.gap = "4px";
statsHUD.appendChild(healthHUD);

const manaHUD = document.createElement("div");
manaHUD.style.display = "flex";
manaHUD.style.gap = "4px";
statsHUD.appendChild(manaHUD);

const hudHotbarRoot = document.createElement("div");
hudHotbarRoot.style.position = "fixed";
hudHotbarRoot.style.bottom = "10px";
hudHotbarRoot.style.left = "50%";
hudHotbarRoot.style.transform = "translateX(-50%)";
hudHotbarRoot.style.display = "flex";
hudHotbarRoot.style.gap = "6px";
hudHotbarRoot.style.zIndex = "150";
hudHotbarRoot.style.pointerEvents = "auto"; 
document.body.appendChild(hudHotbarRoot);

function createStatBlock(fillState: "full" | "half" | "empty", color: string) {
  const el = document.createElement("div");
  el.style.width = "18px";
  el.style.height = "18px";
  el.style.border = "2px solid #111";
  el.style.borderRadius = "2px";
  
  if (fillState === "full") {
    el.style.backgroundColor = color;
    el.style.boxShadow = "inset -3px -3px 0px rgba(0,0,0,0.3), inset 3px 3px 0px rgba(255,255,255,0.4), 2px 2px 4px rgba(0,0,0,0.5)";
  } else if (fillState === "half") {
    el.style.background = `linear-gradient(to right, ${color} 50%, rgba(0,0,0,0.6) 50%)`;
    el.style.boxShadow = "inset 2px 2px 0px rgba(255,255,255,0.3), 2px 2px 4px rgba(0,0,0,0.5)"; 
  } else {
    el.style.backgroundColor = "rgba(0,0,0,0.6)";
    el.style.boxShadow = "inset 2px 2px 5px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,0.5)";
  }
  return el;
}

/* ===============================
   3.1 Inventory UI
================================ */
const invRoot = document.createElement("div");
invRoot.style.position = "fixed";
invRoot.style.left = "50%";
invRoot.style.top = "50%";
invRoot.style.transform = "translate(-50%, -50%)";
invRoot.style.width = "760px";
invRoot.style.maxWidth = "95vw";
invRoot.style.background = "rgba(0,0,0,0.78)";
invRoot.style.border = "1px solid rgba(255,255,255,0.15)";
invRoot.style.borderRadius = "10px";
invRoot.style.padding = "14px";
invRoot.style.color = "white";
invRoot.style.fontFamily = "monospace";
invRoot.style.zIndex = "200";
invRoot.style.pointerEvents = "auto";
invRoot.style.display = "none";
invRoot.style.userSelect = "none";
invRoot.style.boxShadow = "0 10px 30px rgba(0,0,0,0.4)";
document.body.appendChild(invRoot);

invRoot.addEventListener("contextmenu", (e) => e.preventDefault());

const invHeader = document.createElement("div");
invHeader.style.display = "flex";
invHeader.style.alignItems = "center";
invHeader.style.justifyContent = "space-between";
invHeader.style.marginBottom = "10px";
invRoot.appendChild(invHeader);

const invTitle = document.createElement("div");
invTitle.textContent = "Inventory";
invTitle.style.fontSize = "18px";
invTitle.style.fontWeight = "700";
invHeader.appendChild(invTitle);

const invHint = document.createElement("div");
invHint.style.opacity = "0.85";
invHint.style.fontSize = "12px";
invHint.textContent = "LMB: pick/place/stack | RMB: half/place-one | Shift+LMB: quick move | Dbl-Click: Use";
invHeader.appendChild(invHint);

const invMain = document.createElement("div");
invMain.style.display = "grid";
invMain.style.gridTemplateColumns = "1fr 260px";
invMain.style.gap = "12px";
invRoot.appendChild(invMain);

const invLeft = document.createElement("div");
invLeft.style.display = "flex";
invLeft.style.flexDirection = "column";
invLeft.style.gap = "10px";
invMain.appendChild(invLeft);

const invRight = document.createElement("div");
invRight.style.display = "flex";
invRight.style.flexDirection = "column";
invRight.style.gap = "10px";
invMain.appendChild(invRight);

const cursorRow = document.createElement("div");
cursorRow.style.display = "flex";
cursorRow.style.alignItems = "center";
cursorRow.style.gap = "10px";
cursorRow.style.padding = "8px";
cursorRow.style.border = "1px solid rgba(255,255,255,0.12)";
cursorRow.style.borderRadius = "8px";
cursorRow.style.background = "rgba(255,255,255,0.05)";
invLeft.appendChild(cursorRow);

const cursorLabel = document.createElement("div");
cursorLabel.textContent = "Cursor:";
cursorLabel.style.opacity = "0.9";
cursorRow.appendChild(cursorLabel);

const cursorSlotEl = document.createElement("div");
cursorSlotEl.style.width = "64px";
cursorSlotEl.style.height = "64px";
cursorSlotEl.style.borderRadius = "8px";
cursorSlotEl.style.border = "1px solid rgba(255,255,255,0.18)";
cursorSlotEl.style.display = "flex";
cursorSlotEl.style.flexDirection = "column";
cursorSlotEl.style.alignItems = "center";
cursorSlotEl.style.justifyContent = "center";
cursorSlotEl.style.background = "rgba(0,0,0,0.35)";
cursorSlotEl.style.position = "relative";
cursorRow.appendChild(cursorSlotEl);

const cursorNameEl = document.createElement("div");
cursorNameEl.style.fontSize = "11px";
cursorNameEl.style.opacity = "0.95";
cursorNameEl.style.textAlign = "center";
cursorNameEl.style.padding = "0 6px";
cursorNameEl.style.wordBreak = "break-word";
cursorRow.appendChild(cursorNameEl);

const invGridWrap = document.createElement("div");
invGridWrap.style.display = "flex";
invGridWrap.style.flexDirection = "column";
invGridWrap.style.gap = "10px";
invLeft.appendChild(invGridWrap);

const hotbarLabel = document.createElement("div");
hotbarLabel.textContent = "Hotbar (1–5)";
hotbarLabel.style.opacity = "0.9";
invGridWrap.appendChild(hotbarLabel);

const hotbarGrid = document.createElement("div");
hotbarGrid.style.display = "grid";
hotbarGrid.style.gridTemplateColumns = "repeat(5, 64px)";
hotbarGrid.style.gap = "8px";
invGridWrap.appendChild(hotbarGrid);

const backpackLabel = document.createElement("div");
backpackLabel.textContent = "Backpack";
backpackLabel.style.opacity = "0.9";
invGridWrap.appendChild(backpackLabel);

const backpackGrid = document.createElement("div");
backpackGrid.style.display = "grid";
backpackGrid.style.gridTemplateColumns = "repeat(5, 64px)";
backpackGrid.style.gap = "8px";
invGridWrap.appendChild(backpackGrid);

const craftCard = document.createElement("div");
craftCard.style.padding = "10px";
craftCard.style.border = "1px solid rgba(255,255,255,0.12)";
craftCard.style.borderRadius = "8px";
craftCard.style.background = "rgba(255,255,255,0.05)";
invRight.appendChild(craftCard);

const craftTitle = document.createElement("div");
craftTitle.textContent = "Crafting (basic)";
craftTitle.style.fontWeight = "700";
craftTitle.style.marginBottom = "8px";
craftCard.appendChild(craftTitle);

const craftList = document.createElement("div");
craftList.style.display = "flex";
craftList.style.flexDirection = "column";
craftList.style.gap = "8px";
craftCard.appendChild(craftList);

const craftStatus = document.createElement("div");
craftStatus.style.opacity = "0.9";
craftStatus.style.fontSize = "12px";
craftStatus.textContent = "";
invRight.appendChild(craftStatus);

function mkButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.width = "100%";
  b.style.padding = "10px 10px";
  b.style.borderRadius = "8px";
  b.style.border = "1px solid rgba(255,255,255,0.2)";
  b.style.background = "rgba(0,0,0,0.25)";
  b.style.color = "white";
  b.style.cursor = "pointer";
  b.style.fontFamily = "monospace";
  b.style.fontSize = "13px";
  b.onmouseenter = () => (b.style.background = "rgba(255,255,255,0.10)");
  b.onmouseleave = () => (b.style.background = "rgba(0,0,0,0.25)");
  return b;
}

/* ===============================
   4. NOA Engine Initialization
================================ */
const noa = new Engine({
  debug: false,
  container: appEl,
  inverseY: false,
  playerStart: [0, 20, 0],
  tickRate: 30,
  chunkSize: 32,
});

/* ===============================
   4.1 Pointer Lock
================================ */
function requestPointerLock() {
  try {
    const scene = (noa as any).rendering?.getScene?.();
    const canvas =
      scene?.getEngine?.()?.getRenderingCanvas?.() ??
      (noa as any).container ??
      appEl;
    if (canvas?.requestPointerLock) canvas.requestPointerLock();
  } catch {
    if ((appEl as any).requestPointerLock) (appEl as any).requestPointerLock();
  }
}

appEl.addEventListener("click", () => {
  if (!invOpen) requestPointerLock();
});

function hasPointerLock(): boolean {
  return !!(noa.container as any)?.hasPointerLock;
}

/* ===============================
   5. Register Blocks & Materials (16x16 VERTICAL STRIP ATLAS)
================================ */
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;

const BEDROCK_ID = 6;
const COAL_ORE_ID = 30;
const IRON_ORE_ID = 31;
const GOLD_ORE_ID = 32;
const DIAMOND_ORE_ID = 33;

const SAND_ID = 11;
const SNOW_ID = 12;

const DEEPSLATE_ID = 90;
const TUFF_ID = 91;
const MOSS_ID = 92;
const MOSSY_STONE_ID = 93;
const DRIPSTONE_ID = 94;
const DRIPSTONE_BLOCK_ID = 95;
const GLOW_SHROOM_ID = 96;
const CRYSTAL_ID = 97;

const TERRAIN_ATLAS_URL = new URL(
  "./assets/terrain_atlas.png",
  import.meta.url
).href;

const ATLAS = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  WOOD: 4,
  LEAVES: 5,
  BEDROCK: 6,
  COAL_ORE: 7,
  IRON_ORE: 8,
  GOLD_ORE: 9,
  DIAMOND_ORE: 10,

  SAND: 11,
  SNOW: 12,

  DEEPSLATE: 13,
  TUFF: 14,
  MOSS: 15,
  MOSSY_STONE: 16,
  DRIPSTONE: 17,
  DRIPSTONE_BLOCK: 18,
  GLOW_SHROOM: 19,
  CRYSTAL: 20,
} as const;

const ATLAS_TILE_COUNT = 21;

function registerAtlasMaterial(
  name: string,
  opts: { textureURL: string; atlasIndex: number; texHasAlpha?: boolean }
) {
  noa.registry.registerMaterial(name, opts as any);
}

registerAtlasMaterial("grass_top", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.GRASS_TOP });
registerAtlasMaterial("grass_side", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.GRASS_SIDE });
registerAtlasMaterial("dirt", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.DIRT });
registerAtlasMaterial("stone", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.STONE });
registerAtlasMaterial("wood", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.WOOD });
registerAtlasMaterial("leaves", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.LEAVES, texHasAlpha: true });

registerAtlasMaterial("bedrock", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.BEDROCK });
registerAtlasMaterial("coal_ore", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.COAL_ORE });
registerAtlasMaterial("iron_ore", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.IRON_ORE });
registerAtlasMaterial("gold_ore", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.GOLD_ORE });
registerAtlasMaterial("diamond_ore", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.DIAMOND_ORE });

registerAtlasMaterial("sand", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.SAND });
registerAtlasMaterial("snow", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.SNOW });

registerAtlasMaterial("deepslate", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.DEEPSLATE });
registerAtlasMaterial("tuff", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.TUFF });
registerAtlasMaterial("moss", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.MOSS, texHasAlpha: true });
registerAtlasMaterial("mossy_stone", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.MOSSY_STONE });
registerAtlasMaterial("dripstone", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.DRIPSTONE, texHasAlpha: true });
registerAtlasMaterial("dripstone_block", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.DRIPSTONE_BLOCK });
registerAtlasMaterial("glow_shroom", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.GLOW_SHROOM, texHasAlpha: true });
registerAtlasMaterial("crystal", { textureURL: TERRAIN_ATLAS_URL, atlasIndex: ATLAS.CRYSTAL, texHasAlpha: true });

noa.registry.registerBlock(GRASS_ID, { material: ["grass_top", "dirt", "grass_side"] });
noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });
noa.registry.registerBlock(WOOD_ID, { material: "wood" });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves", opaque: false });

noa.registry.registerBlock(BEDROCK_ID, { material: "bedrock" });
noa.registry.registerBlock(COAL_ORE_ID, { material: "coal_ore" });
noa.registry.registerBlock(IRON_ORE_ID, { material: "iron_ore" });
noa.registry.registerBlock(GOLD_ORE_ID, { material: "gold_ore" });
noa.registry.registerBlock(DIAMOND_ORE_ID, { material: "diamond_ore" });

noa.registry.registerBlock(SAND_ID, { material: "sand" });
noa.registry.registerBlock(SNOW_ID, { material: "snow" });

noa.registry.registerBlock(DEEPSLATE_ID, { material: "deepslate" });
noa.registry.registerBlock(TUFF_ID, { material: "tuff" });
noa.registry.registerBlock(MOSS_ID, { material: "moss", opaque: false });
noa.registry.registerBlock(MOSSY_STONE_ID, { material: "mossy_stone" });
noa.registry.registerBlock(DRIPSTONE_ID, { material: "dripstone", opaque: false });
noa.registry.registerBlock(DRIPSTONE_BLOCK_ID, { material: "dripstone_block" });
noa.registry.registerBlock(GLOW_SHROOM_ID, { material: "glow_shroom", opaque: false });
noa.registry.registerBlock(CRYSTAL_ID, { material: "crystal", opaque: false });

/* ===============================
   5.1 Debug Tools: ID Registry & Structure Validation
================================ */
const REGISTERED_BLOCK_IDS = new Set<number>([
  GRASS_ID, DIRT_ID, STONE_ID, WOOD_ID, LEAVES_ID, BEDROCK_ID,
  COAL_ORE_ID, IRON_ORE_ID, GOLD_ORE_ID, DIAMOND_ORE_ID,
  SAND_ID, SNOW_ID, DEEPSLATE_ID, TUFF_ID, MOSS_ID,
  MOSSY_STONE_ID, DRIPSTONE_ID, DRIPSTONE_BLOCK_ID, GLOW_SHROOM_ID, CRYSTAL_ID,
]);

function isRegisteredBlockId(id: number) {
  return id === 0 || REGISTERED_BLOCK_IDS.has(id); 
}

(globalThis as any).__debugStructureIds = (structure: any) => {
  if (!structure || !Array.isArray(structure.blocks)) {
    console.warn("[STRUCT] invalid structure (missing blocks array)");
    return;
  }

  const counts = new Map<number, number>();
  let missingId = 0;

  for (const b of structure.blocks) {
    const id = Number((b as any)?.id);
    if (!Number.isFinite(id)) {
      missingId++;
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const unknown = sorted.filter(([id]) => !isRegisteredBlockId(id));

  console.log("[STRUCT] block id counts:", sorted.slice(0, 30).map(([id, c]) => ({ id, count: c })));
  console.log("[STRUCT] unknown ids (NOT registered client-side):", unknown.map(([id, c]) => ({ id, count: c })));
  console.log("[STRUCT] blocks missing/invalid id fields:", missingId);
};

(globalThis as any).__listRegisteredBlocks = () => {
  console.log("[STRUCT] REGISTERED_BLOCK_IDS:", Array.from(REGISTERED_BLOCK_IDS.values()).sort((a, b) => a - b));
};

/* ===============================
   6. Inventory & Combat/Stats State
================================ */
type PlayerStats = {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
};

type InvState = { 
  slots: ItemStack[]; 
  cursor: ItemStack;
  stats: PlayerStats; 
};

const HOTBAR_SLOTS = 5;
const BACKPACK_SLOTS = 20;
const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

let invOpen = false;
let invState: InvState = {
  slots: Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 })),
  cursor: { id: 0, count: 0 },
  stats: { hp: 20, maxHp: 20, mana: 50, maxMana: 50 }
};

let selectedHotbar = 0;
let viewModelEnabled = true;

let remotePlayersEnabled = true;
let remoteXray = true; 

let DEBUG_PARTICLES_ALWAYS = false;

let myHp = 20;
let myMaxHp = 20;
let myMana = 50;
let myMaxMana = 50;

const remoteFlashes = new Map<string, number>(); 
const remoteSwings = new Map<string, number>();  

/* ===============================
   6.0 Safe Zone state
================================ */
type SafeZoneMsg = { x: number; z: number; r: number };
let safeZone: SafeZoneMsg | null = null;

function isFiniteNum(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isInSafeZoneXZ(x: number, z: number): boolean {
  if (!safeZone) return false;
  const dx = x + 0.5 - safeZone.x;
  const dz = z + 0.5 - safeZone.z;
  return dx * dx + dz * dz <= safeZone.r * safeZone.r;
}

/* ===============================
   6.1 Viewmodel Debug/Tuning State
================================ */
let vmDebug = false;
let vmTuning = false;
let vmMirrorX = true;

let vmBaseXMul = 0.74;
let vmBaseY = -0.68;

let vmRotX = 0.22;
let vmRotY = 0.1;
let vmRotZ = -0.58;

let vmPitchMul = 0.45;
let vmPunchRotMul = 0.75;
let vmTurnSwayMulY = 0.35;
let vmTurnSwayMulZ = 0.25;
let vmPunchMoveX = 0.12;
let vmPunchMoveY = 0.08;

/* ===============================
   6.2 Remote state
================================ */
type NetTransform = { 
  x: number; 
  y: number; 
  z: number; 
  yaw?: number;
  hp?: number;
  maxHp?: number;
};
const netTransforms = new Map<string, NetTransform>();

let lastSnapshotIds: string[] = [];
let lastSnapshotAt = 0;
let lastTransformAt = 0;

/* ===============================
   6.3 Drops state
================================ */
type Drop = {
  dropId: string;
  itemId: number;
  count: number;
  x: number;
  y: number;
  z: number;
  createdAt: number;
};
const drops = new Map<string, Drop>();

const dropMeshes = new Map<string, BABYLON.AbstractMesh>();
let dropSceneUid: string | number | null = null;

let lastPickupScanAt = 0;
let lastPickupSentAt = 0;
const pickupSentRecently = new Map<string, number>();

/* ===============================
   6.4 Inventory UI rendering + events
================================ */
const slotEls: HTMLDivElement[] = [];
const backpackEls: HTMLDivElement[] = [];
const hudSlotEls: HTMLDivElement[] = []; 

function itemName(id: number): string {
  const def: ItemDef | undefined = (ITEM_DEFS as any)[id];
  return def?.name ?? `Item ${id}`;
}

function stackLabel(s: ItemStack): string {
  if (!s || s.id <= 0 || s.count <= 0) return "";
  return `${itemName(s.id)}\n×${s.count}`;
}

function renderSlot(el: HTMLDivElement, stack: ItemStack, isSelected = false) {
  el.innerHTML = "";
  el.style.width = "64px";
  el.style.height = "64px";
  el.style.borderRadius = "8px";
  el.style.border = isSelected
    ? "2px solid rgba(255,255,255,0.9)"
    : "1px solid rgba(255,255,255,0.18)";
  el.style.background = "rgba(0,0,0,0.35)";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.position = "relative";
  el.style.cursor = "pointer";

  if (stack && stack.id > 0 && stack.count > 0) {
    const isSkill = stack.id >= 1000 && stack.id <= 2000;
    
    if (isSkill) {
      el.style.border = isSelected ? "2px solid #00FFFF" : "1px solid rgba(0,255,255,0.4)";
      el.style.background = "radial-gradient(circle, rgba(0,100,150,0.6) 0%, rgba(0,0,0,0.4) 100%)";
    }

    const name = document.createElement("div");
    name.textContent = itemName(stack.id);
    name.style.fontSize = "11px";
    name.style.textAlign = "center";
    name.style.padding = "0 6px";
    name.style.opacity = "0.95";
    name.style.wordBreak = "break-word";
    
    if (isSkill) {
      name.style.color = "#00FFFF";
    }
    
    el.appendChild(name);

    if (!isSkill) {
      const count = document.createElement("div");
      count.textContent = `×${stack.count}`;
      count.style.position = "absolute";
      count.style.right = "6px";
      count.style.bottom = "4px";
      count.style.fontSize = "12px";
      count.style.opacity = "0.95";
      el.appendChild(count);
    }

    const dur = Number((stack as any).dur ?? 0);
    if (Number.isFinite(dur) && dur > 0) {
      const dEl = document.createElement("div");
      dEl.textContent = `${dur}`;
      dEl.style.position = "absolute";
      dEl.style.left = "6px";
      dEl.style.bottom = "4px";
      dEl.style.fontSize = "11px";
      dEl.style.opacity = "0.85";
      el.appendChild(dEl);
    }
  }
}

function renderInventoryUI() {
  renderSlot(cursorSlotEl, invState.cursor, false);
  cursorNameEl.textContent =
    invState.cursor.id > 0
      ? stackLabel(invState.cursor).split("\n")[0]
      : "(empty)";

  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    renderSlot(slotEls[i], invState.slots[i], i === selectedHotbar);
  }

  for (let i = 0; i < BACKPACK_SLOTS; i++) {
    renderSlot(backpackEls[i], invState.slots[HOTBAR_SLOTS + i], false);
  }

  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    renderSlot(hudSlotEls[i], invState.slots[i], i === selectedHotbar);
  }

  const countItemSlotsOnly = (id: number): number => {
    let n = 0;
    for (const s of invState.slots) {
      if (s.id === id && s.count > 0) {
        n += s.count;
      }
    }
    return n;
  };

  for (const child of Array.from(craftList.children)) {
    const btn = child as HTMLButtonElement;
    const rid = (btn as any).__recipeId as string | undefined;
    if (!rid) continue;

    const recipe = RECIPES.find((r) => r.id === rid);
    if (!recipe) {
      btn.style.opacity = "0.5";
      continue;
    }

    let ok = true;
    for (const req of recipe.inputs) {
      if (countItemSlotsOnly(req.id) < req.count) {
        ok = false;
        break;
      }
    }
    btn.style.opacity = ok ? "1" : "0.5";
  }
}

function sendInvClick(slot: number, button: "L" | "R", shift: boolean) {
  if (!room) return;
  const isHotbar = slot < HOTBAR_SLOTS;
  room.send("invClick", { 
    area: isHotbar ? "hotbar" : "inv", 
    index: isHotbar ? slot : slot - HOTBAR_SLOTS, 
    button, 
    shift 
  });
}

function setupInventorySlots() {
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const el = document.createElement("div");
    (el as any).__slotIndex = i;
    el.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.button === 2 ? "R" : "L";
      sendInvClick(i, btn, e.shiftKey);
    };
    el.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (room) room.send("useItem", { slot: (el as any).__slotIndex });
    };
    slotEls.push(el);
    hotbarGrid.appendChild(el);
  }

  for (let i = 0; i < BACKPACK_SLOTS; i++) {
    const idx = HOTBAR_SLOTS + i;
    const el = document.createElement("div");
    (el as any).__slotIndex = idx;
    el.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.button === 2 ? "R" : "L";
      sendInvClick(idx, btn, e.shiftKey);
    };
    el.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (room) room.send("useItem", { slot: (el as any).__slotIndex });
    };
    backpackEls.push(el);
    backpackGrid.appendChild(el);
  }

  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const el = document.createElement("div");
    el.onmousedown = (e) => {
      e.preventDefault();
      selectedHotbar = i;
      renderInventoryUI();
      updateOverlay();
    };
    hudSlotEls.push(el);
    hudHotbarRoot.appendChild(el);
  }
}

function addCraftButton(titleText: string, recipeId: string) {
  const b = mkButton(titleText);
  (b as any).__recipeId = recipeId;

  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!room) return;
    room.send("craft", { recipeId, max: false, times: 1 });
  };

  b.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!room) return;
    room.send("craft", { recipeId, max: true });
  };

  craftList.appendChild(b);
}

function initUI() {
  try {
    setupInventorySlots();
  } catch (e) {
    console.warn("[UI] setupInventorySlots failed", e);
  }

  try {
    for (const r of RECIPES) {
      const inStr = r.inputs.map((it) => `${itemName(it.id)}×${it.count}`).join(" + ");
      const outStr = `${itemName(r.output.id)}×${r.output.count}`;
      addCraftButton(`${outStr}  ←  ${inStr}   [RMB=max]`, r.id);
    }
  } catch (e) {
    console.warn("[UI] craft buttons failed", e);
  }

  try {
    renderInventoryUI();
  } catch {}

  try {
    updateOverlay();
  } catch {}
}

/* ===============================
   6.5 Overlay & Stats HUD
================================ */
function getClosestRemoteDistance(): number | null {
  if (!room) return null;
  const me = noa.ents.getPosition(noa.playerEntity) as [number, number, number];
  if (!me) return null;

  let best: number | null = null;
  for (const [id, t] of netTransforms.entries()) {
    if (id === room.sessionId) continue;
    const dx = t.x - me[0];
    const dy = t.y - me[1];
    const dz = t.z - me[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (best == null || d < best) best = d;
  }
  return best;
}

function getHotbarHeldName(): string {
  const s = invState.slots[selectedHotbar];
  if (!s || s.id <= 0 || s.count <= 0) return "(empty)";
  return itemName(s.id);
}

function getSafeZoneLine(): string {
  if (!safeZone) return "Safe Zone: (unknown)";
  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
  if (!p) return `Safe Zone: center=(${safeZone.x},${safeZone.z}) r=${safeZone.r}`;
  const dx = p[0] - safeZone.x;
  const dz = p[2] - safeZone.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const inside = dist <= safeZone.r;
  return `Safe Zone: r=${safeZone.r} dist=${dist.toFixed(1)} ${inside ? "(INSIDE)" : ""}`;
}

function updateCoordsHUD() {
  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;

  if (!p) {
    coordsHUD.textContent = "XYZ: ?";
    return;
  }

  const x = Math.floor(p[0]);
  const y = Math.floor(p[1]);
  const z = Math.floor(p[2]);

  const chunkSize = 32;
  const cx = Math.floor(x / chunkSize);
  const cz = Math.floor(z / chunkSize);

  coordsHUD.innerHTML = `
    <div><strong>XYZ:</strong> ${x} / ${y} / ${z}</div>
    <div style="opacity:.85"><strong>Chunk:</strong> ${cx}, ${cz}</div>
  `;
}

function updateStatsHUD() {
  healthHUD.innerHTML = "";
  manaHUD.innerHTML = "";

  const hpContainers = Math.max(1, Math.floor(myMaxHp / 2));
  for (let i = 0; i < hpContainers; i++) {
    const hpVal = myHp - (i * 2);
    let state: "full" | "half" | "empty" = "empty";
    if (hpVal >= 2) state = "full";
    else if (hpVal === 1) state = "half";
    
    healthHUD.appendChild(createStatBlock(state, "#ff2222")); 
  }

  const manaContainers = Math.max(1, Math.floor(myMaxMana / 10));
  for (let i = 0; i < manaContainers; i++) {
    const mVal = myMana - (i * 10);
    let state: "full" | "half" | "empty" = "empty";
    if (mVal >= 10) state = "full";
    else if (mVal >= 5) state = "half"; 
    
    manaHUD.appendChild(createStatBlock(state, "#2277ff")); 
  }
}

function updateOverlay(extraLine = "") {
  updateStatsHUD();

  const status = room ? `Online (${room.sessionId})` : "Connecting...";

  const snapAge = lastSnapshotAt
    ? `${((performance.now() - lastSnapshotAt) / 1000).toFixed(1)}s`
    : "n/a";
  const xformAge = lastTransformAt
    ? `${((performance.now() - lastTransformAt) / 1000).toFixed(1)}s`
    : "n/a";
  const snapPreview = lastSnapshotIds.slice(0, 6).join(", ");

  const closest = getClosestRemoteDistance();
  const closestStr = closest == null ? "n/a" : `${closest.toFixed(2)}m`;

  const heldName = getHotbarHeldName();

  const mineLine =
    miningProgress && miningProgress.progress > 0
      ? `Mining: ${(miningProgress.progress * 100).toFixed(0)}% (stage ${miningProgress.stage})`
      : miningActive
      ? `Mining: active (awaiting progress...)`
      : "Mining: -";

  const psLine = minePS
    ? `PS: rate=${minePS.emitRate} alive=${minePS.isStarted() ? "Y" : "N"}`
    : "PS: (none)";

  const safeLine = getSafeZoneLine();

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedHotbar + 1}] ${heldName}<br>
    <strong>Inventory:</strong> ${invOpen ? "OPEN" : "CLOSED"}<br>
    <strong>Viewmodel:</strong> ${viewModelEnabled ? "ON" : "OFF"}<br>
    <strong>Remote Players:</strong> ${remotePlayersEnabled ? "ON" : "OFF"} |
    <strong>Xray:</strong> ${remoteXray ? "ON" : "OFF"}<br>
    <strong>VM Debug:</strong> ${vmDebug ? "ON" : "OFF"} |
    <strong>VM Tune:</strong> ${vmTuning ? "ON" : "OFF"} |
    <strong>Mirror:</strong> ${vmMirrorX ? "ON" : "OFF"}<br>
    <strong>${mineLine}</strong><br>
    <span style="opacity:.9">${psLine}</span><br>
    <strong>DEBUG_PARTICLES_ALWAYS:</strong> ${DEBUG_PARTICLES_ALWAYS ? "ON" : "OFF"}<br>
    <strong>${safeLine}</strong><br>
    -------------------------<br>
    [Click/Hold LMB] Mine/Attack | [R-Click] Place<br>
    [1-5] Select Hotbar Slot<br>
    [WASD] Move  |  [Space] Jump<br>
    [I] Inventory<br>
    [V] Toggle Viewmodel<br>
    [P] Toggle Remote Players<br>
    [O] Toggle Remote Xray<br>
    [B] Toggle VM Debug (axes/frame)<br>
    [N] Toggle VM Tuning (captures tuning keys)<br>
    [M] Toggle VM Mirror (handedness)<br>
    [K] Toggle DEBUG_PARTICLES_ALWAYS<br>
    <span style="opacity:.9">Remote debug:</span><br>
    <span style="opacity:.9">netTransforms=${netTransforms.size} closest=${closestStr}</span><br>
    <span style="opacity:.9">lastSnapshot=${snapAge} lastTransform=${xformAge}</span><br>
    <span style="opacity:.9">snapshotIds=[${snapPreview}]</span><br>
    <span style="opacity:.9">drops=${drops.size}</span><br>
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}

/* ===============================
   6.6 Key handling
================================ */
document.addEventListener("keydown", (e) => {
  const key = Number.parseInt(e.key, 10);
  if (Number.isFinite(key) && key >= 1 && key <= HOTBAR_SLOTS) {
    selectedHotbar = key - 1;
    renderInventoryUI();
    updateOverlay();
    return;
  }

  if (e.key === "i" || e.key === "I") {
    setInvOpen(!invOpen);
    updateOverlay(invOpen ? "Inventory opened" : "Inventory closed");
    return;
  }

  if (e.key === "v" || e.key === "V") {
    viewModelEnabled = !viewModelEnabled;
    updateOverlay(viewModelEnabled ? "Viewmodel: ON" : "Viewmodel: OFF");
    return;
  }

  if (e.key === "p" || e.key === "P") {
    remotePlayersEnabled = !remotePlayersEnabled;
    updateOverlay(remotePlayersEnabled ? "Remote Players: ON" : "Remote Players: OFF");
    return;
  }

  if (e.key === "o" || e.key === "O") {
    remoteXray = !remoteXray;
    updateOverlay(remoteXray ? "Remote Xray: ON" : "Remote Xray: OFF");
    return;
  }

  if (e.key === "b" || e.key === "B") {
    vmDebug = !vmDebug;
    updateOverlay(vmDebug ? "VM Debug: ON" : "VM Debug: OFF");
    return;
  }

  if (e.key === "n" || e.key === "N") {
    vmTuning = !vmTuning;
    updateOverlay(vmTuning ? "VM Tuning: ON (tuning keys captured)" : "VM Tuning: OFF");
    return;
  }

  if (e.key === "m" || e.key === "M") {
    vmMirrorX = !vmMirrorX;
    updateOverlay(vmMirrorX ? "VM Mirror: ON" : "VM Mirror: OFF");
    return;
  }

  if (e.key === "k" || e.key === "K") {
    DEBUG_PARTICLES_ALWAYS = !DEBUG_PARTICLES_ALWAYS;
    updateOverlay(DEBUG_PARTICLES_ALWAYS ? "DEBUG particles forced ON" : "DEBUG particles forced OFF");
    return;
  }
});

window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (!vmTuning) return;

    const isArrow =
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown";

    const isRotKey =
      e.key === "7" ||
      e.key === "8" ||
      e.key === "9" ||
      e.key === "0" ||
      e.key === "-" ||
      e.key === "=";

    if (!isArrow && !isRotKey) return;

    e.preventDefault();
    e.stopPropagation();
    (e as any).stopImmediatePropagation?.();

    const fineMove = e.shiftKey ? 0.003 : 0.01;

    if (e.key === "ArrowLeft") vmBaseXMul -= fineMove;
    if (e.key === "ArrowRight") vmBaseXMul += fineMove;
    if (e.key === "ArrowUp") vmBaseY += fineMove;
    if (e.key === "ArrowDown") vmBaseY -= fineMove;

    const rStep = e.shiftKey ? 0.02 : 0.05;
    if (e.key === "7") vmRotX -= rStep;
    if (e.key === "8") vmRotX += rStep;
    if (e.key === "9") vmRotY -= rStep;
    if (e.key === "0") vmRotY += rStep;
    if (e.key === "-") vmRotZ -= rStep;
    if (e.key === "=") vmRotZ += rStep;

    updateOverlay(
      `VM: xMul=${vmBaseXMul.toFixed(3)} y=${vmBaseY.toFixed(3)} | rot=(${vmRotX.toFixed(
        2
      )},${vmRotY.toFixed(2)},${vmRotZ.toFixed(2)}) | mirror=${vmMirrorX ? "ON" : "OFF"}`
    );
  },
  { capture: true }
);

/* ===============================
   7. World Streaming
================================ */
type PendingChunk = {
  data: any;
  chunkSize: number;
  x: number;
  y: number;
  z: number;
};

const pendingChunks = new Map<string, PendingChunk>();
const queuedRequests = new Map<string, { id: string; chunkSize: number; x: number; y: number; z: number }>();
const worldAny = noa.world as any;

function sendChunkRequest(req: { id: string; chunkSize: number; x: number; y: number; z: number }) {
  if (!room) {
    queuedRequests.set(req.id, req);
    return;
  }
  room.send("worldDataNeeded", req);
}

worldAny.on("worldDataNeeded", (id: string, data: any, x: number, y: number, z: number) => {
  const CS = data.shape?.[0] ?? 32;
  pendingChunks.set(id, { data, chunkSize: CS, x, y, z });
  sendChunkRequest({ id, chunkSize: CS, x, y, z });
});

/* ===============================
   7.1 Voxel Decoding
================================ */
function decodeVoxelsToNumberArray(msgVoxels: any, expectedLen: number): number[] | null {
  if (msgVoxels == null) return null;

  if (Array.isArray(msgVoxels)) {
    if (msgVoxels.length !== expectedLen) return null;
    const out = new Array<number>(expectedLen);
    for (let i = 0; i < expectedLen; i++) {
      out[i] = (msgVoxels[i] as any) | 0;
    }
    return out;
  }

  if (msgVoxels instanceof ArrayBuffer) {
    if (msgVoxels.byteLength === expectedLen * 2) {
      const u16 = new Uint16Array(msgVoxels);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u16[i] | 0;
      }
      return out;
    }
    if (msgVoxels.byteLength === expectedLen) {
      const u8 = new Uint8Array(msgVoxels);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u8[i] | 0;
      }
      return out;
    }
    return null;
  }

  if (ArrayBuffer.isView(msgVoxels) && (msgVoxels as any).buffer instanceof ArrayBuffer) {
    const view = msgVoxels as ArrayBufferView;

    const len = (msgVoxels as any).length;
    if (typeof len === "number" && len === expectedLen) {
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = (msgVoxels as any)[i] | 0;
      }
      return out;
    }

    const bytes = view.byteLength;
    if (bytes === expectedLen * 2) {
      const u16 = new Uint16Array(view.buffer, view.byteOffset, expectedLen);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u16[i] | 0;
      }
      return out;
    }
    if (bytes === expectedLen) {
      const u8 = new Uint8Array(view.buffer, view.byteOffset, expectedLen);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u8[i] | 0;
      }
      return out;
    }
    return null;
  }

  return null;
}

function applyChunkFromServer(msg: any) {
  if (!msg || typeof msg.id !== "string") return;

  const pending = pendingChunks.get(msg.id);
  if (!pending) return;

  const CS = typeof msg.chunkSize === "number" && Number.isFinite(msg.chunkSize) ? msg.chunkSize : pending.chunkSize;
  const expected = CS * CS * CS;

  const voxels = decodeVoxelsToNumberArray(msg.voxels, expected);
  if (!voxels) {
    console.warn("[CHUNK] decode failed", msg.id);
    return;
  }

  const data = pending.data;

  let n = 0;
  for (let k = 0; k < CS; k++) {
    for (let j = 0; j < CS; j++) {
      for (let i = 0; i < CS; i++) {
        data.set(i, j, k, voxels[n++] | 0);
      }
    }
  }

  noa.world.setChunkData(msg.id, data);
  pendingChunks.delete(msg.id);
  queuedRequests.delete(msg.id);
}

/* ===============================
   8. Interaction (Mine/Place/Attack)
================================ */
try {
  (noa.inputs as any).bind?.("fire", "mouse1");
  (noa.inputs as any).bind?.("alt-fire", "mouse2");
} catch {}

function getTargetInfo() {
  const tgt = (noa as any).targetedBlock;
  if (!tgt?.position || !tgt?.adjacent) return null;

  return {
    pos: { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] },
    adj: { x: tgt.adjacent[0], y: tgt.adjacent[1], z: tgt.adjacent[2] },
  };
}

let punchT = 1; 
function triggerPunch() {
  punchT = 0;
}

/* ===============================
   8.1 Combat & Mining progress
================================ */
type MineProgressMsg = {
  x: number;
  y: number;
  z: number;
  progress: number;
  stage: number;
  done?: boolean;
  reason?: string;
};

let miningHeld = false; 
let miningTarget: { x: number; y: number; z: number } | null = null;
let miningProgress: MineProgressMsg | null = null;

let miningActive = false;
let miningStickyUntil = 0;
const MINING_STICKY_MS = 1200;

let lastMineSentKey = "";
let lastMineSendAt = 0;
const MINE_RESEND_SAME_TARGET_MS = 250;

let lastMinePunchAt = 0;
const MINE_PUNCH_INTERVAL_MS = 180;

function sendAttack() {
  if (!room) return;
  const yaw = readNoaYaw();
  const pitch = readNoaPitch();
  room.send("attack", { attackId: undefined, heldSlot: selectedHotbar, yaw, pitch, t: Date.now() });
}

function sendStartMine(x: number, y: number, z: number) {
  if (!room) return;

  if (isInSafeZoneXZ(x, z)) {
    updateOverlay("Safe Zone: mining blocked");
    return;
  }

  const now = performance.now();
  if (now - lastMineSendAt < 40) return;

  const key = `${x},${y},${z}`;
  const sameTarget = key === lastMineSentKey;

  if (sameTarget && now - lastMineSendAt < MINE_RESEND_SAME_TARGET_MS) return;

  lastMineSendAt = now;
  lastMineSentKey = key;

  room.send("startMine", { x, y, z, heldSlot: selectedHotbar });
}

function cancelMiningLocal(reason = "") {
  miningHeld = false;
  miningActive = false;
  miningStickyUntil = 0;
  miningTarget = null;
  miningProgress = null;
  lastMineSentKey = "";
  lastMineSendAt = 0;
  if (room) room.send("cancelMine", { reason });
}

function setInvOpen(open: boolean) {
  invOpen = open;
  invRoot.style.display = invOpen ? "block" : "none";
  craftStatus.textContent = invOpen ? "RMB a recipe to craft MAX." : "";
  renderInventoryUI();

  if (invOpen) cancelMiningLocal("inventory_open");
}

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  if (invOpen) return;

  triggerPunch();
  sendAttack(); 

  const target = getTargetInfo();
  if (!target) return;

  const { x, y, z } = target.pos;

  if (isInSafeZoneXZ(x, z)) {
    updateOverlay("Safe Zone: mining blocked");
    return;
  }

  miningHeld = true;
  miningActive = true;
  miningStickyUntil = performance.now() + MINING_STICKY_MS;

  miningTarget = { x, y, z };
  miningProgress = {
    x,
    y,
    z,
    progress: miningProgress?.progress ?? 0,
    stage: miningProgress?.stage ?? 0,
  };

  lastMineSentKey = "";
  lastMineSendAt = 0;
  sendStartMine(x, y, z);
});

window.addEventListener("mouseup", (e: MouseEvent) => {
  if (e.button !== 0) return;
  if (!miningHeld) return;
  miningHeld = false;

  miningActive = true;
  miningStickyUntil = performance.now() + MINING_STICKY_MS;
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  if (invOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.adj;

  if (isInSafeZoneXZ(x, z)) {
    updateOverlay("Safe Zone: placing blocked");
    return;
  }

  const stack = invState.slots[selectedHotbar];
  if (!stack || stack.id <= 0 || stack.count <= 0) return;

  const def: ItemDef | undefined = (ITEM_DEFS as any)[stack.id];
  if (!def || typeof (def as any).placeBlockId !== "number") return;

  const blockToPlace = (def as any).placeBlockId as number;

  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);

  if (x === px && z === pz && (y === py || y === py + 1)) return;

  room?.send("placeBlock", {
    x,
    y,
    z,
    id: blockToPlace,
    fromSlot: selectedHotbar,
  });
});

/* ===============================
   9. Babylon scene access
================================ */
function getNoaScene(): BABYLON.Scene | null {
  const r = (noa as any).rendering as any;
  if (!r) return null;
  const s = (typeof r.getScene === "function" ? r.getScene() : null) ?? r._scene ?? r.scene ?? null;
  return (s as BABYLON.Scene) ?? null;
}

let cachedScene: BABYLON.Scene | null = null;
let cachedSceneUid: string | number | null = null;

function getStableScene(): BABYLON.Scene | null {
  const s = getNoaScene();
  if (!s) return cachedScene;

  const uid = (s as any).uid as string | number | undefined;
  if (!cachedScene || cachedSceneUid !== uid) {
    cachedScene = s;
    cachedSceneUid = uid ?? null;
  }
  return cachedScene;
}

/* ===============================
   9.0 Safe Zone Visuals
================================ */
let safeZoneMesh: BABYLON.Mesh | null = null;
let safeZoneMat: BABYLON.StandardMaterial | null = null;
let safeZoneSceneUid: string | number | null = null;

function ensureSafeZoneVisual(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  const suid = uid ?? null;

  if (safeZoneSceneUid !== suid) {
    try { safeZoneMesh?.dispose(); } catch {}
    try { safeZoneMat?.dispose(); } catch {}
    safeZoneMesh = null;
    safeZoneMat = null;
    safeZoneSceneUid = suid;
  }

  if (safeZoneMesh && safeZoneMat) return;

  safeZoneMesh = BABYLON.MeshBuilder.CreateCylinder(
    "safeZoneCylinder",
    { height: 120, diameter: 2, tessellation: 72, subdivisions: 1 },
    scene
  );
  safeZoneMesh.isPickable = false;
  (safeZoneMesh as any).isInFrustum = () => true;

  safeZoneMat = new BABYLON.StandardMaterial("safeZoneMat", scene);
  safeZoneMat.disableLighting = true;
  safeZoneMat.emissiveColor = new BABYLON.Color3(0.2, 0.8, 1.0);
  safeZoneMat.diffuseColor = safeZoneMat.emissiveColor.clone();
  safeZoneMat.specularColor = new BABYLON.Color3(0, 0, 0);
  safeZoneMat.alpha = 0.12;
  safeZoneMat.backFaceCulling = false;
  safeZoneMat.disableDepthWrite = true;
  safeZoneMat.depthFunction = BABYLON.Constants.LEQUAL;

  safeZoneMesh.material = safeZoneMat;
}

function updateSafeZoneVisual(scene: BABYLON.Scene) {
  if (!safeZone) {
    if (safeZoneMesh) safeZoneMesh.setEnabled(false);
    return;
  }

  ensureSafeZoneVisual(scene);
  if (!safeZoneMesh) return;

  safeZoneMesh.setEnabled(true);

  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
  const yCenter = p ? p[1] : 40;

  safeZoneMesh.position.set(safeZone.x, yCenter, safeZone.z);

  const r = Math.max(2, safeZone.r);
  safeZoneMesh.scaling.x = r;
  safeZoneMesh.scaling.z = r;
  safeZoneMesh.scaling.y = 1;

  if (p) {
    const dx = p[0] - safeZone.x;
    const dz = p[2] - safeZone.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const inside = dist <= safeZone.r;
    const pulse = 1 + (inside ? Math.sin(performance.now() / 180) * 0.015 : 0);
    safeZoneMesh.scaling.x = r * pulse;
    safeZoneMesh.scaling.z = r * pulse;
  }
}

/* ===============================
   9.1 Mining crack visuals
================================ */
let crackMesh: BABYLON.Mesh | null = null;
let crackMat: BABYLON.StandardMaterial | null = null;
let crackSceneUid: string | number | null = null;

function ensureCrackVisual(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  if (crackSceneUid == null) crackSceneUid = uid ?? null;

  if (crackSceneUid !== (uid ?? null)) {
    try { crackMesh?.dispose(); } catch {}
    try { crackMat?.dispose(); } catch {}
    crackMesh = null;
    crackMat = null;
    crackSceneUid = uid ?? null;
  }

  if (crackMesh && crackMat) return;

  crackMesh = BABYLON.MeshBuilder.CreateBox("mineCrackBox", { size: 1.02 }, scene);
  crackMesh.isPickable = false;
  crackMesh.setEnabled(false);
  (crackMesh as any).isInFrustum = () => true;

  crackMat = new BABYLON.StandardMaterial("mineCrackMat", scene);
  crackMat.disableLighting = true;
  crackMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  crackMat.diffuseColor = new BABYLON.Color3(1, 1, 1);
  crackMat.specularColor = new BABYLON.Color3(0, 0, 0);
  crackMat.alpha = 0.0;
  crackMat.backFaceCulling = false;
  crackMat.disableDepthWrite = true;
  crackMat.depthFunction = BABYLON.Constants.LEQUAL;
  crackMat.wireframe = true;
  crackMesh.material = crackMat;
}

function hideCrackVisual() {
  if (crackMesh) crackMesh.setEnabled(false);
  if (crackMat) crackMat.alpha = 0;
}

function updateCrackVisual(scene: BABYLON.Scene) {
  ensureCrackVisual(scene);

  if (!miningProgress || !crackMesh || !crackMat) {
    hideCrackVisual();
    return;
  }

  const { x, y, z, progress } = miningProgress;

  crackMesh.setEnabled(true);
  crackMesh.position.set(x + 0.5, y + 0.5, z + 0.5);

  const a = BABYLON.Scalar.Clamp(0.15 + progress * 0.65, 0, 0.9);
  crackMat.alpha = a;

  const pulse = 1.02 + Math.sin(performance.now() / 80) * 0.005;
  crackMesh.scaling.set(pulse, pulse, pulse);
}

/* ===============================
   9.2 Drop visuals
================================ */
const dropAtlasMats = new Map<number, BABYLON.StandardMaterial>();
let dropAtlasMatsSceneUid: string | number | null = null;

function resetDropAtlasMatsIfSceneChanged(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  const suid = uid ?? null;
  if (dropAtlasMatsSceneUid !== suid) {
    for (const m of dropAtlasMats.values()) {
      try { m.dispose(); } catch {}
    }
    dropAtlasMats.clear();
    dropAtlasMatsSceneUid = suid;
  }
}

function getDropAtlasMaterial(scene: BABYLON.Scene, atlasIndex: number, alpha = false) {
  resetDropAtlasMatsIfSceneChanged(scene);

  const key = (atlasIndex | 0) + (alpha ? 10000 : 0);
  const existing = dropAtlasMats.get(key);
  if (existing) return existing;

  const mat = new BABYLON.StandardMaterial(`dropAtlasMat:${key}`, scene);
  mat.disableLighting = true;
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = true;
  (mat as any).fogEnabled = false;

  const tex = new BABYLON.Texture(TERRAIN_ATLAS_URL, scene, false, false);
  tex.hasAlpha = !!alpha;
  tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
  tex.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);

  const idx = Math.max(0, Math.min(ATLAS_TILE_COUNT - 1, atlasIndex | 0));
  tex.uScale = 1;
  tex.vScale = 1 / ATLAS_TILE_COUNT;
  tex.uOffset = 0;
  tex.vOffset = 1 - (idx + 1) / ATLAS_TILE_COUNT;

  mat.diffuseTexture = tex;
  mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  mat.diffuseColor = new BABYLON.Color3(1, 1, 1);

  dropAtlasMats.set(key, mat);
  return mat;
}

function itemIdToAtlasIndex(itemId: number): number {
  if (itemId === Items.GRASS) return ATLAS.GRASS_SIDE;
  if (itemId === Items.DIRT) return ATLAS.DIRT;
  if (itemId === Items.STONE) return ATLAS.STONE;
  if (itemId === Items.WOOD_LOG) return ATLAS.WOOD;
  if (itemId === Items.LEAVES) return ATLAS.LEAVES;
  if (itemId === Items.COAL) return ATLAS.COAL_ORE;
  if (itemId === Items.RAW_IRON) return ATLAS.IRON_ORE;
  if (itemId === Items.RAW_GOLD) return ATLAS.GOLD_ORE;
  if (itemId === Items.DIAMOND) return ATLAS.DIAMOND_ORE;
  if ((Items as any).SAND && itemId === (Items as any).SAND) return ATLAS.SAND;
  if ((Items as any).SNOW && itemId === (Items as any).SNOW) return ATLAS.SNOW;
  if ((Items as any).DEEPSLATE && itemId === (Items as any).DEEPSLATE) return ATLAS.DEEPSLATE;
  if ((Items as any).TUFF && itemId === (Items as any).TUFF) return ATLAS.TUFF;
  if ((Items as any).MOSS && itemId === (Items as any).MOSS) return ATLAS.MOSS;
  if ((Items as any).MOSSY_STONE && itemId === (Items as any).MOSSY_STONE) return ATLAS.MOSSY_STONE;
  if ((Items as any).DRIPSTONE && itemId === (Items as any).DRIPSTONE) return ATLAS.DRIPSTONE;
  if ((Items as any).DRIPSTONE_BLOCK && itemId === (Items as any).DRIPSTONE_BLOCK) return ATLAS.DRIPSTONE_BLOCK;
  if ((Items as any).GLOW_SHROOM && itemId === (Items as any).GLOW_SHROOM) return ATLAS.GLOW_SHROOM;
  if ((Items as any).CRYSTAL && itemId === (Items as any).CRYSTAL) return ATLAS.CRYSTAL;
  return ATLAS.STONE;
}

function disposeAllDropMeshes() {
  for (const m of dropMeshes.values()) {
    try { m.dispose(); } catch {}
  }
  dropMeshes.clear();
}

function ensureDropVisuals(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  if (dropSceneUid == null) dropSceneUid = uid ?? null;

  if (dropSceneUid !== (uid ?? null)) {
    disposeAllDropMeshes();
    dropSceneUid = uid ?? null;
  }

  for (const d of drops.values()) {
    if (dropMeshes.has(d.dropId)) continue;

    const box = BABYLON.MeshBuilder.CreateBox(`drop:${d.dropId}`, { size: 0.32 }, scene);
    box.isPickable = false;
    (box as any).isInFrustum = () => true;

    const tile = itemIdToAtlasIndex(d.itemId);
    const alpha =
      d.itemId === Items.LEAVES ||
      d.itemId === (Items as any).MOSS ||
      d.itemId === (Items as any).DRIPSTONE ||
      d.itemId === (Items as any).GLOW_SHROOM ||
      d.itemId === (Items as any).CRYSTAL;

    box.material = getDropAtlasMaterial(scene, tile, !!alpha);
    box.rotation.x = 0.25;
    box.rotation.y = Math.random() * Math.PI * 2;
    box.position.set(d.x, d.y, d.z);
    dropMeshes.set(d.dropId, box);
  }

  for (const id of Array.from(dropMeshes.keys())) {
    if (!drops.has(id)) {
      const m = dropMeshes.get(id);
      try { m?.dispose(); } catch {}
      dropMeshes.delete(id);
    }
  }
}

function updateDropVisuals(dtSec: number) {
  const t = performance.now() / 1000;
  for (const d of drops.values()) {
    const m = dropMeshes.get(d.dropId);
    if (!m) continue;
    const bob = Math.sin(t * 3.0 + (d.createdAt % 1000) * 0.01) * 0.08;
    m.position.x = d.x;
    m.position.y = d.y + 0.15 + bob;
    m.position.z = d.z;
    m.rotation.y += dtSec * 1.1;
  }
}

function tryAutoPickup() {
  if (!room || !hasPointerLock() || invOpen || drops.size <= 0) return;

  const now = performance.now();
  if (now - lastPickupScanAt < 120) return;
  lastPickupScanAt = now;

  if (now - lastPickupSentAt < 90) return;

  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
  if (!p) return;

  let bestId: string | null = null;
  let bestD2 = Infinity;

  for (const d of drops.values()) {
    const last = pickupSentRecently.get(d.dropId) ?? 0;
    if (now - last < 600) continue;

    const dx = d.x - p[0];
    const dy = d.y - p[1];
    const dz = d.z - p[2];
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 <= 2.3 * 2.3 && d2 < bestD2) {
      bestD2 = d2;
      bestId = d.dropId;
    }
  }

  if (bestId) {
    lastPickupSentAt = now;
    pickupSentRecently.set(bestId, now);
    room.send("pickupDrop", { dropId: bestId });
  }
}

/* ===============================
   9.3 Mining particles
================================ */
let minePS: BABYLON.ParticleSystem | null = null;
let minePSTex: BABYLON.Texture | null = null;
let minePSSceneUid: string | number | null = null;

function ensureMiningParticles(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  const suid = uid ?? null;

  if (minePSSceneUid !== suid) {
    try { minePS?.dispose(); } catch {}
    try { minePSTex?.dispose(); } catch {}
    minePS = null;
    minePSTex = null;
    minePSSceneUid = suid;
  }

  if (minePS) return;

  const dt = new BABYLON.DynamicTexture("mineParticleTex", { width: 32, height: 32 }, scene, false);
  const ctx = dt.getContext();
  ctx.clearRect(0, 0, 32, 32);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.arc(16, 16, 6, 0, Math.PI * 2);
  ctx.fill();
  dt.update();

  minePSTex = dt;

  const ps = new BABYLON.ParticleSystem("minePS", 600, scene);
  ps.particleTexture = minePSTex;
  ps.renderingGroupId = 2;
  ps.minSize = 0.02;
  ps.maxSize = 0.06;
  ps.minLifeTime = 0.1;
  ps.maxLifeTime = 0.25;
  ps.emitRate = 0;
  ps.minEmitPower = 0.7;
  ps.maxEmitPower = 1.6;
  ps.updateSpeed = 0.015;
  ps.gravity = new BABYLON.Vector3(0, -2.2, 0);
  ps.direction1 = new BABYLON.Vector3(-1, 0.7, -1);
  ps.direction2 = new BABYLON.Vector3(1, 1.3, 1);
  ps.createBoxEmitter(
    new BABYLON.Vector3(-0.35, -0.35, -0.35),
    new BABYLON.Vector3(0.35, 0.35, 0.35),
    new BABYLON.Vector3(-0.2, 0.2, -0.2),
    new BABYLON.Vector3(0.2, 0.6, 0.2)
  );
  ps.color1 = new BABYLON.Color4(1, 1, 1, 1);
  ps.color2 = new BABYLON.Color4(1, 1, 1, 1);
  ps.colorDead = new BABYLON.Color4(1, 1, 1, 0);
  ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
  (ps as any).forceDepthWrite = false;

  minePS = ps;
  minePS.start();
}

function stopMiningParticles() {
  if (!minePS) return;
  minePS.emitRate = 0;
}

function updateMiningParticles(scene: BABYLON.Scene) {
  ensureMiningParticles(scene);
  if (!minePS) return;

  if (DEBUG_PARTICLES_ALWAYS) {
    const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
    if (p) {
      minePS.emitter = new BABYLON.Vector3(p[0], p[1] + 1.4, p[2]);
      minePS.emitRate = 120;
    }
    return;
  }

  if (!miningProgress || !miningActive) {
    stopMiningParticles();
    return;
  }

  const active = miningHeld || (miningProgress.progress >= 0 && miningProgress.progress < 1);
  if (!active) {
    stopMiningParticles();
    return;
  }

  const { x, y, z, progress } = miningProgress;
  minePS.emitter = new BABYLON.Vector3(x + 0.5, y + 0.5, z + 0.5);

  const tgt = getTargetInfo();
  if (tgt && tgt.pos.x === x && tgt.pos.y === y && tgt.pos.z === z) {
    const fx = BABYLON.Scalar.Clamp(tgt.adj.x - tgt.pos.x, -1, 1);
    const fy = BABYLON.Scalar.Clamp(tgt.adj.y - tgt.pos.y, -1, 1);
    const fz = BABYLON.Scalar.Clamp(tgt.adj.z - tgt.pos.z, -1, 1);
    const n = new BABYLON.Vector3(fx, fy, fz);
    if (n.lengthSquared() > 0.2) {
      n.normalize();
      minePS.direction1 = new BABYLON.Vector3(n.x * 0.8 - 0.25, 0.35, n.z * 0.8 - 0.25);
      minePS.direction2 = new BABYLON.Vector3(n.x * 1.4 + 0.25, 0.95, n.z * 1.4 + 0.25);
    }
  }

  const base = miningHeld ? 120 : 80;
  const ramp = progress * 220;
  minePS.emitRate = Math.max(0, Math.floor(base + ramp + Math.sin(performance.now() / 55) * 12));
}

/* ===============================
   Town Hall Label & Beacon
================================ */
let townHallLabelPlane: BABYLON.Mesh | null = null;
let townHallBeacon: BABYLON.Mesh | null = null;
let townHallLabelTex: BABYLON.DynamicTexture | null = null;
let townHallLabelMat: BABYLON.StandardMaterial | null = null;
let townHallLabelSceneUid: string | number | null = null;

function ensureTownHallLabel(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  const suid = uid ?? null;

  if (townHallLabelSceneUid !== suid) {
    try { townHallLabelPlane?.dispose(); } catch {}
    try { townHallBeacon?.dispose(); } catch {}
    try { townHallLabelMat?.dispose(); } catch {}
    try { townHallLabelTex?.dispose(); } catch {}
    townHallLabelPlane = null;
    townHallBeacon = null;
    townHallLabelMat = null;
    townHallLabelTex = null;
    townHallLabelSceneUid = suid;
  }

  if (townHallLabelPlane && townHallBeacon) return;

  townHallBeacon = BABYLON.MeshBuilder.CreateCylinder(
    "townHallBeacon",
    { height: 1, diameter: 0.8, tessellation: 16 },
    scene
  );
  townHallBeacon.renderingGroupId = 3;
  townHallBeacon.isPickable = false;
  (townHallBeacon as any).isInFrustum = () => true;
  (townHallBeacon as any).alwaysSelectAsActiveMesh = true;

  const beaconMat = new BABYLON.StandardMaterial("beaconMat", scene);
  beaconMat.disableLighting = true;
  beaconMat.emissiveColor = new BABYLON.Color3(0.6, 0, 1);
  beaconMat.alpha = 0.5;
  beaconMat.disableDepthWrite = true;
  (beaconMat as any).fogEnabled = false;
  townHallBeacon.material = beaconMat;

  townHallLabelPlane = BABYLON.MeshBuilder.CreatePlane(
    "townHallLabel",
    { width: 12, height: 4 },
    scene
  );
  townHallLabelPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  townHallLabelPlane.renderingGroupId = 3;
  townHallLabelPlane.isPickable = false;
  (townHallLabelPlane as any).isInFrustum = () => true;
  (townHallLabelPlane as any).alwaysSelectAsActiveMesh = true;

  townHallLabelTex = new BABYLON.DynamicTexture("townHallLabelTex", { width: 512, height: 256 }, scene, false);

  townHallLabelMat = new BABYLON.StandardMaterial("townHallLabelMat", scene);
  townHallLabelMat.disableLighting = true;
  townHallLabelMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  townHallLabelMat.backFaceCulling = false;
  townHallLabelMat.disableDepthWrite = true;
  (townHallLabelMat as any).fogEnabled = false;

  townHallLabelMat.diffuseTexture = townHallLabelTex;
  (townHallLabelMat.diffuseTexture as BABYLON.Texture).hasAlpha = true;

  townHallLabelPlane.material = townHallLabelMat;
  redrawTownHallLabel("TOWN HALL", "(0,0)");
}

function redrawTownHallLabel(title: string, subtitle = "") {
  if (!townHallLabelTex) return;

  const ctx = townHallLabelTex.getContext() as unknown as CanvasRenderingContext2D;
  const w = townHallLabelTex.getSize().width;
  const h = townHallLabelTex.getSize().height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#00FFFF";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.font = "bold 80px monospace";
  ctx.fillText(title, w / 2, h * 0.4);

  if (subtitle) {
    ctx.fillStyle = "#FFFF00";
    ctx.font = "bold 50px monospace";
    ctx.fillText(subtitle, w / 2, h * 0.8);
  }
  townHallLabelTex.update();
}

function updateTownHallLabel(scene: BABYLON.Scene) {
  const CENTER_X = 0;
  const CENTER_Z = 0;
  const LABEL_Y = 35;

  ensureTownHallLabel(scene);
  if (!townHallLabelPlane || !townHallBeacon) return;

  townHallLabelPlane.position.set(CENTER_X, LABEL_Y, CENTER_Z);
  const pulse = 1 + Math.sin(performance.now() / 250) * 0.1;
  townHallLabelPlane.scaling.set(pulse, pulse, pulse);

  townHallBeacon.position.set(CENTER_X, LABEL_Y / 2, CENTER_Z);
  townHallBeacon.scaling.y = LABEL_Y;

  const now = performance.now();
  if ((updateTownHallLabel as any)._lastRedraw == null) {
    (updateTownHallLabel as any)._lastRedraw = 0;
  }

  if (now - (updateTownHallLabel as any)._lastRedraw > 1000) {
    (updateTownHallLabel as any)._lastRedraw = now;

    const p = noa.ents.getPosition(noa.playerEntity);
    let distStr = "?";
    if (p) {
      const dx = p[0] - CENTER_X;
      const dz = p[2] - CENTER_Z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      distStr = dist.toFixed(0) + "m";
    }
    redrawTownHallLabel("TOWN HALL", distStr);
  }
}

/* ===============================
   10. Viewmodel Overlay Scene (vmScene)
================================ */
let vmReady = false;
let vmScene: BABYLON.Scene | null = null;
let vmCam: BABYLON.FreeCamera | null = null;
let vmRoot: BABYLON.TransformNode | null = null;
let vmArmRoot: BABYLON.TransformNode | null = null;
let vmEngineHooked = false;

let vmAxes: BABYLON.TransformNode | null = null;
let vmFrame: BABYLON.LinesMesh | null = null;

function ensureVmScene(noaScene: BABYLON.Scene) {
  if (vmReady && vmScene && vmCam && vmRoot && vmArmRoot) return;

  const engine = noaScene.getEngine();

  vmScene = new BABYLON.Scene(engine);
  vmScene.useRightHandedSystem = noaScene.useRightHandedSystem;

  vmScene.autoClear = false;
  vmScene.autoClearDepthAndStencil = true;

  vmCam = new BABYLON.FreeCamera("vmCam", new BABYLON.Vector3(0, 0, -10), vmScene);
  vmCam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  vmCam.setTarget(BABYLON.Vector3.Zero());
  vmScene.activeCamera = vmCam;

  const updateOrtho = () => {
    if (!vmCam) return;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const r = w / Math.max(1, h);

    vmCam.orthoLeft = -r;
    vmCam.orthoRight = r;
    vmCam.orthoTop = 1;
    vmCam.orthoBottom = -1;

    if (vmFrame && vmFrame.getScene()) {
      const pts = [
        new BABYLON.Vector3(-r, -1, 0),
        new BABYLON.Vector3(r, -1, 0),
        new BABYLON.Vector3(r, 1, 0),
        new BABYLON.Vector3(-r, 1, 0),
        new BABYLON.Vector3(-r, -1, 0),
      ];
      BABYLON.MeshBuilder.CreateLines("vmFrame", { points: pts, instance: vmFrame });
    }
  };

  updateOrtho();
  engine.onResizeObservable.add(() => updateOrtho());

  vmRoot = new BABYLON.TransformNode("vmRoot", vmScene);
  vmRoot.position.set(0, 0, 0);
  vmRoot.rotationQuaternion = new BABYLON.Quaternion();

  vmArmRoot = new BABYLON.TransformNode("vmArmRoot", vmScene);
  vmArmRoot.parent = vmRoot;

  const upper = BABYLON.MeshBuilder.CreateBox("vmUpperArm", { width: 0.16, height: 0.44, depth: 0.16 }, vmScene);
  const fore = BABYLON.MeshBuilder.CreateBox("vmForeArm", { width: 0.16, height: 0.38, depth: 0.16 }, vmScene);
  const hand = BABYLON.MeshBuilder.CreateBox("vmHand", { width: 0.17, height: 0.18, depth: 0.17 }, vmScene);

  upper.parent = vmArmRoot;
  fore.parent = vmArmRoot;
  hand.parent = vmArmRoot;

  vmArmRoot.position.set(0.0, 0.1, 0.0);

  upper.position.set(0.0, 0.22, 0.0);
  fore.position.set(0.0, -0.14, 0.02);
  hand.position.set(0.0, -0.4, 0.04);

  const armMat = new BABYLON.StandardMaterial("vmArmMat", vmScene);
  armMat.disableLighting = true;
  armMat.emissiveColor = new BABYLON.Color3(0.85, 0.72, 0.55);
  armMat.diffuseColor = armMat.emissiveColor.clone();
  armMat.specularColor = new BABYLON.Color3(0, 0, 0);
  armMat.backFaceCulling = false;
  armMat.disableDepthWrite = true;
  armMat.depthFunction = BABYLON.Constants.ALWAYS;

  upper.material = armMat;
  fore.material = armMat;
  hand.material = armMat;

  upper.isPickable = false;
  fore.isPickable = false; 
  hand.isPickable = false;

  (upper as any).isInFrustum = () => true;
  (fore as any).isInFrustum = () => true;
  (hand as any).isInFrustum = () => true;

  const ensureVmDebugMeshes = () => {
    if (!vmScene || !vmRoot || !vmCam) return;

    if (!vmAxes) {
      vmAxes = new BABYLON.TransformNode("vmAxes", vmScene);
      vmAxes.parent = vmRoot;

      const makeAxis = (name: string, to: BABYLON.Vector3, color: BABYLON.Color3) => {
        const l = BABYLON.MeshBuilder.CreateLines(name, { points: [BABYLON.Vector3.Zero(), to] }, vmScene!);
        l.color = color;
        l.isPickable = false;
        (l as any).isInFrustum = () => true;
        l.parent = vmAxes!;
        l.renderingGroupId = 3;
        return l;
      };

      makeAxis("vmAxisX", new BABYLON.Vector3(0.35, 0, 0), new BABYLON.Color3(1, 0, 0));
      makeAxis("vmAxisY", new BABYLON.Vector3(0, 0.35, 0), new BABYLON.Color3(0, 1, 0));
      makeAxis("vmAxisZ", new BABYLON.Vector3(0, 0, 0.65), new BABYLON.Color3(0, 0.5, 1));
    }

    if (!vmFrame) {
      const r = (vmCam.orthoRight ?? 1) as number;
      const pts = [
        new BABYLON.Vector3(-r, -1, 0),
        new BABYLON.Vector3(r, -1, 0),
        new BABYLON.Vector3(r, 1, 0),
        new BABYLON.Vector3(-r, 1, 0),
        new BABYLON.Vector3(-r, -1, 0),
      ];
      vmFrame = BABYLON.MeshBuilder.CreateLines("vmFrame", { points: pts }, vmScene);
      vmFrame.color = new BABYLON.Color3(1, 1, 0);
      vmFrame.isPickable = false;
      (vmFrame as any).isInFrustum = () => true;
      vmFrame.renderingGroupId = 3;
    }
  };

  ensureVmDebugMeshes();

  if (!vmEngineHooked) {
    vmEngineHooked = true;

    engine.onEndFrameObservable.add(() => {
      if (viewModelEnabled && vmScene) {
        if (vmAxes) vmAxes.setEnabled(vmDebug);
        if (vmFrame) vmFrame.setEnabled(vmDebug);
        vmScene.render();
      }

      if (remotePlayersEnabled && rpReady && rpScene) {
        rpScene.render();
      }
    });
  }

  vmReady = true;
}

/* ===============================
   10.1 Viewmodel animation
================================ */
let vmTime = 0;
let lastLocalPosVM: [number, number, number] | null = null;
let lastYawVM: number | null = null;
let lastPitchVM: number | null = null;

function readNoaYaw(): number {
  const h = (noa as any).camera?.heading;
  return typeof h === "number" && Number.isFinite(h) ? h : 0;
}

function readNoaPitch(): number {
  const camAny = (noa as any).camera as any;
  const p1 = camAny?.pitch;
  const p2 = camAny?._pitch;
  const p3 = camAny?.rotX;
  const p4 = camAny?.rotation?.[0];
  const v = typeof p1 === "number" && Number.isFinite(p1) ? p1
    : typeof p2 === "number" && Number.isFinite(p2) ? p2
    : typeof p3 === "number" && Number.isFinite(p3) ? p3
    : typeof p4 === "number" && Number.isFinite(p4) ? p4 : 0;
  return v;
}

function wrapPi(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function updateViewmodel(dtSec: number) {
  if (!vmReady || !vmScene || !vmCam || !vmRoot || !vmArmRoot) return;
  if (!viewModelEnabled) return;

  vmArmRoot.scaling.x = vmMirrorX ? -1 : 1;
  vmArmRoot.scaling.y = 1;
  vmArmRoot.scaling.z = 1;

  const pos = noa.ents.getPosition(noa.playerEntity) as [number, number, number];
  let speed = 0;
  if (pos && lastLocalPosVM) {
    const dx = pos[0] - lastLocalPosVM[0];
    const dz = pos[2] - lastLocalPosVM[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    speed = dist / Math.max(0.0001, dtSec);
  }
  if (pos) lastLocalPosVM = [pos[0], pos[1], pos[2]];

  const walk = Math.min(1, speed / 5);
  vmTime += dtSec * (2.5 + walk * 6.0);

  const bob = Math.sin(vmTime * 2.0) * 0.03 * walk;
  const sway = Math.sin(vmTime) * 0.06 * walk;

  const now = performance.now();
  if (miningActive && hasPointerLock() && !invOpen) {
    if (now - lastMinePunchAt > MINE_PUNCH_INTERVAL_MS) {
      lastMinePunchAt = now;
      triggerPunch();
    }
  }

  punchT = Math.min(1, punchT + dtSec * 10.0);
  const punch01 = Math.sin(punchT * Math.PI);

  const r = (vmCam.orthoRight ?? 1) as number;

  const baseX = r * vmBaseXMul;
  const baseY = vmBaseY;

  const x = baseX + sway * 0.55 - punch01 * vmPunchMoveX;
  const y = baseY + bob * 0.65 - punch01 * vmPunchMoveY;

  vmRoot.position.set(x, y, 0);

  const yawNow = readNoaYaw();
  const pitchNow = readNoaPitch();

  const dyaw = lastYawVM == null ? 0 : wrapPi(yawNow - lastYawVM);
  const dpitch = lastPitchVM == null ? 0 : pitchNow - lastPitchVM;

  lastYawVM = yawNow;
  lastPitchVM = pitchNow;

  const pitchInfluence = BABYLON.Scalar.Clamp(pitchNow, -1.2, 1.2);
  const turnSway = BABYLON.Scalar.Clamp(dyaw * 2.0, -0.25, 0.25);
  const lookSway = BABYLON.Scalar.Clamp(dpitch * 1.2, -0.2, 0.2);

  const swing = Math.sin(vmTime * 1.7) * 0.18 * walk;

  vmArmRoot.rotation.x = vmRotX + pitchInfluence * vmPitchMul - punch01 * vmPunchRotMul + lookSway * 0.35;
  vmArmRoot.rotation.y = vmRotY + turnSway * vmTurnSwayMulY;
  vmArmRoot.rotation.z = vmRotZ + swing - turnSway * vmTurnSwayMulZ;
}

/* ===============================
   11. Remote Players Overlay Scene (rpScene)
================================ */
let rpReady = false;
let rpScene: BABYLON.Scene | null = null;
let rpCam: BABYLON.FreeCamera | null = null;
let rpGlowLayer: BABYLON.GlowLayer | null = null;

const remoteMeshes = new Map<string, BABYLON.TransformNode>();
const remoteMats = new Map<string, BABYLON.StandardMaterial>();

let rpRenderOffset = new BABYLON.Vector3(0, 0, 0);

const REMOTE_Y_VISUAL_OFFSET = -1.65;

const remotePrevPos = new Map<string, BABYLON.Vector3>();
const remotePrevAt = new Map<string, number>();
const remoteTargetPos = new Map<string, BABYLON.Vector3>();

function ensureRpScene(noaScene: BABYLON.Scene) {
  if (rpReady && rpScene && rpCam) return;

  const engine = noaScene.getEngine();

  rpScene = new BABYLON.Scene(engine);
  rpScene.useRightHandedSystem = noaScene.useRightHandedSystem;

  rpScene.autoClear = false;
  rpScene.autoClearDepthAndStencil = false;

  rpCam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, 0), rpScene);
  rpCam.minZ = 0.05;
  rpCam.maxZ = 10000;

  rpCam.rotationQuaternion = new BABYLON.Quaternion();
  rpScene.activeCamera = rpCam;

  if (!rpGlowLayer) {
    rpGlowLayer = new BABYLON.GlowLayer("rpGlow", rpScene);
    rpGlowLayer.intensity = 0.4;
  }

  rpReady = true;
}

function makeRemoteMaterial(id: string, scene: BABYLON.Scene): BABYLON.StandardMaterial {
  const mat = new BABYLON.StandardMaterial(`rpMat:${id}`, scene);
  mat.disableLighting = true;
  mat.emissiveColor = new BABYLON.Color3(1, 0.15, 0.15);
  mat.diffuseColor = mat.emissiveColor.clone();
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  (mat as any).fogEnabled = false;
  return mat;
}

function ensureRemoteMesh(id: string): BABYLON.TransformNode | null {
  if (!rpScene) return null;

  const existing = remoteMeshes.get(id);
  if (existing) return existing;

  const isMob = id.includes("dummy") || id.includes("mob");
  const root = new BABYLON.TransformNode(`remoteRoot:${id}`, rpScene);
  (root as any).__isMob = isMob;

  let parts: any = {};

  if (isMob) {
    const mobMat = getDropAtlasMaterial(rpScene, ATLAS.DEEPSLATE);
    
    const body = BABYLON.MeshBuilder.CreateBox(`mobBody:${id}`, { width: 0.9, height: 0.9, depth: 0.6 }, rpScene);
    body.position.set(0, 0.9, 0); 
    
    const head = BABYLON.MeshBuilder.CreateBox(`mobHead:${id}`, { width: 0.5, height: 0.5, depth: 0.5 }, rpScene);
    head.position.set(0, 1.5, 0.15); 

    const armL = BABYLON.MeshBuilder.CreateBox(`mobArmL:${id}`, { width: 0.35, height: 1.1, depth: 0.35 }, rpScene);
    armL.position.set(-0.65, 1.0, 0);

    const armR = BABYLON.MeshBuilder.CreateBox(`mobArmR:${id}`, { width: 0.35, height: 1.1, depth: 0.35 }, rpScene);
    armR.position.set(0.65, 1.0, 0);

    const legL = BABYLON.MeshBuilder.CreateBox(`mobLegL:${id}`, { width: 0.3, height: 0.5, depth: 0.3 }, rpScene);
    legL.position.set(-0.25, 0.25, 0);

    const legR = BABYLON.MeshBuilder.CreateBox(`mobLegR:${id}`, { width: 0.3, height: 0.5, depth: 0.3 }, rpScene);
    legR.position.set(0.25, 0.25, 0);

    [body, head, armL, armR, legL, legR].forEach(m => {
        m.parent = root;
        m.material = mobMat;
        m.isPickable = false;
        (m as any).isInFrustum = () => true;
    });

    const eyeMat = new BABYLON.StandardMaterial(`mobEyeMat:${id}`, rpScene);
    eyeMat.disableLighting = true;
    eyeMat.emissiveColor = new BABYLON.Color3(1, 0.1, 0.1); 
    (eyeMat as any).fogEnabled = false;

    const eyeL = BABYLON.MeshBuilder.CreateBox(`mobEyeL:${id}`, { size: 0.1 }, rpScene);
    eyeL.parent = head;
    eyeL.position.set(-0.12, 0.05, 0.26);
    eyeL.material = eyeMat;

    const eyeR = BABYLON.MeshBuilder.CreateBox(`mobEyeR:${id}`, { size: 0.1 }, rpScene);
    eyeR.parent = head;
    eyeR.position.set(0.12, 0.05, 0.26);
    eyeR.material = eyeMat;

    const orbiters: BABYLON.Mesh[] = [];
    for(let i=0; i<3; i++) {
        const orb = BABYLON.MeshBuilder.CreateBox(`mobOrb${i}:${id}`, {size: 0.15}, rpScene);
        orb.material = eyeMat; 
        orb.parent = root;
        orb.isPickable = false;
        (orb as any).isInFrustum = () => true;
        orbiters.push(orb);
    }

    parts = { body, head, armL, armR, legL, legR, eyeMat, orbiters };

  } else {
    const BODY_W = 0.65;
    const BODY_H = 0.95;
    const BODY_D = 0.32;
    const HEAD = 0.55;
    const ARM_W = 0.2;
    const ARM_H = 0.85;
    const ARM_D = 0.2;
    const LEG_W = 0.22;
    const LEG_H = 0.9;
    const LEG_D = 0.22;

    const legTopY = LEG_H;
    const bodyBottomY = legTopY;
    const bodyCenterY = bodyBottomY + BODY_H * 0.5;
    const headCenterY = bodyBottomY + BODY_H + HEAD * 0.5;

    const mat = makeRemoteMaterial(id, rpScene);
    remoteMats.set(id, mat);

    const body = BABYLON.MeshBuilder.CreateBox(`remoteBody:${id}`, { width: BODY_W, height: BODY_H, depth: BODY_D }, rpScene);
    body.parent = root;
    body.position.set(0, bodyCenterY, 0);
    body.material = mat;
    body.isPickable = false;

    const head = BABYLON.MeshBuilder.CreateBox(`remoteHead:${id}`, { width: HEAD, height: HEAD, depth: HEAD }, rpScene);
    head.parent = root;
    head.position.set(0, headCenterY, 0);
    head.material = mat;
    head.isPickable = false;

    const armL = BABYLON.MeshBuilder.CreateBox(`remoteArmL:${id}`, { width: ARM_W, height: ARM_H, depth: ARM_D }, rpScene);
    armL.parent = root;
    armL.position.set(-(BODY_W * 0.5 + ARM_W * 0.5) + 0.02, bodyBottomY + BODY_H * 0.65, 0);
    armL.material = mat;
    armL.isPickable = false;

    const armR = BABYLON.MeshBuilder.CreateBox(`remoteArmR:${id}`, { width: ARM_W, height: ARM_H, depth: ARM_D }, rpScene);
    armR.parent = root;
    armR.position.set(BODY_W * 0.5 + ARM_W * 0.5 - 0.02, bodyBottomY + BODY_H * 0.65, 0);
    armR.material = mat;
    armR.isPickable = false;

    const legL = BABYLON.MeshBuilder.CreateBox(`remoteLegL:${id}`, { width: LEG_W, height: LEG_H, depth: LEG_D }, rpScene);
    legL.parent = root;
    legL.position.set(-0.16, LEG_H * 0.5, 0);
    legL.material = mat;
    legL.isPickable = false;

    const legR = BABYLON.MeshBuilder.CreateBox(`remoteLegR:${id}`, { width: LEG_W, height: LEG_H, depth: LEG_D }, rpScene);
    legR.parent = root;
    legR.position.set(0.16, LEG_H * 0.5, 0);
    legR.material = mat;
    legR.isPickable = false;

    [body, head, armL, armR, legL, legR].forEach(m => {
        (m as any).isInFrustum = () => true;
    });

    parts = { armL, armR, legL, legR };
  }

  (root as any).__parts = parts;
  (root as any).__walkPhase = 0;

  remoteMeshes.set(id, root);

  remotePrevPos.set(id, new BABYLON.Vector3(0, 0, 0));
  remotePrevAt.set(id, performance.now());
  remoteTargetPos.set(id, new BABYLON.Vector3(0, 0, 0));

  return root;
}

function removeRemoteMesh(id: string) {
  const root = remoteMeshes.get(id);
  if (root) {
    try { root.dispose(); } catch {}
    remoteMeshes.delete(id);
  }
  const mat = remoteMats.get(id);
  if (mat) {
    try { mat.dispose(); } catch {}
    remoteMats.delete(id);
  }
  remotePrevPos.delete(id);
  remotePrevAt.delete(id);
  remoteTargetPos.delete(id);
}

function syncRpCameraFromWorld(worldScene: BABYLON.Scene) {
  if (!rpReady || !rpScene || !rpCam) return;

  const worldCam = worldScene.activeCamera as any;
  if (!worldCam) return;

  rpCam.viewport = worldCam.viewport?.clone?.() ?? rpCam.viewport;

  if (typeof worldCam.fov === "number") (rpCam as any).fov = worldCam.fov;
  if (typeof worldCam.fovMode === "number") (rpCam as any).fovMode = worldCam.fovMode;
  if (typeof worldCam.minZ === "number") rpCam.minZ = worldCam.minZ;
  if (typeof worldCam.maxZ === "number") rpCam.maxZ = worldCam.maxZ;

  const wm = typeof worldCam.getWorldMatrix === "function" ? worldCam.getWorldMatrix() : null;
  if (wm) {
    const absPos = new BABYLON.Vector3();
    wm.decompose(undefined, undefined, absPos);
    rpCam.position.copyFrom(absPos);

    const rotMat = wm.getRotationMatrix();
    const absRotQ = BABYLON.Quaternion.FromRotationMatrix(rotMat);
    if (!rpCam.rotationQuaternion) rpCam.rotationQuaternion = new BABYLON.Quaternion();
    rpCam.rotationQuaternion.copyFrom(absRotQ);
  } else {
    if (typeof worldCam.getAbsolutePosition === "function") {
      rpCam.position.copyFrom(worldCam.getAbsolutePosition());
    } else if (worldCam.globalPosition instanceof BABYLON.Vector3) {
      rpCam.position.copyFrom(worldCam.globalPosition);
    } else if (worldCam.position instanceof BABYLON.Vector3) {
      rpCam.position.copyFrom(worldCam.position);
    }

    if (worldCam.rotationQuaternion && rpCam.rotationQuaternion) {
      rpCam.rotationQuaternion.copyFrom(worldCam.rotationQuaternion);
    } else if (worldCam.rotation instanceof BABYLON.Vector3) {
      rpCam.rotation.copyFrom(worldCam.rotation);
    }
  }

  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
  if (p) {
    rpRenderOffset.set(rpCam.position.x - p[0], rpCam.position.y - p[1], rpCam.position.z - p[2]);
  }

  if (remoteXray) {
    rpScene.autoClearDepthAndStencil = true;
    for (const mat of remoteMats.values()) {
      mat.disableDepthWrite = true;
      mat.depthFunction = BABYLON.Constants.ALWAYS;
    }
  } else {
    rpScene.autoClearDepthAndStencil = false;
    for (const mat of remoteMats.values()) {
      mat.disableDepthWrite = false;
      mat.depthFunction = BABYLON.Constants.LESS;
    }
  }
}

function updateRemoteMeshes() {
  if (!remotePlayersEnabled) return;
  if (!rpReady || !rpScene) return;
  if (!room) return;

  for (const id of Array.from(remoteMeshes.keys())) {
    if (!netTransforms.has(id)) removeRemoteMesh(id);
  }

  const now = performance.now();

  for (const [id, t] of netTransforms.entries()) {
    if (id === room.sessionId) continue;

    const root = ensureRemoteMesh(id);
    if (!root) continue;

    const target = remoteTargetPos.get(id) ?? new BABYLON.Vector3();
    target.set(t.x + rpRenderOffset.x, t.y + rpRenderOffset.y + REMOTE_Y_VISUAL_OFFSET, t.z + rpRenderOffset.z);
    remoteTargetPos.set(id, target);

    const lerp = 0.35;
    root.position.x += (target.x - root.position.x) * lerp;
    root.position.y += (target.y - root.position.y) * lerp;
    root.position.z += (target.z - root.position.z) * lerp;

    if (typeof t.yaw === "number") root.rotation.y = t.yaw;

    const prev = remotePrevPos.get(id) ?? new BABYLON.Vector3(root.position.x, root.position.y, root.position.z);
    const prevAt = remotePrevAt.get(id) ?? now;
    const dt = Math.max(0.001, (now - prevAt) / 1000);

    const dx = root.position.x - prev.x;
    const dz = root.position.z - prev.z;
    const speed = Math.sqrt(dx * dx + dz * dz) / dt;

    prev.copyFrom(root.position);
    remotePrevPos.set(id, prev);
    remotePrevAt.set(id, now);

    const isMob = (root as any).__isMob;
    const parts = (root as any).__parts;
    const mat = remoteMats.get(id);

    if (isMob) {
      const hp = t.hp ?? 100;
      const maxHp = t.maxHp ?? 100;
      const healthPct = hp / Math.max(1, maxHp);
      const isRaging = healthPct < 0.5;

      const targetScale = isRaging ? 1.25 : 1.0;
      root.scaling.x += (targetScale - root.scaling.x) * 0.1;
      root.scaling.y += (targetScale - root.scaling.y) * 0.1;
      root.scaling.z += (targetScale - root.scaling.z) * 0.1;

      if (parts.eyeMat) {
        if (isRaging) {
          parts.eyeMat.emissiveColor.set(1, 0.4, 0); 
        } else {
          parts.eyeMat.emissiveColor.set(1, 0.05, 0.05); 
        }
      }

      if (parts.orbiters) {
        const orbitSpeed = isRaging ? 0.006 : 0.002;
        const orbitRadius = isRaging ? 1.4 : 1.0;
        const heightBob = Math.sin(now * 0.003) * 0.2;
        
        parts.orbiters.forEach((orb: BABYLON.Mesh, i: number) => {
            const angle = (now * orbitSpeed) + (i * ((Math.PI * 2) / parts.orbiters.length));
            orb.position.set(
                Math.cos(angle) * orbitRadius,
                0.8 + heightBob + (i * 0.15),
                Math.sin(angle) * orbitRadius
            );
            orb.rotation.x += dt * 2;
            orb.rotation.y += dt * 3;
        });
      }

      const moving = speed > 0.15;
      const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * (isRaging ? 0.25 : 0.15);
      let phase = (root as any).__walkPhase as number;
      if (!Number.isFinite(phase)) phase = 0;
      phase += moving ? phaseSpeed : 0.02;
      (root as any).__walkPhase = phase;

      const swing = Math.sin(phase) * (moving ? 0.6 : 0.05);
      
      let armPitch = 0;
      const swingTime = remoteSwings.get(id);
      if (swingTime && now - swingTime < 350) {
          const st = (now - swingTime) / 350;
          armPitch = Math.sin(st * Math.PI) * 2.0; 
      }

      if (parts.legL && parts.legR && parts.armL && parts.armR) {
          parts.legL.rotation.x = swing;
          parts.legR.rotation.x = -swing;
          parts.armL.rotation.x = -swing * 0.5;
          parts.armR.rotation.x = swing * 0.5 - armPitch;
      }
    } else {
      if (parts?.legL && parts?.legR && parts?.armL && parts?.armR) {
        const moving = speed > 0.15;
        const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * 0.18;

        let phase = (root as any).__walkPhase as number;
        if (!Number.isFinite(phase)) phase = 0;

        phase += moving ? phaseSpeed : 0.02;
        (root as any).__walkPhase = phase;

        const swing = Math.sin(phase) * (moving ? 0.55 : 0.08);

        if (mat) {
          const flashTime = remoteFlashes.get(id);
          if (flashTime && now - flashTime < 200) {
            mat.emissiveColor.set(1, 0.3, 0.3); 
          } else {
            mat.emissiveColor.set(1, 0.15, 0.15); 
          }
        }

        let armPitch = 0;
        const swingTime = remoteSwings.get(id);
        if (swingTime && now - swingTime < 300) {
          const st = (now - swingTime) / 300;
          armPitch = Math.sin(st * Math.PI) * 1.5; 
        }

        parts.legL.rotation.x = swing * 0.55;
        parts.legR.rotation.x = -swing * 0.55;
        parts.armL.rotation.x = -swing * 0.35;
        parts.armR.rotation.x = swing * 0.35 - armPitch; 
      }
    }
  }
}

/* ===============================
   12. Networking
================================ */
function normId(p: any): string | null {
  if (!p) return null;
  const id = p.id ?? p.sessionId ?? p.sid ?? p.clientId ?? null;
  if (id != null) return String(id);
  if (typeof p === "string") return p;
  return null;
}

function ensureUserId(): string {
  const key = "noa_user_id";
  let id = "";
  try { id = String(localStorage.getItem(key) ?? ""); } catch {}
  if (id && id.length >= 3) return id;

  const rand = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  id = `u_${Date.now().toString(16)}_${rand.slice(0, 10)}`;
  try { localStorage.setItem(key, id); } catch {}
  return id;
}

let canSendMoves = false;

async function connect() {
  try {
    updateOverlay();

    const userId = ensureUserId();
    room = await colyseus.joinOrCreate("my_room", { userId });
    (globalThis as any).room = room;

    updateOverlay();

    for (const req of queuedRequests.values()) {
      room.send("worldDataNeeded", req);
    }

    room.onMessage("chunkData", (msg: any) => applyChunkFromServer(msg));

    room.onMessage("safeZone", (m: any) => {
      if (!m || typeof m !== "object") return;
      const x = Number((m as any).x);
      const z = Number((m as any).z);
      const r = Number((m as any).r);
      if (!isFiniteNum(x) || !isFiniteNum(z) || !isFiniteNum(r)) return;
      safeZone = { x, z, r };
      updateOverlay("Safe Zone received");
    });

    room.onMessage("statsUpdate", (msg: any) => {
      myHp = Number(msg.hp ?? myHp);
      myMaxHp = Number(msg.maxHp ?? myMaxHp);
      myMana = Number(msg.mana ?? myMana);
      myMaxMana = Number(msg.maxMana ?? myMaxMana);
      updateOverlay();
    });

    room.onMessage("useManaResult", (msg: any) => {
      if (!msg.ok) return;
    });

    room.onMessage("playerHit", (msg: any) => {
      const targetId = msg.targetId;
      const attackerId = msg.attackerId;
      
      remoteSwings.set(attackerId, performance.now());

      if (targetId === room?.sessionId) {
        myHp = msg.hpLeft;
        myMaxHp = msg.maxHp ?? myMaxHp;
        
        const flash = document.createElement("div");
        flash.style.position = "absolute";
        flash.style.inset = "0";
        flash.style.backgroundColor = "rgba(255, 0, 0, 0.4)";
        flash.style.pointerEvents = "none";
        flash.style.zIndex = "9999";
        flash.style.transition = "opacity 0.3s ease-out";
        document.body.appendChild(flash);

        requestAnimationFrame(() => {
          flash.style.opacity = "0";
        });
        setTimeout(() => flash.remove(), 350);
      } else {
        remoteFlashes.set(targetId, performance.now());
        const t = netTransforms.get(targetId);
        if (t) {
          t.hp = msg.hpLeft;
          t.maxHp = msg.maxHp;
        }
      }
      updateOverlay();
    });

    room.onMessage("playerSwing", (msg: any) => {
      let x = 0;
      let y = 0;
      let z = 0;
      let yaw = 0;

      if (msg.id === room?.sessionId) {
        const pos = noa.ents.getPosition(noa.playerEntity);
        if (pos) {
          x = pos[0];
          y = pos[1];
          z = pos[2];
          yaw = readNoaYaw();
        }
      } else {
        if (msg.id) {
          remoteSwings.set(msg.id, performance.now());
          const t = netTransforms.get(msg.id);
          if (t) {
            x = t.x;
            y = t.y;
            z = t.z;
            yaw = t.yaw ?? 0;
          }
        }
      }

      if (msg.attackId) {
        spawnSkillVFX(msg.attackId, x, y, z, yaw);
      }
    });

    room.onMessage("attackResult", (msg: any) => {
      if (!msg.ok) {
        // Silent fail for normal gameplay
      }
    });

    room.onMessage("playerRespawn", (msg: any) => {
      if (msg.id === room?.sessionId) {
        myHp = msg.hp;
        myMaxHp = msg.maxHp ?? myMaxHp;
        myMana = msg.mana ?? myMana;
        myMaxMana = msg.maxMana ?? myMaxMana;
        try {
          noa.ents.setPosition(noa.playerEntity, [msg.x, msg.y, msg.z]);
        } catch {}
      }
    });

    room.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
        if (miningProgress && msg.x === miningProgress.x && msg.y === miningProgress.y && msg.z === miningProgress.z) {
          miningProgress = null;
        }
      }
    });

    room.onMessage("mineProgress", (m: any) => {
      if (!m || typeof m !== "object") return;
      const x = Number((m as any).x);
      const y = Number((m as any).y);
      const z = Number((m as any).z);
      const progress = Number((m as any).progress);
      const stage = Number((m as any).stage);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      if (!Number.isFinite(progress) || !Number.isFinite(stage)) return;

      miningProgress = {
        x, y, z,
        progress: Math.max(0, Math.min(1, progress)),
        stage: Math.max(0, Math.min(9, stage | 0)),
        done: !!(m as any).done,
        reason: typeof (m as any).reason === "string" ? (m as any).reason : undefined,
      };

      miningActive = true;
      miningStickyUntil = performance.now() + MINING_STICKY_MS;

      if ((m as any).done) {
        miningHeld = false;
        miningActive = false;
        miningTarget = null;
        lastMineSentKey = "";
        lastMineSendAt = 0;
      }
    });

    room.onMessage("mineCancelled", (_m: any) => {
      miningProgress = null;
      miningHeld = false;
      miningActive = false;
      miningTarget = null;
      lastMineSentKey = "";
      lastMineSendAt = 0;
    });

    room.onMessage("invState", (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      const slots = Array.isArray((msg as any).slots) ? (msg as any).slots : null;
      const cursor = (msg as any).cursor ?? null;
      const stats = (msg as any).stats ?? {};
      if (!slots) return;

      const outSlots: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
      for (let i = 0; i < Math.min(INV_SLOTS, slots.length); i++) {
        const s = slots[i];
        const id = Number((s as any)?.id ?? 0);
        const count = Number((s as any)?.count ?? 0);
        const dur = Number((s as any)?.dur ?? 0);

        outSlots[i] =
          Number.isFinite(id) && Number.isFinite(count) && id > 0 && count > 0
            ? Number.isFinite(dur) && dur > 0
              ? ({ id, count, dur } as any)
              : ({ id, count } as any)
            : ({ id: 0, count: 0 } as any);
      }

      const cId = Number((cursor as any)?.id ?? 0);
      const cCount = Number((cursor as any)?.count ?? 0);
      const cDur = Number((cursor as any)?.dur ?? 0);

      const outCursor: ItemStack =
        Number.isFinite(cId) && Number.isFinite(cCount) && cId > 0 && cCount > 0
          ? Number.isFinite(cDur) && cDur > 0
            ? ({ id: cId, count: cCount, dur: cDur } as any)
            : ({ id: cId, count: cCount } as any)
          : ({ id: 0, count: 0 } as any);

      myHp = Number(stats.hp ?? 20);
      myMaxHp = Number(stats.maxHp ?? 20);
      myMana = Number(stats.mana ?? 50);
      myMaxMana = Number(stats.maxMana ?? 50);

      invState = { 
        slots: outSlots, 
        cursor: outCursor,
        stats: { hp: myHp, maxHp: myMaxHp, mana: myMana, maxMana: myMaxMana }
      };
      
      renderInventoryUI();
      updateOverlay();
    });

    room.onMessage("chatMessage", (msg: any) => {
      if (msg && typeof msg.msg === "string") {
        updateOverlay(`<span style="color: #00FFFF; font-weight: bold; text-shadow: 0 0 5px #00FFFF;">*** ${msg.msg} ***</span>`);
      }
    });

    room.onMessage("dropSpawn", (d: any) => {
      if (!d || typeof d.dropId !== "string") return;
      const dd: Drop = {
        dropId: d.dropId,
        itemId: Number(d.itemId ?? 0),
        count: Number(d.count ?? 0),
        x: Number(d.x ?? 0),
        y: Number(d.y ?? 0),
        z: Number(d.z ?? 0),
        createdAt: Number(d.createdAt ?? Date.now()),
      };
      if (!Number.isFinite(dd.itemId) || !Number.isFinite(dd.count)) return;
      drops.set(dd.dropId, dd);
      updateOverlay();
    });

    room.onMessage("dropDespawn", (m: any) => {
      const id = typeof (m as any)?.dropId === "string" ? (m as any).dropId : "";
      if (!id) return;
      drops.delete(id);
      const mesh = dropMeshes.get(id);
      if (mesh) {
        try { mesh.dispose(); } catch {}
        dropMeshes.delete(id);
      }
      updateOverlay();
    });

    room.onMessage("craftResult", (m: any) => {
      const ok = !!(m as any)?.ok;
      const recipeId = typeof (m as any)?.recipeId === "string" ? (m as any).recipeId : "";
      const crafted = Number((m as any)?.crafted ?? 0);
      const reason = typeof (m as any)?.reason === "string" ? (m as any).reason : "";
      craftStatus.textContent = ok
        ? `Crafted ${crafted} × (${recipeId})`
        : `Craft failed (${recipeId}) ${reason ? `- ${reason}` : ""}`;
      setTimeout(() => {
        if (!invOpen) return;
        craftStatus.textContent = "RMB a recipe to craft MAX.";
      }, 2000);
    });

    room.onMessage("existingPlayers", (players: any) => {
      if (!Array.isArray(players)) return;
      for (const p of players ?? []) {
        const id = normId(p);
        if (!id || (room && id === room.sessionId)) continue;

        const x = Number((p as any).x ?? 0);
        const y = Number((p as any).y ?? 0);
        const z = Number((p as any).z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        netTransforms.set(id, {
          x, y, z,
          yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
          hp: typeof (p as any).hp === "number" ? (p as any).hp : undefined,
          maxHp: typeof (p as any).maxHp === "number" ? (p as any).maxHp : undefined,
        });
      }
      lastTransformAt = performance.now();
      updateOverlay("existingPlayers received");
    });

    room.onMessage("playerJoined", (p: any) => {
      const id = normId(p);
      if (!id || (room && id === room.sessionId)) return;

      const x = Number((p as any).x ?? 0);
      const y = Number((p as any).y ?? 0);
      const z = Number((p as any).z ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, {
        x, y, z,
        yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
        hp: typeof (p as any).hp === "number" ? (p as any).hp : undefined,
        maxHp: typeof (p as any).maxHp === "number" ? (p as any).maxHp : undefined,
      });
      lastTransformAt = performance.now();
    });

    room.onMessage("playerLeft", (p: any) => {
      const id = normId(p);
      if (!id) return;
      netTransforms.delete(id);
      removeRemoteMesh(id);
      lastTransformAt = performance.now();
    });

    room.onMessage("playerTransformOther", (p: any) => {
      const id = normId(p);
      if (!id || (room && id === room.sessionId)) return;

      const x = Number((p as any).x);
      const y = Number((p as any).y);
      const z = Number((p as any).z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      const t = netTransforms.get(id);
      if (t) {
        t.x = x;
        t.y = y;
        t.z = z;
        if (typeof (p as any).yaw === "number") t.yaw = (p as any).yaw;
      } else {
        netTransforms.set(id, {
          x, y, z,
          yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
        });
      }
      lastTransformAt = performance.now();
    });

    room.onMessage("playersSnapshot", (players: any) => {
      if (!Array.isArray(players)) return;
      const ids: string[] = [];
      for (const p of players) {
        const id = normId(p);
        if (!id || (room && id === room.sessionId)) continue;

        const x = Number((p as any).x);
        const y = Number((p as any).y);
        const z = Number((p as any).z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        ids.push(id);
        const existing = netTransforms.get(id);
        if (existing) {
          existing.x = x;
          existing.y = y;
          existing.z = z;
          if (typeof (p as any).yaw === "number") existing.yaw = (p as any).yaw;
          if (typeof (p as any).hp === "number") existing.hp = (p as any).hp;
          if (typeof (p as any).maxHp === "number") existing.maxHp = (p as any).maxHp;
        } else {
          netTransforms.set(id, {
            x, y, z,
            yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
            hp: typeof (p as any).hp === "number" ? (p as any).hp : undefined,
            maxHp: typeof (p as any).maxHp === "number" ? (p as any).maxHp : undefined,
          });
        }
      }
      lastSnapshotIds = ids;
      lastSnapshotAt = performance.now();
    });

    room.onMessage("youJoined", (p: any) => {
      const x = Number((p as any).x);
      const y = Number((p as any).y);
      const z = Number((p as any).z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      try {
        noa.ents.setPosition(noa.playerEntity, [x, y, z]);
      } catch {}

      canSendMoves = true;
      updateOverlay("Spawn synced.");
    });
  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed!</span>";
  }
}

initUI();
connect();

/* ===============================
   12.5 Visual Effects (VFX)
================================ */
const activeVFX: Array<{ 
  type: string; 
  mesh: BABYLON.Mesh; 
  mat: BABYLON.StandardMaterial; 
  life: number; 
  maxLife: number; 
  basePos: BABYLON.Vector3 
}> = [];

function spawnSkillVFX(attackId: string, globalX: number, globalY: number, globalZ: number, yaw: number) {
  if (!rpReady || !rpScene) {
    return;
  }

  const scene = rpScene;
  const uid = `${attackId}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  let mesh: BABYLON.Mesh;
  const mat = new BABYLON.StandardMaterial(`vfxMat_${uid}`, scene);
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.alpha = 1.0;
  mat.alphaMode = BABYLON.Constants.ALPHA_ADD;
  mat.disableDepthWrite = true;
  mat.depthFunction = BABYLON.Constants.ALWAYS;
  
  let maxLife = 0.6;

  if (attackId === "AURA_SLASH") {
    mesh = BABYLON.MeshBuilder.CreateTorus(`slashVFX_${uid}`, { diameter: 4, thickness: 0.2, tessellation: 24 }, scene);
    mesh.scaling.y = 0.1; 
    mat.emissiveColor = new BABYLON.Color3(0, 1, 1); 
  } else if (attackId === "AURA_HEAVY") {
    mesh = BABYLON.MeshBuilder.CreateSphere(`heavyVFX_${uid}`, { diameter: 3, segments: 16 }, scene);
    mat.emissiveColor = new BABYLON.Color3(1, 0, 1); 
    maxLife = 0.8;
  } else if (attackId === "AURA_THRUST") {
    mesh = BABYLON.MeshBuilder.CreateCylinder(`thrustVFX_${uid}`, { height: 6, diameter: 0.6 }, scene);
    mesh.rotation.x = Math.PI / 2; 
    mat.emissiveColor = new BABYLON.Color3(1, 1, 0); 
  } else {
    return; 
  }

  mesh.material = mat;
  mesh.isPickable = false;
  mesh.renderingGroupId = 3; 
  (mesh as any).isInFrustum = () => true;
  (mesh as any).alwaysSelectAsActiveMesh = true;
  
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  
  let bx = globalX + forwardX * 1.5;
  let by = globalY + 1.2;
  let bz = globalZ + forwardZ * 1.5;
  
  if (attackId === "AURA_THRUST") {
    mesh.rotation.y = yaw;
    bx = globalX + forwardX * 3;
    bz = globalZ + forwardZ * 3;
  }

  const basePos = new BABYLON.Vector3(bx, by, bz);

  mesh.position.set(
    basePos.x + rpRenderOffset.x,
    basePos.y + rpRenderOffset.y,
    basePos.z + rpRenderOffset.z
  );

  activeVFX.push({ type: attackId, mesh, mat, life: 0, maxLife, basePos }); 
}

/* ===============================
   13. Tick loop
================================ */
let tickCount = 0;
let lastTickMs = performance.now();

(noa as any).on("tick", () => {
  tickCount++;

  const now = performance.now();
  const dtSec = Math.min(0.05, (now - lastTickMs) / 1000);
  lastTickMs = now;

  const scene = getStableScene();
  if (scene) {
    ensureVmScene(scene);
    ensureRpScene(scene);
    ensureDropVisuals(scene);

    updateSafeZoneVisual(scene);
    updateTownHallLabel(scene);

    syncRpCameraFromWorld(scene);

    updateCrackVisual(scene);
    updateMiningParticles(scene);
  }

  for (let i = activeVFX.length - 1; i >= 0; i--) {
    const vfx = activeVFX[i];
    vfx.life += dtSec;
    
    const progress = Math.min(1, vfx.life / vfx.maxLife);
    
    if (progress > 0.5) {
      vfx.mat.alpha = 1.0 * (1 - ((progress - 0.5) * 2));
    }
    
    if (vfx.type === "AURA_SLASH") {
      vfx.mesh.scaling.x += dtSec * 8;
      vfx.mesh.scaling.z += dtSec * 8;
    } else if (vfx.type === "AURA_HEAVY") {
      vfx.mesh.scaling.x += dtSec * 5;
      vfx.mesh.scaling.y += dtSec * 5;
      vfx.mesh.scaling.z += dtSec * 5;
    } else if (vfx.type === "AURA_THRUST") {
      vfx.mesh.scaling.y += dtSec * 8; 
    }

    vfx.mesh.position.set(
      vfx.basePos.x + rpRenderOffset.x,
      vfx.basePos.y + rpRenderOffset.y,
      vfx.basePos.z + rpRenderOffset.z
    );

    if (vfx.life >= vfx.maxLife) {
      vfx.mat.dispose();
      vfx.mesh.dispose();
      activeVFX.splice(i, 1);
    }
  }

  updateViewmodel(dtSec);
  updateRemoteMeshes();
  updateDropVisuals(dtSec);
  tryAutoPickup();

  if (miningActive && hasPointerLock() && !invOpen) {
    const t = getTargetInfo();

    if (!t?.pos) {
      if (!miningHeld && performance.now() > miningStickyUntil) {
        cancelMiningLocal("no_target");
      }
    } else {
      const { x, y, z } = t.pos;

      if (isInSafeZoneXZ(x, z)) {
        cancelMiningLocal("safe_zone");
      } else if (miningHeld) {
        if (!miningTarget || miningTarget.x !== x || miningTarget.y !== y || miningTarget.z !== z) {
          miningTarget = { x, y, z };
          miningProgress = { x, y, z, progress: 0, stage: 0 };
          lastMineSentKey = "";
          lastMineSendAt = 0;
          sendStartMine(x, y, z);
        } else {
          if (tickCount % 20 === 0) sendStartMine(x, y, z);
        }
      } else {
        if (!miningTarget) {
          miningTarget = { x, y, z };
          miningProgress = { x, y, z, progress: 0, stage: 0 };
          lastMineSentKey = "";
          lastMineSendAt = 0;
          sendStartMine(x, y, z);
        } else {
          if (tickCount % 6 === 0) sendStartMine(miningTarget.x, miningTarget.y, miningTarget.z);

          if (performance.now() > miningStickyUntil && !miningHeld) {
            if (miningProgress && miningProgress.progress < 1) {
              miningStickyUntil = performance.now() + MINING_STICKY_MS;
            } else {
              cancelMiningLocal("sticky_expired");
            }
          }
        }
      }
    }
  } else {
    if (miningActive) cancelMiningLocal(invOpen ? "inventory_open" : "no_pointer_lock");
  }

  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  if (tickCount % 10 === 0) {
    updateOverlay();
    updateCoordsHUD();
  }
});