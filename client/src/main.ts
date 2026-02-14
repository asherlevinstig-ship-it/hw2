/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * Multiplayer voxel client (NOA + Colyseus) with HARD debugging for remote players.
 *
 * Key fixes vs your original:
 * 1) Apply authoritative spawn from server ("youJoined") to local NOA player.
 * 2) Do NOT send playerMove until after "youJoined" (prevents server spawn overwrite / overlap).
 * 3) Remote players are rendered as NOA ENTITIES with a mesh component so they inherit NOA's
 *    render/world-origin transforms (this fixes "pin works but world coords invisible").
 *
 * Debug tools:
 * - P toggles "pin remote marker in front of camera" (local-only)
 * - O toggles debug overlay extra line
 * - Periodic console logs for local/remote/scene/marker state
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
  playerStart: [0, 20, 0], // overridden by server spawn via "youJoined"
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
    [P] Pin Remote Marker (debug)<br>
    [O] Toggle Debug Overlay<br>
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

noa.inputs.down.on("fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

  const { x, y, z } = target.pos;
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!hasPointerLock()) return;
  const target = getTargetInfo();
  if (!target) return;

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
   9. Remote Player Rendering (NOA Entities + Mesh Component)
================================ */
type NetTransform = { x: number; y: number; z: number; yaw?: number };

const netTransforms = new Map<string, NetTransform>();

// Remote player NOA entities + meshes
const remoteEnts = new Map<string, number>();
const remoteMeshes = new Map<string, BABYLON.Mesh>();

let cachedScene: BABYLON.Scene | null = null;
let cachedSceneUid: string | number | null = null;

let pinRemoteMarkerInFront = false;

document.addEventListener("keydown", (e) => {
  if (e.key === "p" || e.key === "P") {
    pinRemoteMarkerInFront = !pinRemoteMarkerInFront;
    console.log("[DEBUG] pinRemoteMarkerInFront =", pinRemoteMarkerInFront);
    updateOverlay(pinRemoteMarkerInFront ? "Pin Remote Marker: ON" : "Pin Remote Marker: OFF");
  }
});

function getRenderedScene(): BABYLON.Scene | null {
  const r = (noa as any).rendering as any;
  if (!r) return null;

  const s1 = (typeof r.getScene === "function" ? r.getScene() : null) as BABYLON.Scene | null;
  const s2 = (r._scene ?? null) as BABYLON.Scene | null;
  const s3 = (r.scene ?? null) as BABYLON.Scene | null;

  return (s1 ?? s2 ?? s3) ?? null;
}

function getStableRenderedScene(): BABYLON.Scene | null {
  const s = getRenderedScene();
  if (!s) return cachedScene;

  const uid = (s as any).uid as string | number | undefined;
  if (!cachedScene || cachedSceneUid !== uid) {
    cachedScene = s;
    cachedSceneUid = uid ?? null;
    console.log("[RENDER] cachedScene set -> uid=", uid, "meshes=", s.meshes.length, "cam=", s.activeCamera?.name);
  }
  return cachedScene;
}

function makeMarkerMaterial(scene: BABYLON.Scene, id: string): BABYLON.StandardMaterial {
  const mat = new BABYLON.StandardMaterial(`remoteMat:${id}`, scene);
  mat.emissiveColor = new BABYLON.Color3(1, 0, 0);
  mat.diffuseColor = new BABYLON.Color3(1, 0, 0);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.disableLighting = true;
  mat.alpha = 1;
  mat.backFaceCulling = false;
  (mat as any).fogEnabled = false;
  return mat;
}

function forceMarkerAlwaysVisible(marker: BABYLON.Mesh) {
  marker.setEnabled(true);
  marker.isVisible = true;
  marker.visibility = 1;

  marker.scaling.set(4, 4, 4);

  marker.alwaysSelectAsActiveMesh = true;
  marker.isPickable = false;
  marker.checkCollisions = false;
  (marker as any).cullingStrategy = BABYLON.AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;

  marker.renderingGroupId = 2;

  const mat = marker.material as BABYLON.StandardMaterial | null;
  if (mat) {
    mat.disableDepthWrite = true;
    (mat as any).disableDepthTest = true;
    mat.alpha = 1;
  }
}

function forceMarkerInFrontOfCamera(marker: BABYLON.Mesh) {
  const scene = marker.getScene();
  const cam = scene.activeCamera as any;
  if (!cam) return;

  const camPos: BABYLON.Vector3 =
    cam.position instanceof BABYLON.Vector3
      ? cam.position
      : new BABYLON.Vector3(cam._position?.x ?? 0, cam._position?.y ?? 0, cam._position?.z ?? 0);

  const fwd: BABYLON.Vector3 =
    typeof cam.getForwardRay === "function"
      ? cam.getForwardRay(1).direction
      : new BABYLON.Vector3(0, 0, 1);

  marker.position.x = camPos.x + fwd.x * 8;
  marker.position.y = camPos.y + fwd.y * 8;
  marker.position.z = camPos.z + fwd.z * 8;
}

function ensureRemoteEntity(id: string): { eid: number; mesh: BABYLON.Mesh } | null {
  const existingEid = remoteEnts.get(id);
  const existingMesh = remoteMeshes.get(id);
  if (existingEid != null && existingMesh) return { eid: existingEid, mesh: existingMesh };

  const scene = getStableRenderedScene();
  if (!scene) return null;

  const mesh = BABYLON.MeshBuilder.CreateSphere(`remote:${id}`, { diameter: 3.0, segments: 16 }, scene);
  mesh.material = makeMarkerMaterial(scene, id);

  const cam = scene.activeCamera;
  if (cam && typeof cam.layerMask === "number") mesh.layerMask = cam.layerMask;
  else mesh.layerMask = 0xffffffff;

  forceMarkerAlwaysVisible(mesh);

  // Create NOA entity
  let eid: number | null = null;
  try {
    // noa.ents.add(position, width, height) exists in many builds
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

  // Attach mesh via NOA mesh component so it inherits NOA render transforms
  try {
    const meshName = (noa as any).ents?.names?.mesh ?? "mesh";
    (noa as any).ents.addComponent(eid, meshName, {
      mesh,
      offset: [0, 0, 0],
    });
  } catch (e) {
    console.warn("[RENDER] Failed to add mesh component to NOA entity", id, e);
    mesh.dispose();
    try {
      (noa as any).ents.removeEntity?.(eid);
    } catch {}
    return null;
  }

  remoteEnts.set(id, eid);
  remoteMeshes.set(id, mesh);

  console.log("[RENDER] remote entity created", {
    id,
    eid,
    sceneUid: (scene as any).uid,
    cam: scene.activeCamera?.name ?? "(none)",
  });

  return { eid, mesh };
}

function removeRemote(id: string) {
  netTransforms.delete(id);

  const eid = remoteEnts.get(id);
  if (eid != null) {
    try {
      (noa as any).ents.removeEntity?.(eid);
    } catch {}
    remoteEnts.delete(id);
  }

  const mesh = remoteMeshes.get(id);
  if (mesh) {
    try {
      mesh.dispose();
    } catch {}
    remoteMeshes.delete(id);
  }
}

/* Apply transforms each tick */
(noa as any).on("tick", () => {
  if (!room) return;

  for (const [id, t] of netTransforms.entries()) {
    if (id === room.sessionId) continue;

    const created = ensureRemoteEntity(id);
    if (!created) continue;

    const { eid, mesh } = created;

    if (pinRemoteMarkerInFront) {
      // Local-only debug pin
      forceMarkerInFrontOfCamera(mesh);

      // Keep entity near camera as well (some NOA culling paths rely on entity pos)
      const scene = mesh.getScene();
      const cam = scene.activeCamera as any;
      if (cam?.position) {
        (noa as any).ents.setPosition(eid, [cam.position.x, cam.position.y, cam.position.z]);
      }
      continue;
    }

    // ✅ Critical: Move via NOA entity so NOA applies world origin shifts
    try {
      (noa as any).ents.setPosition(eid, [t.x, t.y + 6.0, t.z]);
    } catch {}

    // Optional yaw (visual only)
    if (typeof t.yaw === "number") {
      try {
        mesh.rotation.y = t.yaw;
      } catch {}
    }
  }
});

/* ===============================
   10. Networking (Connect & Debug)
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
      // console.log("[NET] playerTransformOther:", p);

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
   11. Sync local position + periodic debug
================================ */
let tickCount = 0;
let debugTick = 0;

(noa as any).on("tick", () => {
  tickCount++;
  debugTick++;

  // Send movement (gated until spawn applied)
  if (room && canSendMoves && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = typeof (noa as any).camera?.heading === "number" ? (noa as any).camera.heading : 0;
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }

  // Periodic debug (~1/sec)
  if (debugTick % 30 === 0) {
    const s = getStableRenderedScene();
    const pos = noa.ents.getPosition(noa.playerEntity);

    let firstRemote: { id: string; t: NetTransform } | null = null;
    if (room) {
      for (const [id, t] of netTransforms.entries()) {
        if (id === room.sessionId) continue;
        firstRemote = { id, t };
        break;
      }
    }

    const markerCount = remoteMeshes.size;
    const netCount = netTransforms.size;

    const line =
      showExtraDebugOverlay
        ? `Local: (${pos[0].toFixed(2)},${pos[1].toFixed(2)},${pos[2].toFixed(2)}) | ` +
          `Remote: ${firstRemote ? `${firstRemote.id} (${firstRemote.t.x.toFixed(2)},${firstRemote.t.y.toFixed(2)},${firstRemote.t.z.toFixed(2)})` : "none"} | ` +
          `Net=${netCount} RemoteEnts=${remoteEnts.size} Meshes=${markerCount} | ` +
          `Scene=${s ? String((s as any).uid) : "null"} Meshes=${s ? s.meshes.length : 0} Cam=${s?.activeCamera?.name ?? "none"} | ` +
          `Pin=${pinRemoteMarkerInFront ? "ON" : "OFF"}`
        : "";

    if (showExtraDebugOverlay) updateOverlay(line);

    console.log("[DBG]", {
      local: { x: pos[0], y: pos[1], z: pos[2] },
      remote: firstRemote ? { id: firstRemote.id, ...firstRemote.t } : null,
      netCount,
      remoteEntCount: remoteEnts.size,
      remoteMeshCount: markerCount,
      scene: s ? { uid: (s as any).uid, meshes: s.meshes.length, cam: s.activeCamera?.name } : null,
      pinRemoteMarkerInFront,
    });

    if (firstRemote) {
      const mesh = remoteMeshes.get(firstRemote.id);
      const eid = remoteEnts.get(firstRemote.id);

      if (mesh) {
        console.log("[DBG remote mesh]", {
          id: firstRemote.id,
          enabled: mesh.isEnabled(),
          isVisible: mesh.isVisible,
          visibility: mesh.visibility,
          meshPos: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
          scaling: { x: mesh.scaling.x, y: mesh.scaling.y, z: mesh.scaling.z },
          layerMask: mesh.layerMask,
          renderingGroupId: (mesh as any).renderingGroupId,
        });
      } else {
        console.log("[DBG remote mesh] none for firstRemote yet");
      }

      if (eid != null) {
        try {
          const ep = (noa as any).ents.getPosition(eid);
          console.log("[DBG remote eid pos]", firstRemote.id, ep);
        } catch (e) {
          console.log("[DBG remote eid pos] failed", e);
        }
      }
    }
  }
});
