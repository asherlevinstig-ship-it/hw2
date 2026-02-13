import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";

/* ===============================
   Colyseus endpoint (Vercel + local fallback)
================================ */

const ENDPOINT = import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";
const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

/* ===============================
   Fullscreen container (Vite CSS often breaks canvas sizing)
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
   Overlay UI (includes hotbar)
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
  playerStart: [0, 8, 0],
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

function renderOverlay(statusLine: string) {
  const hb = hotbar
    .map((b, i) => (i === selectedHotbarIndex ? `[${i + 1}:${b.name}]` : `${i + 1}:${b.name}`))
    .join("  ");

  overlay.innerHTML =
    `Click to lock mouse • WASD move • Space jump<br/>` +
    `Left click mine • Right click place • 1-6 select block<br/>` +
    `Endpoint: ${ENDPOINT}<br/>${statusLine}<br/>` +
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
   Minecraft-ish terrain generator (no deps)
================================ */

function hash2(x: number, z: number): number {
  let n = x * 374761393 + z * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  n = n ^ (n >> 16);
  return (n >>> 0) / 4294967295;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2(x0, z0);
  const n10 = hash2(x1, z0);
  const n01 = hash2(x0, z1);
  const n11 = hash2(x1, z1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sz);
}

function fbm2D(x: number, z: number): number {
  let amp = 1;
  let freq = 0.03;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < 4; i++) {
    sum += valueNoise2D(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }

  return sum / norm;
}

function terrainHeight(wx: number, wz: number): number {
  const n = fbm2D(wx, wz);
  return Math.floor(n * 18 + 2);
}

function treeChance(wx: number, wz: number): boolean {
  const r = hash2(wx * 17, wz * 17);
  return r > 0.985;
}

function placeTree(
  dataArr: any,
  baseWX: number,
  baseWY: number,
  baseWZ: number,
  chunkX: number,
  chunkY: number,
  chunkZ: number
) {
  const h = 4 + Math.floor(hash2(baseWX, baseWZ) * 3);

  const toI = (wx: number) => wx - chunkX + 1;
  const toJ = (wy: number) => wy - chunkY + 1;
  const toK = (wz: number) => wz - chunkZ + 1;

  const shape = dataArr.shape as [number, number, number];
  const inBounds = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < shape[0] && j < shape[1] && k < shape[2];

  for (let t = 1; t <= h; t++) {
    const i = toI(baseWX);
    const j = toJ(baseWY + t);
    const k = toK(baseWZ);
    if (inBounds(i, j, k)) dataArr.set(i, j, k, WOOD_ID);
  }

  const topY = baseWY + h;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const dist = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (dist > 4) continue;

        const i = toI(baseWX + dx);
        const j = toJ(topY + dy);
        const k = toK(baseWZ + dz);

        if (!inBounds(i, j, k)) continue;

        const existing = dataArr.get(i, j, k);
        if (existing === AIR_ID) dataArr.set(i, j, k, LEAVES_ID);
      }
    }
  }
}

/* ===============================
   World generation hookup
================================ */

const worldAny = noa.world as any;

worldAny.on(
  "worldDataNeeded",
  (requestID: any, dataArr: any, chunkX: number, chunkY: number, chunkZ: number, _worldName?: string) => {
    const shape: [number, number, number] = dataArr.shape;
    const seaLevel = 2;

    for (let i = 0; i < shape[0]; i++) {
      for (let k = 0; k < shape[2]; k++) {
        const wx = chunkX + i - 1;
        const wz = chunkZ + k - 1;

        const h = terrainHeight(wx, wz);

        for (let j = 0; j < shape[1]; j++) {
          const wy = chunkY + j - 1;

          let id = AIR_ID;

          if (wy <= h) {
            const depth = h - wy;

            if (depth === 0) {
              id = h <= seaLevel + 1 ? SAND_ID : GRASS_ID;
            } else if (depth <= 3) {
              id = h <= seaLevel + 1 ? SAND_ID : DIRT_ID;
            } else {
              id = STONE_ID;
            }
          }

          dataArr.set(i, j, k, id);
        }

        if (treeChance(wx, wz)) {
          const baseY = h;
          const baseInThisChunk = baseY >= chunkY && baseY < chunkY + (shape[1] - 2);
          if (baseInThisChunk && h > seaLevel + 1) {
            placeTree(dataArr, wx, baseY, wz, chunkX, chunkY, chunkZ);
          }
        }
      }
    }

    noa.world.setChunkData(requestID, dataArr);
  }
);

/* ===============================
   Picking helpers (mine vs place)
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

  const pos = hit.position ?? hit.pos;
  if (!pos) return null;

  const px = Array.isArray(pos) ? pos[0] : pos.x;
  const py = Array.isArray(pos) ? pos[1] : pos.y;
  const pz = Array.isArray(pos) ? pos[2] : pos.z;

  const normal = hit.normal;
  const nx = normal ? (Array.isArray(normal) ? normal[0] : normal.x) : 0;
  const ny = normal ? (Array.isArray(normal) ? normal[1] : normal.y) : 0;
  const nz = normal ? (Array.isArray(normal) ? normal[2] : normal.z) : 0;

  const eps = 0.01;

  // Block we are looking at: nudge INTO surface
  const bx = Math.floor(px - nx * eps);
  const by = Math.floor(py - ny * eps);
  const bz = Math.floor(pz - nz * eps);

  // Place position: nudge OUT of surface (adjacent voxel)
  const px2 = Math.floor(px + nx * eps);
  const py2 = Math.floor(py + ny * eps);
  const pz2 = Math.floor(pz + nz * eps);

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
  if (!pick) return;

  const id = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  if (id === 0) return;

  room.send("mineBlock", { x: pick.block.x, y: pick.block.y, z: pick.block.z });
}

function tryPlace() {
  if (!room) return;

  const pick = getPick(6);
  if (!pick) return;

  // Must be aiming at a real block face
  const targetId = noa.world.getBlockID(pick.block.x, pick.block.y, pick.block.z);
  if (targetId === 0) return;

  // Place only into air
  const placeIdNow = noa.world.getBlockID(pick.place.x, pick.place.y, pick.place.z);
  if (placeIdNow !== 0) return;

  const selected = hotbar[selectedHotbarIndex];

  room.send("placeBlock", {
    x: pick.place.x,
    y: pick.place.y,
    z: pick.place.z,
    id: selected.id,
  });
}

// Left click mine, Right click place
document.addEventListener("mousedown", (e) => {
  if (e.button === 0) {
    tryMine();
  } else if (e.button === 2) {
    tryPlace();
  }
});

// Stop browser context menu on right click
document.addEventListener("contextmenu", (e) => e.preventDefault());

/* ===============================
   Colyseus connect + handlers
================================ */

async function connectToServer() {
  try {
    room = await colyseus.joinOrCreate("my_room");
    renderOverlay(`Connected ✔ (${room.sessionId})`);
    console.log("Connected:", room.name, room.sessionId);

    // Apply authoritative block updates
    room.onMessage("blockUpdate", (msg: any) => {
      if (!msg) return;
      noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
    });

    // No self-corrections (prevents jitter)
    room.onMessage("playerTransform", (_data: any) => {});

    // Debug
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
  if (now - lastSend < 80) return; // ~12.5 updates/sec
  lastSend = now;

  const pos = noa.ents.getPosition(noa.playerEntity);
  room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
});

console.log("NOA + Colyseus client started.");
