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
import { RemoteEntityRenderer, type NetTransform } from "./RemoteEntityRenderer";

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
  if (id === 0) continue; 

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
   5.1 Item Registry (2D Flat Sprites)
================================ */
function getItemTextureUrl(id: number): string | null {
  const map: Record<number, string> = {
    [Items.STICK]: "stick.png",
    [Items.WOOD_PICK]: "wood_pickaxe.png",
    [Items.STONE_PICK]: "stone_pickaxe.png",
    [Items.IRON_PICK]: "iron_pickaxe.png",
    [Items.DIAMOND_PICK]: "diamond_pickaxe.png",
    [Items.WOOD_SWORD]: "wood_sword.png",
    [Items.STONE_SWORD]: "stone_sword.png",
    [Items.IRON_SWORD]: "iron_sword.png",
    [Items.DIAMOND_SWORD]: "diamond_sword.png",
    [Items.WOOD_AXE]: "wood_axe.png",
    [Items.STONE_AXE]: "stone_axe.png",
    [Items.IRON_AXE]: "iron_axe.png",
    [Items.DIAMOND_AXE]: "diamond_axe.png",
    [Items.COAL]: "coal.png",
    [Items.RAW_IRON]: "raw_iron.png",
    [Items.RAW_GOLD]: "raw_gold.png",
    [Items.DIAMOND]: "diamond.png",
    [Items.STONE_IRON]: "iron_ingot.png", 
    [Items.STONE_SHADOW]: "coal.png",
    [Items.STONE_BLOOD]: "redstone_dust.png",
    [Items.STONE_ASTRAL]: "amethyst_shard.png"
  };
  return map[id] ? `/items/${map[id]}` : null;
}

/* ===============================
   5.2 Debug Tools: ID Registry Validation
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

const remoteRenderer = new RemoteEntityRenderer();

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
    <div><u>XYZ:</u> ${x} / ${y} / ${z}</div>
    <div style="opacity:.85"><u>Chunk:</u> ${cx}, ${cz}</div>
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

// Global UI timers for the overlay
let nextEventAt = 0;
let currentEventTimer = 0;

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

  const now = Date.now();
  let eventLine = "";
  if (currentEventTimer > now) {
      const s = Math.ceil((currentEventTimer - now) / 1000);
      eventLine = `<span style="color: #ff4444; font-weight: bold; text-shadow: 1px 1px 2px #000;">EVENT ENDS IN: ${s}s</span><br>`;
  } else if (nextEventAt > now) {
      const diff = Math.floor((nextEventAt - now) / 1000);
      const m = Math.floor(diff / 60);
      const s = (diff % 60).toString().padStart(2, "0");
      eventLine = `<span style="color: #ffff00; font-weight: bold; text-shadow: 1px 1px 2px #000;">Next Event In: ${m}:${s}</span><br>`;
  } else if (nextEventAt > 0) {
      eventLine = `<span style="color: #00ff00; font-weight: bold; text-shadow: 1px 1px 2px #000;">Event Starting...</span><br>`;
  }

  overlay.innerHTML = `
    <u>Status:</u> ${status}<br>
    ${eventLine}
    <u>Holding:</u> [${selectedHotbar + 1}] ${heldName}<br>
    <u>Inventory:</u> ${invOpen ? "OPEN" : "CLOSED"}<br>
    <u>Viewmodel:</u> ${viewModelEnabled ? "ON" : "OFF"}<br>
    <u>Remote Players:</u> ${remoteRenderer.enabled ? "ON" : "OFF"} |
    <u>Xray:</u> ${remoteRenderer.xrayEnabled ? "ON" : "OFF"}<br>
    <u>VM Debug:</u> ${vmDebug ? "ON" : "OFF"} |
    <u>VM Tune:</u> ${vmTuning ? "ON" : "OFF"} |
    <u>Mirror:</u> ${vmMirrorX ? "ON" : "OFF"}<br>
    <u>${mineLine}</u><br>
    <span style="opacity:.9">${psLine}</span><br>
    <u>DEBUG_PARTICLES_ALWAYS:</u> ${DEBUG_PARTICLES_ALWAYS ? "ON" : "OFF"}<br>
    <u>${safeLine}</u><br>
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
    remoteRenderer.enabled = !remoteRenderer.enabled;
    updateOverlay(remoteRenderer.enabled ? "Remote Players: ON" : "Remote Players: OFF");
    return;
  }

  if (e.key === "o" || e.key === "O") {
    remoteRenderer.xrayEnabled = !remoteRenderer.xrayEnabled;
    updateOverlay(remoteRenderer.xrayEnabled ? "Remote Xray: ON" : "Remote Xray: OFF");
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
    const view = msgVoxels as ArrayBufferView;
    if (view.byteLength === expectedLen * 2) {
      const aligned = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      const u16 = new Uint16Array(aligned);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u16[i] | 0;
      }
      return out;
    }
    if (view.byteLength === expectedLen) {
      const aligned = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      const u8 = new Uint8Array(aligned);
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = u8[i] | 0;
      }
      return out;
    }
    if (typeof (view as any).length === "number" && (view as any).length === expectedLen) {
      const out = new Array<number>(expectedLen);
      for (let i = 0; i < expectedLen; i++) {
        out[i] = (view as any)[i] | 0;
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
      return; 
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
const dropItemMats = new Map<number, BABYLON.StandardMaterial>();

function getDropItemMaterial(scene: BABYLON.Scene, id: number): BABYLON.StandardMaterial {
  if (dropItemMats.has(id)) return dropItemMats.get(id)!;
  
  const mat = new BABYLON.StandardMaterial(`dropItemMat_${id}`, scene);
  const texUrl = getItemTextureUrl(id);
  
  if (texUrl) {
    mat.diffuseTexture = new BABYLON.Texture(texUrl, scene, true, true, BABYLON.Texture.NEAREST_SAMPLINGMODE);
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
  } else {
    mat.emissiveColor = new BABYLON.Color3(1, 0, 1);
  }
  
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.emissiveColor = BABYLON.Color3.White();
  
  dropItemMats.set(id, mat);
  return mat;
}

function disposeAllDropMeshes() {
  for (const m of dropMeshes.values()) {
    try { m.dispose(); } catch {}
  }
  dropMeshes.clear();
  dropItemMats.forEach(m => {
    try { m.dispose(); } catch {}
  });
  dropItemMats.clear();
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

    const itemUrl = getItemTextureUrl(d.itemId);
    let mesh: BABYLON.Mesh;

    if (itemUrl) {
      mesh = BABYLON.MeshBuilder.CreatePlane(`drop:${d.dropId}`, { size: 0.4 }, scene);
      mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      mesh.material = getDropItemMaterial(scene, d.itemId);
      (mesh as any).__isItem = true;
    } else {
      mesh = BABYLON.MeshBuilder.CreateBox(`drop:${d.dropId}`, { size: 0.32 }, scene);
      if (matManager) {
        const matInfo = matManager.getMaterialForBlock(d.itemId);
        if (Array.isArray(matInfo)) {
            mesh.material = matInfo[0]; 
        } else if (matInfo) {
            mesh.material = matInfo;
        }
      }
      mesh.rotation.x = 0.25;
      mesh.rotation.y = Math.random() * Math.PI * 2;
      (mesh as any).__isItem = false;
    }

    mesh.isPickable = false;
    (mesh as any).isInFrustum = () => true;
    mesh.position.set(d.x, d.y, d.z);
    dropMeshes.set(d.dropId, mesh);
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
    
    if (!(m as any).__isItem) {
        m.rotation.y += dtSec * 1.1;
    }
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

  vmItemMesh = new BABYLON.TransformNode("vmItemMesh", vmScene);
  vmItemMesh.parent = vmArmRoot;

  const itemUrl = getItemTextureUrl(heldId);

  if (itemUrl) {
    vmItemMesh.position.set(0.45, -0.45, 0.85);
    
    vmItemMesh.rotation.x = 0;
    vmItemMesh.rotation.y = Math.PI + (Math.PI / 8); 
    vmItemMesh.rotation.z = -Math.PI / 6;
    
    vmItemMesh.scaling.set(2.0, 2.0, 2.0);

    const plane = BABYLON.MeshBuilder.CreatePlane(`vmPlane_${heldId}`, { size: 0.6 }, vmScene);
    const mat = new BABYLON.StandardMaterial(`vmItemMat_${heldId}`, vmScene);
    mat.diffuseTexture = new BABYLON.Texture(itemUrl, vmScene, true, true, BABYLON.Texture.NEAREST_SAMPLINGMODE);
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    mat.emissiveColor = BABYLON.Color3.White();
    mat.disableLighting = true;
    mat.disableDepthWrite = true;
    mat.depthFunction = BABYLON.Constants.ALWAYS;
    
    plane.material = mat;
    plane.parent = vmItemMesh;

  } else {
    vmItemMesh.rotation.x = Math.PI / 8;
    vmItemMesh.rotation.y = Math.PI / 4;
    vmItemMesh.rotation.z = 0;
    vmItemMesh.scaling.set(2.5, 2.5, 2.5);

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
let clientWorldTime = 0.26; 

async function connectToHub() {
  try {
    updateOverlay();

    const userId = ensureUserId();
    const savedClass = localStorage.getItem("noa_player_class");
    
    if (!savedClass) {
      classOverlay.style.display = "flex";
    }

    const token = sessionStorage.getItem("reconnectionToken");
    if (token) {
        try {
            room = await colyseus.reconnect(token);
            console.log("[Client] Successfully reconnected to previous room!");
        } catch (e) {
            console.log("[Client] Reconnection failed, joining Hub normally...");
            sessionStorage.removeItem("reconnectionToken");
            room = await colyseus.joinOrCreate("my_room", { userId });
        }
    } else {
        room = await colyseus.joinOrCreate("my_room", { userId });
    }

    (globalThis as any).room = room;
    
    if (room) {
        sessionStorage.setItem("reconnectionToken", room.reconnectionToken);
    }

    if (savedClass && room) {
      room.send("selectClass", { classId: savedClass });
    }

    for (const req of queuedRequests.values()) {
      room.send("worldDataNeeded", req);
    }

    bindRoomHandlers(room!);
    updateOverlay();

  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed!</span>";
  }
}

// Binds all dynamic hooks to the currently active room
function bindRoomHandlers(r: Room) {
    r.onMessage("chunkData", (msg: any) => applyChunkFromServer(msg));

    r.onMessage("worldTime", (msg: any) => {
        if (Number.isFinite(msg.time)) {
             clientWorldTime = msg.time; 
        }
    });

    r.onMessage("worldMeta", (msg: any) => {
        if (Number.isFinite(msg.worldTime)) {
            clientWorldTime = msg.worldTime;
        }
    });

    r.onMessage("safeZone", (m: any) => {
      if (!m || typeof m !== "object") return;
      const x = Number((m as any).cx ?? (m as any).x); 
      const z = Number((m as any).cz ?? (m as any).z);
      const rad = Number((m as any).radius ?? (m as any).r);
      const name = typeof (m as any).name === "string" ? (m as any).name : undefined;
      
      if (!isFiniteNum(x) || !isFiniteNum(z) || !isFiniteNum(rad)) return;
      
      safeZone = { x, z, r: rad, name };
      updateOverlay("Safe Zone received");
    });

    r.onMessage("statsUpdate", (msg: any) => {
      myHp = Number(msg.hp ?? myHp);
      myMaxHp = Number(msg.maxHp ?? myMaxHp);
      myMana = Number(msg.mana ?? myMana);
      myMaxMana = Number(msg.maxMana ?? myMaxMana);
      updateOverlay();
    });

    r.onMessage("useManaResult", (msg: any) => {
      if (!msg.ok) return;
    });

    r.onMessage("playerHit", (msg: any) => {
      const targetId = msg.targetId;
      const attackerId = msg.attackerId;
      
      remoteSwings.set(attackerId, performance.now());

      if (targetId === r.sessionId) {
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

    r.onMessage("playerSwing", (msg: any) => {
      let x = 0;
      let y = 0;
      let z = 0;
      let yaw = 0;

      if (msg.id === r.sessionId) {
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
        remoteRenderer.spawnSkillVFX(msg.attackId, x, y, z, yaw);
      }
    });

    r.onMessage("attackResult", (msg: any) => {
      if (!msg.ok) {
        // Silent fail for normal gameplay
      }
    });

    r.onMessage("playerRespawn", (msg: any) => {
      if (msg.id === r.sessionId) {
        myHp = msg.hp;
        myMaxHp = msg.maxHp ?? myMaxHp;
        myMana = msg.mana ?? myMana;
        myMaxMana = msg.maxMana ?? myMaxMana;
        try {
          noa.ents.setPosition(noa.playerEntity, [msg.x, msg.y, msg.z]);
        } catch {}
      }
    });

    r.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
        if (miningProgress && msg.x === miningProgress.x && msg.y === miningProgress.y && msg.z === miningProgress.z) {
          miningProgress = null;
        }
      }
    });

    r.onMessage("mineProgress", (m: any) => {
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

    r.onMessage("mineCancelled", (_m: any) => {
      miningProgress = null;
      miningHeld = false;
      miningActive = false;
      miningTarget = null;
      lastMineSentKey = "";
      lastMineSendAt = 0;
    });

    r.onMessage("invState", (msg: any) => {
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

    r.onMessage("chatMessage", (msg: any) => {
      if (msg && typeof msg.msg === "string") {
        updateOverlay(`<span style="color: #00FFFF; text-shadow: 0 0 5px #00FFFF;">*** ${msg.msg} ***</span>`);
      }
    });

    r.onMessage("dropSpawn", (d: any) => {
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

    r.onMessage("dropDespawn", (m: any) => {
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

    r.onMessage("craftResult", (m: any) => {
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

    r.onMessage("existingPlayers", (players: any) => {
      if (!Array.isArray(players)) return;
      for (const p of players ?? []) {
        const id = normId(p);
        if (!id || (r && id === r.sessionId)) continue;

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

    r.onMessage("playerJoined", (p: any) => {
      const id = normId(p);
      if (!id || (r && id === r.sessionId)) return;

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

    r.onMessage("playerLeft", (p: any) => {
      const id = normId(p);
      if (!id) return;
      netTransforms.delete(id);
      remoteRenderer.removeRemoteMesh(id);
      lastTransformAt = performance.now();
    });

    r.onMessage("playerTransformOther", (p: any) => {
      const id = normId(p);
      if (!id || (r && id === r.sessionId)) return;

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

    r.onMessage("playersSnapshot", (players: any) => {
      if (!Array.isArray(players)) return;
      const ids: string[] = [];
      for (const p of players) {
        const id = normId(p);
        if (!id || (r && id === r.sessionId)) continue;

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

    r.onMessage("youJoined", (p: any) => {
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

    // --- EVENT SCHEDULER SYNC HOOKS ---
    r.onMessage("nextEventTime", (msg: any) => {
        nextEventAt = Number(msg.time) || 0;
        updateOverlay();
    });

    r.onMessage("syncEventTimer", (msg: any) => {
        currentEventTimer = Date.now() + msg.remainingMs;
        nextEventAt = 0; 
        updateOverlay();
    });

    r.onMessage("eventStart", (msg: any) => {
        if (msg.timer) {
             currentEventTimer = Date.now() + msg.timer;
        }
        nextEventAt = 0; 
        updateOverlay(`<span style="color: #00FFFF; text-shadow: 0 0 5px #00FFFF;">*** EVENT STARTED: ${msg.rules} ***</span>`);
    });

    r.onMessage("eventEnd", (msg: any) => {
        currentEventTimer = 0;
        updateOverlay(`<span style="color: #00FFFF; text-shadow: 0 0 5px #00FFFF;">*** EVENT OVER: ${msg.reason} ***</span>`);
    });

    r.onMessage("joinEvent", async (reservation: any) => {
        console.log("[Client] Consuming seat reservation for event:", reservation);
        try {
            updateOverlay(`<span style="color: #ffff00;">Teleporting to Arena...</span>`);
            if (room) {
                console.log("[Client] Leaving old room...");
                room.removeAllListeners();
                await room.leave();
            }
            
            pendingChunks.clear();
            queuedRequests.clear();
            netTransforms.clear();
            drops.clear();
            dropMeshes.forEach(m => { try { m.dispose(); } catch{} });
            dropMeshes.clear();
            
            if (typeof (noa as any).world?.invalidateAllChunks === "function") {
                (noa as any).world.invalidateAllChunks();
            }

            console.log("[Client] Connecting to new room...");
            room = await colyseus.consumeSeatReservation(reservation);
            (globalThis as any).room = room;
            
            if (room) {
                sessionStorage.setItem("reconnectionToken", room.reconnectionToken);
            }
            
            bindRoomHandlers(room);
            updateOverlay(`<span style="color: #00ff00;">Joined Event Arena!</span>`);
            console.log("[Client] Successfully joined Event Room!");
        } catch (e) {
            console.error("[Client] Failed to join event", e);
            updateOverlay(`<span style="color: #ff0000;">Failed to join event!</span>`);
        }
    });

    r.onMessage("returnToHub", async () => {
        console.log("[Client] Event over. Returning to Hub...");
        try {
            updateOverlay(`<span style="color: #ffff00;">Returning to Hub...</span>`);
            if (room) {
                console.log("[Client] Leaving event room...");
                room.removeAllListeners();
                await room.leave();
            }
            
            pendingChunks.clear();
            queuedRequests.clear();
            netTransforms.clear();
            drops.clear();
            dropMeshes.forEach(m => { try { m.dispose(); } catch{} });
            dropMeshes.clear();
            currentEventTimer = 0;

            if (typeof (noa as any).world?.invalidateAllChunks === "function") {
                (noa as any).world.invalidateAllChunks();
            }
            
            console.log("[Client] Reconnecting to Hub...");
            const userId = ensureUserId();
            room = await colyseus.joinOrCreate("my_room", { userId });
            (globalThis as any).room = room;
            
            if (room) {
                sessionStorage.setItem("reconnectionToken", room.reconnectionToken);
            }
            
            const savedClass = localStorage.getItem("noa_player_class");
            if (savedClass) room!.send("selectClass", { classId: savedClass });
            
            bindRoomHandlers(room!);
            updateOverlay(`<span style="color: #00ff00;">Returned to Hub.</span>`);
            console.log("[Client] Successfully returned to Hub!");
        } catch(e) {
            console.error("[Client] Failed to return to hub", e);
            updateOverlay(`<span style="color: #ff0000;">Failed to return to Hub!</span>`);
        }
    });
}

initUI();
connectToHub();

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
        color = "#b026ff"; 
    }

    if (newState !== currentZoneState) {
        currentZoneState = newState;
        showZoneNotification(title, sub, color);
    }
}

// 13.2 Day/Night Cycle + Skybox Logic
let skyReady = false;
let skyScene: BABYLON.Scene | null = null;
let skyCam: BABYLON.FreeCamera | null = null;
let skyRoot: BABYLON.TransformNode | null = null;
let skySceneUid: string | number | null = null;
let sunMesh: BABYLON.Mesh | null = null;
let moonMesh: BABYLON.Mesh | null = null;
let starsMesh: BABYLON.Mesh | null = null;
let skyMaterial: BABYLON.StandardMaterial | null = null;
let skyEngineHooked = false;

function ensureSkyScene(noaScene: BABYLON.Scene) {
  const uid = (noaScene as any).uid as string | number | undefined;

  if (skyReady && skyScene && skyCam && skySceneUid === (uid ?? null)) return;
  
  if (skyRoot) {
      skyRoot.dispose();
      skyRoot = null;
      sunMesh = null;
      moonMesh = null;
      starsMesh = null;
  }
  skySceneUid = uid ?? null;

  const engine = noaScene.getEngine();
  
  skyScene = new BABYLON.Scene(engine);
  skyScene.autoClear = true; 
  
  skyCam = new BABYLON.FreeCamera("skyCam", BABYLON.Vector3.Zero(), skyScene);
  skyCam.maxZ = 2500;
  skyScene.activeCamera = skyCam;

  skyRoot = new BABYLON.TransformNode("skyRoot", skyScene);

  const createSkyMesh = (name: string, m: BABYLON.Mesh) => {
      m.name = name;
      m.parent = skyRoot;
      m.alwaysSelectAsActiveMesh = true;
      m.isPickable = false;
      return m;
  };

  skyMaterial = new BABYLON.StandardMaterial("skyMat", skyScene);
  skyMaterial.disableLighting = true;
  skyMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  skyMaterial.backFaceCulling = false;

  sunMesh = BABYLON.MeshBuilder.CreateSphere("sun", { diameter: 45, segments: 16 }, skyScene);
  createSkyMesh("sun", sunMesh);
  
  const sunMat = new BABYLON.StandardMaterial("sunMat", skyScene);
  sunMat.emissiveColor = new BABYLON.Color3(1, 0.9, 0.5);
  sunMat.disableLighting = true;
  (sunMat as any).fogEnabled = false;
  sunMesh.material = sunMat;

  moonMesh = BABYLON.MeshBuilder.CreateSphere("moon", { diameter: 30, segments: 16 }, skyScene);
  createSkyMesh("moon", moonMesh);
  
  const moonMat = new BABYLON.StandardMaterial("moonMat", skyScene);
  moonMat.emissiveColor = new BABYLON.Color3(0.9, 0.9, 1);
  moonMat.disableLighting = true;
  (moonMat as any).fogEnabled = false;
  
  const noiseTex = new BABYLON.NoiseProceduralTexture("moonNoise", 256, skyScene);
  noiseTex.octaves = 4;
  noiseTex.persistence = 0.8;
  moonMat.diffuseTexture = noiseTex;
  moonMesh.material = moonMat;

  // Explicit geometry for stars to guarantee WebGL rendering
  const starCount = 800;
  const positions: number[] = [];
  const indices: number[] = [];
  let idx = 0;
  for (let i = 0; i < starCount; i++) {
     const theta = Math.random() * Math.PI * 2;
     const phi = Math.acos(2 * Math.random() - 1);
     const r = 90 + Math.random() * 5;

     const x = r * Math.sin(phi) * Math.cos(theta);
     const y = r * Math.cos(phi);
     const z = r * Math.sin(phi) * Math.sin(theta);

     const s = 0.12; 
     positions.push(
         x, y + s, z,
         x - s, y - s, z,
         x + s, y - s, z
     );
     indices.push(idx, idx+1, idx+2);
     idx += 3;
  }

  starsMesh = new BABYLON.Mesh("stars", skyScene);
  createSkyMesh("stars", starsMesh);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.applyToMesh(starsMesh);

  const starMat = new BABYLON.StandardMaterial("starMat", skyScene);
  starMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  starMat.disableLighting = true;
  starMat.alpha = 1.0;
  starMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  (starMat as any).fogEnabled = false;
  starsMesh.material = starMat;

  for (let i=0; i<15; i++) {
     const c = BABYLON.MeshBuilder.CreateSphere("cloud"+i, { diameter: 15 + Math.random()*10, segments: 4 }, skyScene);
     createSkyMesh("cloud"+i, c);
     
     const cMat = new BABYLON.StandardMaterial("cloudMat", skyScene);
     cMat.emissiveColor = new BABYLON.Color3(0.95, 0.95, 0.95);
     cMat.alpha = 0.4;
     cMat.disableLighting = true;
     (cMat as any).fogEnabled = false; 
     c.material = cMat;
     
     const theta = Math.random() * Math.PI * 2;
     const phi = Math.random() * Math.PI * 0.35; 
     const r = 80;
     c.position.set(
       r * Math.sin(phi) * Math.cos(theta),
       Math.abs(r * Math.cos(phi)), 
       r * Math.sin(phi) * Math.sin(theta)
     );
     c.scaling.y = 0.3; 
     (c as any).rotationSpeed = (Math.random() - 0.5) * 0.001;
  }

  if (!skyEngineHooked) {
    skyEngineHooked = true;
    
    (noa as any).on("beforeRender", () => {
        const noaCam = getStableScene()?.activeCamera;
        if (noaCam && skyCam && skyScene) {
            skyCam.position.set(0, 0, 0);
            
            const lookDir = noaCam.getForwardRay().direction;
            skyCam.setTarget(lookDir);

            skyScene.render();
        }
    });
  }

  skyReady = true;
}

function updateDayNightCycle(dt: number) {
    clientWorldTime = (clientWorldTime + (dt / 1200)) % 1; 

    const scene = getStableScene();
    if (!scene) return;

    if (scene.activeCamera && scene.activeCamera.maxZ < 1000) {
        scene.activeCamera.maxZ = 1000;
    }

    ensureSkyScene(scene);

    if (scene.autoClear) {
        scene.autoClear = false; 
        scene.autoClearDepthAndStencil = true;
    }

    if (skyRoot && skyScene && skyCam) {
       const cam = scene.activeCamera;
       if (cam) {
          const mask = cam.layerMask;
          for (const child of skyRoot.getChildMeshes()) {
            child.layerMask = mask;
          }
       } 

       const p = noa.ents.getPosition(noa.playerEntity);
       if (p) skyRoot.position.set(p[0], p[1], p[2]);

       const angle = (clientWorldTime - 0.25) * Math.PI * 2; 
       
       if (sunMesh) {
           sunMesh.position.set(0, Math.sin(angle) * 100, Math.cos(angle) * 100);
       }
       if (moonMesh) {
           moonMesh.position.set(0, -Math.sin(angle) * 100, -Math.cos(angle) * 100);
       }
       
       for(const child of skyRoot.getChildren()) {
           if (child.name.startsWith("cloud")) {
               (child as BABYLON.Mesh).rotation.y += dt * 0.02;
           }
       }

       let r=0, g=0, b=0;
       let starAlpha = 1.0;
       
       if (clientWorldTime < 0.2) { 
           r = 0.05; g = 0.05; b = 0.15;
           starAlpha = 1.0;
       } else if (clientWorldTime < 0.3) { 
           r = 0.8; g = 0.5; b = 0.4;
           starAlpha = 1.0 - ((clientWorldTime - 0.2) / 0.1);
       } else if (clientWorldTime < 0.7) { 
           r = 0.5; g = 0.7; b = 1.0;
           starAlpha = 0.0;
       } else if (clientWorldTime < 0.8) { 
           r = 0.7; g = 0.4; b = 0.6;
           starAlpha = (clientWorldTime - 0.7) / 0.1;
       } else { 
           r = 0.05; g = 0.05; b = 0.15;
           starAlpha = 1.0;
       }

       if (starsMesh && starsMesh.material) {
           (starsMesh.material as BABYLON.StandardMaterial).alpha = Math.max(0, Math.min(1, starAlpha));
       }

       skyScene.clearColor = new BABYLON.Color4(r, g, b, 1);
       skyScene.ambientColor = new BABYLON.Color3(r, g, b);
       scene.ambientColor = new BABYLON.Color3(r, g, b);
       if (scene.fogColor) {
           scene.fogColor = new BABYLON.Color3(r*0.8, g*0.8, b*0.9);
       }
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
    
    remoteRenderer.ensureScene(scene);
    remoteRenderer.syncCamera(scene, noa.ents.getPosition(noa.playerEntity) as number[] | null, remoteRenderer.xrayEnabled);

    ensureDropVisuals(scene);

    updateSafeZoneVisual(scene);
    updateTownHallLabel(scene);

    updateCrackVisual(scene);
    updateMiningParticles(scene);
  }

  remoteRenderer.updateVFX(dtSec);
  remoteRenderer.update(dtSec, netTransforms, room?.sessionId, matManager, remoteFlashes, remoteSwings);

  updateViewmodel(dtSec);
  updateDropVisuals(dtSec);
  tryAutoPickup();
  updateDayNightCycle(dtSec); 
  
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