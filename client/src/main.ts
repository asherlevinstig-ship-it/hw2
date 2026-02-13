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
overlay.innerHTML =
  `Click to lock mouse • WASD move • Space jump • Left click mine<br/>` +
  `Endpoint: ${ENDPOINT}<br/>Connecting...`;
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
   Mining (ray-pick block and request server to remove it)
================================ */

function getTargetedBlock(maxDist = 6): { x: number; y: number; z: number } | null {
  const pick = (noa as any).pick;

  if (!pick || typeof pick.pickBlock !== "function") {
    console.warn("NOA pick.pickBlock not available:", pick);
    return null;
  }

  const hit = pick.pickBlock(maxDist);
  if (!hit) return null;

  const v = hit.voxel ?? hit.voxelCoords ?? hit.position ?? hit.pos;
  if (!v) return null;

  const x = Math.floor(Array.isArray(v) ? v[0] : v.x);
  const y = Math.floor(Array.isArray(v) ? v[1] : v.y);
  const z = Math.floor(Array.isArray(v) ? v[2] : v.z);

  return { x, y, z };
}

function tryMine() {
  if (!room) return;

  const target = getTargetedBlock(6);
  if (!target) {
    console.log("Mine: no target (ray hit nothing)");
    return;
  }

  const id = noa.world.getBlockID(target.x, target.y, target.z);
  console.log("Mine target:", target, "blockID:", id);

  if (id === 0) return;

  room.send("mineBlock", target);
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // left click
  tryMine();
});

/* ===============================
   Colyseus connect + handlers
================================ */

async function connectToServer() {
  try {
    room = await colyseus.joinOrCreate("my_room");

    overlay.innerHTML =
      `Click to lock mouse • WASD move • Space jump • Left click mine<br/>` +
      `Endpoint: ${ENDPOINT}<br/>Connected ✔ (${room.sessionId})`;
    console.log("Connected:", room.name, room.sessionId);

    room.onMessage("blockUpdate", (msg: any) => {
      console.log("blockUpdate:", msg);
      if (!msg) return;
      noa.world.setBlockID(msg.id, msg.x, msg.y, msg.z);
    });

    // Intentionally do NOT set our own position from server every tick (prevents jitter)
    room.onMessage("playerTransform", (_data: any) => {});

    room.onMessage("*", (messageType: string | number, payload: unknown) => {
      console.log("Server message:", messageType, payload);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    overlay.innerHTML =
      `Click to lock mouse • WASD move • Space jump • Left click mine<br/>` +
      `Endpoint: ${ENDPOINT}<br/>Connection failed ❌`;
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
