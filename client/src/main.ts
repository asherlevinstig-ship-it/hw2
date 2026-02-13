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
  playerStart: [0, 10, 0], // Start high, fall down to the generated floor
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
   FIXED: World generation hook
   Generates a floor at Y=0 so you don't fall forever
================================ */

const worldAny = noa.world as any;

if (worldAny && typeof worldAny.on === "function") {
  worldAny.on(
    "worldDataNeeded",
    // We prefix _x and _z with underscore to suppress "unused variable" warnings
    (id: string, data: any, _x: number, y: number, _z: number) => {
      worldDataNeededCount++;

      // Populate chunk data
      // 'data' is an ndarray, but we can access it via .set(x, y, z, val)
      // Chunk size is usually 32
      for (let i = 0; i < 32; i++) {
        for (let j = 0; j < 32; j++) {
          for (let k = 0; k < 32; k++) {
            
            // Calculate global height
            const globalY = y * 32 + j;
            
            if (globalY === 0) {
                // Grass floor
                data.set(i, j, k, GRASS_ID);
            } else if (globalY < 0 && globalY >= -5) {
                // Dirt layer
                data.set(i, j, k, DIRT_ID);
            } else if (globalY < -5) {
                // Stone base
                data.set(i, j, k, STONE_ID);
            } else {
                // Air (implicit, but good to be explicit if reusing arrays)
                data.set(i, j, k, AIR_ID);
            }
          }
        }
      }

      // Tell engine chunk is ready
      noa.world.setChunkData(id, data);
    }
  );
}

/* ===============================
   Picking helpers (noa.targetedBlock)
================================ */

type PickResult = {
  block: { x: number; y: number; z: number };
  place: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
};

function getPick(): PickResult | null {
  const tgt = (noa as any).targetedBlock;
  if (!tgt) return null;

  const pos = tgt.position;
  const adj = tgt.adjacent;
  const norm = tgt.normal;

  if (!Array.isArray(pos) || !Array.isArray(adj) || !Array.isArray(norm)) return null;

  const [bx, by, bz] = pos;
  const [px, py, pz] = adj;
  const [nx, ny, nz] = norm;

  return {
    block: { x: bx, y: by, z: bz },
    place: { x: px, y: py, z: pz },
    normal: { x: nx ?? 0, y: ny ?? 0, z: nz ?? 0 },
  };
}

/* ===============================
   Mining + Building (optimistic local + server broadcast)
================================ */

function tryMine() {
  const pick = getPick();
  if (!pick) return;

  const hitId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  
  if (hitId === AIR_ID) return;

  console.log("⛏ Mine request:", pick.block, "ID:", hitId);

  // Optimistic local edit
  noa.world.setBlockID(AIR_ID, pick.block.x, pick.block.y, pick.block.z);

  // Tell server
  room?.send("mineBlock", { x: pick.block.x, y: pick.block.y, z: pick.block.z });
}

function tryPlace() {
  const pick = getPick();
  if (!pick) return;

  const placeId = noa.world.getBlockID(pick.place.x, pick.place.y, pick.place.z);
  const selected = hotbar[selectedHotbarIndex];

  if (placeId !== AIR_ID) return; // Can't place inside a block

  // Prevent placing inside player
  const ppos = noa.ents.getPosition(noa.playerEntity);
  const px0 = Math.floor(ppos[0]);
  const py0 = Math.floor(ppos[1]);
  const pz0 = Math.floor(ppos[2]);
  
  // Simple hitbox check (feet + head)
  if ((pick.place.x === px0 && pick.place.z === pz0) && 
      (pick.place.y === py0 || pick.place.y === py0 + 1)) {
      return; 
  }

  console.log("🧱 Place request:", pick.place, "Item:", selected.name);

  // Optimistic local edit
  noa.world.setBlockID(selected.id, pick.place.x, pick.place.y, pick.place.z);

  // Tell server
  room?.send("placeBlock", { x: pick.place.x, y: pick.place.y, z: pick.place.z, id: selected.id });
}

/* ===============================
   FIXED: Input Handling
   Using noa.inputs ensures clicks work during pointer lock
================================ */

// Bind actions
noa.inputs.bind('fire', 'H'); // Dummy key, we use mouse binding below
noa.inputs.bind('alt-fire', 'J'); // Dummy key

noa.inputs.down.on('fire', () => {
    if (noa.container.hasPointerLock) {
        tryMine();
    }
});

noa.inputs.down.on('alt-fire', () => {
    if (noa.container.hasPointerLock) {
        tryPlace();
    }
});

/* ===============================
   Colyseus connect + handlers
================================ */

async function connectToServer() {
  try {
    room = await colyseus.joinOrCreate("my_room");
    renderOverlay(`Connected ✔ (${room.sessionId})`);
    console.log("Connected:", room.name, room.sessionId);

    // Server -> Client: blockUpdate
    room.onMessage("blockUpdate", (msg: any) => {
      if (!msg) return;
      if (typeof msg.x !== "number" || typeof msg.y !== "number" || typeof msg.z !== "number") return;
      if (typeof msg.id !== "number") return;
      noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
    });

    // Server -> Client: other players' transforms
    room.onMessage("playerTransformOther", (_data: any) => {
      // TODO: Implement remote player entities
    });

    room.onMessage("existingPlayers", (players: any) => {
      console.log("existingPlayers:", players);
    });

    room.onMessage("playerJoined", (p: any) => {
      console.log("playerJoined:", p);
    });

    room.onMessage("playerLeft", (p: any) => {
      console.log("playerLeft:", p);
    });

    room.onMessage("pong", (payload: any) => {
      console.log("pong:", payload);
    });

  } catch (err) {
    console.error("Failed to connect:", err);
    room = null;
    renderOverlay("Connection failed ❌");
  }
}

connectToServer();

/* ===============================
   Send position to server each tick
================================ */

const noaAny = noa as any;
let lastSend = 0;

noaAny.on("tick", () => {
  const r = room;
  if (!r) return;

  const now = performance.now();
  if (now - lastSend < 50) return; // Throttled to ~20hz
  lastSend = now;

  const pos = noa.ents.getPosition(noa.playerEntity);
  r.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
});

console.log("NOA + Colyseus client started.");