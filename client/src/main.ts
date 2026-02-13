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

  // Optional: uncomment if you WANT 32 explicitly
  // chunkSize: 32,
});

/* ===============================
   4.1 Pointer Lock (make sure it actually happens)
================================ */
appEl.addEventListener("click", () => {
  // NOA often manages this, but forcing it makes debugging easier
  const canvas = (noa as any).rendering?.getScene?.()?.getEngine?.()?.getRenderingCanvas?.();
  // Fallback: try locking on appEl
  const el: any = canvas ?? appEl;
  if (el?.requestPointerLock) el.requestPointerLock();
});

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

function updateOverlay() {
  const status = room ? `Online (${room.sessionId})` : "Connecting...";
  const currentBlock = hotbar[selectedSlot];

  overlay.innerHTML = `
    <strong>Status:</strong> ${status}<br>
    <strong>Holding:</strong> [${selectedSlot + 1}] ${currentBlock.name}<br>
    -------------------------<br>
    [L-Click] Mine  |  [R-Click] Place<br>
    [1-5] Select Block<br>
    [WASD] Move  |  [Space] Jump
  `;
}
updateOverlay();

document.addEventListener("keydown", (e) => {
  const key = parseInt(e.key);
  if (key > 0 && key <= hotbar.length) {
    selectedSlot = key - 1;
    updateOverlay();
  }
});

/* ===============================
   7. Terrain Generation (FIXED)
================================ */
const worldAny = noa.world as any;

let firstChunkLogged = false;

worldAny.on("worldDataNeeded", (id: string, data: any, x: number, y: number, z: number) => {
  // ✅ derive chunk size from data shape
  const CS = data.shape?.[0] ?? 32;

  if (!firstChunkLogged) {
    firstChunkLogged = true;
    console.log("✅ worldDataNeeded firing. chunkSize =", CS, "first chunk coords =", { x, y, z });
  }

  const baseHeight = 12; // ✅ prevents “all air” at y>=0

  for (let i = 0; i < CS; i++) {
    for (let k = 0; k < CS; k++) {
      const globalX = x * CS + i;
      const globalZ = z * CS + k;

      const height =
        baseHeight +
        Math.floor(Math.sin(globalX / 15) * 6 + Math.cos(globalZ / 15) * 6);

      for (let j = 0; j < CS; j++) {
        const globalY = y * CS + j;

        if (globalY > height) data.set(i, j, k, AIR_ID);
        else if (globalY === height) data.set(i, j, k, GRASS_ID);
        else if (globalY > height - 4) data.set(i, j, k, DIRT_ID);
        else data.set(i, j, k, STONE_ID);
      }
    }
  }

  noa.world.setChunkData(id, data);
});

/* ===============================
   8. Input & Interaction Logic
================================ */

// ✅ Ensure bindings exist (varies by noa setup)
try {
  (noa.inputs as any).bind?.("fire", "mouse1");
  (noa.inputs as any).bind?.("alt-fire", "mouse2");
} catch {
  // ignore if bind API differs
}

function getTargetInfo() {
  const tgt = (noa as any).targetedBlock;
  if (!tgt?.position || !tgt?.adjacent) return null;

  return {
    pos: { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] },
    adj: { x: tgt.adjacent[0], y: tgt.adjacent[1], z: tgt.adjacent[2] },
  };
}

let firstInputLogged = false;

noa.inputs.down.on("fire", () => {
  if (!firstInputLogged) {
    firstInputLogged = true;
    console.log("✅ Input firing (fire). pointerLock =", (noa.container as any).hasPointerLock);
  }

  if (!(noa.container as any).hasPointerLock) return;

  const target = getTargetInfo();
  if (!target) return;

  const { x, y, z } = target.pos;
  noa.world.setBlockID(AIR_ID, x, y, z);
  room?.send("mineBlock", { x, y, z });
});

noa.inputs.down.on("alt-fire", () => {
  if (!firstInputLogged) {
    firstInputLogged = true;
    console.log("✅ Input firing (alt-fire). pointerLock =", (noa.container as any).hasPointerLock);
  }

  if (!(noa.container as any).hasPointerLock) return;

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
   9. Networking (Connect & Sync)
================================ */
async function connect() {
  try {
    updateOverlay();

    room = await colyseus.joinOrCreate("my_room");
    console.log("✅ Joined room:", room.sessionId);
    updateOverlay();

    room.onMessage("blockUpdate", (msg: any) => {
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
      }
    });

    room.onMessage("existingPlayers", (players: any[]) => {
      console.log("👋 Existing players:", players);
    });

    room.onMessage("playerJoined", (p: any) => console.log("➕ Player joined:", p));
    room.onMessage("playerLeft", (p: any) => console.log("➖ Player left:", p));
    room.onMessage("playerTransformOther", (_p: any) => {});
  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed!</span>";
  }
}

connect();

/* ===============================
   10. Sync Position
================================ */
let tickCount = 0;
(noa as any).on("tick", () => {
  tickCount++;
  if (room && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
  }
});
