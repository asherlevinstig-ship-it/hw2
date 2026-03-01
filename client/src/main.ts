// client/src/main.ts
// FULL FILE - No Omits, All Logic

import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core/Legacy/legacy";

import {
  Items,
  ITEM_DEFS,
  RECIPES,
  type ItemStack,
  type ItemDef,
} from "./shared/items";

import { BlockRegistry } from "./BlockRegistry";
import { BlockMaterialManager } from "./BlockMaterialManager";

import {
  appEl, classOverlay, selectedClassId, confirmBtn, overlay, coordsHUD,
  healthHUD, manaHUD, hudHotbarRoot, showZoneNotification, createStatIcon,
  invRoot, cursorSlotEl, cursorNameEl, hotbarGrid, backpackGrid,
  craftList, craftStatus, mkButton
} from "./ui";

/* ===============================
   1. Colyseus Setup
================================ */
const ENDPOINT = import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";
const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

/* ===============================
   4. NOA Engine Initialization
================================ */
const noa = new Engine({
  debug: false,
  container: appEl!,
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

appEl!.addEventListener("click", () => {
  if (!invOpen && classOverlay.style.display === "none") requestPointerLock();
});

function hasPointerLock(): boolean {
  return !!(noa.container as any)?.hasPointerLock;
}

confirmBtn.onclick = () => {
  if (!selectedClassId) return;
  localStorage.setItem("noa_player_class", selectedClassId);
  classOverlay.style.display = "none";
  if (room) room.send("selectClass", { classId: selectedClassId });
  requestPointerLock();
};

/* ===============================
   5. Register Blocks & Materials (Dynamic from Registry)
================================ */
const registeredNoaMats = new Set<string>();

function registerNoaMat(name: string, url: string, hasAlpha: boolean) {
  if (registeredNoaMats.has(name)) return;
  noa.registry.registerMaterial(name, { textureURL: url, texHasAlpha: hasAlpha });
  registeredNoaMats.add(name);
}

for (const stringId in BlockRegistry) {
  const id = Number(stringId);
  if (id === 0) continue; // Air

  const def = BlockRegistry[id];
  const tex = def.textures;

  if (tex.all) {
    const matName = `mat_${id}_all`;
    registerNoaMat(matName, tex.all, def.isTransparent);
    noa.registry.registerBlock(id, { material: matName, opaque: !def.isTransparent });
  } else {
    const matTop = `mat_${id}_top`;
    const matBot = `mat_${id}_bottom`;
    const matSide = `mat_${id}_side`;
    const matFront = `mat_${id}_front`;

    if (tex.top) registerNoaMat(matTop, tex.top, def.isTransparent);
    if (tex.bottom) registerNoaMat(matBot, tex.bottom, def.isTransparent);
    if (tex.side) registerNoaMat(matSide, tex.side, def.isTransparent);
    if (tex.front) registerNoaMat(matFront, tex.front, def.isTransparent);

    // left, right, top, bottom, front, back
    const topTex = tex.top ? matTop : matSide;
    const botTex = tex.bottom ? matBot : matSide;
    const frontTex = tex.front ? matFront : matSide;

    noa.registry.registerBlock(id, {
      material: [matSide, matSide, topTex, botTex, frontTex, matSide],
      opaque: !def.isTransparent
    });
  }
}

/* ===============================
   5.1 Debug Tools: ID Registry Validation
================================ */
function isRegisteredBlockId(id: number) {
  return id === 0 || !!BlockRegistry[id]; 
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
type SafeZoneMsg = { x: number; z: number; r: number; name?: string };
let safeZone: SafeZoneMsg | null = null;
let currentZoneState: string | null = null;

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

let vmBaseXMul = 0.65;
let vmBaseY = -0.75;
let vmBaseZ = 1.15; 

let vmRotX = 0.22;
let vmRotY = 0.1;
let vmRotZ = -0.58;

let vmPitchMul = 0.45;
let vmPunchRotMul = 1.2; 
let vmTurnSwayMulY = 0.35;
let vmTurnSwayMulZ = 0.25;
let vmPunchMoveX = 0.25; 
let vmPunchMoveY = 0.15; 
let vmPunchMoveZ = 0.35; 

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

function renderSlot(el: HTMLDivElement, stack: ItemStack, isSelected = false) {
  el.innerHTML = "";
  el.style.width = "64px";
  el.style.height = "64px";
  el.style.borderRadius = "8px";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.position = "relative";
  el.style.cursor = "pointer";
  el.style.background = "rgba(0,0,0,0.35)";
  el.style.border = isSelected
    ? "2px solid rgba(255,255,255,0.9)"
    : "1px solid rgba(255,255,255,0.18)";

  if (stack && stack.id > 0 && stack.count > 0) {
    const def = (ITEM_DEFS as any)[stack.id] as ItemDef | undefined;
    
    if (def && def.icon) {
      const img = document.createElement("img");
      img.src = def.icon;
      img.style.width = "42px";
      img.style.height = "42px";
      img.style.imageRendering = "pixelated";
      img.style.filter = "invert(1)"; 
      img.style.opacity = "0.9";
      
      img.onerror = () => {
          img.style.display = "none";
          const fallback = document.createElement("div");
          fallback.textContent = def.fallback || "❓";
          fallback.style.fontSize = "28px";
          el.appendChild(fallback);
      };
      
      el.appendChild(img);

      if (def.color) {
        if (isSelected) {
           el.style.borderColor = def.color;
           el.style.boxShadow = `0 0 8px ${def.color}, inset 0 0 10px ${def.color}40`;
        } else {
           el.style.borderColor = def.color;
           el.style.boxShadow = `inset 0 0 5px ${def.color}30`;
        }
      }
    } else {
      const name = document.createElement("div");
      name.textContent = itemName(stack.id);
      name.style.fontSize = "11px";
      name.style.textAlign = "center";
      name.style.padding = "0 4px";
      name.style.wordBreak = "break-word";
      el.appendChild(name);
    }

    if (!def || (def.id < 1000)) {
      if (stack.count > 1 || (def && def.maxStack > 1)) {
        const count = document.createElement("div");
        count.textContent = `${stack.count}`;
        count.style.position = "absolute";
        count.style.right = "4px";
        count.style.bottom = "2px";
        count.style.fontSize = "12px";
        count.style.fontWeight = "bold";
        count.style.color = "white";
        count.style.textShadow = "1px 1px 0 #000";
        el.appendChild(count);
      }
    }

    const dur = Number((stack as any).dur ?? 0);
    if (Number.isFinite(dur) && dur > 0) {
      const dEl = document.createElement("div");
      dEl.textContent = `${dur}`;
      dEl.style.position = "absolute";
      dEl.style.left = "4px";
      dEl.style.bottom = "2px";
      dEl.style.fontSize = "10px";
      dEl.style.color = "#ccc";
      dEl.style.textShadow = "1px 1px 0 #000";
      el.appendChild(dEl);
    }
  }
}

function renderInventoryUI() {
  renderSlot(cursorSlotEl, invState.cursor, false);
  cursorNameEl.textContent =
    invState.cursor.id > 0
      ? itemName(invState.cursor.id)
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
    
    healthHUD.appendChild(createStatIcon("heart", state)); 
  }

  const manaContainers = Math.max(1, Math.floor(myMaxMana / 10));
  for (let i = 0; i < manaContainers; i++) {
    const mVal = myMana - (i * 10);
    let state: "full" | "half" | "empty" = "empty";
    if (mVal >= 10) state = "full";
    else if (mVal >= 5) state = "half"; 
    
    manaHUD.appendChild(createStatIcon("mana", state)); 
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
    [U] Teleport to Cave Below<br>
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
    if (classOverlay.style.display !== "none") return;
    setInvOpen(!invOpen);
    updateOverlay(invOpen ? "Inventory opened" : "Inventory closed");
    return;
  }

  if (e.key === "u" || e.key === "U") {
    if (room) room.send("devTpCave");
    updateOverlay("Scanning for caves below...");
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

    const isBaseZKey = 
      e.key === "[" || 
      e.key === "]";

    const isRotKey =
      e.key === "7" ||
      e.key === "8" ||
      e.key === "9" ||
      e.key === "0" ||
      e.key === "-" ||
      e.key === "=";

    if (!isArrow && !isRotKey && !isBaseZKey) return;

    e.preventDefault();
    e.stopPropagation();
    (e as any).stopImmediatePropagation?.();

    const fineMove = e.shiftKey ? 0.003 : 0.01;

    if (e.key === "ArrowLeft") vmBaseXMul -= fineMove;
    if (e.key === "ArrowRight") vmBaseXMul += fineMove;
    if (e.key === "ArrowUp") vmBaseY += fineMove;
    if (e.key === "ArrowDown") vmBaseY -= fineMove;
    if (e.key === "[") vmBaseZ -= fineMove;
    if (e.key === "]") vmBaseZ += fineMove;

    const rStep = e.shiftKey ? 0.02 : 0.05;
    if (e.key === "7") vmRotX -= rStep;
    if (e.key === "8") vmRotX += rStep;
    if (e.key === "9") vmRotY -= rStep;
    if (e.key === "0") vmRotY += rStep;
    if (e.key === "-") vmRotZ -= rStep;
    if (e.key === "=") vmRotZ += rStep;

    updateOverlay(
      `VM: x=${vmBaseXMul.toFixed(3)} y=${vmBaseY.toFixed(3)} z=${vmBaseZ.toFixed(3)} | rot=(${vmRotX.toFixed(
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

  if (ArrayBuffer.isView(msgVoxels)) {
    const view = msgVoxels as any;
    if (view.byteLength === expectedLen * 2) {
      const u16 = new Uint16Array(view.buffer, view.byteOffset, expectedLen);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u16[i] | 0;
      }
      return out;
    }
    if (view.byteLength === expectedLen) {
      const u8 = new Uint8Array(view.buffer, view.byteOffset, expectedLen);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u8[i] | 0;
      }
      return out;
    }
    if (typeof view.length === "number" && view.length === expectedLen) {
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = view[i] | 0;
      }
      return out;
    }
  }

  if (typeof msgVoxels === "object" && typeof msgVoxels.length === "number" && msgVoxels.length === expectedLen) {
    const out = new Array<number>(expectedLen);
    for (let i = 0; i < expectedLen; i++) {
      out[i] = msgVoxels[i] | 0;
    }
    return out;
  }

  if (msgVoxels && msgVoxels.type === "Buffer" && Array.isArray(msgVoxels.data)) {
    const data = msgVoxels.data;
    if (data.length === expectedLen) {
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = data[i] | 0;
      }
      return out;
    }
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
  if (classOverlay.style.display !== "none") return;
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

// INPUT HANDLING UPDATE
noa.inputs.down.on("alt-fire", () => {
  if (classOverlay.style.display !== "none") return;
  if (!hasPointerLock()) return;
  if (invOpen) return;

  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  // CHECK FOR INTERACTION FIRST
  const targetedBlockId = noa.world.getBlockID(target.pos.x, target.pos.y, target.pos.z);
  
  if (targetedBlockId === Items.CHEST) {
      // Send Interact
      if (room) room.send("interact", { x: target.pos.x, y: target.pos.y, z: target.pos.z });
      return; // Stop processing placement
  }

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
   9.01 Material Manager Integration & Cross-Scene Cloner
================================ */
let matManager: BlockMaterialManager | null = null;

function ensureMaterialManager(scene: BABYLON.Scene) {
  if (!matManager) {
    matManager = new BlockMaterialManager(scene);
    matManager.loadAllTextures().catch(console.error);
  }
}

// Babylon requires materials to be instantiated in the exact scene they are used in.
// We grab the loaded textures from the world scene (via matManager) and create fresh mats for our overlays.
function createOverlayMat(targetScene: BABYLON.Scene, sourceMatInfo: BABYLON.Material | BABYLON.Material[] | null | undefined): BABYLON.StandardMaterial {
  const src = Array.isArray(sourceMatInfo) ? sourceMatInfo[0] : sourceMatInfo;
  const mat = new BABYLON.StandardMaterial("overlayMat", targetScene);
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.depthFunction = BABYLON.Constants.ALWAYS;
  (mat as any).fogEnabled = false;

  if (src && src instanceof BABYLON.StandardMaterial && src.diffuseTexture) {
    mat.diffuseTexture = src.diffuseTexture;
    mat.emissiveTexture = src.diffuseTexture;
    if (src.useAlphaFromDiffuseTexture) {
      mat.useAlphaFromDiffuseTexture = true;
      mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
    }
  } else {
    mat.emissiveColor = new BABYLON.Color3(1, 0, 1);
  }
  return mat;
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

    if (matManager) {
      const matInfo = matManager.getMaterialForBlock(d.itemId);
      if (Array.isArray(matInfo)) {
          // It's a block with different faces, we can just assign the Side material for the rotating drop icon
          box.material = matInfo[0]; 
      } else if (matInfo) {
          box.material = matInfo;
      }
    }

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
let vmGrip: BABYLON.TransformNode | null = null; 
let vmEngineHooked = false;

let vmAxes: BABYLON.TransformNode | null = null;
let vmFrame: BABYLON.LinesMesh | null = null;

let vmUpperArmMesh: BABYLON.Mesh | null = null;
let vmForeArmMesh: BABYLON.Mesh | null = null;
let vmHandMesh: BABYLON.Mesh | null = null;

function ensureVmScene(noaScene: BABYLON.Scene) {
  if (vmReady && vmScene && vmCam && vmRoot && vmArmRoot) return;

  const engine = noaScene.getEngine();

  vmScene = new BABYLON.Scene(engine);
  vmScene.useRightHandedSystem = noaScene.useRightHandedSystem;

  vmScene.autoClear = false;
  vmScene.autoClearDepthAndStencil = true;

  vmCam = new BABYLON.FreeCamera("vmCam", new BABYLON.Vector3(0, 0, 0), vmScene);
  vmCam.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
  vmCam.fov = 0.75;
  vmCam.minZ = 0.01;
  vmCam.maxZ = 100;
  vmCam.setTarget(new BABYLON.Vector3(0, 0, 1));
  vmScene.activeCamera = vmCam;

  vmRoot = new BABYLON.TransformNode("vmRoot", vmScene);
  vmRoot.position.set(0, 0, 0);
  vmRoot.rotationQuaternion = new BABYLON.Quaternion();

  vmArmRoot = new BABYLON.TransformNode("vmArmRoot", vmScene);
  vmArmRoot.parent = vmRoot;

  vmUpperArmMesh = BABYLON.MeshBuilder.CreateBox("vmUpperArm", { width: 0.16, height: 0.44, depth: 0.16 }, vmScene);
  vmForeArmMesh = BABYLON.MeshBuilder.CreateBox("vmForeArm", { width: 0.16, height: 0.38, depth: 0.16 }, vmScene);
  vmHandMesh = BABYLON.MeshBuilder.CreateBox("vmHand", { width: 0.17, height: 0.18, depth: 0.17 }, vmScene);

  vmUpperArmMesh.parent = vmArmRoot;
  vmForeArmMesh.parent = vmArmRoot;
  vmHandMesh.parent = vmArmRoot;

  vmArmRoot.position.set(0.0, 0.1, 0.0);

  vmUpperArmMesh.position.set(0.0, 0.22, 0.0);
  vmForeArmMesh.position.set(0.0, -0.14, 0.02);
  vmHandMesh.position.set(0.0, -0.4, 0.04);

  vmGrip = new BABYLON.TransformNode("vmGrip", vmScene);
  vmGrip.parent = vmHandMesh;
  vmGrip.position.set(0.0, -0.06, 0.10); 
  vmGrip.rotation.set(0, 0, 0);

  const armMat = new BABYLON.StandardMaterial("vmArmMat", vmScene);
  armMat.disableLighting = true;
  armMat.emissiveColor = new BABYLON.Color3(0.85, 0.72, 0.55);
  armMat.diffuseColor = armMat.emissiveColor.clone();
  armMat.specularColor = new BABYLON.Color3(0, 0, 0);
  armMat.backFaceCulling = false;
  armMat.disableDepthWrite = true;
  armMat.depthFunction = BABYLON.Constants.ALWAYS;

  vmUpperArmMesh.material = armMat;
  vmForeArmMesh.material = armMat;
  vmHandMesh.material = armMat;

  vmUpperArmMesh.isPickable = false;
  vmForeArmMesh.isPickable = false; 
  vmHandMesh.isPickable = false;

  (vmUpperArmMesh as any).isInFrustum = () => true;
  (vmForeArmMesh as any).isInFrustum = () => true;
  (vmHandMesh as any).isInFrustum = () => true;

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
      const pts = [
        new BABYLON.Vector3(-1, -1, 1),
        new BABYLON.Vector3(1, -1, 1),
        new BABYLON.Vector3(1, 1, 1),
        new BABYLON.Vector3(-1, 1, 1),
        new BABYLON.Vector3(-1, -1, 1),
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
   10.1 Viewmodel Item Mesh Logic
================================ */
let currentVmItemId = -1;
let vmItemMesh: BABYLON.TransformNode | null = null;

function updateVmItem() {
  if (!vmScene || !vmArmRoot) return;

  const heldStack = invState.slots[selectedHotbar];
  const heldId = (heldStack && heldStack.count > 0) ? heldStack.id : 0;

  const isUnarmed = heldId === 0;
  if (vmUpperArmMesh) vmUpperArmMesh.setEnabled(isUnarmed);
  if (vmForeArmMesh) vmForeArmMesh.setEnabled(isUnarmed);
  if (vmHandMesh) vmHandMesh.setEnabled(isUnarmed);

  if (heldId === currentVmItemId) return;
  currentVmItemId = heldId;

  if (vmItemMesh) {
    vmItemMesh.dispose();
    vmItemMesh = null;
  }

  if (isUnarmed) return;

  const def = (ITEM_DEFS as any)[heldId] as ItemDef | undefined;
  if (!def) return;

  vmItemMesh = new BABYLON.TransformNode("vmItemMesh", vmScene);
  vmItemMesh.parent = vmArmRoot;

  if (def.tool) {
     const headId = 
        def.tool.kind === "sword" ? Items.RAW_IRON :
        def.tool.kind === "pick" ? Items.STONE :
        def.tool.kind === "axe" ? Items.WOOD_LOG :
        Items.STONE;

     const headMatInfo = matManager?.getMaterialForBlock(headId);
     const handleMatInfo = matManager?.getMaterialForBlock(Items.WOOD_LOG);

     if (def.tool.kind === "sword") {
         vmItemMesh.rotation.x = Math.PI / 4; 
         vmItemMesh.rotation.y = 0;
         vmItemMesh.rotation.z = 0;
         vmItemMesh.scaling.set(4, 4, 4);

         const handle = BABYLON.MeshBuilder.CreateBox("handle", { width: 0.07, height: 0.22, depth: 0.07 }, vmScene);
         handle.material = createOverlayMat(vmScene, handleMatInfo);
         handle.position.y = 0.02;
         
         const guard = BABYLON.MeshBuilder.CreateBox("guard", { width: 0.22, height: 0.06, depth: 0.10 }, vmScene);
         guard.material = createOverlayMat(vmScene, headMatInfo);
         guard.position.y = 0.16;
         
         const blade = BABYLON.MeshBuilder.CreateBox("blade", { width: 0.10, height: 0.75, depth: 0.03 }, vmScene);
         blade.material = createOverlayMat(vmScene, headMatInfo);
         blade.position.y = 0.56;
         
         handle.parent = vmItemMesh;
         guard.parent = vmItemMesh;
         blade.parent = vmItemMesh;

         vmItemMesh.position.set(0.3, -0.4, 0.5);

     } else if (def.tool.kind === "pick" || def.tool.kind === "axe") {
         vmItemMesh.rotation.x = Math.PI / 4;
         vmItemMesh.rotation.y = -Math.PI / 10;
         vmItemMesh.rotation.z = 0;
         vmItemMesh.scaling.set(3.5, 3.5, 3.5);

         const handle = BABYLON.MeshBuilder.CreateBox("handle", { width: 0.07, height: 0.65, depth: 0.07 }, vmScene);
         handle.material = createOverlayMat(vmScene, handleMatInfo);
         handle.position.y = 0.2;
         
         const head = BABYLON.MeshBuilder.CreateBox("head", { width: 0.45, height: 0.10, depth: 0.10 }, vmScene);
         head.material = createOverlayMat(vmScene, headMatInfo);
         head.position.y = 0.45;

         if (def.tool.kind === "axe") {
           head.position.x = 0.08;
           head.scaling.set(0.6, 2.5, 1);
         }
         
         handle.parent = vmItemMesh;
         head.parent = vmItemMesh;

         vmItemMesh.position.set(0.3, -0.4, 0.5);
     }
  } else {
     // Blocks or Raw Items
     vmItemMesh.rotation.x = Math.PI / 8;
     vmItemMesh.rotation.y = Math.PI / 4;
     vmItemMesh.rotation.z = 0;
     vmItemMesh.scaling.set(2, 2, 2);

     const box = BABYLON.MeshBuilder.CreateBox("vmBlock", { size: 0.22 }, vmScene);
     
     if (matManager) {
        const m = matManager.getMaterialForBlock(heldId);
        if (Array.isArray(m)) {
            const multi = new BABYLON.MultiMaterial(`vmMulti_${heldId}`, vmScene);
            m.forEach(mat => multi.subMaterials.push(createOverlayMat(vmScene!, mat)));
            box.material = multi;
        } else if (m) {
            box.material = createOverlayMat(vmScene, m);
        }
     }
     
     box.parent = vmItemMesh;
     vmItemMesh.position.set(0.3, -0.2, 0.6);
  }

  // Enforce overlay depth buffer
  vmItemMesh.getChildMeshes().forEach(m => {
     m.renderingGroupId = 3;
     m.isPickable = false;
     (m as any).isInFrustum = () => true;
  });
}

/* ===============================
   10.2 Viewmodel animation
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
  
  updateVmItem();

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

  punchT = Math.min(1, punchT + dtSec * 3.5);
  
  const punch01 = Math.sin(Math.pow(punchT, 0.6) * Math.PI);

  const baseX = vmBaseXMul;
  const baseY = vmBaseY;
  const baseZ = vmBaseZ;

  const x = baseX + sway * 0.08 - punch01 * vmPunchMoveX;
  const y = baseY + bob * 0.08 - punch01 * vmPunchMoveY;
  const z = baseZ - punch01 * vmPunchMoveZ; 

  vmRoot.position.set(x, y, z);

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

function updateMobNameplate(root: BABYLON.TransformNode, id: string, hp: number, maxHp: number) {
    if (!rpScene) return;

    let plate = (root as any).__nameplate as BABYLON.Mesh;
    let tex = (root as any).__nameplateTex as BABYLON.DynamicTexture;

    if (!plate) {
        // Create Plane
        plate = BABYLON.MeshBuilder.CreatePlane("np:" + id, { width: 1.5, height: 0.4 }, rpScene);
        plate.parent = root;
        plate.position.y = 2.2; // Float above head
        plate.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        plate.isPickable = false;
        
        // Create Texture
        tex = new BABYLON.DynamicTexture("npTex:" + id, { width: 256, height: 64 }, rpScene, false);
        tex.hasAlpha = true;

        const mat = new BABYLON.StandardMaterial("npMat:" + id, rpScene);
        mat.diffuseTexture = tex;
        mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        
        plate.material = mat;

        (root as any).__nameplate = plate;
        (root as any).__nameplateTex = tex;
    }

    // Only redraw if HP changed to save perf
    const lastHp = (root as any).__lastHp;
    if (lastHp !== hp) {
        (root as any).__lastHp = hp;
        
        const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, 256, 64);

        // Background Bar (Grey)
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(10, 35, 236, 12);

        // Health Bar (Red)
        const pct = Math.max(0, hp / maxHp);
        ctx.fillStyle = pct > 0.5 ? "#00ff00" : (pct > 0.25 ? "#ffff00" : "#ff0000");
        ctx.fillRect(10, 35, 236 * pct, 12);

        // Name Text
        ctx.font = "bold 24px monospace";
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        ctx.shadowColor = "black";
        ctx.shadowBlur = 4;
        
        let name = "Player";
        if (id.includes("golem")) name = "Deepslate Golem";
        else if (id.includes("dummy")) name = "Training Dummy";
        
        ctx.fillText(name, 128, 25);
        tex.update();
    }
}

function ensureRemoteMesh(id: string): BABYLON.TransformNode | null {
  if (!rpScene) return null;

  const existing = remoteMeshes.get(id);
  if (existing) return existing;

  const isMob = id.includes("dummy") || id.includes("mob") || id.includes("golem");
  const root = new BABYLON.TransformNode(`remoteRoot:${id}`, rpScene);
  (root as any).__isMob = isMob;

  let parts: any = {};

  if (isMob) {
    const mobMat = new BABYLON.StandardMaterial(`rpMat:${id}`, rpScene);
    mobMat.disableLighting = true;
    mobMat.backFaceCulling = false;
    (mobMat as any).fogEnabled = false;

    // Cross-scene material transfer: Grab the texture from matManager and assign to new material
    const baseMatInfo = matManager?.getMaterialForBlock(Items.DEEPSLATE);
    const baseMat = (Array.isArray(baseMatInfo) ? baseMatInfo[0] : baseMatInfo) as BABYLON.StandardMaterial | undefined;

    if (baseMat && baseMat.diffuseTexture) {
      mobMat.diffuseTexture = baseMat.diffuseTexture;
      mobMat.emissiveTexture = baseMat.diffuseTexture;
    } else {
      mobMat.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.5); // Grey fallback
    }

    remoteMats.set(id, mobMat);
    
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

    parts = { body, head, armL, armR, legL, legR, eyeMat, orbiters, mobMat };

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

    parts = { body, head, armL, armR, legL, legR, bodyCenterY, headCenterY };
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

function updateRemoteMeshes(dtSec: number) {
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

    const lerp = 1 - Math.pow(0.001, dtSec);
    root.position.x += (target.x - root.position.x) * lerp;
    root.position.y += (target.y - root.position.y) * lerp;
    root.position.z += (target.z - root.position.z) * lerp;

    if (typeof t.yaw === "number") {
      let dyaw = t.yaw - root.rotation.y;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      root.rotation.y += dyaw * lerp;
    }

    const prev = remotePrevPos.get(id) ?? new BABYLON.Vector3(root.position.x, root.position.y, root.position.z);
    const prevAt = remotePrevAt.get(id) ?? now;
    const dtMove = Math.max(0.001, (now - prevAt) / 1000);

    const dx = root.position.x - prev.x;
    const dz = root.position.z - prev.z;
    const speed = Math.sqrt(dx * dx + dz * dz) / dtMove;

    prev.copyFrom(root.position);
    remotePrevPos.set(id, prev);
    remotePrevAt.set(id, now);

    const isMob = (root as any).__isMob;
    const parts = (root as any).__parts;
    const mat = remoteMats.get(id);

    const hp = t.hp ?? 100;
    const maxHp = t.maxHp ?? 100;
    updateMobNameplate(root, id, hp, maxHp);

    if (isMob) {
      const healthPct = hp / Math.max(1, maxHp);
      const isRaging = healthPct < 0.5;

      const targetScale = isRaging ? 1.25 : 1.0;
      root.scaling.x += (targetScale - root.scaling.x) * 0.1;
      root.scaling.y += (targetScale - root.scaling.y) * 0.1;
      root.scaling.z += (targetScale - root.scaling.z) * 0.1;

      const flashTime = remoteFlashes.get(id);
      const isHit = flashTime && now - flashTime < 200;

      if (mat) {
        if (isHit) {
          mat.emissiveColor.set(1, 0.2, 0.2);
          mat.diffuseColor.set(1, 0.2, 0.2);
        } else {
          mat.emissiveColor.set(1, 1, 1);
          mat.diffuseColor.set(1, 1, 1);
        }
      }

      if (parts.eyeMat) {
        if (isRaging) {
          parts.eyeMat.emissiveColor.set(1, 0.4, 0); 
        } else {
          parts.eyeMat.emissiveColor.set(1, 0.05, 0.05); 
        }
      }

      if (parts.orbiters) {
        const orbitSpeed = isRaging ? 6.0 : 2.0;
        const orbitRadius = isRaging ? 1.4 : 1.0;
        const heightBob = Math.sin(now * 0.003) * 0.2;
        
        parts.orbiters.forEach((orb: BABYLON.Mesh, i: number) => {
            const angle = ((now * 0.001) * orbitSpeed) + (i * ((Math.PI * 2) / parts.orbiters.length));
            orb.position.set(
                Math.cos(angle) * orbitRadius,
                0.8 + heightBob + (i * 0.15),
                Math.sin(angle) * orbitRadius
            );
            orb.rotation.x += dtSec * 2;
            orb.rotation.y += dtSec * 3;
        });
      }

      const moving = speed > 0.15;
      const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * (isRaging ? 0.25 : 0.15);
      let phase = (root as any).__walkPhase as number;
      if (!Number.isFinite(phase)) phase = 0;
      phase += moving ? phaseSpeed : 0.02;
      (root as any).__walkPhase = phase;

      const breath = Math.sin(now * 0.002) * 0.03;
      const bounce = moving ? Math.abs(Math.sin(phase)) * 0.15 : 0;
      const swing = Math.sin(phase) * (moving ? 0.6 : 0.05);
      
      let armPitch = 0;
      let bodyPitch = 0;
      const swingTime = remoteSwings.get(id);
      
      if (swingTime && now - swingTime < 600) {
        const elapsed = now - swingTime;
        if (elapsed < 200) {
          const t = elapsed / 200;
          armPitch = -0.8 * t;
          bodyPitch = -0.2 * t;
        } else {
          const t = (elapsed - 200) / 400;
          armPitch = Math.sin(t * Math.PI) * 2.5 - 0.8 * (1 - t);
          bodyPitch = Math.sin(t * Math.PI) * 0.4;
        }
      }

      if (parts.body && parts.head && parts.legL && parts.legR && parts.armL && parts.armR) {
          parts.body.position.y = 0.9 + breath + bounce;
          parts.head.position.y = 1.5 + breath + bounce;
          
          parts.body.rotation.x = bodyPitch;
          parts.head.rotation.x = bodyPitch * 0.5;

          parts.legL.rotation.x = swing;
          parts.legR.rotation.x = -swing;
          parts.armL.rotation.x = -swing * 0.5;
          parts.armR.rotation.x = swing * 0.5 - armPitch;
      }
    } else {
      if (parts?.legL && parts?.legR && parts?.armL && parts?.armR && parts?.body && parts?.head) {
        const moving = speed > 0.15;
        const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * 0.18;

        let phase = (root as any).__walkPhase as number;
        if (!Number.isFinite(phase)) phase = 0;

        phase += moving ? phaseSpeed : 0.02;
        (root as any).__walkPhase = phase;

        const breath = Math.sin(now * 0.002) * 0.02;
        const bounce = moving ? Math.abs(Math.sin(phase * 2)) * 0.05 : 0;
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
        let bodyPitch = moving ? 0.1 : 0;
        let bodyYaw = 0;
        let headYaw = 0;

        const swingTime = remoteSwings.get(id);
        if (swingTime && now - swingTime < 450) {
          const elapsed = now - swingTime;
          if (elapsed < 150) {
            const t = elapsed / 150;
            const ease = t * t * (3 - 2 * t);
            armPitch = -0.6 * ease;
            bodyPitch += -0.15 * ease;
            bodyYaw = 0.3 * ease; 
            headYaw = -0.3 * ease; 
          } else {
            const t = (elapsed - 150) / 300;
            const strikeT = Math.sin(Math.pow(t, 0.5) * Math.PI);
            
            armPitch = strikeT * 2.2 - 0.6 * (1 - t);
            bodyPitch += strikeT * 0.4;
            bodyYaw = -0.4 * strikeT + 0.3 * (1 - t); 
            headYaw = 0.4 * strikeT - 0.3 * (1 - t);
          }
        }

        parts.body.position.y = parts.bodyCenterY + breath + bounce;
        parts.head.position.y = parts.headCenterY + breath + bounce;

        parts.body.rotation.x = bodyPitch;
        parts.body.rotation.y = bodyYaw;
        parts.head.rotation.x = bodyPitch * 0.5;
        parts.head.rotation.y = headYaw;

        parts.legL.rotation.x = swing * 0.55;
        parts.legR.rotation.x = -swing * 0.55;
        parts.armL.rotation.x = -swing * 0.35 + bodyYaw * 0.5; 
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
let clientWorldTime = 0; // 0..1

async function connect() {
  try {
    updateOverlay();

    const userId = ensureUserId();
    const savedClass = localStorage.getItem("noa_player_class");
    
    if (!savedClass) {
      classOverlay.style.display = "flex";
    }

    room = await colyseus.joinOrCreate("my_room", { userId });
    (globalThis as any).room = room;

    if (savedClass && room) {
      room.send("selectClass", { classId: savedClass });
    }

    updateOverlay();

    for (const req of queuedRequests.values()) {
      room.send("worldDataNeeded", req);
    }

    room.onMessage("chunkData", (msg: any) => applyChunkFromServer(msg));

    room.onMessage("worldTime", (msg: any) => {
        if (Number.isFinite(msg.time)) {
             clientWorldTime = msg.time; // Resync
        }
    });

    room.onMessage("worldMeta", (msg: any) => {
        if (Number.isFinite(msg.worldTime)) {
            clientWorldTime = msg.worldTime;
        }
    });

    room.onMessage("safeZone", (m: any) => {
      if (!m || typeof m !== "object") return;
      const x = Number((m as any).cx ?? (m as any).x); // Fix server key mismatch
      const z = Number((m as any).cz ?? (m as any).z);
      const r = Number((m as any).radius ?? (m as any).r);
      const name = typeof (m as any).name === "string" ? (m as any).name : undefined;
      
      if (!isFiniteNum(x) || !isFiniteNum(z) || !isFiniteNum(r)) return;
      
      safeZone = { x, z, r, name };
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
  } else if (attackId === "NATURE_GRASP") {
    mesh = BABYLON.MeshBuilder.CreateTorusKnot(`natureVFX_${uid}`, { radius: 1.5, tube: 0.2, radialSegments: 64, tubularSegments: 8, p: 2, q: 3 }, scene);
    mat.emissiveColor = new BABYLON.Color3(0.2, 1.0, 0.2); 
    maxLife = 0.9;
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

// 13.1 Zone Logic Hook
function updateZoneCheck() {
    if (!noa || !noa.playerEntity) return;
    const p = noa.ents.getPosition(noa.playerEntity);
    if (!p) return;

    const x = p[0];
    const y = p[1];
    const z = p[2];

    let newState = "wild";
    let title = "The Wilderness";
    let sub = "Danger Zone - PvP Enabled";
    let color = "#ff4444";

    // 1. Check Safe Zone
    if (isInSafeZoneXZ(x, z)) {
        newState = "safe";
        title = safeZone?.name || "Town of Beginnings";
        sub = "Safe Zone - Combat Disabled";
        color = "#44ff44";
    }
    // 2. Check Deep Caves (Y < 10)
    else if (y < 10) {
        newState = "cave";
        title = "Deep Caverns";
        sub = "Darkness Encroaches";
        color = "#b026ff"; // Purple/Red
    }

    if (newState !== currentZoneState) {
        currentZoneState = newState;
        showZoneNotification(title, sub, color);
    }
}

// 13.2 Day/Night Cycle + Skybox Logic
let skyRoot: BABYLON.TransformNode | null = null;
let sunMesh: BABYLON.Mesh | null = null;
let moonMesh: BABYLON.Mesh | null = null;
let skyMaterial: BABYLON.StandardMaterial | null = null;

function ensureSkybox(scene: BABYLON.Scene) {
  if (skyRoot) return;

  // Root node follows camera
  skyRoot = new BABYLON.TransformNode("skyRoot", scene);
  
  // Sky Material (unlit)
  skyMaterial = new BABYLON.StandardMaterial("skyMat", scene);
  skyMaterial.disableLighting = true;
  skyMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  skyMaterial.backFaceCulling = false;

  // SUN: Yellow Sphere with Halo
  sunMesh = BABYLON.MeshBuilder.CreateSphere("sun", { diameter: 40 }, scene);
  const sunMat = new BABYLON.StandardMaterial("sunMat", scene);
  sunMat.emissiveColor = new BABYLON.Color3(1, 0.9, 0.5);
  sunMat.disableLighting = true;
  (sunMat as any).fogEnabled = false; // Important: Make sun visible through atmosphere
  sunMesh.material = sunMat;
  sunMesh.parent = skyRoot;
  sunMesh.position.set(0, 0, 600); 

  // MOON: White Sphere with Detail
  moonMesh = BABYLON.MeshBuilder.CreateSphere("moon", { diameter: 25 }, scene);
  const moonMat = new BABYLON.StandardMaterial("moonMat", scene);
  moonMat.emissiveColor = new BABYLON.Color3(0.9, 0.9, 1);
  moonMat.disableLighting = true;
  (moonMat as any).fogEnabled = false; // Important
  
  // Add noise for moon craters
  const noiseTex = new BABYLON.NoiseProceduralTexture("moonNoise", 256, scene);
  noiseTex.octaves = 4;
  noiseTex.persistence = 0.8;
  moonMat.diffuseTexture = noiseTex;
  
  moonMesh.material = moonMat;
  moonMesh.parent = skyRoot;
  moonMesh.position.set(0, 0, -600);

  // STARS: Points Cloud
  const starCount = 800;
  const starData = new Float32Array(starCount * 3);
  for (let i=0; i<starCount; i++) {
     const theta = Math.random() * Math.PI * 2;
     const phi = Math.acos(2 * Math.random() - 1);
     const r = 550 + Math.random() * 50;
     starData[i*3] = r * Math.sin(phi) * Math.cos(theta);
     starData[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
     starData[i*3+2] = r * Math.cos(phi);
  }
  const stars = new BABYLON.Mesh("stars", scene);
  const vertexData = new BABYLON.VertexData();
  vertexData.positions = starData;
  vertexData.applyToMesh(stars, true);
  
  const starMat = new BABYLON.StandardMaterial("starMat", scene);
  starMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  starMat.pointsCloud = true;
  starMat.pointSize = 2;
  (starMat as any).fogEnabled = false; // Important
  stars.material = starMat;
  stars.parent = skyRoot;

  // CLOUDS: Floating low-poly spheres
  for (let i=0; i<15; i++) {
     const c = BABYLON.MeshBuilder.CreateSphere("cloud"+i, { diameter: 30 + Math.random()*40, segments: 4 }, scene);
     const cMat = new BABYLON.StandardMaterial("cloudMat", scene);
     cMat.emissiveColor = new BABYLON.Color3(0.95, 0.95, 0.95);
     cMat.alpha = 0.3;
     cMat.disableLighting = true;
     (cMat as any).fogEnabled = false; 
     c.material = cMat;
     c.parent = skyRoot;
     
     // Random pos in upper hemisphere
     const theta = Math.random() * Math.PI * 2;
     const phi = Math.random() * Math.PI * 0.35; // 0 to ~60 deg
     const r = 450;
     c.position.set(
       r * Math.sin(phi) * Math.cos(theta),
       Math.abs(r * Math.cos(phi)), // Always above
       r * Math.sin(phi) * Math.sin(theta)
     );
     c.scaling.y = 0.3; // flatten
     (c as any).rotationSpeed = (Math.random() - 0.5) * 0.001;
  }
}

function updateDayNightCycle(dt: number) {
    // Client prediction
    clientWorldTime = (clientWorldTime + (dt / 1200)) % 1; 

    const scene = getStableScene();
    if (!scene) return;

    ensureSkybox(scene);

    if (skyRoot) {
       // Lock sky to player position (infinite horizon effect)
       const p = noa.ents.getPosition(noa.playerEntity);
       if (p) {
          skyRoot.position.set(p[0], p[1], p[2]);
       }

       // Rotate Celestial Bodies based on time (0..1)
       // Time 0 = Midnight (Sun -Z, Moon +Z)
       // Time 0.25 = Dawn (Sun +X, Moon -X)
       // Time 0.5 = Noon (Sun +Y, Moon -Y)
       const angle = (clientWorldTime - 0.25) * Math.PI * 2; 
       
       if (sunMesh) {
           sunMesh.position.set(Math.cos(angle) * 600, Math.sin(angle) * 600, 0);
           sunMesh.lookAt(skyRoot.position); // Always face center
       }
       if (moonMesh) {
           moonMesh.position.set(-Math.cos(angle) * 600, -Math.sin(angle) * 600, 0);
           moonMesh.lookAt(skyRoot.position);
       }
       
       // Clouds slow drift
       if (skyRoot.getChildren) {
           for(const child of skyRoot.getChildren()) {
               if (child.name.startsWith("cloud")) {
                   // Fix rotation error by casting to Mesh
                   (child as BABYLON.Mesh).rotation.y += dt * 0.02;
               }
           }
       }
    }

    // Gradient Phases for Sky Color
    let r=0, g=0, b=0;
    
    // Simple 4-point gradient interpolation
    if (clientWorldTime < 0.2) { // Night -> Dawn
        r = 0.05; g = 0.05; b = 0.15;
    } else if (clientWorldTime < 0.3) { // Dawn
        r = 0.8; g = 0.5; b = 0.4;
    } else if (clientWorldTime < 0.7) { // Day
        r = 0.5; g = 0.7; b = 1.0;
    } else if (clientWorldTime < 0.8) { // Dusk
        r = 0.7; g = 0.4; b = 0.6;
    } else { // Night
        r = 0.05; g = 0.05; b = 0.15;
    }

    scene.clearColor = new BABYLON.Color4(r, g, b, 1);
    scene.ambientColor = new BABYLON.Color3(r, g, b);
    if (scene.fogColor) {
        scene.fogColor = new BABYLON.Color3(r*0.8, g*0.8, b*0.9);
    }
}

(noa as any).on("tick", () => {
  tickCount++;

  const now = performance.now();
  const dtSec = Math.min(0.05, (now - lastTickMs) / 1000);
  lastTickMs = now;

  if (classOverlay.style.display !== "none") {
    const body = noa.ents.getPhysicsBody(noa.playerEntity);
    if (body) {
      body.velocity[0] = 0;
      body.velocity[1] = 0; 
      body.velocity[2] = 0;
    }
  }

  const scene = getStableScene();
  if (scene) {
    ensureMaterialManager(scene);

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
    } else if (vfx.type === "NATURE_GRASP") {
      vfx.mesh.rotation.y += dtSec * 10;
      vfx.mesh.scaling.x += dtSec * 4;
      vfx.mesh.scaling.y += dtSec * 4;
      vfx.mesh.scaling.z += dtSec * 4;
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
  updateRemoteMeshes(dtSec);
  updateDropVisuals(dtSec);
  tryAutoPickup();
  updateDayNightCycle(dtSec); // 13.2 Call cycle
  
  if (tickCount % 20 === 0) updateZoneCheck();

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