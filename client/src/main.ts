/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * PATH B (server-authoritative chunks):
 * - Client does NOT generate terrain locally.
 * - Client requests chunks from server on noa "worldDataNeeded"
 * - Server responds with "chunkData" containing voxels for that chunk id.
 * - Client fills noa chunk buffer and calls noa.world.setChunkData(id, data)
 *
 * Multiplayer:
 * - Sends: "playerMove", "mineBlock", "placeBlock"
 * - Receives: "chunkData", "blockUpdate",
 *            "existingPlayers", "playerJoined", "playerLeft",
 *            "playerTransformOther", "playersSnapshot", "youJoined"
 *
 * Requires your server room name: "my_room"
 * Requires server to implement "worldDataNeeded" -> "chunkData" (as in the Path B room I gave you)
 */

import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";

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

// Prevent right-click menu
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Fullscreen styles
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
  // If you want to force 32, uncomment:
  // chunkSize: 32,
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
    ${extraLine ? `<span style="opacity:.85">${extraLine}</span>` : ""}
  `;
}

updateOverlay();

document.addEventListener("keydown", (e) => {
  const key = Number.parseInt(e.key, 10);
  if (Number.isFinite(key) && key >= 1 && key <= hotbar.length) {
    selectedSlot = key - 1;
    updateOverlay();
  }
});

/* ===============================
   7. Terrain (PATH B: Server Chunk Streaming)
================================
   IMPORTANT:
   - We do NOT generate blocks here.
   - We request the chunk from server and wait for "chunkData".
 */
type PendingChunk = { data: any; chunkSize: number };

const pendingChunks = new Map<string, PendingChunk>();
const worldAny = noa.world as any;

let firstChunkLogged = false;

worldAny.on("worldDataNeeded", (id: string, data: any, x: number, y: number, z: number) => {
  const CS = data.shape?.[0] ?? 32;

  if (!firstChunkLogged) {
    firstChunkLogged = true;
    console.log("✅ worldDataNeeded firing (requesting from server).", { id, CS, x, y, z });
  }

  // stash the buffer NOA gives us
  pendingChunks.set(id, { data, chunkSize: CS });

  // request chunk from server
  room?.send("worldDataNeeded", {
    id,
    chunkSize: CS,
    x,
    y,
    z,
  });
});

/* ===============================
   8. Interaction Logic (Mine/Place)
================================ */

// Try to ensure bindings exist (depends on noa version)
try {
  (noa.inputs as any).bind?.("fire", "mouse1");
  (noa.inputs as any).bind?.("alt-fire", "mouse2");
} catch {
  // no-op
}

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

  // optimistic local update (feels responsive)
  noa.world.setBlockID(AIR_ID, x, y, z);

  // authoritative server update
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

  if (x === px && z === pz && (y === py || y === py + 1)) {
    console.log("❌ Cannot place block: Player is standing here.");
    return;
  }

  // optimistic local update
  noa.world.setBlockID(blockToPlace, x, y, z);

  // authoritative server update
  room?.send("placeBlock", { x, y, z, id: blockToPlace });
});

/* ===============================
   8.5 Minecraft-style Avatars (Option A - no assets)
================================ */

type Avatar = {
  root: any;
  head: any;
  body: any;
  armL: any;
  armR: any;
  legL: any;
  legR: any;
  lastPos: { x: number; y: number; z: number };
  lastT: number;
};

const avatars = new Map<string, Avatar>();

function getBabylonOrThrow() {
  const BABYLON = (globalThis as any).BABYLON;
  if (BABYLON) return BABYLON;

  throw new Error(
    "BABYLON global not found. noa-engine usually provides Babylon globally. " +
      "If not, install/explicitly import Babylon and update avatar code accordingly."
  );
}

function getSceneOrThrow() {
  const scene = (noa as any).rendering?.getScene?.();
  if (scene) return scene;
  throw new Error("Could not access Babylon scene via noa.rendering.getScene().");
}

function colorFromId(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const r = ((h >>> 0) & 255) / 255;
  const g = (((h >>> 8) >>> 0) & 255) / 255;
  const b = (((h >>> 16) >>> 0) & 255) / 255;
  return { r, g, b };
}

function createAvatar(id: string) {
  const BABYLON = getBabylonOrThrow();
  const scene = getSceneOrThrow();

  const SCALE = 1 / 16;

  const headSize = 8 * SCALE;
  const bodyW = 8 * SCALE;
  const bodyH = 12 * SCALE;
  const bodyD = 4 * SCALE;
  const limbW = 4 * SCALE;
  const limbH = 12 * SCALE;
  const limbD = 4 * SCALE;

  const root = new BABYLON.TransformNode(`avatar:${id}`, scene);

  const col = colorFromId(id);

  const matHead = new BABYLON.StandardMaterial(`matHead:${id}`, scene);
  matHead.diffuseColor = new BABYLON.Color3(col.r * 0.8 + 0.1, col.g * 0.8 + 0.1, col.b * 0.8 + 0.1);

  const matBody = new BABYLON.StandardMaterial(`matBody:${id}`, scene);
  matBody.diffuseColor = new BABYLON.Color3(col.r * 0.6 + 0.2, col.g * 0.6 + 0.2, col.b * 0.6 + 0.2);

  const matLimb = new BABYLON.StandardMaterial(`matLimb:${id}`, scene);
  matLimb.diffuseColor = new BABYLON.Color3(col.r * 0.5 + 0.25, col.g * 0.5 + 0.25, col.b * 0.5 + 0.25);

  function makeSwingPart(name: string, w: number, h: number, d: number, mat: any) {
    const mesh = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    mesh.material = mat;
    mesh.setPivotPoint(new BABYLON.Vector3(0, h / 2, 0));
    mesh.parent = root;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    return mesh;
  }

  const head = BABYLON.MeshBuilder.CreateBox(`head:${id}`, { size: headSize }, scene);
  head.material = matHead;
  head.parent = root;
  head.isPickable = false;
  head.checkCollisions = false;

  const body = BABYLON.MeshBuilder.CreateBox(`body:${id}`, { width: bodyW, height: bodyH, depth: bodyD }, scene);
  body.material = matBody;
  body.parent = root;
  body.isPickable = false;
  body.checkCollisions = false;

  const armL = makeSwingPart(`armL:${id}`, limbW, limbH, limbD, matLimb);
  const armR = makeSwingPart(`armR:${id}`, limbW, limbH, limbD, matLimb);
  const legL = makeSwingPart(`legL:${id}`, limbW, limbH, limbD, matLimb);
  const legR = makeSwingPart(`legR:${id}`, limbW, limbH, limbD, matLimb);

  const feetY = 0;

  legL.position.set(-bodyW * 0.25, feetY + limbH, 0);
  legR.position.set(bodyW * 0.25, feetY + limbH, 0);

  body.position.set(0, feetY + limbH + bodyH * 0.5, 0);

  const shoulderY = feetY + limbH + bodyH;
  armL.position.set(-bodyW * 0.75, shoulderY, 0);
  armR.position.set(bodyW * 0.75, shoulderY, 0);

  head.position.set(0, shoulderY + headSize * 0.5, 0);

  const now = performance.now();
  const avatar: Avatar = {
    root,
    head,
    body,
    armL,
    armR,
    legL,
    legR,
    lastPos: { x: 0, y: 0, z: 0 },
    lastT: now,
  };

  avatars.set(id, avatar);
  return avatar;
}

function removeAvatar(id: string) {
  const av = avatars.get(id);
  if (!av) return;

  [av.head, av.body, av.armL, av.armR, av.legL, av.legR].forEach((m) => m.dispose());
  av.root.dispose();
  avatars.delete(id);
}

function updateAvatar(id: string, x: number, y: number, z: number, yawRad?: number) {
  const av = avatars.get(id) ?? createAvatar(id);

  av.root.position.x = x;
  av.root.position.y = y;
  av.root.position.z = z;

  if (typeof yawRad === "number" && Number.isFinite(yawRad)) {
    av.root.rotation.y = yawRad;
  }

  const t = performance.now();
  const dt = Math.max(0.001, (t - av.lastT) / 1000);

  const dx = x - av.lastPos.x;
  const dz = z - av.lastPos.z;
  const speed = Math.sqrt(dx * dx + dz * dz) / dt;

  const isMoving = speed > 0.2;
  const swing = isMoving ? Math.min(1, speed / 4) : 0;

  const phase = t * 0.012;
  const swingAmt = 0.9 * swing;

  const targetArm = Math.sin(phase) * swingAmt;
  const targetLeg = Math.sin(phase + Math.PI) * swingAmt;

  function damp(current: number, target: number, k = 12) {
    return current + (target - current) * (1 - Math.exp(-k * dt));
  }

  av.armL.rotation.x = damp(av.armL.rotation.x, targetArm);
  av.armR.rotation.x = damp(av.armR.rotation.x, -targetArm);
  av.legL.rotation.x = damp(av.legL.rotation.x, targetLeg);
  av.legR.rotation.x = damp(av.legR.rotation.x, -targetLeg);

  av.lastPos = { x, y, z };
  av.lastT = t;
}

/* ===============================
   9. Networking (Connect & Sync)
================================ */

function normId(p: any): string | null {
  if (!p) return null;
  const id = p.id ?? p.sessionId ?? p.sid ?? p.clientId ?? null;
  if (id != null) return String(id);
  if (typeof p === "string") return p;
  return null;
}

function isMe(id: string): boolean {
  return !!room && id === room.sessionId;
}

function applyChunkFromServer(msg: any) {
  if (!msg || typeof msg.id !== "string") return;

  const pending = pendingChunks.get(msg.id);
  if (!pending) return;

  const CS = pending.chunkSize;
  const voxels: number[] = Array.isArray(msg.voxels) ? msg.voxels : [];

  if (voxels.length !== CS * CS * CS) {
    console.warn("⚠️ chunkData wrong size", { got: voxels.length, expected: CS * CS * CS, msg });
    pendingChunks.delete(msg.id);
    return;
  }

  const data = pending.data;

  // Must match server packing: i + CS*(j + CS*k)
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
}

async function connect() {
  try {
    updateOverlay();

    room = await colyseus.joinOrCreate("my_room");
    console.log("✅ Joined room:", room.sessionId);
    updateOverlay();

    // 0) Server chunk streaming response
    room.onMessage("chunkData", (msg: any) => {
      applyChunkFromServer(msg);
    });

    // 1) Block updates
    room.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
      }
    });

    // 2) Existing players (initial load)
    room.onMessage("existingPlayers", (players: any[]) => {
      console.log("👋 Existing players:", players);
      for (const p of players ?? []) {
        const id = normId(p);
        if (!id || isMe(id)) continue;

        updateAvatar(
          id,
          Number(p.x ?? 0),
          Number(p.y ?? 0),
          Number(p.z ?? 0),
          typeof p.yaw === "number" ? p.yaw : undefined
        );
      }
    });

    // 3) New player joined
    room.onMessage("playerJoined", (p: any) => {
      console.log("➕ Player joined:", p);
      const id = normId(p);
      if (!id || isMe(id)) return;

      updateAvatar(
        id,
        Number(p.x ?? 0),
        Number(p.y ?? 0),
        Number(p.z ?? 0),
        typeof p.yaw === "number" ? p.yaw : undefined
      );
    });

    // 4) Player left
    room.onMessage("playerLeft", (p: any) => {
      console.log("➖ Player left:", p);
      const id = normId(p);
      if (!id) return;
      removeAvatar(id);
    });

    // 5) Other player movement
    room.onMessage("playerTransformOther", (p: any) => {
      const id = normId(p);
      if (!id || isMe(id)) return;

      const x = Number(p.x);
      const y = Number(p.y);
      const z = Number(p.z);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      updateAvatar(id, x, y, z, typeof p.yaw === "number" ? p.yaw : undefined);
    });

    // 6) Periodic snapshot (robustness)
    room.onMessage("playersSnapshot", (players: any[]) => {
      if (!Array.isArray(players)) return;

      for (const p of players) {
        const id = normId(p);
        if (!id || isMe(id)) continue;

        const x = Number(p.x);
        const y = Number(p.y);
        const z = Number(p.z);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        updateAvatar(id, x, y, z, typeof p.yaw === "number" ? p.yaw : undefined);
      }
    });

    // 7) Optional server ack for own join
    room.onMessage("youJoined", (p: any) => {
      console.log("🟦 youJoined:", p);
    });
  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed!</span>";
  }
}

connect();

/* ===============================
   10. Sync Position
================================ */

function tryGetYaw(): number {
  // Yaw handling varies by NOA version; keep safe fallback
  // Many setups expose camera rotation via rendering
  const rot = (noa as any).rendering?.getCameraRotation?.();
  if (rot && typeof rot.y === "number" && Number.isFinite(rot.y)) return rot.y;

  // Fallback: try to read from Babylon active camera
  try {
    const scene = (noa as any).rendering?.getScene?.();
    const cam = scene?.activeCamera;
    if (cam && typeof cam.rotation?.y === "number" && Number.isFinite(cam.rotation.y)) return cam.rotation.y;
  } catch {
    // ignore
  }

  return 0;
}

let tickCount = 0;
(noa as any).on("tick", () => {
  tickCount++;

  if (room && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    const yaw = tryGetYaw();

    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2], yaw });
  }
});
