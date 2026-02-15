/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * NOA voxel client + Colyseus multiplayer
 * - Server authoritative chunk streaming (Path B)
 * - Mine/place block sync
 * - Remote players rendered in a SECOND Babylon scene (rpScene) rendered AFTER NOA
 * - FIRST-PERSON VIEWMODEL ARM rendered in a SECOND Babylon scene (vmScene)
 *
 * Why rpScene?
 * NOA’s world scene/camera/layerMask/renderGroups can be swapped/managed internally.
 * Rendering remotes in our own scene *after* NOA guarantees they appear (like the arm).
 *
 * Controls:
 * - V toggles viewmodel overlay ON/OFF
 * - P toggles Remote Player overlay ON/OFF
 * - O toggles Remote "X-RAY" (always visible) ON/OFF
 *
 * Debug controls (viewmodel):
 * - B toggles VM debug visuals (axes + screen frame)
 * - N toggles VM tuning mode (enables hotkey nudging)
 * - M toggles VM mirror (fixes "wrong direction"/handedness)
 *
 * Inventory/Crafting:
 * - E toggles Inventory (hotbar + backpack) ON/OFF
 * - C toggles Crafting list ON/OFF
 * - Left click slot: pick/place/swap/stack (server authoritative cursor)
 * - Right click slot: split/take-half/place-one (server authoritative cursor)
 * - Shift + Left click slot: quick move between hotbar/backpack
 * - Click recipe: craft once; Shift+click: craft max
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

// Stable userId for persistence (server uses this to load/save inventory)
const LS_USER_ID_KEY = "noa_uid_v1";
function getOrCreateUserId(): string {
  try {
    const existing = localStorage.getItem(LS_USER_ID_KEY);
    if (existing && existing.length >= 6) return existing;

    const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const id = `u_${rnd()}_${rnd()}`.replace(/[^a-zA-Z0-9_\-]/g, "");
    localStorage.setItem(LS_USER_ID_KEY, id);
    return id;
  } catch {
    // fallback (non-persistent)
    return `u_${Date.now().toString(16)}`;
  }
}
const userId = getOrCreateUserId();

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
   3.1 Inventory UI (E) + Craft UI (C)
================================ */
const uiRoot = document.createElement("div");
uiRoot.style.position = "fixed";
uiRoot.style.left = "0";
uiRoot.style.top = "0";
uiRoot.style.right = "0";
uiRoot.style.bottom = "0";
uiRoot.style.display = "none";
uiRoot.style.zIndex = "200";
uiRoot.style.pointerEvents = "auto";
uiRoot.style.userSelect = "none";
uiRoot.style.fontFamily = "monospace";
document.body.appendChild(uiRoot);

const uiBackdrop = document.createElement("div");
uiBackdrop.style.position = "absolute";
uiBackdrop.style.left = "0";
uiBackdrop.style.top = "0";
uiBackdrop.style.right = "0";
uiBackdrop.style.bottom = "0";
uiBackdrop.style.background = "rgba(0,0,0,0.35)";
uiBackdrop.style.pointerEvents = "auto";
uiRoot.appendChild(uiBackdrop);

const uiPanel = document.createElement("div");
uiPanel.style.position = "absolute";
uiPanel.style.left = "50%";
uiPanel.style.top = "50%";
uiPanel.style.transform = "translate(-50%, -50%)";
uiPanel.style.width = "720px";
uiPanel.style.maxWidth = "95vw";
uiPanel.style.background = "rgba(10,10,10,0.92)";
uiPanel.style.border = "1px solid rgba(255,255,255,0.18)";
uiPanel.style.borderRadius = "10px";
uiPanel.style.boxShadow = "0 12px 40px rgba(0,0,0,0.35)";
uiPanel.style.padding = "14px";
uiPanel.style.display = "grid";
uiPanel.style.gridTemplateColumns = "1fr 1fr";
uiPanel.style.gap = "12px";
uiPanel.style.pointerEvents = "auto";
uiRoot.appendChild(uiPanel);

const invPanel = document.createElement("div");
invPanel.style.display = "flex";
invPanel.style.flexDirection = "column";
invPanel.style.gap = "10px";
uiPanel.appendChild(invPanel);

const craftPanel = document.createElement("div");
craftPanel.style.display = "flex";
craftPanel.style.flexDirection = "column";
craftPanel.style.gap = "10px";
uiPanel.appendChild(craftPanel);

const invTitle = document.createElement("div");
invTitle.textContent = "Inventory (E to close)";
invTitle.style.color = "white";
invTitle.style.fontSize = "16px";
invTitle.style.fontWeight = "700";
invPanel.appendChild(invTitle);

const invHint = document.createElement("div");
invHint.innerHTML =
  `<span style="opacity:.9">L-click: pick/place/swap/stack | R-click: split/place-one | Shift+L: quick move</span>`;
invHint.style.color = "white";
invHint.style.fontSize = "12px";
invHint.style.opacity = "0.95";
invPanel.appendChild(invHint);

const invGrid = document.createElement("div");
invGrid.style.display = "grid";
invGrid.style.gridTemplateColumns = "repeat(5, 1fr)";
invGrid.style.gap = "8px";
invGrid.style.padding = "8px";
invGrid.style.borderRadius = "10px";
invGrid.style.border = "1px solid rgba(255,255,255,0.15)";
invGrid.style.background = "rgba(255,255,255,0.04)";
invPanel.appendChild(invGrid);

const invCursorLine = document.createElement("div");
invCursorLine.style.color = "white";
invCursorLine.style.fontSize = "12px";
invCursorLine.style.opacity = "0.95";
invCursorLine.textContent = "Cursor: (empty)";
invPanel.appendChild(invCursorLine);

const craftTitle = document.createElement("div");
craftTitle.textContent = "Crafting (C to close)";
craftTitle.style.color = "white";
craftTitle.style.fontSize = "16px";
craftTitle.style.fontWeight = "700";
craftPanel.appendChild(craftTitle);

const craftHint = document.createElement("div");
craftHint.innerHTML = `<span style="opacity:.9">Click recipe: craft once | Shift+click: craft max</span>`;
craftHint.style.color = "white";
craftHint.style.fontSize = "12px";
craftHint.style.opacity = "0.95";
craftPanel.appendChild(craftHint);

const craftList = document.createElement("div");
craftList.style.display = "flex";
craftList.style.flexDirection = "column";
craftList.style.gap = "8px";
craftList.style.padding = "8px";
craftList.style.borderRadius = "10px";
craftList.style.border = "1px solid rgba(255,255,255,0.15)";
craftList.style.background = "rgba(255,255,255,0.04)";
craftPanel.appendChild(craftList);

const craftResultLine = document.createElement("div");
craftResultLine.style.color = "white";
craftResultLine.style.fontSize = "12px";
craftResultLine.style.opacity = "0.95";
craftResultLine.textContent = "";
craftPanel.appendChild(craftResultLine);

let uiInventoryOpen = false;
let uiCraftOpen = false;

function showUIIfNeeded() {
  const shouldShow = uiInventoryOpen || uiCraftOpen;
  uiRoot.style.display = shouldShow ? "block" : "none";
  invPanel.style.display = uiInventoryOpen ? "flex" : "none";
  craftPanel.style.display = uiCraftOpen ? "flex" : "none";

  if (shouldShow) {
    try {
      (document as any).exitPointerLock?.();
    } catch {}
  }
}

uiBackdrop.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  // clicking outside closes both
  uiInventoryOpen = false;
  uiCraftOpen = false;
  showUIIfNeeded();
});

uiPanel.addEventListener("mousedown", (e) => {
  // prevent backdrop close
  e.stopPropagation();
});

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
  // do not lock pointer if UI is open
  if (uiInventoryOpen || uiCraftOpen) return;

  try {
    const scene = (noa as any).rendering?.getScene?.();
    const canvas =
      scene?.getEngine?.()?.getRenderingCanvas?.() ?? (noa as any).container ?? appEl;

    if (canvas?.requestPointerLock) canvas.requestPointerLock();
  } catch {
    if ((appEl as any).requestPointerLock) (appEl as any).requestPointerLock();
  }
}

appEl.addEventListener("click", () => requestPointerLock());

function hasPointerLock(): boolean {
  return !!(noa.container as any)?.hasPointerLock;
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
   6. Items / Inventory (client mirror of server ids)
================================ */
type ItemStack = { id: number; count: number };

const ITEMS = {
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
  1: { id: 1, name: "Grass", maxStack: 64, placeBlockId: 1 },
  2: { id: 2, name: "Dirt", maxStack: 64, placeBlockId: 2 },
  3: { id: 3, name: "Stone", maxStack: 64, placeBlockId: 3 },
  4: { id: 4, name: "Wood", maxStack: 64, placeBlockId: 4 },
  5: { id: 5, name: "Leaves", maxStack: 64, placeBlockId: 5 },

  10: { id: 10, name: "Planks", maxStack: 64 },
  11: { id: 11, name: "Stick", maxStack: 64 },
  20: { id: 20, name: "Wood Pick", maxStack: 1 },
};

type Recipe = {
  id: string;
  name: string;
  inputs: Array<{ id: number; count: number }>;
  output: { id: number; count: number };
};

const RECIPES: Recipe[] = [
  { id: "planks_from_log", name: "Planks", inputs: [{ id: ITEMS.WOOD_LOG, count: 1 }], output: { id: ITEMS.PLANK, count: 4 } },
  { id: "sticks_from_planks", name: "Sticks", inputs: [{ id: ITEMS.PLANK, count: 2 }], output: { id: ITEMS.STICK, count: 4 } },
  { id: "wood_pick", name: "Wood Pick", inputs: [{ id: ITEMS.PLANK, count: 3 }, { id: ITEMS.STICK, count: 2 }], output: { id: ITEMS.WOOD_PICK, count: 1 } },
];

// Inventory layout must match server
const HOTBAR_SLOTS = 5;
const BACKPACK_SLOTS = 20;
const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

let invSlots: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
let invCursor: ItemStack = { id: 0, count: 0 };

let selectedSlot = 0;

// Viewmodel + remote toggles
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
   6.3 Drops (server authoritative)
================================ */
type Drop = {
  dropId: string;
  itemId: number;
  count: number;
  x: number;
  y: number;
  z: number;
  createdAt?: number;
};

const drops = new Map<string, Drop>();
const dropMeshes = new Map<string, BABYLON.AbstractMesh>();
let dropMat: BABYLON.StandardMaterial | null = null;

// render offset for world-space meshes that we draw in NOA scene
let worldRenderOffset = new BABYLON.Vector3(0, 0, 0);

/* ===============================
   6.4 Overlay
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

function itemName(id: number): string {
  const d = ITEM_DEFS[id];
  return d ? d.name : id === 0 ? "Empty" : `Item#${id}`;
}

function hotbarLabel(slotIndex: number): string {
  const s = invSlots[slotIndex] ?? { id: 0, count: 0 };
  if (!s.id || s.count <= 0) return "(empty)";
  return `${itemName(s.id)} x${s.count}`;
}

function formatCursor(): string {
  if (!invCursor.id || invCursor.count <= 0) return "(empty)";
  return `${itemName(invCursor.id)} x${invCursor.count}`;
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
    <strong>UserId:</strong> ${userId}<br>
    <strong>Hotbar:</strong> [${selectedSlot + 1}] ${hotbarLabel(selectedSlot)}<br>
    <strong>Cursor:</strong> ${formatCursor()}<br>
    <strong>UI:</strong> Inv=${uiInventoryOpen ? "OPEN" : "closed"} Craft=${uiCraftOpen ? "OPEN" : "closed"}<br>
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
    [V] Toggle Viewmodel<br>
    [P] Toggle Remote Players<br>
    [O] Toggle Remote Xray<br>
    [E] Toggle Inventory UI<br>
    [C] Toggle Crafting UI<br>
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
   6.5 Inventory UI rendering + input
================================ */
const slotEls: HTMLDivElement[] = [];
function buildInventoryGrid() {
  invGrid.innerHTML = "";
  slotEls.length = 0;

  const makeSlotEl = (slotIndex: number) => {
    const el = document.createElement("div");
    el.style.height = "56px";
    el.style.borderRadius = "10px";
    el.style.border = "1px solid rgba(255,255,255,0.18)";
    el.style.background = "rgba(0,0,0,0.25)";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.position = "relative";
    el.style.cursor = "pointer";
    el.style.pointerEvents = "auto";

    const label = document.createElement("div");
    label.style.color = "white";
    label.style.fontSize = "11px";
    label.style.textAlign = "center";
    label.style.padding = "0 4px";
    label.style.lineHeight = "1.05";
    label.style.opacity = "0.95";
    el.appendChild(label);

    const count = document.createElement("div");
    count.style.position = "absolute";
    count.style.right = "6px";
    count.style.bottom = "4px";
    count.style.color = "white";
    count.style.fontSize = "12px";
    count.style.fontWeight = "700";
    count.style.textShadow = "0 1px 2px rgba(0,0,0,0.6)";
    el.appendChild(count);

    const tag = document.createElement("div");
    tag.style.position = "absolute";
    tag.style.left = "6px";
    tag.style.top = "4px";
    tag.style.color = "rgba(255,255,255,0.8)";
    tag.style.fontSize = "10px";
    tag.style.opacity = "0.9";
    tag.textContent = slotIndex < HOTBAR_SLOTS ? `${slotIndex + 1}` : `${slotIndex - HOTBAR_SLOTS + 1}`;
    el.appendChild(tag);

    const updateSlotEl = () => {
      const s = invSlots[slotIndex] ?? { id: 0, count: 0 };
      const isSel = slotIndex === selectedSlot && slotIndex < HOTBAR_SLOTS;

      el.style.outline = isSel ? "2px solid rgba(120,220,255,0.9)" : "none";
      el.style.boxShadow = isSel ? "0 0 0 2px rgba(120,220,255,0.25)" : "none";

      if (!s.id || s.count <= 0) {
        label.textContent = "";
        count.textContent = "";
        el.style.background = "rgba(0,0,0,0.25)";
      } else {
        label.textContent = itemName(s.id);
        count.textContent = s.count > 1 ? String(s.count) : "";
        el.style.background = "rgba(255,255,255,0.06)";
      }
    };

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!room) return;

      const button = e.button === 2 ? "R" : "L";
      const shift = !!e.shiftKey;

      // If hotbar slot clicked, also select it for quick place
      if (slotIndex < HOTBAR_SLOTS && button === "L" && !shift) {
        selectedSlot = slotIndex;
      }

      room.send("invClick", { slot: slotIndex, button, shift });
      updateOverlay();
    });

    (el as any).__update = updateSlotEl;

    slotEls.push(el);
    invGrid.appendChild(el);
  };

  // Build 5x5 layout: first row is hotbar (5), next 4 rows are backpack (20)
  for (let i = 0; i < INV_SLOTS; i++) makeSlotEl(i);
}

buildInventoryGrid();

function updateInventoryUI() {
  invCursorLine.textContent = `Cursor: ${formatCursor()}`;
  for (const el of slotEls) {
    const u = (el as any).__update as (() => void) | undefined;
    u?.();
  }
}

function countInInventory(itemId: number): number {
  let n = 0;
  for (const s of invSlots) if (s.id === itemId && s.count > 0) n += s.count;
  return n;
}

function renderCraftList() {
  craftList.innerHTML = "";
  for (const r of RECIPES) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "10px";
    row.style.padding = "10px";
    row.style.borderRadius = "10px";
    row.style.border = "1px solid rgba(255,255,255,0.16)";
    row.style.background = "rgba(0,0,0,0.25)";
    row.style.cursor = "pointer";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.flexDirection = "column";
    left.style.gap = "4px";

    const name = document.createElement("div");
    name.textContent = r.name;
    name.style.color = "white";
    name.style.fontWeight = "700";
    name.style.fontSize = "14px";
    left.appendChild(name);

    const io = document.createElement("div");
    io.style.color = "rgba(255,255,255,0.9)";
    io.style.fontSize = "12px";

    const ins = r.inputs
      .map((x) => {
        const have = countInInventory(x.id);
        const ok = have >= x.count;
        return `${itemName(x.id)} ${have}/${x.count}${ok ? " ✓" : ""}`;
      })
      .join("  •  ");

    io.textContent = `${ins}  →  ${itemName(r.output.id)} x${r.output.count}`;
    left.appendChild(io);

    const right = document.createElement("div");
    right.style.color = "rgba(255,255,255,0.9)";
    right.style.fontSize = "12px";
    right.style.opacity = "0.95";
    right.textContent = "Craft";
    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!room) return;

      const max = !!e.shiftKey;
      room.send("craft", { recipeId: r.id, max, times: 1 });
      craftResultLine.textContent = max ? `Crafting max: ${r.name}...` : `Crafting: ${r.name}...`;
    });

    craftList.appendChild(row);
  }
}

renderCraftList();

/* ===============================
   6.6 Key handling
================================ */
document.addEventListener("keydown", (e) => {
  // If VM tuning is enabled, we still allow toggles here,
  // but tuning movement keys are captured in capture-phase handler below.
  // If UI is open, we want E/C to close, but avoid movement/hotbar changes while typing UI.
  const uiOpen = uiInventoryOpen || uiCraftOpen;

  // Hotbar 1-5 (disabled if UI open)
  if (!uiOpen) {
    const key = Number.parseInt(e.key, 10);
    if (Number.isFinite(key) && key >= 1 && key <= HOTBAR_SLOTS) {
      selectedSlot = key - 1;
      updateOverlay();
      updateInventoryUI();
      return;
    }
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

  if (e.key === "e" || e.key === "E") {
    uiInventoryOpen = !uiInventoryOpen;
    // if opening inv, close craft (optional)
    if (uiInventoryOpen) uiCraftOpen = false;
    showUIIfNeeded();
    updateInventoryUI();
    renderCraftList();
    updateOverlay(uiInventoryOpen ? "Inventory: OPEN" : "Inventory: closed");
    return;
  }

  if (e.key === "c" || e.key === "C") {
    uiCraftOpen = !uiCraftOpen;
    // if opening craft, close inv (optional)
    if (uiCraftOpen) uiInventoryOpen = false;
    showUIIfNeeded();
    updateInventoryUI();
    renderCraftList();
    updateOverlay(uiCraftOpen ? "Crafting: OPEN" : "Crafting: closed");
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

function selectedHotbarStack(): ItemStack {
  const s = invSlots[selectedSlot] ?? { id: 0, count: 0 };
  return { id: s.id | 0, count: s.count | 0 };
}

function itemPlacesBlock(itemId: number): number | null {
  const def = ITEM_DEFS[itemId];
  if (!def) return null;
  const b = def.placeBlockId;
  return typeof b === "number" ? b : null;
}

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  if (uiInventoryOpen || uiCraftOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.pos;

  // local prediction (server will confirm via blockUpdate)
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  if (uiInventoryOpen || uiCraftOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.adj;

  // Don't place inside yourself (client-side best-effort)
  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);
  if (x === px && z === pz && (y === py || y === py + 1)) return;

  // Determine placeable block from selected hotbar item
  const s = selectedHotbarStack();
  if (!s.id || s.count <= 0) return;

  const blockId = itemPlacesBlock(s.id);
  if (blockId == null) return;

  // local prediction
  noa.world.setBlockID(blockId, x, y, z);

  // authoritative place: consumes 1 from selectedSlot on server
  room?.send("placeBlock", { x, y, z, id: blockId, fromSlot: selectedSlot });
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
   9.1 Drops rendering in NOA scene
================================ */
function ensureDropMaterial(scene: BABYLON.Scene) {
  if (dropMat && dropMat.getScene() === scene) return;

  dropMat = new BABYLON.StandardMaterial("dropMat", scene);
  dropMat.disableLighting = true;
  dropMat.emissiveColor = new BABYLON.Color3(1, 1, 0.2);
  dropMat.diffuseColor = dropMat.emissiveColor.clone();
  dropMat.specularColor = new BABYLON.Color3(0, 0, 0);
  dropMat.backFaceCulling = false;
  (dropMat as any).fogEnabled = false;
}

function ensureDropMesh(drop: Drop, scene: BABYLON.Scene) {
  const existing = dropMeshes.get(drop.dropId);
  if (existing && existing.getScene() === scene) return;

  // If existing from old scene, dispose
  if (existing && existing.getScene() !== scene) {
    try {
      existing.dispose();
    } catch {}
    dropMeshes.delete(drop.dropId);
  }

  ensureDropMaterial(scene);

  const mesh = BABYLON.MeshBuilder.CreateSphere(`drop:${drop.dropId}`, { diameter: 0.25, segments: 10 }, scene);
  mesh.isPickable = false;
  mesh.material = dropMat!;
  mesh.renderingGroupId = 2;

  (mesh as any).isInFrustum = () => true;

  dropMeshes.set(drop.dropId, mesh);
}

function removeDropMesh(dropId: string) {
  const m = dropMeshes.get(dropId);
  if (m) {
    try {
      m.dispose();
    } catch {}
    dropMeshes.delete(dropId);
  }
}

function updateDropMeshes(dtSec: number) {
  const scene = getStableScene();
  if (!scene) return;

  // Create meshes for known drops
  for (const d of drops.values()) ensureDropMesh(d, scene);

  const time = performance.now() / 1000;

  for (const d of drops.values()) {
    const m = dropMeshes.get(d.dropId);
    if (!m) continue;

    // Floating-origin correction: render offset computed from camera - player
    const bob = Math.sin(time * 3.2 + (d.x + d.z) * 0.3) * 0.06;
    m.position.set(
      d.x + worldRenderOffset.x,
      d.y + worldRenderOffset.y + bob,
      d.z + worldRenderOffset.z
    );

    m.rotation.y += dtSec * 1.6;
  }
}

function tryAutoPickupDrops() {
  if (!room) return;
  if (!hasPointerLock()) return; // only auto-pickup during active play

  const p = noa.ents.getPosition(noa.playerEntity) as [number, number, number] | null;
  if (!p) return;

  // small radius; server validates anyway
  const r2 = 2.25 * 2.25;

  for (const d of drops.values()) {
    const dx = d.x - p[0];
    const dy = d.y - p[1];
    const dz = d.z - p[2];
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 <= r2) {
      room.send("pickupDrop", { dropId: d.dropId });
    }
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
    worldRenderOffset.copyFrom(rpRenderOffset);
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

    // Pass userId for persistence
    room = await colyseus.joinOrCreate("my_room", { userId });
    (globalThis as any).room = room;

    console.log("[NET] joined room", { sessionId: room.sessionId, userId });

    updateOverlay();

    // Flush queued chunk requests
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
      try {
        const slots = Array.isArray(msg?.slots) ? msg.slots : null;
        const cursor = msg?.cursor ?? null;

        if (slots) {
          const next: ItemStack[] = Array.from({ length: INV_SLOTS }, () => ({ id: 0, count: 0 }));
          for (let i = 0; i < Math.min(INV_SLOTS, slots.length); i++) {
            const s = slots[i];
            const id = Number(s?.id ?? 0) | 0;
            const count = Number(s?.count ?? 0) | 0;
            next[i] = id > 0 && count > 0 ? { id, count } : { id: 0, count: 0 };
          }
          invSlots = next;
        }

        const cId = Number(cursor?.id ?? 0) | 0;
        const cCount = Number(cursor?.count ?? 0) | 0;
        invCursor = cId > 0 && cCount > 0 ? { id: cId, count: cCount } : { id: 0, count: 0 };

        updateInventoryUI();
        renderCraftList();
        updateOverlay("invState received");
      } catch {}
    });

    room.onMessage("craftResult", (msg: any) => {
      const ok = !!msg?.ok;
      const recipeId = String(msg?.recipeId ?? "");
      const crafted = Number(msg?.crafted ?? 0) | 0;
      const reason = String(msg?.reason ?? "");

      if (ok) {
        craftResultLine.textContent = `Crafted ${crafted} × ${recipeId}`;
        updateOverlay(`Crafted ${crafted} × ${recipeId}`);
      } else {
        craftResultLine.textContent = `Craft failed: ${recipeId} (${reason || "unknown"})`;
        updateOverlay(`Craft failed: ${recipeId} (${reason || "unknown"})`);
      }
    });

    // Drops
    room.onMessage("dropSpawn", (d: any) => {
      if (!d || typeof d.dropId !== "string") return;
      const drop: Drop = {
        dropId: String(d.dropId),
        itemId: Number(d.itemId ?? 0) | 0,
        count: Number(d.count ?? 1) | 0,
        x: Number(d.x ?? 0),
        y: Number(d.y ?? 0),
        z: Number(d.z ?? 0),
        createdAt: typeof d.createdAt === "number" ? d.createdAt : undefined,
      };
      if (!Number.isFinite(drop.x) || !Number.isFinite(drop.y) || !Number.isFinite(drop.z)) return;
      drops.set(drop.dropId, drop);
    });

    room.onMessage("dropDespawn", (d: any) => {
      const id = String(d?.dropId ?? "");
      if (!id) return;
      drops.delete(id);
      removeDropMesh(id);
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
   13. Tick loop (drive vm updates + networking + rp sync)
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
  }

  updateViewmodel(dtSec);

  // Update remote meshes every tick (cheap; few boxes)
  updateRemoteMeshes();

  // Drops
  updateDropMeshes(dtSec);
  if (tickCount % 2 === 0) tryAutoPickupDrops();

  // Send movement (throttled)
  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // Keep overlay + UI fresh
  if (tickCount % 10 === 0) {
    updateOverlay();
    if (uiInventoryOpen || uiCraftOpen) {
      updateInventoryUI();
      renderCraftList();
    }
  }
});
