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
   World generation hook (FAST air fill)
================================ */

const worldAny = noa.world as any;
let testPlatformBuilt = false;

if (worldAny && typeof worldAny.on === "function") {
  worldAny.on(
    "worldDataNeeded",
    (requestID: any, dataArr: any, _chunkX: number, _chunkY: number, _chunkZ: number) => {
      worldDataNeededCount++;

      // Fast-path: entire chunk is AIR
      noa.world.setChunkData(requestID, dataArr, null, AIR_ID);

      // Build a client-side scaffold platform once, after first chunk request
      if (!testPlatformBuilt) {
        testPlatformBuilt = true;
        setTimeout(buildTestPlatform, 0);
      }
    }
  );
}

/* ===============================
   TEST PLATFORM (client-only scaffold)
================================ */

function buildTestPlatform() {
  const yTop = 2;

  for (let x = -20; x <= 20; x++) {
    for (let z = -20; z <= 20; z++) {
      noa.world.setBlockID(DIRT_ID, x, yTop - 1, z);
      noa.world.setBlockID(GRASS_ID, x, yTop, z);

      if (x === 0 && z === 0) {
        for (let y = yTop + 1; y <= yTop + 4; y++) {
          noa.world.setBlockID(STONE_ID, x, y, z);
        }
      }
    }
  }

  console.log("✅ Test platform placed (client voxels) at y=2");
}

/* ===============================
   Picking helpers (use noa.targetedBlock)
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

  if (
    typeof bx !== "number" ||
    typeof by !== "number" ||
    typeof bz !== "number" ||
    typeof px !== "number" ||
    typeof py !== "number" ||
    typeof pz !== "number"
  ) {
    return null;
  }

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
  if (!pick) {
    console.log("Pick: no hit");
    return;
  }

  const hitId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  console.log("Mine pick:", pick, "hitId:", hitId);

  if (hitId === AIR_ID) return;

  // Optimistic local edit (instant feel)
  noa.world.setBlockID(AIR_ID, pick.block.x, pick.block.y, pick.block.z);

  // Tell server (server broadcasts blockUpdate back)
  room?.send("mineBlock", { x: pick.block.x, y: pick.block.y, z: pick.block.z });
}

function tryPlace() {
  const pick = getPick();
  if (!pick) {
    console.log("Pick: no hit");
    return;
  }

  const hitId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  const placeId = noa.world.getBlockID(pick.place.x, pick.place.y, pick.place.z);
  const selected = hotbar[selectedHotbarIndex];

  console.log("Place pick:", pick, "hitId:", hitId, "placeId:", placeId, "placing:", selected);

  if (hitId === AIR_ID) return;
  if (placeId !== AIR_ID) return;

  // Prevent placing inside player's current voxel (simple guard)
  const ppos = noa.ents.getPosition(noa.playerEntity);
  const px0 = Math.floor(ppos[0]);
  const py0 = Math.floor(ppos[1]);
  const pz0 = Math.floor(ppos[2]);
  if (pick.place.x === px0 && pick.place.y === py0 && pick.place.z === pz0) return;

  // Optimistic local edit
  noa.world.setBlockID(selected.id, pick.place.x, pick.place.y, pick.place.z);

  // Tell server (server MUST implement placeBlock handler)
  room?.send("placeBlock", { x: pick.place.x, y: pick.place.y, z: pick.place.z, id: selected.id });
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

    // Server -> Client: blockUpdate
    room.onMessage("blockUpdate", (msg: any) => {
      if (!msg) return;
      if (typeof msg.x !== "number" || typeof msg.y !== "number" || typeof msg.z !== "number") return;
      if (typeof msg.id !== "number") return;
      noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
    });

    // Server -> Client: other players' transforms (placeholder, no unused param warning)
    room.onMessage("playerTransformOther", (_data: any) => {
      // Later: update remote player entities here
    });

    room.onMessage("existingPlayers", (players: any) => {
      console.log("existingPlayers:", players);
      // Later: spawn remote entities here
    });

    room.onMessage("playerJoined", (p: any) => {
      console.log("playerJoined:", p);
      // Later: spawn remote entity for p.id
    });

    room.onMessage("playerLeft", (p: any) => {
      console.log("playerLeft:", p);
      // Later: despawn remote entity for p.id
    });

    room.onMessage("pong", (payload: any) => {
      console.log("pong:", payload);
    });

    room.onMessage("*", (messageType: string | number, payload: unknown) => {
      console.log("Server message:", messageType, payload);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    room = null;
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
  const r = room;
  if (!r) return;

  const now = performance.now();
  if (now - lastSend < 80) return;
  lastSend = now;

  const pos = noa.ents.getPosition(noa.playerEntity);
  r.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
});

console.log("NOA + Colyseus client started.");
