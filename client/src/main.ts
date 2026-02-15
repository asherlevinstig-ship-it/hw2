/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * NOA voxel client + Colyseus multiplayer
 * - Server authoritative chunk streaming (Path B)
 * - Mine/place block sync
 * - Remote players rendered in a SECOND Babylon scene (rpScene) rendered AFTER NOA
 * - FIRST-PERSON VIEWMODEL ARM rendered in a SECOND Babylon scene (vmScene)
 *
 * Added in this version (Basic survival loop):
 * ✅ Server-authoritative inventory (hotbar + backpack), stack sizes
 * ✅ Inventory UI (drag/drop, swap, stack, split, right-click place 1 into slot)
 * ✅ Block drops: mining spawns a pickup drop entity (from server)
 * ✅ Pickup loop: client detects proximity -> requests pickupDrop
 * ✅ Crafting UI (simple recipe list): wood -> planks -> sticks -> wood pick
 *
 * Controls:
 * - V toggles viewmodel overlay ON/OFF
 * - P toggles Remote Player overlay ON/OFF
 * - O toggles Remote "X-RAY" (always visible) ON/OFF
 *
 * Inventory controls:
 * - E toggles inventory UI
 * - Left click slot: pick up / place / swap / stack
 * - Right click slot:
 *   - if cursor empty: take half (ceil) from slot
 *   - if cursor holding: place 1 into slot (if compatible)
 * - Shift + Left click slot: quick move between hotbar/backpack (simple)
 *
 * Debug controls (viewmodel):
 * - B toggles VM debug visuals (axes + screen frame)
 * - N toggles VM tuning mode (enables hotkey nudging)
 * - M toggles VM mirror (fixes "wrong direction"/handedness)
 *
 * IMPORTANT FIX:
 * When VM tuning is ON, we intercept tuning keys at CAPTURE phase and call
 * preventDefault + stopPropagation so NOA doesn't treat arrow keys as movement.
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
   3.1 Inventory UI Setup (DOM)
================================ */
const invRoot = document.createElement("div");
invRoot.style.position = "fixed";
invRoot.style.left = "0";
invRoot.style.top = "0";
invRoot.style.right = "0";
invRoot.style.bottom = "0";
invRoot.style.display = "none";
invRoot.style.alignItems = "center";
invRoot.style.justifyContent = "center";
invRoot.style.background = "rgba(0,0,0,0.45)";
invRoot.style.zIndex = "200";
invRoot.style.pointerEvents = "auto";
invRoot.style.userSelect = "none";
document.body.appendChild(invRoot);

const invPanel = document.createElement("div");
invPanel.style.width = "860px";
invPanel.style.maxWidth = "95vw";
invPanel.style.background = "rgba(15,15,15,0.92)";
invPanel.style.border = "1px solid rgba(255,255,255,0.18)";
invPanel.style.borderRadius = "10px";
invPanel.style.boxShadow = "0 12px 35px rgba(0,0,0,0.55)";
invPanel.style.padding = "14px";
invPanel.style.fontFamily = "monospace";
invPanel.style.color = "white";
invPanel.style.pointerEvents = "auto";
invRoot.appendChild(invPanel);

const invHeader = document.createElement("div");
invHeader.style.display = "flex";
invHeader.style.alignItems = "center";
invHeader.style.justifyContent = "space-between";
invHeader.style.marginBottom = "10px";
invPanel.appendChild(invHeader);

const invTitle = document.createElement("div");
invTitle.textContent = "Inventory";
invTitle.style.fontSize = "18px";
invTitle.style.fontWeight = "700";
invHeader.appendChild(invTitle);

const invHint = document.createElement("div");
invHint.style.fontSize = "12px";
invHint.style.opacity = "0.85";
invHint.innerHTML =
  "E: close &nbsp;|&nbsp; LMB: move/swap/stack &nbsp;|&nbsp; RMB: split/place-1 &nbsp;|&nbsp; Shift+LMB: quick-move";
invHeader.appendChild(invHint);

const invBody = document.createElement("div");
invBody.style.display = "grid";
invBody.style.gridTemplateColumns = "1fr 320px";
invBody.style.gap = "14px";
invPanel.appendChild(invBody);

const invLeft = document.createElement("div");
invLeft.style.display = "flex";
invLeft.style.flexDirection = "column";
invLeft.style.gap = "10px";
invBody.appendChild(invLeft);

const invRight = document.createElement("div");
invRight.style.display = "flex";
invRight.style.flexDirection = "column";
invRight.style.gap = "10px";
invBody.appendChild(invRight);

const hotbarLabel = document.createElement("div");
hotbarLabel.textContent = "Hotbar (1–5)";
hotbarLabel.style.fontWeight = "700";
hotbarLabel.style.opacity = "0.9";
invLeft.appendChild(hotbarLabel);

const hotbarGrid = document.createElement("div");
hotbarGrid.style.display = "grid";
hotbarGrid.style.gridTemplateColumns = "repeat(5, 1fr)";
hotbarGrid.style.gap = "8px";
invLeft.appendChild(hotbarGrid);

const backpackLabel = document.createElement("div");
backpackLabel.textContent = "Backpack";
backpackLabel.style.fontWeight = "700";
backpackLabel.style.opacity = "0.9";
invLeft.appendChild(backpackLabel);

const backpackGrid = document.createElement("div");
backpackGrid.style.display = "grid";
backpackGrid.style.gridTemplateColumns = "repeat(5, 1fr)";
backpackGrid.style.gap = "8px";
invLeft.appendChild(backpackGrid);

const craftLabel = document.createElement("div");
craftLabel.textContent = "Crafting (shapeless)";
craftLabel.style.fontWeight = "700";
craftLabel.style.opacity = "0.9";
invRight.appendChild(craftLabel);

const craftList = document.createElement("div");
craftList.style.display = "flex";
craftList.style.flexDirection = "column";
craftList.style.gap = "8px";
invRight.appendChild(craftList);

const cursorBox = document.createElement("div");
cursorBox.style.marginTop = "6px";
cursorBox.style.padding = "10px";
cursorBox.style.border = "1px solid rgba(255,255,255,0.18)";
cursorBox.style.borderRadius = "8px";
cursorBox.style.background = "rgba(0,0,0,0.25)";
cursorBox.style.fontSize = "12px";
cursorBox.style.opacity = "0.95";
invRight.appendChild(cursorBox);

const invFooter = document.createElement("div");
invFooter.style.marginTop = "12px";
invFooter.style.fontSize = "12px";
invFooter.style.opacity = "0.85";
invFooter.innerHTML =
  "Tip: When inventory is open, mining/placing is disabled. Close inventory to resume.";
invPanel.appendChild(invFooter);

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

function exitPointerLock() {
  try {
    if (document.pointerLockElement) document.exitPointerLock();
  } catch {}
}

appEl.addEventListener("click", () => {
  if (!inventoryOpen) requestPointerLock();
});

function hasPointerLock(): boolean {
  return document.pointerLockElement != null;
}

/* ===============================
   5. Register Blocks & Materials
================================ */
const AIR_ID = 0;
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const WOOD_ID = 4;
const LEAVES_ID = 5;

noa.registry.registerMaterial("grass", { color: [0.2, 0.8, 0.2] });
noa.registry.registerMaterial("dirt", { color: [0.5, 0.35, 0.15] });
noa.registry.registerMaterial("stone", { color: [0.5, 0.5, 0.5] });
noa.registry.registerMaterial("wood", { color: [0.4, 0.25, 0.1] });
noa.registry.registerMaterial("leaves", { color: [0.1, 0.6, 0.1] });

noa.registry.registerBlock(GRASS_ID, { material: "grass" });
noa.registry.registerBlock(DIRT_ID, { material: "dirt" });
noa.registry.registerBlock(STONE_ID, { material: "stone" });
noa.registry.registerBlock(WOOD_ID, { material: "wood" });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves" });

/* ===============================
   6. Items + Inventory State
================================ */
type ItemStack = { id: number; count: number };


const Items = {
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD_LOG: 4,
  LEAVES: 5,

  PLANK: 10,
  STICK: 11,
  WOOD_PICK: 20,
} as const;

type ItemDef = {
  id: number;
  name: string;
  maxStack: number;
  placeBlockId?: number;
};

const ITEM_DEFS: Record<number, ItemDef> = {
  [Items.GRASS]: { id: Items.GRASS, name: "Grass", maxStack: 64, placeBlockId: GRASS_ID },
  [Items.DIRT]: { id: Items.DIRT, name: "Dirt", maxStack: 64, placeBlockId: DIRT_ID },
  [Items.STONE]: { id: Items.STONE, name: "Stone", maxStack: 64, placeBlockId: STONE_ID },
  [Items.WOOD_LOG]: { id: Items.WOOD_LOG, name: "Wood", maxStack: 64, placeBlockId: WOOD_ID },
  [Items.LEAVES]: { id: Items.LEAVES, name: "Leaves", maxStack: 64, placeBlockId: LEAVES_ID },
  [Items.PLANK]: { id: Items.PLANK, name: "Planks", maxStack: 64 },
  [Items.STICK]: { id: Items.STICK, name: "Stick", maxStack: 64 },
  [Items.WOOD_PICK]: { id: Items.WOOD_PICK, name: "Wood Pick", maxStack: 1 },
};

type Recipe = {
  id: string;
  name: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

const RECIPES: Recipe[] = [
  { id: "planks_from_log", name: "Planks", inputs: [{ id: Items.WOOD_LOG, count: 1 }], output: { id: Items.PLANK, count: 4 } },
  { id: "sticks_from_planks", name: "Sticks", inputs: [{ id: Items.PLANK, count: 2 }], output: { id: Items.STICK, count: 4 } },
  { id: "wood_pick", name: "Wood Pick", inputs: [{ id: Items.PLANK, count: 3 }, { id: Items.STICK, count: 2 }], output: { id: Items.WOOD_PICK, count: 1 } },
];

const HOTBAR_SLOTS = 5;
const BACKPACK_SLOTS = 20;
const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

// Server-authoritative inventory snapshot
let invSlots: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));

// Selected hotbar index (0..4)
let selectedSlot = 0;

// Inventory UI open?
let inventoryOpen = false;

// Client-side cursor stack for UI interaction (server is still the authority; cursor only drives requests)
let cursorStack: ItemStack = { id: 0, count: 0 };

// UI slot nodes
const slotEls: HTMLDivElement[] = [];

// Toggle states
let viewModelEnabled = true;
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
   6.3 Drop state (server authoritative)
================================ */
type DropMsg = { dropId: string; itemId: number; count: number; x: number; y: number; z: number; createdAt?: number };
const drops = new Map<string, DropMsg>();
const dropMeshes = new Map<string, BABYLON.Mesh>();
const dropPickupCooldown = new Map<string, number>(); // dropId -> last request time (ms)

/* ===============================
   6.4 Overlay helpers
================================ */
function getItemName(id: number): string {
  if (!id) return "Empty";
  return ITEM_DEFS[id]?.name ?? `Item ${id}`;
}

function getHoldingName(): string {
  const s = invSlots[selectedSlot] ?? { id: 0, count: 0 };
  if (!s.id || s.count <= 0) return "Empty";
  return `${getItemName(s.id)} x${s.count}`;
}

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

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedSlot + 1}] ${getHoldingName()}<br>
    <strong>Inventory:</strong> ${inventoryOpen ? "OPEN" : "CLOSED"} | <strong>Cursor:</strong> ${
      cursorStack.id ? `${getItemName(cursorStack.id)} x${cursorStack.count}` : "Empty"
    }<br>
    <strong>Viewmodel:</strong> ${viewModelEnabled ? "ON" : "OFF"}<br>
    <strong>Remote Players:</strong> ${remotePlayersEnabled ? "ON" : "OFF"} |
    <strong>Xray:</strong> ${remoteXray ? "ON" : "OFF"}<br>
    <strong>VM Debug:</strong> ${vmDebug ? "ON" : "OFF"} |
    <strong>VM Tune:</strong> ${vmTuning ? "ON" : "OFF"} |
    <strong>Mirror:</strong> ${vmMirrorX ? "ON" : "OFF"}<br>
    -------------------------<br>
    [L-Click] Mine  |  [R-Click] Place<br>
    [1-5] Select Hotbar Slot<br>
    [WASD] Move  |  [Space] Jump<br>
    [E] Inventory<br>
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
   6.5 Inventory UI rendering + interactions
================================ */
function setInventoryOpen(open: boolean) {
  inventoryOpen = open;
  invRoot.style.display = open ? "flex" : "none";

  if (open) {
    exitPointerLock();
  } else {
    // leave cursor stack as-is; users can close while holding (Minecraft-like)
    // but you can auto-drop later if you want.
  }
  renderInventoryUI();
  updateOverlay(open ? "Inventory: OPEN" : "Inventory: CLOSED");
}

function safeStackClone(s: ItemStack | undefined | null): ItemStack {
  if (!s) return { id: 0, count: 0 };
  return { id: s.id | 0, count: s.count | 0 };
}

function slotLabel(stack: ItemStack): string {
  if (!stack.id || stack.count <= 0) return "";
  return `${getItemName(stack.id)}\n x${stack.count}`;
}

function createSlotEl(slotIndex: number): HTMLDivElement {
  const el = document.createElement("div");
  el.style.height = "64px";
  el.style.borderRadius = "8px";
  el.style.border = "1px solid rgba(255,255,255,0.18)";
  el.style.background = "rgba(0,0,0,0.25)";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.textAlign = "center";
  el.style.whiteSpace = "pre-line";
  el.style.fontSize = "11px";
  el.style.lineHeight = "1.05";
  el.style.cursor = "pointer";
  el.style.pointerEvents = "auto";

  const badge = document.createElement("div");
  badge.style.position = "absolute";
  badge.style.right = "10px";
  badge.style.bottom = "8px";
  badge.style.fontSize = "11px";
  badge.style.opacity = "0.92";
  badge.style.pointerEvents = "none";

  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.width = "100%";
  wrap.style.height = "100%";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.appendChild(badge);
  el.appendChild(wrap);

  function setSelectedVisual() {
    if (slotIndex === selectedSlot) {
      el.style.outline = "2px solid rgba(255,255,255,0.55)";
      el.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.3) inset";
    } else {
      el.style.outline = "none";
      el.style.boxShadow = "none";
    }
  }

  function updateText() {
    const s = safeStackClone(invSlots[slotIndex]);
    wrap.textContent = slotLabel(s);
    wrap.appendChild(badge);

    if (slotIndex < HOTBAR_SLOTS) {
      badge.textContent = `${slotIndex + 1}`;
    } else {
      badge.textContent = "";
    }

    setSelectedVisual();
  }

  updateText();

  // Left click: move/swap/stack
  el.addEventListener("mousedown", (ev) => {
    if (!inventoryOpen) return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    const shift = (ev as MouseEvent).shiftKey;

    if (shift) {
      // quick move between hotbar/backpack
      quickMoveSlot(slotIndex);
      return;
    }

    handleSlotLeftClick(slotIndex);
  });

  // Right click: split / place-1
  el.addEventListener("contextmenu", (ev) => {
    if (!inventoryOpen) return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  el.addEventListener("mousedown", (ev) => {
    if (!inventoryOpen) return;
    if (ev.button !== 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    handleSlotRightClick(slotIndex);
  });

  // Hover highlight
  el.addEventListener("mouseenter", () => {
    if (!inventoryOpen) return;
    el.style.border = "1px solid rgba(255,255,255,0.40)";
  });
  el.addEventListener("mouseleave", () => {
    el.style.border = "1px solid rgba(255,255,255,0.18)";
  });

  // stored for refresh calls
  (el as any).__update = updateText;
  return el;
}

function rebuildInventorySlotsUI() {
  hotbarGrid.innerHTML = "";
  backpackGrid.innerHTML = "";
  slotEls.length = 0;

  for (let i = 0; i < INV_SLOTS; i++) {
    const el = createSlotEl(i);
    slotEls.push(el);
    if (i < HOTBAR_SLOTS) hotbarGrid.appendChild(el);
    else backpackGrid.appendChild(el);
  }
}

function updateCursorBox() {
  const cs = cursorStack;
  const txt =
    cs.id && cs.count > 0
      ? `Cursor: ${getItemName(cs.id)} x${cs.count}`
      : `Cursor: (empty)`;
  cursorBox.textContent = txt;
}

function renderInventoryUI() {
  if (slotEls.length !== INV_SLOTS) rebuildInventorySlotsUI();

  for (const el of slotEls) {
    const upd = (el as any).__update as (() => void) | undefined;
    upd?.();
  }

  craftList.innerHTML = "";
  for (const r of RECIPES) {
    const btn = document.createElement("button");
    btn.style.padding = "10px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid rgba(255,255,255,0.20)";
    btn.style.background = "rgba(0,0,0,0.30)";
    btn.style.color = "white";
    btn.style.cursor = "pointer";
    btn.style.textAlign = "left";
    btn.style.fontFamily = "monospace";
    btn.style.fontSize = "12px";
    btn.style.lineHeight = "1.2";

    const inputsStr = r.inputs.map((x) => `${getItemName(x.id)} x${x.count}`).join(", ");
    const outStr = `${getItemName(r.output.id)} x${r.output.count}`;
    btn.textContent = `${r.name}\n${inputsStr}  →  ${outStr}`;

    btn.addEventListener("click", () => {
      if (!room) return;
      room.send("craft", { recipeId: r.id, times: 1 });
    });

    craftList.appendChild(btn);
  }

  updateCursorBox();
}

function isEmpty(s: ItemStack): boolean {
  return !s.id || s.count <= 0;
}

function handleSlotLeftClick(slotIndex: number) {
  if (!room) return;



  // If cursor empty: pick up full stack from slot -> cursor (request invMove slot->cursor is not a thing).
  // We'll do the classic approach: cursor is client-side, but server inventory is authoritative.
  // To keep server authority and still allow cursor interactions, we implement cursor as:
  // - cursorStack just mirrors what we "intend" to hold
  // - and we use invMove between slots to simulate actions
  //
  // So for left click:
  // - if cursor empty: take entire slot into cursor by moving it into a special "cursor slot" doesn't exist server-side.
  //   Therefore: we do a SWAP protocol:
  //   - store cursor locally
  //   - request server to move slot to a "free" staging slot? (not good)
  //
  // Instead: simplest server-authoritative UI is "slot-to-slot only".
  // But user asked drag/drop + cursor. We'll implement cursor purely client-side and convert operations into invMove messages:
  //
  // Rules:
  // 1) Cursor empty, click slot:
  //    - copy slot into cursor locally
  //    - request server to clear slot by moving it to itself with amount?? Not supported.
  //
  // Therefore we implement cursor operations using server messages:
  // ✅ We use invMove for slot-to-slot actions.
  // ✅ For cursor, we keep it client-side ONLY for display, but we DO NOT actually remove items from inventory until placed.
  // That feels wrong.
  //
  // Better approach (still no schemas): treat cursor as "virtual", and send direct invMove requests using
  // a selected "cursor source slot" stored client-side.
  //
  // We'll do this:
  // - cursorSourceSlot: number | null
  // - cursorAmount: number (how many we're moving from that source)
  // - operations translate to invMove from cursorSourceSlot -> target.
  //
  // This keeps server inventory authoritative and eliminates "ghost" cursor stacks.
  //
  // So: implement cursor as a reference to a real source slot, not an extracted stack.

  // This is implemented below with cursorSourceSlot.
  // We keep this function as wrapper to route to ref-based cursor behavior.
  slotLeftClickRefCursor(slotIndex);
}

let cursorSourceSlot: number | null = null; // inventory slot index we are "holding" from
let cursorHeldCount = 0; // how many from source we intend to move (<= source count)
let cursorHeldId = 0;

function refreshCursorFromSource() {
  if (cursorSourceSlot == null) {
    cursorStack = { id: 0, count: 0 };
    cursorHeldCount = 0;
    cursorHeldId = 0;
    updateCursorBox();
    updateOverlay();
    return;
  }

  const src = safeStackClone(invSlots[cursorSourceSlot]);
  if (isEmpty(src)) {
    cursorSourceSlot = null;
    cursorStack = { id: 0, count: 0 };
    cursorHeldCount = 0;
    cursorHeldId = 0;
  } else {
    // cap held count by current source count
    cursorHeldId = src.id;
    cursorHeldCount = Math.min(cursorHeldCount, src.count);
    if (cursorHeldCount <= 0) cursorHeldCount = src.count;
    cursorStack = { id: cursorHeldId, count: cursorHeldCount };
  }

  updateCursorBox();
  updateOverlay();
}

function clearCursorRef() {
  cursorSourceSlot = null;
  cursorHeldCount = 0;
  cursorHeldId = 0;
  cursorStack = { id: 0, count: 0 };
  updateCursorBox();
  updateOverlay();
}

function slotLeftClickRefCursor(slotIndex: number) {
  if (!room) return;

  // If not holding anything yet: start holding from this slot (full stack)
  if (cursorSourceSlot == null) {
    const s = safeStackClone(invSlots[slotIndex]);
    if (isEmpty(s)) return;
    cursorSourceSlot = slotIndex;
    cursorHeldId = s.id;
    cursorHeldCount = s.count;
    cursorStack = { id: cursorHeldId, count: cursorHeldCount };
    renderInventoryUI();
    updateOverlay(`Picked up: ${getItemName(cursorHeldId)} x${cursorHeldCount}`);
    return;
  }

  // If clicking the same source slot: drop cursor (cancel)
  if (cursorSourceSlot === slotIndex) {
    clearCursorRef();
    renderInventoryUI();
    return;
  }

  // Attempt to move from source -> target (full held count)
  const from = cursorSourceSlot;
  const to = slotIndex;
  const amount = cursorHeldCount;

  // Send invMove to server; server decides stacking/swap
  room.send("invMove", { from, to, amount });

  // After sending, we keep cursorSourceSlot as-is, but the server snapshot may change it.
  // We'll refresh cursor after next invState.
  updateOverlay(`Move request: ${from} -> ${to} amount=${amount}`);
}

function slotRightClickRefCursor(slotIndex: number) {
  if (!room) return;

  // If not holding: right click takes HALF (ceil) from that slot
  if (cursorSourceSlot == null) {
    const s = safeStackClone(invSlots[slotIndex]);
    if (isEmpty(s)) return;

    cursorSourceSlot = slotIndex;
    cursorHeldId = s.id;
    cursorHeldCount = Math.ceil(s.count / 2);
    cursorStack = { id: cursorHeldId, count: cursorHeldCount };
    renderInventoryUI();
    updateOverlay(`Split: took ${cursorHeldCount} of ${getItemName(cursorHeldId)}`);
    return;
  }

  // Holding something: place 1 into clicked slot
  const from = cursorSourceSlot;
  const to = slotIndex;

  if (cursorHeldCount <= 0) {
    clearCursorRef();
    renderInventoryUI();
    return;
  }

  room.send("invMove", { from, to, amount: 1 });
  cursorHeldCount = Math.max(0, cursorHeldCount - 1);
  cursorStack.count = cursorHeldCount;

  // If we placed last, clear
  if (cursorHeldCount <= 0) clearCursorRef();

  updateOverlay(`Place 1: ${from} -> ${to}`);
}

function handleSlotRightClick(slotIndex: number) {
  slotRightClickRefCursor(slotIndex);
}

function quickMoveSlot(slotIndex: number) {
  if (!room) return;

  // If cursor is active, quick-move not supported (avoid complexity)
  if (cursorSourceSlot != null) return;

  const s = safeStackClone(invSlots[slotIndex]);
  if (isEmpty(s)) return;

  const isHotbar = slotIndex < HOTBAR_SLOTS;
  const destStart = isHotbar ? HOTBAR_SLOTS : 0;
  const destEnd = isHotbar ? INV_SLOTS : HOTBAR_SLOTS;

  // Find first compatible stack or empty slot
  let dest = -1;
  for (let i = destStart; i < destEnd; i++) {
    const d = safeStackClone(invSlots[i]);
    if (isEmpty(d)) {
      if (dest < 0) dest = i;
      continue;
    }
    if (d.id === s.id) {
      dest = i;
      break;
    }
  }
  if (dest < 0) return;

  room.send("invMove", { from: slotIndex, to: dest, amount: s.count });
  updateOverlay(`Quick move: ${slotIndex} -> ${dest}`);
}

/* ===============================
   6.6 Key handling
================================ */
document.addEventListener("keydown", (e) => {
  // Inventory toggle
  if (e.key === "e" || e.key === "E") {
    setInventoryOpen(!inventoryOpen);
    return;
  }

  // Hotbar 1-5
  const key = Number.parseInt(e.key, 10);
  if (Number.isFinite(key) && key >= 1 && key <= HOTBAR_SLOTS) {
    selectedSlot = key - 1;
    renderInventoryUI();
    updateOverlay();
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
   8. Interaction (Mine/Place)
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

function currentHeldPlaceBlockId(): number | null {
  const s = invSlots[selectedSlot];
  if (!s || !s.id || s.count <= 0) return null;
  const def = ITEM_DEFS[s.id];
  const placeId = def?.placeBlockId;
  if (typeof placeId === "number" && placeId > 0) return placeId;
  return null;
}

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  if (inventoryOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.pos;
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  if (inventoryOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  const blockToPlace = currentHeldPlaceBlockId();
  if (!blockToPlace) return;

  triggerPunch();

  const { x, y, z } = target.adj;

  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);

  if (x === px && z === pz && (y === py || y === py + 1)) return;

  noa.world.setBlockID(blockToPlace, x, y, z);
  room?.send("placeBlock", { x, y, z, id: blockToPlace });

  // (Optional later) also request server to consume 1 from inventory.
  // For now, your survival loop focuses on pickup + crafting; placing consumption can be added next step.
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
   9.1 Drop mesh helpers
================================ */
let dropMat: BABYLON.StandardMaterial | null = null;

function ensureDropMaterial(scene: BABYLON.Scene) {
  if (dropMat && dropMat.getScene() === scene) return dropMat;

  dropMat = new BABYLON.StandardMaterial("dropMat", scene);
  dropMat.disableLighting = true;
  dropMat.emissiveColor = new BABYLON.Color3(0.9, 0.85, 0.25);
  dropMat.diffuseColor = dropMat.emissiveColor.clone();
  dropMat.specularColor = new BABYLON.Color3(0, 0, 0);
  dropMat.backFaceCulling = false;
  (dropMat as any).fogEnabled = false;
  return dropMat;
}

function spawnDropMesh(d: DropMsg) {
  const scene = getStableScene();
  if (!scene) return;

  const existing = dropMeshes.get(d.dropId);
  if (existing) {
    existing.position.set(d.x, d.y, d.z);
    return;
  }

  const mat = ensureDropMaterial(scene);

  const mesh = BABYLON.MeshBuilder.CreateBox(
    `drop:${d.dropId}`,
    { width: 0.35, height: 0.35, depth: 0.35 },
    scene
  );
  mesh.position.set(d.x, d.y, d.z);
  mesh.material = mat;
  mesh.isPickable = false;

  (mesh as any).isInFrustum = () => true;

  dropMeshes.set(d.dropId, mesh);
}

function despawnDropMesh(dropId: string) {
  const m = dropMeshes.get(dropId);
  if (m) {
    try {
      m.dispose();
    } catch {}
    dropMeshes.delete(dropId);
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

  // Do NOT clear color (keep world). Clear depth so viewmodel draws on top.
  vmScene.autoClear = false;
  vmScene.autoClearDepthAndStencil = true;

  // Ortho camera in screenspace
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

  // --- Minecraft-ish blocky arm ---
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

  // Lift arm slightly relative to anchor to reduce clipping
  vmArmRoot.position.set(0.0, 0.10, 0.0);

  // Stack parts
  upper.position.set(0.0, 0.22, 0.0);
  fore.position.set(0.0, -0.14, 0.02);
  hand.position.set(0.0, -0.40, 0.04);

  // Unlit material, always on top
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

  // Debug visuals
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

  // Hook engine end-of-frame once
  if (!vmEngineHooked) {
    vmEngineHooked = true;

    engine.onEndFrameObservable.add(() => {
      // Render order: NOA (already rendered) -> vmScene -> rpScene
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

  // Compute walk speed
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

  // View sway uses deltas
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

// ✅ Floating-origin render offset (NOA keeps Babylon cam near origin)
let rpRenderOffset = new BABYLON.Vector3(0, 0, 0);
let lastRpOffsetLogAt = 0;

// ✅ Visual adjustment so remote "feet" sit on ground even if server y is camera/capsule based
const REMOTE_Y_VISUAL_OFFSET = -1.65;

// ✅ Per-remote movement tracking (for smoothing + walk animation)
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

let canSendMoves = false;

async function connect() {
  try {
    updateOverlay();

    room = await colyseus.joinOrCreate("my_room");
    (globalThis as any).room = room;

    console.log("[NET] joined room", { sessionId: room.sessionId });

    updateOverlay();

    for (const req of queuedRequests.values()) {
      room.send("worldDataNeeded", req);
    }

    room.onMessage("chunkData", (msg: any) => applyChunkFromServer(msg));

    room.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
      }
    });

    // Inventory snapshot
    room.onMessage("invState", (msg: any) => {
      if (!msg || !Array.isArray(msg.slots)) return;

      // Copy into fixed-size local
      const next: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
      for (let i = 0; i < Math.min(INV_SLOTS, msg.slots.length); i++) {
        const s = msg.slots[i];
        const id = Number(s?.id ?? 0) | 0;
        const count = Number(s?.count ?? 0) | 0;
        next[i] = id > 0 && count > 0 ? { id, count } : { id: 0, count: 0 };
      }
      invSlots = next;

      // Cursor ref must stay consistent with server
      refreshCursorFromSource();

      renderInventoryUI();
      updateOverlay("invState received");
    });

    // Drops
    room.onMessage("dropSpawn", (d: any) => {
      if (!d || typeof d.dropId !== "string") return;
      const drop: DropMsg = {
        dropId: d.dropId,
        itemId: Number(d.itemId ?? 0) | 0,
        count: Number(d.count ?? 1) | 0,
        x: Number(d.x ?? 0),
        y: Number(d.y ?? 0),
        z: Number(d.z ?? 0),
        createdAt: typeof d.createdAt === "number" ? d.createdAt : undefined,
      };
      drops.set(drop.dropId, drop);
      spawnDropMesh(drop);
      updateOverlay("dropSpawn");
    });

    room.onMessage("dropDespawn", (d: any) => {
      const id = typeof d?.dropId === "string" ? d.dropId : null;
      if (!id) return;
      drops.delete(id);
      despawnDropMesh(id);
      dropPickupCooldown.delete(id);
      updateOverlay("dropDespawn");
    });

    room.onMessage("existingPlayers", (players: any) => {
      if (!Array.isArray(players)) return;

      for (const p of players ?? []) {
        const id = normId(p);
        if (!id || (room && id === room.sessionId)) continue;

        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        const z = Number(p.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
      }

      lastTransformAt = performance.now();
      console.log("[NET] existingPlayers", { count: netTransforms.size });
      updateOverlay("existingPlayers received");
    });

    room.onMessage("playerJoined", (p: any) => {
      const id = normId(p);
      if (!id || (room && id === room.sessionId)) return;

      const x = Number(p.x ?? 0);
      const y = Number(p.y ?? 0);
      const z = Number(p.z ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });

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

      const x = Number(p.x);
      const y = Number(p.y);
      const z = Number(p.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
      lastTransformAt = performance.now();
    });

    room.onMessage("playersSnapshot", (players: any) => {
      if (!Array.isArray(players)) return;

      const ids: string[] = [];

      for (const p of players) {
        const id = normId(p);
        if (!id || (room && id === room.sessionId)) continue;

        const x = Number(p.x);
        const y = Number(p.y);
        const z = Number(p.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        ids.push(id);
        netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
      }

      lastSnapshotIds = ids;
      lastSnapshotAt = performance.now();
      updateOverlay("playersSnapshot received");
    });

    room.onMessage("youJoined", (p: any) => {
      const x = Number(p.x);
      const y = Number(p.y);
      const z = Number(p.z);
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
   13. Drop pickup loop
================================ */
function tryPickupNearbyDrops() {
  if (!room) return;
  if (inventoryOpen) return; // optional: disable pickups while UI open

  const me = noa.ents.getPosition(noa.playerEntity) as [number, number, number];
  if (!me) return;

  const now = performance.now();

  for (const d of drops.values()) {
    const dx = d.x - me[0];
    const dy = d.y - me[1];
    const dz = d.z - me[2];
    const dist2 = dx * dx + dy * dy + dz * dz;

    // client-side threshold a bit tighter than server (server uses its own)
    if (dist2 > 2.0 * 2.0) continue;

    const last = dropPickupCooldown.get(d.dropId) ?? 0;
    if (now - last < 350) continue;

    dropPickupCooldown.set(d.dropId, now);
    room.send("pickupDrop", { dropId: d.dropId });
  }
}

function animateDropMeshes(dtSec: number) {
  // Bobbing + spin
  const t = performance.now() / 1000;
  for (const d of drops.values()) {
    const m = dropMeshes.get(d.dropId);
    if (!m) continue;
    const bob = Math.sin(t * 2.6 + (d.dropId.length % 10)) * 0.08;
    m.position.y = d.y + bob;
    m.rotation.y += dtSec * 1.6;
  }
}

/* ===============================
   14. Tick loop (drive vm updates + networking + rp sync + drops)
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

    // Sync rp camera from NOA camera every tick (critical)
    syncRpCameraFromWorld(scene);

    // Ensure drop material is bound to current scene (if NOA rebuilds scene)
    ensureDropMaterial(scene);

    // Ensure any drops have meshes in the current scene
    if (tickCount % 10 === 0) {
      for (const d of drops.values()) spawnDropMesh(d);
    }
  }

  updateViewmodel(dtSec);

  updateRemoteMeshes();

  animateDropMeshes(dtSec);

  // Pickup checks (throttled)
  if (tickCount % 5 === 0) tryPickupNearbyDrops();

  // Send movement (throttled)
  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // Keep overlay fresh
  if (tickCount % 10 === 0) updateOverlay();
});

/* ===============================
   15. Inventory UI background click closes (optional)
================================ */
invRoot.addEventListener("mousedown", (ev) => {
  // click outside panel closes
  if (ev.target === invRoot) {
    setInventoryOpen(false);
  }
});

// Also keep cursor selection visuals consistent
renderInventoryUI();
