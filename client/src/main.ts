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
   6. Hotbar System
================================ */
const hotbar = [
  { id: GRASS_ID, name: "Grass" },
  { id: DIRT_ID, name: "Dirt" },
  { id: STONE_ID, name: "Stone" },
  { id: WOOD_ID, name: "Wood" },
  { id: LEAVES_ID, name: "Leaves" },
];

let selectedSlot = 0;
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
   6.3 Overlay
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

function updateOverlay(extraLine = "") {
  const status = room ? `Online (${room.sessionId})` : "Connecting...";
  const currentBlock = hotbar[selectedSlot];

  const snapAge = lastSnapshotAt ? `${((performance.now() - lastSnapshotAt) / 1000).toFixed(1)}s` : "n/a";
  const xformAge = lastTransformAt ? `${((performance.now() - lastTransformAt) / 1000).toFixed(1)}s` : "n/a";
  const snapPreview = lastSnapshotIds.slice(0, 6).join(", ");

  const closest = getClosestRemoteDistance();
  const closestStr = closest == null ? "n/a" : `${closest.toFixed(2)}m`;

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedSlot + 1}] ${currentBlock.name}<br>
    <strong>Viewmodel:</strong> ${viewModelEnabled ? "ON" : "OFF"}<br>
    <strong>Remote Players:</strong> ${remotePlayersEnabled ? "ON" : "OFF"} |
    <strong>Xray:</strong> ${remoteXray ? "ON" : "OFF"}<br>
    <strong>VM Debug:</strong> ${vmDebug ? "ON" : "OFF"} |
    <strong>VM Tune:</strong> ${vmTuning ? "ON" : "OFF"} |
    <strong>Mirror:</strong> ${vmMirrorX ? "ON" : "OFF"}<br>
    -------------------------<br>
    [L-Click] Mine  |  [R-Click] Place<br>
    [1-5] Select Block<br>
    [WASD] Move  |  [Space] Jump<br>
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
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}
updateOverlay();

/* ===============================
   6.4 Key handling
================================ */
document.addEventListener("keydown", (e) => {
  // Hotbar 1-5
  const key = Number.parseInt(e.key, 10);
  if (Number.isFinite(key) && key >= 1 && key <= hotbar.length) {
    selectedSlot = key - 1;
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
      e.key === "7" || e.key === "8" || e.key === "9" || e.key === "0" || e.key === "-" || e.key === "=";

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
      `VM: xMul=${vmBaseXMul.toFixed(3)} y=${vmBaseY.toFixed(3)} | rot=(${vmRotX.toFixed(2)},${vmRotY.toFixed(
        2
      )},${vmRotZ.toFixed(2)}) | mirror=${vmMirrorX ? "ON" : "OFF"}`
    );
  },
  { capture: true }
);

/* ===============================
   7. World Streaming (Path B)
================================ */
type PendingChunk = { data: any; chunkSize: number; x: number; y: number; z: number };

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

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.pos;
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

  triggerPunch();

  const { x, y, z } = target.adj;
  const blockToPlace = hotbar[selectedSlot].id;

  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);

  if (x === px && z === pz && (y === py || y === py + 1)) return;

  noa.world.setBlockID(blockToPlace, x, y, z);
  room?.send("placeBlock", { x, y, z, id: blockToPlace });
});

/* ===============================
   9. Babylon scene access (NOA scene)
================================ */
function getNoaScene(): BABYLON.Scene | null {
  const r = (noa as any).rendering as any;
  if (!r) return null;
  const s =
    (typeof r.getScene === "function" ? r.getScene() : null) ??
    r._scene ??
    r.scene ??
    null;
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

  const upper = BABYLON.MeshBuilder.CreateBox("vmUpperArm", { width: 0.16, height: 0.44, depth: 0.16 }, vmScene);
  const fore = BABYLON.MeshBuilder.CreateBox("vmForeArm", { width: 0.16, height: 0.38, depth: 0.16 }, vmScene);
  const hand = BABYLON.MeshBuilder.CreateBox("vmHand", { width: 0.17, height: 0.18, depth: 0.17 }, vmScene);

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
    (typeof p1 === "number" && Number.isFinite(p1)
      ? p1
      : typeof p2 === "number" && Number.isFinite(p2)
        ? p2
        : typeof p3 === "number" && Number.isFinite(p3)
          ? p3
          : typeof p4 === "number" && Number.isFinite(p4)
            ? p4
            : 0);
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
   - TRUE 3D scene rendered after NOA
   - Camera is synced to NOA world camera each tick
   - Remote meshes live here so they cannot be culled/hidden by NOA pipeline
================================ */
let rpReady = false;
let rpScene: BABYLON.Scene | null = null;
let rpCam: BABYLON.FreeCamera | null = null;

const remoteMeshes = new Map<string, BABYLON.TransformNode>();
const remoteMats = new Map<string, BABYLON.StandardMaterial>();

function ensureRpScene(noaScene: BABYLON.Scene) {
  if (rpReady && rpScene && rpCam) return;

  const engine = noaScene.getEngine();

  rpScene = new BABYLON.Scene(engine);

  // DO NOT clear color (keep world).
  // Depth/stencil behavior:
  // - If xray ON: we clear depth and force ALWAYS so remotes draw on top.
  // - If xray OFF: we keep depth so remotes can be occluded by blocks (best-effort).
  rpScene.autoClear = false;
  rpScene.autoClearDepthAndStencil = false;

  rpCam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, 0), rpScene);
  rpCam.minZ = 0.05;
  rpCam.maxZ = 10000;

  // IMPORTANT: set rotationQuaternion so we can copy from world camera safely
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

  // Simple “player” made from boxes (body + head)
  const root = new BABYLON.TransformNode(`remoteRoot:${id}`, rpScene);

  const body = BABYLON.MeshBuilder.CreateBox(`remoteBody:${id}`, { width: 0.7, height: 1.2, depth: 0.35 }, rpScene);
  const head = BABYLON.MeshBuilder.CreateBox(`remoteHead:${id}`, { width: 0.55, height: 0.55, depth: 0.55 }, rpScene);

  body.parent = root;
  head.parent = root;

  body.position.set(0, 0.6, 0);
  head.position.set(0, 1.55, 0);

  const mat = makeRemoteMaterial(id, rpScene);
  remoteMats.set(id, mat);
  body.material = mat;
  head.material = mat;

  body.isPickable = false;
  head.isPickable = false;

  remoteMeshes.set(id, root);
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
}

function syncRpCameraFromWorld(worldScene: BABYLON.Scene) {
  if (!rpReady || !rpScene || !rpCam) return;

  const worldCam = worldScene.activeCamera;
  if (!worldCam) return;

  // Copy viewport & camera params
  rpCam.viewport = worldCam.viewport.clone();

  // Copy FOV/aspect-ish (FreeCamera will use engine aspect automatically)
  if (typeof (worldCam as any).fov === "number") (rpCam as any).fov = (worldCam as any).fov;

  // Copy clipping
  if (typeof worldCam.minZ === "number") rpCam.minZ = worldCam.minZ;
  if (typeof worldCam.maxZ === "number") rpCam.maxZ = worldCam.maxZ;

  // Position: use global position if available
// Position: use global position if available
const gp = (worldCam as any).globalPosition as BABYLON.Vector3 | undefined;
if (gp instanceof BABYLON.Vector3) {
  rpCam.position.copyFrom(gp);
} else {
  const wp = (worldCam as any).position as BABYLON.Vector3 | undefined;
  if (wp instanceof BABYLON.Vector3) rpCam.position.copyFrom(wp);
}


  // Rotation: prefer quaternion
  const rq = (worldCam as any).rotationQuaternion as BABYLON.Quaternion | null | undefined;
  if (rq && rpCam.rotationQuaternion) {
    rpCam.rotationQuaternion.copyFrom(rq);
  } else {
    // fallback: Euler
    const rot = (worldCam as any).rotation as BABYLON.Vector3 | undefined;
    if (rot) rpCam.rotation.copyFrom(rot);
  }

  // X-ray depth behavior
  if (remoteXray) {
    rpScene.autoClearDepthAndStencil = true;
    // Force always visible
    for (const mat of remoteMats.values()) {
      mat.disableDepthWrite = true;
      mat.depthFunction = BABYLON.Constants.ALWAYS;
    }
  } else {
    rpScene.autoClearDepthAndStencil = false;
    // Try normal depth test (occlusion may work depending on NOA depth buffer)
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

  // Remove meshes for players no longer present
  for (const id of Array.from(remoteMeshes.keys())) {
    if (!netTransforms.has(id)) removeRemoteMesh(id);
  }

  for (const [id, t] of netTransforms.entries()) {
    if (id === room.sessionId) continue;

    const root = ensureRemoteMesh(id);
    if (!root) continue;

    root.position.set(t.x, t.y, t.z);

    // simple yaw rotation around Y
    if (typeof t.yaw === "number") root.rotation.y = t.yaw;
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
      updateOverlay(`playerJoined: ${id}`);
    });

    room.onMessage("playerLeft", (p: any) => {
      const id = normId(p);
      if (!id) return;

      netTransforms.delete(id);
      removeRemoteMesh(id);

      lastTransformAt = performance.now();
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

  // Send movement (throttled)
  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // Keep overlay fresh
  if (tickCount % 10 === 0) updateOverlay();
});
