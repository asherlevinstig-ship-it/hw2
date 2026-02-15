/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * NOA voxel client + Colyseus multiplayer
 * - Server authoritative chunk streaming (Path B)
 * - Mine/place block sync (Option A: server authoritative)
 * - Remote players rendered in a SECOND Babylon scene (rpScene) rendered AFTER NOA
 * - FIRST-PERSON VIEWMODEL ARM rendered in a SECOND Babylon scene (vmScene)
 *
 * Added:
 * ✅ Inventory (hotbar + backpack) with cursor + clicks (left/right/shift)
 * ✅ Server-authoritative drops + pickup (auto pickup when close)
 * ✅ Basic crafting via simple recipe list (buttons in inventory UI)
 * ✅ 16x16 TEXTURE ATLAS (vertical strip) for blocks (grass top/side/bottom etc)
 *
 * Option A (new):
 * ✅ Server-authoritative mining (hold-to-mine): client does NOT remove blocks locally
 * ✅ Mining progress "cracks" (visual overlay wireframe cube, driven by server progress)
 * ✅ Tool-based mining speeds (server computes; client just displays progress)
 *
 * Atlas requirement (NOA):
 * - Atlas is a VERTICAL STRIP: width=16, height=16*N tiles stacked top->bottom.
 * - We select a tile via `atlasIndex`.
 *
 * Controls:
 * - V toggles viewmodel overlay ON/OFF
 * - P toggles Remote Player overlay ON/OFF
 * - O toggles Remote "X-RAY" (always visible) ON/OFF
 * - I toggles Inventory UI
 *
 * Debug controls (viewmodel):
 * - B toggles VM debug visuals (axes + screen frame)
 * - N toggles VM tuning mode (enables hotkey nudging)
 * - M toggles VM mirror (fixes "wrong direction"/handedness)
 *
 * IMPORTANT FIX:
 * When VM tuning is ON, we intercept tuning keys at CAPTURE phase and call
 * preventDefault + stopPropagation so NOA doesn't treat arrow keys as movement.
 *
 * IMPORTANT FIX (TDZ):
 * ✅ Declare mining state BEFORE updateOverlay() is first called.
 *
 * IMPORTANT FIX (Pointer Lock):
 * ✅ Use document.pointerLockElement instead of noa.container.hasPointerLock.
 */

import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core/Legacy/legacy";

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

// Prevent RMB menu inside inv (we already do global, but keep it explicit)
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
invHint.textContent = "LMB: pick/place/stack | RMB: half/place-one | Shift+LMB: quick move";
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
      scene?.getEngine?.()?.getRenderingCanvas?.() ?? (noa as any).container ?? appEl;

    if (canvas?.requestPointerLock) canvas.requestPointerLock();
  } catch {
    if ((appEl as any).requestPointerLock) (appEl as any).requestPointerLock();
  }
}

appEl.addEventListener("click", () => {
  if (!invOpen) requestPointerLock();
});

// ✅ FIX: reliable pointer lock check
function hasPointerLock(): boolean {
  return document.pointerLockElement != null;
}

/* ===============================
   5. Register Blocks & Materials (16x16 VERTICAL STRIP ATLAS)
================================ */
// Block IDs (MUST match server)
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;

// Minerals + bedrock (MUST match server)
const BEDROCK_ID = 6;
const COAL_ORE_ID = 7;
const IRON_ORE_ID = 8;
const GOLD_ORE_ID = 9;
const DIAMOND_ORE_ID = 10;

// Vite-safe asset URL: create client/src/assets/terrain_atlas.png
// The atlas must be width=16, height=16*N tiles stacked top->bottom.
const TERRAIN_ATLAS_URL = new URL("./assets/terrain_atlas.png", import.meta.url).href;

// Atlas indices (tile order top->bottom in your PNG)
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
} as const;

/**
 * ✅ noa-engine v0.33+ API:
 * registerMaterial(name, optionsObj)
 * optionsObj uses:
 *   - textureURL (string)
 *   - atlasIndex (number)
 *   - texHasAlpha (boolean)
 *
 * If you pass "texture" instead of "textureURL", NOA will create the material
 * without any diffuseTexture -> your world becomes WHITE.
 */
function registerAtlasMaterial(
  name: string,
  opts: { textureURL: string; atlasIndex: number; texHasAlpha?: boolean }
) {
  console.log("[ATLAS] creating material", name, "index", opts.atlasIndex, "url", opts.textureURL);
  noa.registry.registerMaterial(name, opts as any);
}

registerAtlasMaterial("grass_top", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.GRASS_TOP,
});

registerAtlasMaterial("grass_side", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.GRASS_SIDE,
});

registerAtlasMaterial("dirt", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.DIRT,
});

registerAtlasMaterial("stone", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.STONE,
});

registerAtlasMaterial("wood", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.WOOD,
});

registerAtlasMaterial("leaves", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.LEAVES,
  texHasAlpha: true,
});

registerAtlasMaterial("bedrock", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.BEDROCK,
});

registerAtlasMaterial("coal_ore", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.COAL_ORE,
});

registerAtlasMaterial("iron_ore", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.IRON_ORE,
});

registerAtlasMaterial("gold_ore", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.GOLD_ORE,
});

registerAtlasMaterial("diamond_ore", {
  textureURL: TERRAIN_ATLAS_URL,
  atlasIndex: ATLAS.DIAMOND_ORE,
});

// Blocks
noa.registry.registerBlock(GRASS_ID, {
  // [top, bottom, sides]
  material: ["grass_top", "dirt", "grass_side"],
});

noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });
noa.registry.registerBlock(WOOD_ID, { material: "wood" });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves", opaque: false });

noa.registry.registerBlock(BEDROCK_ID, { material: "bedrock" });
noa.registry.registerBlock(COAL_ORE_ID, { material: "coal_ore" });
noa.registry.registerBlock(IRON_ORE_ID, { material: "iron_ore" });
noa.registry.registerBlock(GOLD_ORE_ID, { material: "gold_ore" });
noa.registry.registerBlock(DIAMOND_ORE_ID, { material: "diamond_ore" });

/* ===============================
   6. Item/Inventory State
================================ */
// Item IDs (MUST match server)
const Items = {
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  PLANK: 10,
  STICK: 11,
  WOOD_PICK: 20,

  COAL: 30,
  RAW_IRON: 31,
  RAW_GOLD: 32,
  DIAMOND: 33,
} as const;

type ItemDef = {
  id: number;
  name: string;
  maxStack: number;
  placeBlockId?: number;
};

const ITEM_DEFS: Record<number, ItemDef> = {
  1: { id: 1, name: "Grass", maxStack: 64, placeBlockId: GRASS_ID },
  2: { id: 2, name: "Dirt", maxStack: 64, placeBlockId: DIRT_ID },
  3: { id: 3, name: "Stone", maxStack: 64, placeBlockId: STONE_ID },
  4: { id: 4, name: "Wood", maxStack: 64, placeBlockId: WOOD_ID },
  5: { id: 5, name: "Leaves", maxStack: 64, placeBlockId: LEAVES_ID },

  10: { id: 10, name: "Planks", maxStack: 64 },
  11: { id: 11, name: "Stick", maxStack: 64 },
  20: { id: 20, name: "Wood Pick", maxStack: 1 },

  30: { id: 30, name: "Coal", maxStack: 64 },
  31: { id: 31, name: "Raw Iron", maxStack: 64 },
  32: { id: 32, name: "Raw Gold", maxStack: 64 },
  33: { id: 33, name: "Diamond", maxStack: 64 },
};

type ItemStack = { id: number; count: number };
type InvState = { slots: ItemStack[]; cursor: ItemStack };

const HOTBAR_SLOTS = 5;
const BACKPACK_SLOTS = 20;
const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

let invOpen = false;
let invState: InvState = {
  slots: Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 })),
  cursor: { id: 0, count: 0 },
};

let selectedHotbar = 0;
let viewModelEnabled = true;

// Remote overlay toggles
let remotePlayersEnabled = true;
let remoteXray = true; // always visible by default (debug)

/* ===============================
   6.1 Viewmodel Debug/Tuning State
================================ */
let vmDebug = true;
let vmTuning = false;
let vmMirrorX = true;

// Tunable base placement & pose
let vmBaseXMul = 0.74;
let vmBaseY = -0.68;

let vmRotX = 0.22;
let vmRotY = 0.10;
let vmRotZ = -0.58;

// responsiveness multipliers
let vmPitchMul = 0.45;
let vmPunchRotMul = 0.75;
let vmTurnSwayMulY = 0.35;
let vmTurnSwayMulZ = 0.25;
let vmPunchMoveX = 0.12;
let vmPunchMoveY = 0.08;

/* ===============================
   6.2 Remote state (DECLARED EARLY to avoid TDZ)
================================ */
type NetTransform = { x: number; y: number; z: number; yaw?: number };
const netTransforms = new Map<string, NetTransform>();

let lastSnapshotIds: string[] = [];
let lastSnapshotAt = 0;
let lastTransformAt = 0;

/* ===============================
   6.3 Drops state (server authoritative)
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

// Visual meshes for drops
const dropMeshes = new Map<string, BABYLON.AbstractMesh>();
let dropSceneUid: string | number | null = null;

// Pickup throttling
let lastPickupScanAt = 0;
let lastPickupSentAt = 0;
const pickupSentRecently = new Map<string, number>();

/* ===============================
   6.4 Mining progress (Option A)  ✅ MOVED UP to avoid TDZ
================================ */
type MineProgressMsg = {
  x: number;
  y: number;
  z: number;
  progress: number; // 0..1
  stage: number; // 0..9
  done?: boolean;
  reason?: string;
};

let miningHeld = false;
let miningTarget: { x: number; y: number; z: number } | null = null;
let miningProgress: MineProgressMsg | null = null;
let lastMineSentKey = "";
let lastMineSendAt = 0;

let crackMesh: BABYLON.Mesh | null = null;
let crackMat: BABYLON.StandardMaterial | null = null;
let crackSceneUid: string | number | null = null;

/* ===============================
   6.5 Inventory UI rendering + events
================================ */
const slotEls: HTMLDivElement[] = [];
const backpackEls: HTMLDivElement[] = [];

function stackLabel(s: ItemStack): string {
  if (!s || s.id <= 0 || s.count <= 0) return "";
  const def = ITEM_DEFS[s.id];
  const nm = def ? def.name : `Item ${s.id}`;
  return `${nm}\n×${s.count}`;
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
    const def = ITEM_DEFS[stack.id];
    const nm = def ? def.name : `Item ${stack.id}`;
    const name = document.createElement("div");
    name.textContent = nm;
    name.style.fontSize = "11px";
    name.style.textAlign = "center";
    name.style.padding = "0 6px";
    name.style.opacity = "0.95";
    name.style.wordBreak = "break-word";

    const count = document.createElement("div");
    count.textContent = `×${stack.count}`;
    count.style.position = "absolute";
    count.style.right = "6px";
    count.style.bottom = "4px";
    count.style.fontSize = "12px";
    count.style.opacity = "0.95";

    el.appendChild(name);
    el.appendChild(count);
  }
}

function renderInventoryUI() {
  // Cursor
  renderSlot(cursorSlotEl, invState.cursor, false);
  cursorNameEl.textContent =
    invState.cursor.id > 0 ? stackLabel(invState.cursor).split("\n")[0] : "(empty)";

  // Hotbar
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    renderSlot(slotEls[i], invState.slots[i], i === selectedHotbar);
  }

  // Backpack
  for (let i = 0; i < BACKPACK_SLOTS; i++) {
    renderSlot(backpackEls[i], invState.slots[HOTBAR_SLOTS + i], false);
  }

  // Craft buttons enable/disable (client hint only)
  const canCraft = (recipeId: string) => {
    const countItem = (id: number) => {
      let n = 0;
      for (const s of invState.slots) if (s.id === id && s.count > 0) n += s.count;
      return n;
    };

    if (recipeId === "planks_from_log") return countItem(Items.WOOD_LOG) >= 1;
    if (recipeId === "sticks_from_planks") return countItem(Items.PLANK) >= 2;
    if (recipeId === "wood_pick") return countItem(Items.PLANK) >= 3 && countItem(Items.STICK) >= 2;
    return true;
  };

  for (const child of Array.from(craftList.children)) {
    const el = child as HTMLButtonElement;
    const rid = (el as any).__recipeId as string | undefined;
    if (!rid) continue;
    const ok = canCraft(rid);
    el.style.opacity = ok ? "1" : "0.5";
  }
}

function sendInvClick(slot: number, button: "L" | "R", shift: boolean) {
  if (!room) return;
  room.send("invClick", { slot, button, shift });
}

function setupInventorySlots() {
  // Hotbar slots
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const el = document.createElement("div");
    (el as any).__slotIndex = i;
    el.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.button === 2 ? "R" : "L";
      sendInvClick(i, btn, e.shiftKey);
    };
    slotEls.push(el);
    hotbarGrid.appendChild(el);
  }

  // Backpack slots
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
    backpackEls.push(el);
    backpackGrid.appendChild(el);
  }
}
setupInventorySlots();

// Craft buttons
function addCraftButton(title: string, recipeId: string) {
  const b = mkButton(title);
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
addCraftButton("Wood → Planks (1 log → 4 planks) [RMB = max]", "planks_from_log");
addCraftButton("Planks → Sticks (2 planks → 4 sticks) [RMB = max]", "sticks_from_planks");
addCraftButton("Wood Pick (3 planks + 2 sticks) [RMB = max]", "wood_pick");

function cancelMiningLocal(reason = "") {
  miningHeld = false;
  miningTarget = null;
  miningProgress = null;
  lastMineSentKey = "";
  if (room) room.send("cancelMine", { reason });
}

function setInvOpen(open: boolean) {
  invOpen = open;
  invRoot.style.display = invOpen ? "block" : "none";
  craftStatus.textContent = invOpen ? "RMB a recipe to craft MAX." : "";
  renderInventoryUI();

  // cancel mining when opening UI
  if (invOpen) cancelMiningLocal("inventory_open");
}

/* ===============================
   6.6 Overlay
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
  const def = ITEM_DEFS[s.id];
  return def ? def.name : `Item ${s.id}`;
}

function updateOverlay(extraLine = "") {
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
      : "Mining: -";

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
    -------------------------<br>
    [Hold LMB] Mine  |  [R-Click] Place<br>
    [1-5] Select Hotbar Slot<br>
    [WASD] Move  |  [Space] Jump<br>
    [I] Inventory<br>
    [V] Toggle Viewmodel<br>
    [P] Toggle Remote Players<br>
    [O] Toggle Remote Xray<br>
    [B] Toggle VM Debug (axes/frame)<br>
    [N] Toggle VM Tuning (captures tuning keys)<br>
    [M] Toggle VM Mirror (handedness)<br>
    <span style="opacity:.9">Remote debug:</span><br>
    <span style="opacity:.9">netTransforms=${netTransforms.size} closest=${closestStr}</span><br>
    <span style="opacity:.9">lastSnapshot=${snapAge} lastTransform=${xformAge}</span><br>
    <span style="opacity:.9">snapshotIds=[${snapPreview}]</span><br>
    <span style="opacity:.9">drops=${drops.size}</span><br>
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}
updateOverlay();

/* ===============================
   6.7 Key handling
================================ */
document.addEventListener("keydown", (e) => {
  // Hotbar 1-5
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
});

// Capture-phase handler for tuning keys ONLY (so mouse/NOA stays normal)
window.addEventListener(
  "keydown",
  (e) => {
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

    // Move anchor
    if (e.key === "ArrowLeft") vmBaseXMul -= fineMove;
    if (e.key === "ArrowRight") vmBaseXMul += fineMove;
    if (e.key === "ArrowUp") vmBaseY += fineMove;
    if (e.key === "ArrowDown") vmBaseY -= fineMove;

    // Rotate base pose
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
   7. World Streaming (Path B)
================================ */
type PendingChunk = { data: any; chunkSize: number; x: number; y: number; z: number };

const pendingChunks = new Map<string, PendingChunk>();
const queuedRequests = new Map<
  string,
  { id: string; chunkSize: number; x: number; y: number; z: number }
>();
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

type TypedArrayLike = { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
function isTypedArrayLike(v: unknown): v is TypedArrayLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "buffer" in (v as any) &&
    "byteOffset" in (v as any) &&
    "byteLength" in (v as any) &&
    (v as any).buffer instanceof ArrayBuffer
  );
}
function toNumberArrayVoxels(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) | 0;
    return out;
  }
  if (isTypedArrayLike(v)) {
    const u8 = new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
    const out = new Array<number>(u8.length);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] | 0;
    return out;
  }
  if (v instanceof ArrayBuffer) {
    const u8 = new Uint8Array(v);
    const out = new Array<number>(u8.length);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] | 0;
    return out;
  }
  return null;
}

function applyChunkFromServer(msg: any) {
  if (!msg || typeof msg.id !== "string") return;

  const pending = pendingChunks.get(msg.id);
  if (!pending) return;

  const CS =
    typeof msg.chunkSize === "number" && Number.isFinite(msg.chunkSize)
      ? msg.chunkSize
      : pending.chunkSize;

  const expected = CS * CS * CS;

  const voxels = toNumberArrayVoxels(msg.voxels);
  if (!voxels || voxels.length !== expected) return;

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
   8. Interaction (Mine/Place) - Option A mining
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

/* ---- Viewmodel punch ---- */
let punchT = 1; // 0..1
function triggerPunch() {
  punchT = 0;
}

function sendStartMine(x: number, y: number, z: number) {
  if (!room) return;
  const now = performance.now();
  if (now - lastMineSendAt < 40) return; // tiny throttle
  lastMineSendAt = now;

  const key = `${x},${y},${z}`;
  if (key === lastMineSentKey) return;
  lastMineSentKey = key;

  room.send("startMine", { x, y, z });
}

/* Hold-to-mine start */
noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  if (invOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.pos;
  miningHeld = true;
  miningTarget = { x, y, z };
  miningProgress = { x, y, z, progress: 0, stage: 0 };

  lastMineSentKey = "";
  sendStartMine(x, y, z);
});

/* Release to cancel */
window.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return; // left button only
  if (!miningHeld) return;
  cancelMiningLocal("mouseup");
});

/* Place block (Option A: do NOT setBlockID locally) */
noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  if (invOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.adj;

  const stack = invState.slots[selectedHotbar];
  if (!stack || stack.id <= 0 || stack.count <= 0) return;

  const def = ITEM_DEFS[stack.id];
  if (!def || typeof def.placeBlockId !== "number") return;

  const blockToPlace = def.placeBlockId;

  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);

  // don't place into your own body
  if (x === px && z === pz && (y === py || y === py + 1)) return;

  room?.send("placeBlock", { x, y, z, id: blockToPlace, fromSlot: selectedHotbar });
});

/* ===============================
   9. Babylon scene access (NOA scene)
================================ */
function getNoaScene(): BABYLON.Scene | null {
  const r = (noa as any).rendering as any;
  if (!r) return null;
  const s =
    (typeof r.getScene === "function" ? r.getScene() : null) ?? r._scene ?? r.scene ?? null;
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
   9.1 Mining crack visuals (wireframe overlay)
================================ */
function ensureCrackVisual(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;
  if (crackSceneUid == null) crackSceneUid = uid ?? null;

  // if scene changed (NOA scene recreated), rebuild
  if (crackSceneUid !== (uid ?? null)) {
    try {
      crackMesh?.dispose();
    } catch {}
    try {
      crackMat?.dispose();
    } catch {}
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

  // opacity ramps up with progress
  const a = BABYLON.Scalar.Clamp(0.15 + progress * 0.65, 0, 0.9);
  crackMat.alpha = a;

  // subtle “pulse” as you mine
  const pulse = 1.02 + Math.sin(performance.now() / 80) * 0.005;
  crackMesh.scaling.set(pulse, pulse, pulse);
}

/* ===============================
   9.2 Drop visuals in NOA world scene
================================ */
function disposeAllDropMeshes() {
  for (const m of dropMeshes.values()) {
    try {
      m.dispose();
    } catch {}
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

    const box = BABYLON.MeshBuilder.CreateBox(`drop:${d.dropId}`, { size: 0.28 }, scene);
    box.isPickable = false;
    (box as any).isInFrustum = () => true;

    const mat = new BABYLON.StandardMaterial(`dropMat:${d.dropId}`, scene);
    mat.disableLighting = true;

    const c = (() => {
      if (d.itemId === Items.DIAMOND) return new BABYLON.Color3(0.2, 0.9, 0.9);
      if (d.itemId === Items.RAW_GOLD) return new BABYLON.Color3(0.9, 0.8, 0.2);
      if (d.itemId === Items.RAW_IRON) return new BABYLON.Color3(0.75, 0.55, 0.35);
      if (d.itemId === Items.COAL) return new BABYLON.Color3(0.2, 0.2, 0.2);
      if (d.itemId === Items.WOOD_LOG) return new BABYLON.Color3(0.45, 0.28, 0.12);
      if (d.itemId === Items.STONE) return new BABYLON.Color3(0.6, 0.6, 0.6);
      return new BABYLON.Color3(0.85, 0.85, 0.85);
    })();

    mat.emissiveColor = c;
    mat.diffuseColor = c.clone();
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.backFaceCulling = false;
    (mat as any).fogEnabled = false;

    box.material = mat;

    box.position.set(d.x, d.y, d.z);
    dropMeshes.set(d.dropId, box);
  }

  for (const id of Array.from(dropMeshes.keys())) {
    if (!drops.has(id)) {
      const m = dropMeshes.get(id);
      try {
        m?.dispose();
      } catch {}
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
    m.rotation.y += dtSec * 1.4;
  }
}

function tryAutoPickup() {
  if (!room) return;
  if (!hasPointerLock()) return;
  if (invOpen) return;
  if (drops.size <= 0) return;

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
   10. Viewmodel Overlay Scene (vmScene)
================================ */
let vmReady = false;
let vmScene: BABYLON.Scene | null = null;
let vmCam: BABYLON.FreeCamera | null = null;

let vmRoot: BABYLON.TransformNode | null = null;
let vmArmRoot: BABYLON.TransformNode | null = null;

let vmEngineHooked = false;

// Debug meshes
let vmAxes: BABYLON.TransformNode | null = null;
let vmFrame: BABYLON.LinesMesh | null = null;

function ensureVmScene(noaScene: BABYLON.Scene) {
  if (vmReady && vmScene && vmCam && vmRoot && vmArmRoot) return;

  const engine = noaScene.getEngine();

  vmScene = new BABYLON.Scene(engine);
  vmScene.useRightHandedSystem = noaScene.useRightHandedSystem;

  console.log("[VM] ensureVmScene", { useRightHandedSystem: vmScene.useRightHandedSystem });

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

  const upper = BABYLON.MeshBuilder.CreateBox(
    "vmUpperArm",
    { width: 0.16, height: 0.44, depth: 0.16 },
    vmScene
  );
  const fore = BABYLON.MeshBuilder.CreateBox(
    "vmForeArm",
    { width: 0.16, height: 0.38, depth: 0.16 },
    vmScene
  );
  const hand = BABYLON.MeshBuilder.CreateBox(
    "vmHand",
    { width: 0.17, height: 0.18, depth: 0.17 },
    vmScene
  );

  upper.parent = vmArmRoot;
  fore.parent = vmArmRoot;
  hand.parent = vmArmRoot;

  vmArmRoot.position.set(0.0, 0.10, 0.0);

  upper.position.set(0.0, 0.22, 0.0);
  fore.position.set(0.0, -0.14, 0.02);
  hand.position.set(0.0, -0.40, 0.04);

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

  upper.isPickable = fore.isPickable = hand.isPickable = false;

  (upper as any).isInFrustum = () => true;
  (fore as any).isInFrustum = () => true;
  (hand as any).isInFrustum = () => true;

  const ensureVmDebugMeshes = () => {
    if (!vmScene || !vmRoot || !vmCam) return;

    if (!vmAxes) {
      vmAxes = new BABYLON.TransformNode("vmAxes", vmScene);
      vmAxes.parent = vmRoot;

      const makeAxis = (name: string, to: BABYLON.Vector3, color: BABYLON.Color3) => {
        const l = BABYLON.MeshBuilder.CreateLines(
          name,
          { points: [BABYLON.Vector3.Zero(), to] },
          vmScene!
        );
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
   10.1 Viewmodel animation (screenspace)
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
  const v =
    typeof p1 === "number" && Number.isFinite(p1)
      ? p1
      : typeof p2 === "number" && Number.isFinite(p2)
        ? p2
        : typeof p3 === "number" && Number.isFinite(p3)
          ? p3
          : typeof p4 === "number" && Number.isFinite(p4)
            ? p4
            : 0;
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

  vmArmRoot.rotation.x =
    vmRotX + pitchInfluence * vmPitchMul - punch01 * vmPunchRotMul + lookSway * 0.35;
  vmArmRoot.rotation.y = vmRotY + turnSway * vmTurnSwayMulY;
  vmArmRoot.rotation.z = vmRotZ + swing - turnSway * vmTurnSwayMulZ;
}

/* ===============================
   11. Remote Players Overlay Scene (rpScene)
================================ */
let rpReady = false;
let rpScene: BABYLON.Scene | null = null;
let rpCam: BABYLON.FreeCamera | null = null;

const remoteMeshes = new Map<string, BABYLON.TransformNode>();
const remoteMats = new Map<string, BABYLON.StandardMaterial>();

let rpRenderOffset = new BABYLON.Vector3(0, 0, 0);
let lastRpOffsetLogAt = 0;

const REMOTE_Y_VISUAL_OFFSET = -1.65;

const remotePrevPos = new Map<string, BABYLON.Vector3>();
const remotePrevAt = new Map<string, number>();
const remoteTargetPos = new Map<string, BABYLON.Vector3>();

function ensureRpScene(noaScene: BABYLON.Scene) {
  if (rpReady && rpScene && rpCam) return;

  const engine = noaScene.getEngine();

  rpScene = new BABYLON.Scene(engine);
  rpScene.useRightHandedSystem = noaScene.useRightHandedSystem;

  console.log("[RP] ensureRpScene", { useRightHandedSystem: rpScene.useRightHandedSystem });

  rpScene.autoClear = false;
  rpScene.autoClearDepthAndStencil = false;

  rpCam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, 0), rpScene);
  rpCam.minZ = 0.05;
  rpCam.maxZ = 10000;

  rpCam.rotationQuaternion = new BABYLON.Quaternion();

  rpScene.activeCamera = rpCam;

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

  const root = new BABYLON.TransformNode(`remoteRoot:${id}`, rpScene);

  const BODY_W = 0.65;
  const BODY_H = 0.95;
  const BODY_D = 0.32;

  const HEAD = 0.55;

  const ARM_W = 0.20;
  const ARM_H = 0.85;
  const ARM_D = 0.20;

  const LEG_W = 0.22;
  const LEG_H = 0.90;
  const LEG_D = 0.22;

  const legTopY = LEG_H;
  const bodyBottomY = legTopY;
  const bodyCenterY = bodyBottomY + BODY_H * 0.5;
  const headCenterY = bodyBottomY + BODY_H + HEAD * 0.5;

  const mat = makeRemoteMaterial(id, rpScene);
  remoteMats.set(id, mat);

  const body = BABYLON.MeshBuilder.CreateBox(
    `remoteBody:${id}`,
    { width: BODY_W, height: BODY_H, depth: BODY_D },
    rpScene
  );
  body.parent = root;
  body.position.set(0, bodyCenterY, 0);
  body.material = mat;
  body.isPickable = false;

  const head = BABYLON.MeshBuilder.CreateBox(
    `remoteHead:${id}`,
    { width: HEAD, height: HEAD, depth: HEAD },
    rpScene
  );
  head.parent = root;
  head.position.set(0, headCenterY, 0);
  head.material = mat;
  head.isPickable = false;

  const armL = BABYLON.MeshBuilder.CreateBox(
    `remoteArmL:${id}`,
    { width: ARM_W, height: ARM_H, depth: ARM_D },
    rpScene
  );
  armL.parent = root;
  armL.position.set(-(BODY_W * 0.5 + ARM_W * 0.5) + 0.02, bodyBottomY + BODY_H * 0.65, 0);
  armL.material = mat;
  armL.isPickable = false;

  const armR = BABYLON.MeshBuilder.CreateBox(
    `remoteArmR:${id}`,
    { width: ARM_W, height: ARM_H, depth: ARM_D },
    rpScene
  );
  armR.parent = root;
  armR.position.set(BODY_W * 0.5 + ARM_W * 0.5 - 0.02, bodyBottomY + BODY_H * 0.65, 0);
  armR.material = mat;
  armR.isPickable = false;

  const legL = BABYLON.MeshBuilder.CreateBox(
    `remoteLegL:${id}`,
    { width: LEG_W, height: LEG_H, depth: LEG_D },
    rpScene
  );
  legL.parent = root;
  legL.position.set(-0.16, LEG_H * 0.5, 0);
  legL.material = mat;
  legL.isPickable = false;

  const legR = BABYLON.MeshBuilder.CreateBox(
    `remoteLegR:${id}`,
    { width: LEG_W, height: LEG_H, depth: LEG_D },
    rpScene
  );
  legR.parent = root;
  legR.position.set(0.16, LEG_H * 0.5, 0);
  legR.material = mat;
  legR.isPickable = false;

  (body as any).isInFrustum = () => true;
  (head as any).isInFrustum = () => true;
  (armL as any).isInFrustum = () => true;
  (armR as any).isInFrustum = () => true;
  (legL as any).isInFrustum = () => true;
  (legR as any).isInFrustum = () => true;

  (root as any).__parts = { armL, armR, legL, legR };
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
    try {
      root.dispose();
    } catch {}
    remoteMeshes.delete(id);
  }
  const mat = remoteMats.get(id);
  if (mat) {
    try {
      mat.dispose();
    } catch {}
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

  const now = performance.now();
  if (now - lastRpOffsetLogAt > 1500) {
    lastRpOffsetLogAt = now;

    const lp = worldCam.position instanceof BABYLON.Vector3 ? worldCam.position : null;
    const ap =
      typeof worldCam.getAbsolutePosition === "function"
        ? worldCam.getAbsolutePosition()
        : worldCam.globalPosition instanceof BABYLON.Vector3
          ? worldCam.globalPosition
          : null;

    console.log("[RP] cam+offset", {
      handedness: rpScene.useRightHandedSystem ? "RH" : "LH",
      xray: remoteXray,
      worldLocalPos: lp ? { x: +lp.x.toFixed(2), y: +lp.y.toFixed(2), z: +lp.z.toFixed(2) } : null,
      worldAbsPos: ap ? { x: +ap.x.toFixed(2), y: +ap.y.toFixed(2), z: +ap.z.toFixed(2) } : null,
      rpCamPos: { x: +rpCam.position.x.toFixed(2), y: +rpCam.position.y.toFixed(2), z: +rpCam.position.z.toFixed(2) },
      playerPos: p ? { x: +p[0].toFixed(2), y: +p[1].toFixed(2), z: +p[2].toFixed(2) } : null,
      rpRenderOffset: { x: +rpRenderOffset.x.toFixed(2), y: +rpRenderOffset.y.toFixed(2), z: +rpRenderOffset.z.toFixed(2) },
      hasWorldMatrix: typeof worldCam.getWorldMatrix === "function",
    });
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
    target.set(
      t.x + rpRenderOffset.x,
      t.y + rpRenderOffset.y + REMOTE_Y_VISUAL_OFFSET,
      t.z + rpRenderOffset.z
    );
    remoteTargetPos.set(id, target);

    const lerp = 0.35;
    root.position.x += (target.x - root.position.x) * lerp;
    root.position.y += (target.y - root.position.y) * lerp;
    root.position.z += (target.z - root.position.z) * lerp;

    if (typeof t.yaw === "number") root.rotation.y = t.yaw;

    const prev =
      remotePrevPos.get(id) ??
      new BABYLON.Vector3(root.position.x, root.position.y, root.position.z);
    const prevAt = remotePrevAt.get(id) ?? now;
    const dt = Math.max(0.001, (now - prevAt) / 1000);

    const dx = root.position.x - prev.x;
    const dz = root.position.z - prev.z;
    const speed = Math.sqrt(dx * dx + dz * dz) / dt;

    prev.copyFrom(root.position);
    remotePrevPos.set(id, prev);
    remotePrevAt.set(id, now);

    const parts = (root as any).__parts as
      | { armL: BABYLON.Mesh; armR: BABYLON.Mesh; legL: BABYLON.Mesh; legR: BABYLON.Mesh }
      | undefined;

    if (parts?.legL && parts?.legR && parts?.armL && parts?.armR) {
      const moving = speed > 0.15;
      const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * 0.18;

      let phase = (root as any).__walkPhase as number;
      if (!Number.isFinite(phase)) phase = 0;

      phase += moving ? phaseSpeed : 0.02;
      (root as any).__walkPhase = phase;

      const swing = Math.sin(phase) * (moving ? 0.55 : 0.08);

      parts.legL.rotation.x = swing * 0.55;
      parts.legR.rotation.x = -swing * 0.55;
      parts.armL.rotation.x = -swing * 0.35;
      parts.armR.rotation.x = swing * 0.35;
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
  try {
    id = String(localStorage.getItem(key) ?? "");
  } catch {}
  if (id && id.length >= 3) return id;

  const rand = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  id = `u_${Date.now().toString(16)}_${rand.slice(0, 10)}`;
  try {
    localStorage.setItem(key, id);
  } catch {}
  return id;
}

let canSendMoves = false;

async function connect() {
  try {
    updateOverlay();

    const userId = ensureUserId();
    room = await colyseus.joinOrCreate("my_room", { userId });
    (globalThis as any).room = room;

    console.log("[NET] joined room", { sessionId: room.sessionId, userId });

    updateOverlay();

    for (const req of queuedRequests.values()) {
      room.send("worldDataNeeded", req);
    }

    room.onMessage("chunkData", (msg: any) => applyChunkFromServer(msg));

    room.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);

        // if the block we were mining changed, clear cracks
        if (
          miningProgress &&
          msg.x === miningProgress.x &&
          msg.y === miningProgress.y &&
          msg.z === miningProgress.z
        ) {
          miningProgress = null;
        }
      }
    });

    // Mining progress (server authoritative)
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
        x,
        y,
        z,
        progress: Math.max(0, Math.min(1, progress)),
        stage: Math.max(0, Math.min(9, stage | 0)),
        done: !!(m as any).done,
        reason: typeof (m as any).reason === "string" ? (m as any).reason : undefined,
      };

      if ((m as any).done) {
        miningHeld = false;
        miningTarget = null;
        lastMineSentKey = "";
      }
    });

    room.onMessage("mineCancelled", (_m: any) => {
      miningProgress = null;
      miningHeld = false;
      miningTarget = null;
      lastMineSentKey = "";
    });

    // Inventory state from server
    room.onMessage("invState", (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      const slots = Array.isArray((msg as any).slots) ? (msg as any).slots : null;
      const cursor = (msg as any).cursor ?? null;
      if (!slots) return;

      const outSlots: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
      for (let i = 0; i < Math.min(INV_SLOTS, slots.length); i++) {
        const s = slots[i];
        const id = Number((s as any)?.id ?? 0);
        const count = Number((s as any)?.count ?? 0);
        outSlots[i] =
          Number.isFinite(id) && Number.isFinite(count) && id > 0 && count > 0
            ? { id, count }
            : { id: 0, count: 0 };
      }

      const cId = Number((cursor as any)?.id ?? 0);
      const cCount = Number((cursor as any)?.count ?? 0);
      const outCursor: ItemStack =
        Number.isFinite(cId) && Number.isFinite(cCount) && cId > 0 && cCount > 0
          ? { id: cId, count: cCount }
          : { id: 0, count: 0 };

      invState = { slots: outSlots, cursor: outCursor };
      renderInventoryUI();
      updateOverlay();
    });

    // Drops
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
        try {
          mesh.dispose();
        } catch {}
        dropMeshes.delete(id);
      }
      updateOverlay();
    });

    // Craft result
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

    // Players
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
          x,
          y,
          z,
          yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
        });
      }

      lastTransformAt = performance.now();
      console.log("[NET] existingPlayers", { count: netTransforms.size });
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
        x,
        y,
        z,
        yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
      });

      lastTransformAt = performance.now();
      console.log("[NET] playerJoined", { id, x, y, z });
      updateOverlay(`playerJoined: ${id}`);
    });

    room.onMessage("playerLeft", (p: any) => {
      const id = normId(p);
      if (!id) return;

      netTransforms.delete(id);
      removeRemoteMesh(id);

      lastTransformAt = performance.now();
      console.log("[NET] playerLeft", { id });
      updateOverlay(`playerLeft: ${id}`);
    });

    room.onMessage("playerTransformOther", (p: any) => {
      const id = normId(p);
      if (!id || (room && id === room.sessionId)) return;

      const x = Number((p as any).x);
      const y = Number((p as any).y);
      const z = Number((p as any).z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, {
        x,
        y,
        z,
        yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
      });
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
        netTransforms.set(id, {
          x,
          y,
          z,
          yaw: typeof (p as any).yaw === "number" ? (p as any).yaw : undefined,
        });
      }

      lastSnapshotIds = ids;
      lastSnapshotAt = performance.now();
      updateOverlay("playersSnapshot received");
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
      console.log("[NET] youJoined spawn", { x, y, z });
      updateOverlay("Spawn synced.");
    });
  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed!</span>";
  }
}

connect();

/* ===============================
   13. Tick loop (drive vm updates + networking + rp sync + drops + mining)
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

    // Sync rp camera from NOA camera every tick (critical)
    syncRpCameraFromWorld(scene);

    // crack overlay updates
    updateCrackVisual(scene);
  }

  updateViewmodel(dtSec);

  // Remote meshes every tick
  updateRemoteMeshes();

  // Drop visuals + pickup
  updateDropVisuals(dtSec);
  tryAutoPickup();

  // Hold-to-mine tracking: if you drag to a new block, start mining that instead
  if (miningHeld && hasPointerLock() && !invOpen) {
    const t = getTargetInfo();
    if (t?.pos) {
      const { x, y, z } = t.pos;
      if (!miningTarget || miningTarget.x !== x || miningTarget.y !== y || miningTarget.z !== z) {
        miningTarget = { x, y, z };
        miningProgress = { x, y, z, progress: 0, stage: 0 };
        lastMineSentKey = "";
        sendStartMine(x, y, z);
      } else {
        // keep-alive / resync occasionally
        if (tickCount % 20 === 0) sendStartMine(x, y, z);
      }
    }
  }

  // Send movement (throttled)
  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw =
      typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // Keep overlay fresh
  if (tickCount % 10 === 0) updateOverlay();
});
