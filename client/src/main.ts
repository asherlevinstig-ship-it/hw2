import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";

/* ===============================
   1. Colyseus Setup
================================ */
// Use local endpoint or Vercel environment variable
const ENDPOINT = import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";
const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

/* ===============================
   2. DOM & CSS Setup
================================ */
const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Missing <div id='app'></div> in index.html");

// CRITICAL: Prevent the browser right-click menu so we can use it for placing blocks
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Ensure the container fills the screen
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
overlay.style.pointerEvents = "none"; // Clicks pass through to game
overlay.style.userSelect = "none";
overlay.style.zIndex = "100";
document.body.appendChild(overlay);

/* ===============================
   4. NOA Engine Initialization
================================ */
const noa = new Engine({
  debug: true,
  container: appEl,
  inverseY: false,         // Standard FPS controls
  playerStart: [0, 20, 0], // Start high up to avoid spawning in ground
  tickRate: 30,            // Tick rate
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

// Materials (Colors)
noa.registry.registerMaterial("grass", { color: [0.2, 0.8, 0.2] });
noa.registry.registerMaterial("dirt", { color: [0.5, 0.35, 0.15] });
noa.registry.registerMaterial("stone", { color: [0.5, 0.5, 0.5] });
noa.registry.registerMaterial("wood", { color: [0.4, 0.25, 0.1] });
noa.registry.registerMaterial("leaves", { color: [0.1, 0.6, 0.1] });

// Blocks
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

// Handle number keys for hotbar
document.addEventListener("keydown", (e) => {
  const key = parseInt(e.key);
  if (key > 0 && key <= hotbar.length) {
    selectedSlot = key - 1;
    updateOverlay();
  }
});

/* ===============================
   7. Terrain Generation (Hills)
================================ */
const worldAny = noa.world as any;

// "_x" and "_z" are unused variables, prefixed with _ to silence TypeScript
worldAny.on("worldDataNeeded", (id: string, data: any, x: number, y: number, z: number) => {
  // Loop through the chunk's local coordinates (0-31)
  for (let i = 0; i < 32; i++) {
    for (let k = 0; k < 32; k++) {
      
      // Calculate global coordinates
      const globalX = x * 32 + i;
      const globalZ = z * 32 + k;

      // Generate height using Sine waves (Hills)
      const height = Math.floor(
        Math.sin(globalX / 15) * 6 + 
        Math.cos(globalZ / 15) * 6
      );

      for (let j = 0; j < 32; j++) {
        // Calculate global height
        const globalY = y * 32 + j;

        if (globalY > height) {
          // Air
          data.set(i, j, k, AIR_ID);
        } else if (globalY === height) {
          // Top Layer
          data.set(i, j, k, GRASS_ID);
        } else if (globalY > height - 4) {
          // Middle Layer
          data.set(i, j, k, DIRT_ID);
        } else {
          // Bottom Layer
          data.set(i, j, k, STONE_ID);
        }
      }
    }
  }
  // Send data back to engine
  noa.world.setChunkData(id, data);
});

/* ===============================
   8. Input & Interaction Logic
================================ */

// Helper to get targeted block info
function getTargetInfo() {
  const tgt = (noa as any).targetedBlock;
  
  if (!tgt || !tgt.position) return null;

  return {
    // The block we are looking at
    pos: {
      x: tgt.position[0],
      y: tgt.position[1],
      z: tgt.position[2],
    },
    // The empty space next to it (for placing)
    adj: {
      x: tgt.adjacent[0],
      y: tgt.adjacent[1],
      z: tgt.adjacent[2],
    }
  };
}

// Action: Mine (Left Click)
noa.inputs.down.on('fire', () => {
  // 1. Ensure pointer is locked (game is active)
  if (!noa.container.hasPointerLock) {
    return; // The engine handles locking on first click
  }

  // 2. Get Target
  const target = getTargetInfo();
  if (!target) return; // Looking at sky or too far away

  const { x, y, z } = target.pos;

  // 3. Update Local World (Instant feedback)
  console.log(`⛏ Mining at ${x}, ${y}, ${z}`);
  noa.world.setBlockID(AIR_ID, x, y, z);

  // 4. Send to Server
  room?.send("mineBlock", { x, y, z });
});

// Action: Place (Right Click)
noa.inputs.down.on('alt-fire', () => {
  // 1. Ensure pointer is locked
  if (!noa.container.hasPointerLock) return;

  // 2. Get Target
  const target = getTargetInfo();
  if (!target) return;

  const { x, y, z } = target.adj;
  const blockToPlace = hotbar[selectedSlot].id;

  // 3. Collision Check (Don't place block inside player)
  const entPos = noa.ents.getPosition(noa.playerEntity);
  const px = Math.floor(entPos[0]);
  const py = Math.floor(entPos[1]);
  const pz = Math.floor(entPos[2]);

  // Check feet and head positions
  if (x === px && z === pz && (y === py || y === py + 1)) {
    console.log("❌ Cannot place block: Player is standing here.");
    return; 
  }

  // 4. Update Local World
  console.log(`🧱 Placing block ${blockToPlace} at ${x}, ${y}, ${z}`);
  noa.world.setBlockID(blockToPlace, x, y, z);

  // 5. Send to Server
  room?.send("placeBlock", { x, y, z, id: blockToPlace });
});

/* ===============================
   9. Networking (Connect & Sync)
================================ */

async function connect() {
  try {
    updateOverlay(); // Show "Connecting..."
    
    // Join Room
    room = await colyseus.joinOrCreate("my_room");
    console.log("✅ Joined room:", room.sessionId);
    updateOverlay(); // Show "Online"

    // Listen for block updates from other players
    room.onMessage("blockUpdate", (msg: any) => {
      // msg format: { x, y, z, id }
      if (msg && typeof msg.id === "number") {
        noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
      }
    });

    // TODO: Add handlers for 'playerJoined', 'playerLeft', 'playerMove' here

  } catch (e) {
    console.error("Connection Error:", e);
    overlay.innerHTML += "<br><span style='color:red'>Connection Failed! Check console.</span>";
  }
}

// Start connection
connect();

/* ===============================
   10. Sync Position
================================ */

let tickCount = 0;
// Cast noa to any to fix TS error
(noa as any).on('tick', () => {
  tickCount++;
  // Send every 3rd tick (~10 times a second)
  if (room && tickCount % 3 === 0) {
    const pos = noa.ents.getPosition(noa.playerEntity);
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
  }
});