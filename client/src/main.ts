/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * NOA voxel client + Colyseus multiplayer
 * - Server authoritative chunk streaming (Path B)
 * - Mine/place block sync
 * - Remote players debug rendering via SECOND Babylon scene (rpScene) rendered AFTER NOA
 * - FIRST-PERSON VIEWMODEL ARM rendered in a SECOND Babylon scene (vmScene)
 *
 * Why rpScene?
 * NOA/Babylon scene used by noa-engine can swap cameras, layerMasks, and rendering groups.
 * rpScene renders AFTER NOA, just like the arm, so it is guaranteed visible.
 *
 * Controls:
 * - V toggles viewmodel overlay ON/OFF
 * - P toggles Remote Player Debug overlay ON/OFF (screen-space markers)
 *
 * Debug controls (viewmodel):
 * - B toggles VM debug visuals (axes + screen frame)
 * - N toggles VM tuning mode (enables hotkey nudging)
 * - M toggles VM mirror (fixes "wrong direction"/handedness)
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

// Remote player debug overlay toggle
let remoteDebugEnabled = true;

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

// Debug state for networking (overlay)
let lastSnapshotIds: string[] = [];
let lastSnapshotAt = 0;
let lastTransformAt = 0;

function updateOverlay(extraLine = "") {
  const status = room ? `Online (${room.sessionId})` : "Connecting...";
  const currentBlock = hotbar[selectedSlot];

  const netCount = netTransforms.size;
  const meshCount = rpMarkers.size;
  const snapAge = lastSnapshotAt ? `${((performance.now() - lastSnapshotAt) / 1000).toFixed(1)}s` : "n/a";
  const xformAge = lastTransformAt ? `${((performance.now() - lastTransformAt) / 1000).toFixed(1)}s` : "n/a";
  const snapPreview = lastSnapshotIds.slice(0, 5).join(", ");

  const closest = getClosestRemoteDistance();
  const closestStr = closest == null ? "n/a" : `${closest.toFixed(2)}m`;

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedSlot + 1}] ${currentBlock.name}<br>
    <strong>Viewmodel:</strong> ${viewModelEnabled ? "ON" : "OFF"}<br>
    <strong>Remote Debug:</strong> ${remoteDebugEnabled ? "ON" : "OFF"}<br>
    <strong>VM Debug:</strong> ${vmDebug ? "ON" : "OFF"} |
    <strong>VM Tune:</strong> ${vmTuning ? "ON" : "OFF"} |
    <strong>Mirror:</strong> ${vmMirrorX ? "ON" : "OFF"}<br>
    -------------------------<br>
    [L-Click] Mine  |  [R-Click] Place<br>
    [1-5] Select Block<br>
    [WASD] Move  |  [Space] Jump<br>
    [V] Toggle Viewmodel<br>
    [P] Toggle Remote Debug overlay<br>
    [B] Toggle VM Debug (axes/frame)<br>
    [N] Toggle VM Tuning (captures tuning keys)<br>
    [M] Toggle VM Mirror (handedness)<br>
    <span style="opacity:.9">Remote debug:</span><br>
    <span style="opacity:.9">netTransforms=${netCount} markers=${meshCount}</span><br>
    <span style="opacity:.9">lastSnapshot=${snapAge} lastTransform=${xformAge}</span><br>
    <span style="opacity:.9">closestRemote=${closestStr}</span><br>
    <span style="opacity:.9">snapshotIds=[${snapPreview}]</span><br>
    <span style="opacity:.9">Tuning keys (Tune ON): Arrows=Move | Shift+Arrows=Fine | 7/8 rotX | 9/0 rotY | -/= rotZ</span><br>
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}
updateOverlay();

/* ===============================
   6.2 Key handling
================================ */
document.addEventListener("keydown", (e) => {
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
    remoteDebugEnabled = !remoteDebugEnabled;
    updateOverlay(remoteDebugEnabled ? "Remote Debug: ON" : "Remote Debug: OFF");
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

let punchT = 1;
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

let vmAxes: BABYLON.TransformNode | null = null;
let vmFrame: BABYLON.LinesMesh | null = null;

function ensureVmScene(noaScene: BABYLON.Scene) {
  if (vmReady && vmScene && vmCam && vmRoot && vmArmRoot) return;

  const engine = noaScene.getEngine();

  vmScene = new BABYLON.Scene(engine);
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
      // Render order: NOA (already rendered) -> vmScene -> rpScene
      if (viewModelEnabled && vmScene) {
        if (vmAxes) vmAxes.setEnabled(vmDebug);
        if (vmFrame) vmFrame.setEnabled(vmDebug);
        vmScene.render();
      }

      if (remoteDebugEnabled && rpReady && rpScene) {
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

  vmArmRoot.rotation.x = vmRotX + pitchInfluence * vmPitchMul - punch01 * vmPunchRotMul + lookSway * 0.35;
  vmArmRoot.rotation.y = vmRotY + turnSway * vmTurnSwayMulY;
  vmArmRoot.rotation.z = vmRotZ + swing - turnSway * vmTurnSwayMulZ;
}

/* ===============================
   11. Remote Player Debug Overlay Scene (rpScene)
   - Renders AFTER NOA (like arm)
   - Projects remote 3D positions to screen-space markers
================================ */
type NetTransform = { x: number; y: number; z: number; yaw?: number };
const netTransforms = new Map<string, NetTransform>();

let rpReady = false;
let rpScene: BABYLON.Scene | null = null;
let rpCam: BABYLON.FreeCamera | null = null;

// marker root per player id
const rpMarkers = new Map<string, BABYLON.TransformNode>();

function ensureRpScene(noaScene: BABYLON.Scene) {
  if (rpReady && rpScene && rpCam) return;

  const engine = noaScene.getEngine();

  rpScene = new BABYLON.Scene(engine);
  rpScene.autoClear = false;
  rpScene.autoClearDepthAndStencil = true;

  rpCam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, -10), rpScene);
  rpCam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  rpCam.setTarget(BABYLON.Vector3.Zero());
  rpScene.activeCamera = rpCam;

  const updateOrtho = () => {
    if (!rpCam) return;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const r = w / Math.max(1, h);

    rpCam.orthoLeft = -r;
    rpCam.orthoRight = r;
    rpCam.orthoTop = 1;
    rpCam.orthoBottom = -1;
  };
  updateOrtho();
  engine.onResizeObservable.add(() => updateOrtho());

  rpReady = true;
}

function makeMarker(id: string) {
  if (!rpScene) return null;

  const root = new BABYLON.TransformNode(`rpRoot:${id}`, rpScene);

  const pill = BABYLON.MeshBuilder.CreateBox(
    `rpBox:${id}`,
    { width: 0.06, height: 0.16, depth: 0.02 },
    rpScene
  );
  pill.parent = root;

  const mat = new BABYLON.StandardMaterial(`rpMat:${id}`, rpScene);
  mat.disableLighting = true;
  mat.emissiveColor = new BABYLON.Color3(1, 0.2, 0.2);
  mat.diffuseColor = mat.emissiveColor.clone();
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.depthFunction = BABYLON.Constants.ALWAYS;

  pill.material = mat;

  pill.isPickable = false;
  (pill as any).isInFrustum = () => true;

  return root;
}

// project world position into screen space marker
function updateRemoteDebugMarkers() {
  if (!remoteDebugEnabled) return;
  if (!rpReady || !rpScene || !rpCam) return;

  const worldScene = getStableScene();
  if (!worldScene) return;

  const cam = worldScene.activeCamera;
  if (!cam) return;

  // Ortho bounds for screen-space marker placement
  const r = (rpCam.orthoRight ?? 1) as number;

  // Clean up markers for players that left
  for (const id of Array.from(rpMarkers.keys())) {
    if (!netTransforms.has(id)) {
      const m = rpMarkers.get(id);
      if (m) {
        try { m.dispose(); } catch {}
      }
      rpMarkers.delete(id);
    }
  }

  for (const [id, t] of netTransforms.entries()) {
    if (room && id === room.sessionId) continue;

    let marker = rpMarkers.get(id);
    if (!marker) {
      const created = makeMarker(id);
      if (!created) continue;
      marker = created;
      rpMarkers.set(id, marker);
    }

    // world position (head-ish)
    const worldPos = new BABYLON.Vector3(t.x, t.y + 1.6, t.z);

    // Babylon gives screen coords in pixels
    const engine = worldScene.getEngine();
    const vp = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());

    const sp = BABYLON.Vector3.Project(
      worldPos,
      BABYLON.Matrix.Identity(),
      cam.getTransformationMatrix(),

      vp
    );

    // If behind camera, hide marker
    // (z outside [0,1] indicates clipped)
    const behind = sp.z < 0 || sp.z > 1;
    marker.setEnabled(!behind);

    if (behind) continue;

    // Convert pixel screen to our ortho space:
    // x: [0..w] -> [-r..r]
    // y: [0..h] -> [1..-1]  (flip Y)
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();

    const nx = (sp.x / Math.max(1, w)) * 2 - 1; // -1..1
    const ny = 1 - (sp.y / Math.max(1, h)) * 2; //  1..-1

    marker.position.set(nx * r, ny * 1.0, 0);

    // Small yaw indicator via rotation (optional)
    if (typeof t.yaw === "number") {
      marker.rotation.z = 0;
      marker.rotation.y = 0;
      marker.rotation.x = 0;
    }
  }
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
      updateOverlay("playerJoined received");
    });

    room.onMessage("playerLeft", (p: any) => {
      const id = normId(p);
      if (!id) return;
      netTransforms.delete(id);
      lastTransformAt = performance.now();
      updateOverlay("playerLeft received");
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
   13. Tick loop (drive vm updates + networking + remote debug)
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
  }

  updateViewmodel(dtSec);
  updateRemoteDebugMarkers();

  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // keep overlay fresh
  if (tickCount % 10 === 0) updateOverlay();
});
