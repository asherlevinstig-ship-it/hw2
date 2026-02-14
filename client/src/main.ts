/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * NOA voxel client + Colyseus multiplayer
 * - Server authoritative chunk streaming (Path B)
 * - Mine/place block sync
 * - Remote players rendered via NOA entities + mesh component
 * - First-person arm: MAIN SCENE viewmodel (NO UtilityLayer)
 *
 * ✅ CAMERA TRUTH (confirmed):
 * In this NOA setup, Babylon FreeCamera.position stays at (0,0,0).
 * The REAL camera world pose comes from inverse(viewMatrix).
 *
 * ✅ NEW DEBUG (forward sign theory):
 * Some rigs have inverse(viewMatrix) "forward" pointing backwards.
 * We now render TWO debug planes:
 *   - +basis.forward  (magenta)
 *   - -basis.forward  (cyan)
 * We also compare basis.forward vs cam.getForwardRay().direction,
 * and flip forward for the ARM if dot < 0.
 *
 * Debug controls:
 * - P toggles pinning remote marker in front of camera (local-only debug)
 * - O toggles extra debug overlay line
 * - L toggles FORCE renderList mode (camera renders arm/planes explicitly)
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
  debug: true,
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
let showExtraDebugOverlay = true;
let FORCE_RENDERLIST_MODE = true;

function updateOverlay(extraLine = "") {
  const status = room ? `Online (${room.sessionId})` : "Connecting...";
  const currentBlock = hotbar[selectedSlot];

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedSlot + 1}] ${currentBlock.name}<br>
    -------------------------<br>
    [L-Click] Mine  |  [R-Click] Place<br>
    [1-5] Select Block<br>
    [WASD] Move  |  [Space] Jump<br>
    [P] Pin Remote (debug)<br>
    [O] Toggle Debug Overlay<br>
    [L] Toggle FORCE renderList: ${FORCE_RENDERLIST_MODE ? "ON" : "OFF"}<br>
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}
updateOverlay();

document.addEventListener("keydown", (e) => {
  const key = Number.parseInt(e.key, 10);
  if (Number.isFinite(key) && key >= 1 && key <= hotbar.length) {
    selectedSlot = key - 1;
    updateOverlay();
    return;
  }
  if (e.key === "o" || e.key === "O") {
    showExtraDebugOverlay = !showExtraDebugOverlay;
    updateOverlay(showExtraDebugOverlay ? "Debug overlay: ON" : "Debug overlay: OFF");
    return;
  }
  if (e.key === "l" || e.key === "L") {
    FORCE_RENDERLIST_MODE = !FORCE_RENDERLIST_MODE;
    console.log("[ARMDBG] FORCE_RENDERLIST_MODE =", FORCE_RENDERLIST_MODE);
    updateOverlay(`FORCE renderList: ${FORCE_RENDERLIST_MODE ? "ON" : "OFF"}`);
    return;
  }
});

/* ===============================
   7. World Streaming (Path B)
================================ */
type PendingChunk = { data: any; chunkSize: number; x: number; y: number; z: number };

const pendingChunks = new Map<string, PendingChunk>();
const queuedRequests = new Map<string, { id: string; chunkSize: number; x: number; y: number; z: number }>();
const worldAny = noa.world as any;

let firstChunkLogged = false;

function sendChunkRequest(req: { id: string; chunkSize: number; x: number; y: number; z: number }) {
  if (!room) {
    queuedRequests.set(req.id, req);
    return;
  }
  room.send("worldDataNeeded", req);
}

worldAny.on("worldDataNeeded", (id: string, data: any, x: number, y: number, z: number) => {
  const CS = data.shape?.[0] ?? 32;

  if (!firstChunkLogged) {
    firstChunkLogged = true;
    console.log("✅ worldDataNeeded firing (requesting from server).", { id, CS, x, y, z });
  }

  pendingChunks.set(id, { data, chunkSize: CS, x, y, z });
  sendChunkRequest({ id, chunkSize: CS, x, y, z });
});

function applyChunkFromServer(msg: any) {
  if (!msg || typeof msg.id !== "string") return;

  const pending = pendingChunks.get(msg.id);
  if (!pending) return;

  const CS =
    typeof msg.chunkSize === "number" && Number.isFinite(msg.chunkSize)
      ? msg.chunkSize
      : pending.chunkSize;

  const voxels: number[] = Array.isArray(msg.voxels) ? msg.voxels : [];
  const expected = CS * CS * CS;

  if (voxels.length !== expected) {
    console.warn("⚠️ chunkData wrong size", { got: voxels.length, expected, msg });
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

let armPunch = 0;
let armPunchVel = 0;

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

  armPunchVel = 10;

  const { x, y, z } = target.pos;
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

  armPunchVel = 10;

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
   9. Babylon scene/camera access
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

function logCanvasForScene(scene: BABYLON.Scene) {
  try {
    const eng = scene.getEngine();
    const canvas = eng.getRenderingCanvas();
    console.log("[CANVAS]", {
      sceneUid: (scene as any).uid,
      canvasId: (canvas as any)?.id ?? null,
      canvasW: (canvas as any)?.width ?? null,
      canvasH: (canvas as any)?.height ?? null,
    });
  } catch (e) {
    console.log("[CANVAS] failed", e);
  }
}

function getStableScene(): BABYLON.Scene | null {
  const s = getNoaScene();
  if (!s) return cachedScene;

  const uid = (s as any).uid as string | number | undefined;
  if (!cachedScene || cachedSceneUid !== uid) {
    cachedScene = s;
    cachedSceneUid = uid ?? null;
    console.log("[RENDER] cachedScene set -> uid=", uid, "meshes=", s.meshes.length, "cam=", s.activeCamera?.name);
    logCanvasForScene(s);
  }
  return cachedScene;
}

function getNoaCamera(scene: BABYLON.Scene): BABYLON.Camera | null {
  const r = (noa as any).rendering as any;

  const c1 = (typeof r?.getCamera === "function" ? r.getCamera() : null) as BABYLON.Camera | null;
  if (c1) return c1;

  const c2 = (r?._camera ?? null) as BABYLON.Camera | null;
  if (c2) return c2;

  const c3 = (r?.camera ?? null) as BABYLON.Camera | null;
  if (c3) return c3;

  const c4 = ((noa as any).camera?._camera ?? null) as BABYLON.Camera | null;
  if (c4) return c4;

  return (scene.activeCamera ?? null) as BABYLON.Camera | null;
}

/* ===============================
   10. TRUE camera pose helpers
================================ */
function getTrueCameraWorldPos(cam: BABYLON.Camera): BABYLON.Vector3 {
  try {
    const invView = cam.getViewMatrix().clone();
    invView.invert();
    return new BABYLON.Vector3(invView.m[12], invView.m[13], invView.m[14]);
  } catch {
    return (cam as any)._globalPosition?.clone?.() ?? cam.position.clone();
  }
}

function getTrueCameraBasis(cam: BABYLON.Camera) {
  const view = cam.getViewMatrix();
  const inv = view.clone();
  inv.invert();

  const right = new BABYLON.Vector3(inv.m[0], inv.m[1], inv.m[2]).normalize();
  const up = new BABYLON.Vector3(inv.m[4], inv.m[5], inv.m[6]).normalize();
  const forward = new BABYLON.Vector3(inv.m[8], inv.m[9], inv.m[10]).normalize();
  return { forward, right, up };
}

function getTrueCameraRotationQuat(cam: BABYLON.Camera): BABYLON.Quaternion {
  const view = cam.getViewMatrix();
  const inv = view.clone();
  inv.invert();
  const rot = new BABYLON.Quaternion();
  inv.decompose(undefined, rot, undefined);
  return rot;
}

/* ===============================
   11. Arm / Debug planes
================================ */
let fpArmReady = false;
let fpArmRoot: BABYLON.TransformNode | null = null;
let fpArmMesh: BABYLON.Mesh | null = null;

let fpDbgPlanePlus: BABYLON.Mesh | null = null;  // +basis.forward (magenta)
let fpDbgPlaneMinus: BABYLON.Mesh | null = null; // -basis.forward (cyan)

let fpArmSceneUid: string | number | null = null;

let lastLocalPos: [number, number, number] | null = null;
let armTime = 0;

function disposeArm() {
  try { fpArmMesh?.dispose(false, true); } catch {}
  try { fpArmRoot?.dispose(false, true); } catch {}
  try { fpDbgPlanePlus?.dispose(false, true); } catch {}
  try { fpDbgPlaneMinus?.dispose(false, true); } catch {}
  fpArmMesh = null;
  fpArmRoot = null;
  fpDbgPlanePlus = null;
  fpDbgPlaneMinus = null;
  fpArmReady = false;
  fpArmSceneUid = null;
}

function makePlane(scene: BABYLON.Scene, name: string, color: BABYLON.Color3) {
  const p = BABYLON.MeshBuilder.CreatePlane(name, { size: 1.5 }, scene);
  const m = new BABYLON.StandardMaterial(name + "_MAT", scene);
  m.disableLighting = true;
  m.emissiveColor = color;
  m.diffuseColor = color;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.depthFunction = BABYLON.Constants.ALWAYS;
  p.material = m;

  p.renderingGroupId = 0;
  p.layerMask = 0xffffffff;
  p.isPickable = false;
  p.setEnabled(true);
  p.isVisible = true;

  (p as any).isInFrustum = () => true;
  (p as any).alwaysSelectAsActiveMesh = true;
  return p;
}

function ensureDebugPlanes(scene: BABYLON.Scene) {
  if (
    fpDbgPlanePlus && !fpDbgPlanePlus.isDisposed() &&
    fpDbgPlaneMinus && !fpDbgPlaneMinus.isDisposed()
  ) return;

  fpDbgPlanePlus = makePlane(scene, "ARM_DEBUG_PLANE_PLUS", new BABYLON.Color3(1, 0, 1));   // magenta
  fpDbgPlaneMinus = makePlane(scene, "ARM_DEBUG_PLANE_MINUS", new BABYLON.Color3(0, 1, 1)); // cyan

  console.log("[ARMDBG] Created TWO debug planes: +forward (magenta) and -forward (cyan)");
}

function setupArm(scene: BABYLON.Scene) {
  const uid = (scene as any).uid as string | number | undefined;

  if (fpArmReady && fpArmSceneUid !== (uid ?? null)) {
    console.warn("[ARMDBG] Scene swap -> rebuild arm", { from: fpArmSceneUid, to: uid });
    disposeArm();
  }
  if (fpArmReady) return;

  const cam = getNoaCamera(scene) ?? scene.activeCamera;
  if (!cam) return;

  fpArmSceneUid = uid ?? null;

  ensureDebugPlanes(scene);

  fpArmRoot = new BABYLON.TransformNode("fpArmRoot", scene);
  fpArmRoot.parent = null;
  fpArmRoot.position.set(0, 0, 0);
  fpArmRoot.rotationQuaternion = new BABYLON.Quaternion();

  const forearm = BABYLON.MeshBuilder.CreateCylinder(
    "fpForearm",
    { height: 1.35, diameter: 0.32, tessellation: 16 },
    scene
  );
  forearm.rotation.x = Math.PI / 2;

  const hand = BABYLON.MeshBuilder.CreateBox(
    "fpHand",
    { width: 0.38, height: 0.28, depth: 0.55 },
    scene
  );
  hand.position.z = 0.62;
  hand.rotation.x = Math.PI / 2;

  const thumb = BABYLON.MeshBuilder.CreateBox(
    "fpThumb",
    { width: 0.12, height: 0.12, depth: 0.28 },
    scene
  );
  thumb.position.set(0.20, -0.06, 0.56);
  thumb.rotation.x = Math.PI / 2;
  thumb.rotation.z = -0.55;

  const merged = BABYLON.Mesh.MergeMeshes([forearm, hand, thumb], true, true, undefined, false, true);
  if (!merged) return;

  fpArmMesh = merged;
  fpArmMesh.name = "fpArm";
  fpArmMesh.parent = fpArmRoot;
  fpArmMesh.scaling.setAll(2.0);

  const mat = new BABYLON.StandardMaterial("fpArmMat", scene);
  mat.disableLighting = true;
  mat.emissiveColor = new BABYLON.Color3(0.15, 0.65, 1.0);
  mat.diffuseColor = new BABYLON.Color3(0.15, 0.65, 1.0);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.depthFunction = BABYLON.Constants.ALWAYS;

  fpArmMesh.material = mat;
  fpArmMesh.isPickable = false;
  fpArmMesh.isVisible = true;
  fpArmMesh.setEnabled(true);

  // IMPORTANT: group 0, never culled
  fpArmMesh.renderingGroupId = 0;
  fpArmMesh.layerMask = 0xffffffff;
  (fpArmMesh as any).isInFrustum = () => true;
  (fpArmMesh as any).alwaysSelectAsActiveMesh = true;

  fpArmReady = true;

  console.log("[ARMDBG] Arm created (group 0)", {
    cam: cam.name,
    sceneUid: (scene as any).uid,
    camMask: (cam as any).layerMask,
  });
}

function applyForceRenderList(scene: BABYLON.Scene) {
  const cam = scene.activeCamera as any;
  if (!cam) return;

  if (!FORCE_RENDERLIST_MODE) {
    (cam as any).renderList = null;
    return;
  }

  const list: BABYLON.AbstractMesh[] = [];
  if (fpArmMesh) list.push(fpArmMesh);
  if (fpDbgPlanePlus) list.push(fpDbgPlanePlus);
  if (fpDbgPlaneMinus) list.push(fpDbgPlaneMinus);

  (cam as any).renderList = list;

  // Ensure masks overlap
  try { cam.layerMask = 0xffffffff; } catch {}
}

function updateArm(dtSec: number) {
  if (!fpArmReady || !fpArmRoot || !fpArmMesh) return;

  const scene = fpArmMesh.getScene();
  const cam = (getNoaCamera(scene) ?? scene.activeCamera) as BABYLON.Camera | null;
  if (!cam) return;

  // Walk speed
  const pos = noa.ents.getPosition(noa.playerEntity) as [number, number, number];
  if (!pos) return;

  let speed = 0;
  if (lastLocalPos) {
    const dx = pos[0] - lastLocalPos[0];
    const dz = pos[2] - lastLocalPos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    speed = dist / Math.max(0.0001, dtSec);
  }
  lastLocalPos = [pos[0], pos[1], pos[2]];

  const walk = Math.min(1, speed / 5);
  armTime += dtSec * (2.5 + walk * 6.0);

  const bob = Math.sin(armTime * 2.0) * 0.05 * walk;
  const sway = Math.sin(armTime) * 0.25 * walk;

  // punch
  armPunch += armPunchVel * dtSec;
  armPunchVel *= Math.pow(0.02, dtSec);
  armPunch *= Math.pow(0.10, dtSec);
  armPunch = Math.min(1, armPunch);
  const punch01 = Math.sin(armPunch * Math.PI);

  // TRUE pose
  const camPosTrue = getTrueCameraWorldPos(cam);
  const basis = getTrueCameraBasis(cam);

  // Determine correct forward sign by comparing to Babylon forward ray
  let forward = basis.forward.clone();
  let rayFwd: BABYLON.Vector3 | null = null;
  try {
    rayFwd = cam.getForwardRay(1).direction.clone().normalize();
  } catch {}

  if (rayFwd) {
    const dot = BABYLON.Vector3.Dot(rayFwd, forward);
    const flipped = dot < 0;
    if (flipped) forward = forward.scale(-1);

    if ((updateArm as any)._dotLogged !== true) {
      (updateArm as any)._dotLogged = true;
      console.log("[ARMDBG] forward sign check", {
        basisFwd: basis.forward.asArray(),
        rayFwd: rayFwd.asArray(),
        dot,
        flipped,
      });
    }
  }

  const right = basis.right;
  const up = basis.up;

  // Place TWO planes using RAW basis.forward (no flip) so we can visually confirm
  if (fpDbgPlanePlus && !fpDbgPlanePlus.isDisposed()) {
    fpDbgPlanePlus.position.copyFrom(camPosTrue.add(basis.forward.scale(2.5)));
    if (!fpDbgPlanePlus.rotationQuaternion) fpDbgPlanePlus.rotationQuaternion = new BABYLON.Quaternion();
    fpDbgPlanePlus.rotationQuaternion.copyFrom(getTrueCameraRotationQuat(cam));
  }
  if (fpDbgPlaneMinus && !fpDbgPlaneMinus.isDisposed()) {
    fpDbgPlaneMinus.position.copyFrom(camPosTrue.add(basis.forward.scale(-2.5)));
    if (!fpDbgPlaneMinus.rotationQuaternion) fpDbgPlaneMinus.rotationQuaternion = new BABYLON.Quaternion();
    fpDbgPlaneMinus.rotationQuaternion.copyFrom(getTrueCameraRotationQuat(cam));
  }

  // Arm offsets (use possibly flipped forward)
  const distFwd = 0.75 + punch01 * 0.20;
  const distRight = 0.45;
  const distUp = -0.35 + bob;

  const armPos = camPosTrue
    .add(forward.scale(distFwd))
    .add(right.scale(distRight))
    .add(up.scale(distUp));

  fpArmRoot.position.copyFrom(armPos);

  if (!fpArmRoot.rotationQuaternion) fpArmRoot.rotationQuaternion = new BABYLON.Quaternion();
  fpArmRoot.rotationQuaternion.copyFrom(getTrueCameraRotationQuat(cam));

  // local swing
  fpArmMesh.rotation.x = 0.15 + Math.sin(armTime) * 0.18 * walk - punch01 * 0.25;
  fpArmMesh.rotation.y = punch01 * 0.15;
  fpArmMesh.rotation.z = -0.35 + Math.cos(armTime * 1.2) * 0.12 * walk + sway * 0.06;

  // one-time snapshot
  if ((updateArm as any)._logged !== true) {
    (updateArm as any)._logged = true;
    console.log("[ARMDBG] camPos/trueCamPos/armPos", {
      camPos: cam.position.asArray(),
      trueCamPos: camPosTrue.asArray(),
      armPos: armPos.asArray(),
      activeCamName: scene.activeCamera?.name ?? null,
      camName: cam.name,
    });
  }
}

function logAllCameras(scene: BABYLON.Scene) {
  const cams = scene.cameras ?? [];
  const data = cams.map((c: any) => ({
    name: c?.name ?? "unnamed",
    type: c?.getClassName?.() ?? "Camera",
    layerMask: c?.layerMask ?? null,
    pos: c?.position?.asArray?.() ?? null,
    isActive: scene.activeCamera === c,
  }));
  console.log("[ARMDBG] cameras:", data);
}

/* Render loop hook (ONLY ONE IMPLEMENTATION) */
function hookScene(scene: BABYLON.Scene) {
  if ((scene as any).__armHooked) return;
  (scene as any).__armHooked = true;

  scene.onBeforeRenderObservable.add(() => {
    setupArm(scene);
    updateArm(1 / 60);
    applyForceRenderList(scene);
  });

  console.log("[FP] hooked arm to scene render loop", (scene as any).uid);
}

/* ===============================
   12. Remote Player Rendering
================================ */
type NetTransform = { x: number; y: number; z: number; yaw?: number };

const netTransforms = new Map<string, NetTransform>();
const remoteEnts = new Map<string, number>();
const remoteMeshes = new Map<string, BABYLON.Mesh>();

let pinRemoteMarkerInFront = false;

document.addEventListener("keydown", (e) => {
  if (e.key === "p" || e.key === "P") {
    pinRemoteMarkerInFront = !pinRemoteMarkerInFront;
    console.log("[DEBUG] pinRemoteMarkerInFront =", pinRemoteMarkerInFront);
    updateOverlay(pinRemoteMarkerInFront ? "Pin Remote: ON" : "Pin Remote: OFF");
  }
});

function makeRemoteMaterial(scene: BABYLON.Scene, id: string): BABYLON.StandardMaterial {
  const mat = new BABYLON.StandardMaterial(`remoteMat:${id}`, scene);
  mat.disableLighting = true;
  mat.emissiveColor = new BABYLON.Color3(1, 0.1, 0.1);
  mat.diffuseColor = new BABYLON.Color3(1, 0.1, 0.1);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.alpha = 1;
  mat.backFaceCulling = false;
  (mat as any).fogEnabled = false;
  return mat;
}

function ensureRemoteEntity(id: string): { eid: number; mesh: BABYLON.Mesh } | null {
  const existingEid = remoteEnts.get(id);
  const existingMesh = remoteMeshes.get(id);
  if (existingEid != null && existingMesh) return { eid: existingEid, mesh: existingMesh };

  const scene = getStableScene();
  if (!scene) return null;

  const mesh = BABYLON.MeshBuilder.CreateSphere(`remote:${id}`, { diameter: 1.0, segments: 12 }, scene);
  mesh.material = makeRemoteMaterial(scene, id);

  const cam = scene.activeCamera;
  if (cam && typeof (cam as any).layerMask === "number") mesh.layerMask = (cam as any).layerMask;
  else mesh.layerMask = 0xffffffff;

  mesh.setEnabled(true);
  mesh.isVisible = true;
  mesh.visibility = 1;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  mesh.renderingGroupId = 0;

  let eid: number | null = null;
  try {
    const maybe = (noa as any).ents.add?.([0, 0, 0], 1, 2);
    if (typeof maybe === "number") eid = maybe;
  } catch {}

  if (eid == null) {
    try {
      const maybe2 = (noa as any).ents.createEntity?.();
      if (typeof maybe2 === "number") eid = maybe2;
    } catch {}
  }

  if (eid == null) {
    console.warn("[RENDER] Could not create NOA entity for remote player", id);
    mesh.dispose();
    return null;
  }

  try {
    const meshName = (noa as any).ents?.names?.mesh ?? "mesh";
    (noa as any).ents.addComponent(eid, meshName, { mesh, offset: [0, 0, 0] });
  } catch (e) {
    console.warn("[RENDER] Failed to add mesh component to NOA entity", id, e);
    mesh.dispose();
    try { (noa as any).ents.removeEntity?.(eid); } catch {}
    return null;
  }

  remoteEnts.set(id, eid);
  remoteMeshes.set(id, mesh);

  console.log("[RENDER] remote entity created", { id, eid });
  return { eid, mesh };
}

function removeRemote(id: string) {
  netTransforms.delete(id);

  const eid = remoteEnts.get(id);
  if (eid != null) {
    try { (noa as any).ents.removeEntity?.(eid); } catch {}
    remoteEnts.delete(id);
  }

  const mesh = remoteMeshes.get(id);
  if (mesh) {
    try { mesh.dispose(); } catch {}
    remoteMeshes.delete(id);
  }
}

function forceRemoteInFrontOfCamera(mesh: BABYLON.Mesh) {
  const scene = mesh.getScene();
  const cam = (scene.activeCamera ?? null) as any;
  if (!cam) return;

  const camPosTrue = getTrueCameraWorldPos(cam as any);
  const { forward } = getTrueCameraBasis(cam as any);

  mesh.position.x = camPosTrue.x + forward.x * 6;
  mesh.position.y = camPosTrue.y + forward.y * 6;
  mesh.position.z = camPosTrue.z + forward.z * 6;
}

/* Apply remote transforms each tick */
(noa as any).on("tick", () => {
  if (!room) return;

  for (const [id, t] of netTransforms.entries()) {
    if (id === room.sessionId) continue;

    const created = ensureRemoteEntity(id);
    if (!created) continue;

    const { eid, mesh } = created;

    if (pinRemoteMarkerInFront) {
      forceRemoteInFrontOfCamera(mesh);
      continue;
    }

    try { (noa as any).ents.setPosition(eid, [t.x, t.y + 6.0, t.z]); } catch {}
    if (typeof t.yaw === "number") {
      try { mesh.rotation.y = t.yaw; } catch {}
    }
  }
});

/* ===============================
   13. Networking
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

    console.log("✅ Joined room:", room.sessionId);
    console.log("[NET] endpoint =", ENDPOINT);
    console.log("[NET] joined room:", { name: room.name, sessionId: room.sessionId });

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
      const len = Array.isArray(players) ? players.length : 0;
      console.log("[NET] existingPlayers:", len, players);

      for (const p of players ?? []) {
        const id = normId(p);
        if (!id || id === room!.sessionId) continue;

        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        const z = Number(p.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
      }
    });

    room.onMessage("playerJoined", (p: any) => {
      console.log("[NET] playerJoined:", p);
      const id = normId(p);
      if (!id || id === room!.sessionId) return;

      const x = Number(p.x ?? 0);
      const y = Number(p.y ?? 0);
      const z = Number(p.z ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
    });

    room.onMessage("playerLeft", (p: any) => {
      console.log("[NET] playerLeft:", p);
      const id = normId(p);
      if (!id) return;
      removeRemote(id);
    });

    room.onMessage("playerTransformOther", (p: any) => {
      const id = normId(p);
      if (!id || id === room!.sessionId) return;

      const x = Number(p.x);
      const y = Number(p.y);
      const z = Number(p.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
    });

    room.onMessage("playersSnapshot", (players: any) => {
      const len = Array.isArray(players) ? players.length : 0;
      console.log("[NET] playersSnapshot:", len, players);
      if (!Array.isArray(players)) return;

      for (const p of players) {
        const id = normId(p);
        if (!id || id === room!.sessionId) continue;

        const x = Number(p.x);
        const y = Number(p.y);
        const z = Number(p.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        netTransforms.set(id, { x, y, z, yaw: typeof p.yaw === "number" ? p.yaw : undefined });
      }
    });

    room.onMessage("youJoined", (p: any) => {
      console.log("🟦 youJoined:", p);

      const x = Number(p.x);
      const y = Number(p.y);
      const z = Number(p.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      try {
        noa.ents.setPosition(noa.playerEntity, [x, y, z]);
        console.log("[NET] Applied server spawn to local player:", { x, y, z });
      } catch (e) {
        console.warn("[NET] Failed to setPosition for local player:", e);
      }

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
   14. Tick loop
================================ */
let tickCount = 0;
let debugTick = 0;
let lastTickMs = performance.now();

(noa as any).on("tick", () => {
  tickCount++;
  debugTick++;

  const now = performance.now();
  const dtSec = Math.min(0.05, (now - lastTickMs) / 1000);
  lastTickMs = now;

  const scene = getStableScene();
  if (scene) hookScene(scene);

  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  if (scene && debugTick % 60 === 0) {
    logAllCameras(scene);
  }

  if (debugTick % 30 === 0 && showExtraDebugOverlay) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const cam = scene ? (getNoaCamera(scene) ?? scene.activeCamera) : null;
    const truePos = cam ? getTrueCameraWorldPos(cam).asArray() : null;

    updateOverlay(
      `Local: (${pos[0].toFixed(2)},${pos[1].toFixed(2)},${pos[2].toFixed(2)}) | ` +
      `Scene=${scene ? String((scene as any).uid) : "null"} | ` +
      `activeCam=${scene?.activeCamera?.name ?? "none"} | ` +
      `trueCamPos=${truePos ? `(${truePos[0].toFixed(2)},${truePos[1].toFixed(2)},${truePos[2].toFixed(2)})` : "null"}`
    );
  }

  updateArm(dtSec);
});
