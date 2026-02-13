import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";

/* ===============================
   Colyseus endpoint (Vercel + local fallback)
================================ */

const ENDPOINT = import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";
const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

/* ===============================
   Fullscreen container
================================ */

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Missing <div id='app'></div> in index.html");

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";

appEl.style.position = "fixed";
appEl.style.left = "0";
appEl.style.top = "0";
appEl.style.width = "100vw";
appEl.style.height = "100vh";
appEl.style.overflow = "hidden";

/* ===============================
   Overlay UI
================================ */

const overlay = document.createElement("div");
overlay.style.position = "fixed";
overlay.style.left = "10px";
overlay.style.top = "10px";
overlay.style.padding = "8px 10px";
overlay.style.fontFamily = "system-ui, sans-serif";
overlay.style.fontSize = "12px";
overlay.style.background = "rgba(0,0,0,0.55)";
overlay.style.color = "#fff";
overlay.style.borderRadius = "8px";
overlay.style.zIndex = "9999";
overlay.style.userSelect = "none";
document.body.appendChild(overlay);

/* ===============================
   NOA Engine boot
================================ */

const noa = new Engine({
  debug: true,
  container: appEl,
  playerStart: [0, 10, 0],
  tickRate: 30,
  maxRenderRate: 0,
});

/* ===============================
   Block IDs + Materials + Blocks
================================ */

const AIR_ID = 0;
const GRASS_ID = 1;
const DIRT_ID = 2;
const STONE_ID = 3;
const SAND_ID = 4;
const WOOD_ID = 5;
const LEAVES_ID = 6;

noa.registry.registerMaterial("grass", { color: [0.25, 0.75, 0.25] });
noa.registry.registerMaterial("dirt", { color: [0.45, 0.3, 0.18] });
noa.registry.registerMaterial("stone", { color: [0.55, 0.55, 0.58] });
noa.registry.registerMaterial("sand", { color: [0.85, 0.8, 0.55] });
noa.registry.registerMaterial("wood", { color: [0.45, 0.28, 0.15] });
noa.registry.registerMaterial("leaves", { color: [0.18, 0.55, 0.18] });

noa.registry.registerBlock(GRASS_ID, { material: "grass", solid: true, opaque: true });
noa.registry.registerBlock(DIRT_ID, { material: "dirt", solid: true, opaque: true });
noa.registry.registerBlock(STONE_ID, { material: "stone", solid: true, opaque: true });
noa.registry.registerBlock(SAND_ID, { material: "sand", solid: true, opaque: true });
noa.registry.registerBlock(WOOD_ID, { material: "wood", solid: true, opaque: true });
noa.registry.registerBlock(LEAVES_ID, { material: "leaves", solid: true, opaque: true });

/* ===============================
   Hotbar (1-6)
================================ */

type Placeable = { id: number; name: string };

const hotbar: Placeable[] = [
  { id: GRASS_ID, name: "Grass" },
  { id: DIRT_ID, name: "Dirt" },
  { id: STONE_ID, name: "Stone" },
  { id: SAND_ID, name: "Sand" },
  { id: WOOD_ID, name: "Wood" },
  { id: LEAVES_ID, name: "Leaves" },
];

let selectedHotbarIndex = 0;

let worldDataNeededCount = 0;

function renderOverlay(statusLine: string) {
  const hb = hotbar
    .map((b, i) => (i === selectedHotbarIndex ? `[${i + 1}:${b.name}]` : `${i + 1}:${b.name}`))
    .join("  ");

  overlay.innerHTML =
    `Click to lock mouse • WASD move • Space jump<br/>` +
    `Left click mine • Right click place • 1-6 select block<br/>` +
    `Endpoint: ${ENDPOINT}<br/>${statusLine}<br/>` +
    `worldDataNeeded: ${worldDataNeededCount}<br/>` +
    `Hotbar: ${hb}`;
}

renderOverlay("Connecting...");

document.addEventListener("keydown", (e) => {
  const n = Number(e.key);
  if (n >= 1 && n <= hotbar.length) {
    selectedHotbarIndex = n - 1;
    renderOverlay(room ? `Connected ✔ (${room.sessionId})` : "Connecting...");
  }
});

/* ===============================
   World generation hook (kept, but instrumented)
   If this NEVER increments, your generator is not being used.
================================ */

const worldAny = noa.world as any;

if (worldAny && typeof worldAny.on === "function") {
  worldAny.on(
    "worldDataNeeded",
    (requestID: any, dataArr: any, _chunkX: number, _chunkY: number, _chunkZ: number) => {

      worldDataNeededCount++;
      // For now, leave chunks empty (AIR) to avoid confusing results.
      // We'll re-enable procedural terrain after mining/building is confirmed working.
      const shape: [number, number, number] = dataArr.shape;
      for (let i = 0; i < shape[0]; i++) {
        for (let j = 0; j < shape[1]; j++) {
          for (let k = 0; k < shape[2]; k++) {
            dataArr.set(i, j, k, AIR_ID);
          }
        }
      }
      noa.world.setChunkData(requestID, dataArr);
    }
  );
}

/* ===============================
   TEST PLATFORM (forces real voxels)
   If mining/building works after this, picker + networking are correct.
================================ */

function buildTestPlatform() {
  // A 41x41 grass platform at y=2, with dirt under it (Minecraft-ish)
  const yTop = 2;

  for (let x = -20; x <= 20; x++) {
    for (let z = -20; z <= 20; z++) {
      noa.world.setBlockID(DIRT_ID, x, yTop - 1, z);
      noa.world.setBlockID(GRASS_ID, x, yTop, z);

      // small stone pillar at origin for easy targeting
      if (x === 0 && z === 0) {
        for (let y = yTop + 1; y <= yTop + 4; y++) {
          noa.world.setBlockID(STONE_ID, x, y, z);
        }
      }
    }
  }

  console.log("✅ Test platform placed (real voxels) at y=2");
}

// Wait a moment so the scene is ready, then place blocks
setTimeout(buildTestPlatform, 250);

/* ===============================
   Picking helpers (stable Minecraft-style)
================================ */

type PickResult = {
  block: { x: number; y: number; z: number };
  place: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
};

function getPick(maxDist = 6): PickResult | null {
  const pickFn = (noa as any).pick;
  if (typeof pickFn !== "function") return null;

  const hit = pickFn.call(noa, null, null, maxDist, null);
  if (!hit) return null;

  const n = hit.normal ?? { x: 0, y: 0, z: 0 };
  const nx0 = Array.isArray(n) ? n[0] : n.x;
  const ny0 = Array.isArray(n) ? n[1] : n.y;
  const nz0 = Array.isArray(n) ? n[2] : n.z;

  const nx = Math.sign(Math.round(nx0));
  const ny = Math.sign(Math.round(ny0));
  const nz = Math.sign(Math.round(nz0));

  const voxel = hit.voxel ?? hit.voxelCoords;

  let bx: number;
  let by: number;
  let bz: number;

  if (voxel) {
    bx = Math.floor(Array.isArray(voxel) ? voxel[0] : voxel.x);
    by = Math.floor(Array.isArray(voxel) ? voxel[1] : voxel.y);
    bz = Math.floor(Array.isArray(voxel) ? voxel[2] : voxel.z);
  } else {
    const p = hit.position ?? hit.pos;
    if (!p) return null;

    const px = Array.isArray(p) ? p[0] : p.x;
    const py = Array.isArray(p) ? p[1] : p.y;
    const pz = Array.isArray(p) ? p[2] : p.z;

    const eps = 0.001;
    bx = Math.floor(px - nx * eps);
    by = Math.floor(py - ny * eps);
    bz = Math.floor(pz - nz * eps);
  }

  const px2 = bx + nx;
  const py2 = by + ny;
  const pz2 = bz + nz;

  return {
    block: { x: bx, y: by, z: bz },
    place: { x: px2, y: py2, z: pz2 },
    normal: { x: nx, y: ny, z: nz },
  };
}

/* ===============================
   Mining + Building
================================ */

function tryMine() {
  if (!room) return;

  const pick = getPick(6);
  if (!pick) {
    console.log("Pick: no hit");
    return;
  }

  const hitId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  console.log("Mine pick:", pick, "hitId:", hitId);

  if (hitId === 0) return;

  room.send("mineBlock", { x: pick.block.x, y: pick.block.y, z: pick.block.z });
}

function tryPlace() {
  if (!room) return;

  const pick = getPick(6);
  if (!pick) {
    console.log("Pick: no hit");
    return;
  }

  const hitId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  const placeId = noa.world.getBlockID(pick.place.x, pick.place.y, pick.place.z);
  const selected = hotbar[selectedHotbarIndex];

  console.log("Place pick:", pick, "hitId:", hitId, "placeId:", placeId, "placing:", selected);

  if (hitId === 0) return;
  if (placeId !== 0) return;

  room.send("placeBlock", { x: pick.place.x, y: pick.place.y, z: pick.place.z, id: selected.id });
}

document.addEventListener("mousedown", (e) => {
  if (e.button === 2) e.preventDefault();

  if (e.button === 0) {
    tryMine();
  } else if (e.button === 2) {
    tryPlace();
  }
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

/* ===============================
   Colyseus connect + handlers
================================ */

async function connectToServer() {
  try {
    room = await colyseus.joinOrCreate("my_room");
    renderOverlay(`Connected ✔ (${room.sessionId})`);
    console.log("Connected:", room.name, room.sessionId);

    room.onMessage("blockUpdate", (msg: any) => {
      if (!msg) return;
      noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
    });

    // no server corrections for local player yet
    room.onMessage("playerTransform", (_data: any) => {});

    room.onMessage("*", (messageType: string | number, payload: unknown) => {
      console.log("Server message:", messageType, payload);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    renderOverlay("Connection failed ❌");
  }
}

connectToServer();

/* ===============================
   Send position to server each tick (throttled)
================================ */

const noaAny = noa as any;
let lastSend = 0;

noaAny.on("tick", () => {
  if (!room) return;

  const now = performance.now();
  if (now - lastSend < 80) return;
  lastSend = now;

  const pos = noa.ents.getPosition(noa.playerEntity);
  room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
});

console.log("NOA + Colyseus client started.");
