import { Engine } from "noa-engine";

/**
 * Minimal NOA boot:
 * - Flat terrain at y <= 0
 * - Two block types: grass + stone (simple colors)
 * - Default NOA player movement + mouse look
 */

const noa = new Engine({
  debug: true,
  // Start above the terrain so you fall onto it
  playerStart: [0, 20, 0],

  // These are safe defaults to keep it light while testing
  tickRate: 30,
  maxRenderRate: 0, // uncapped
  // You can tweak these later once it’s running
  // (they’re consumed by child modules too)
});

// --- Make the page fill the screen nicely ---
document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";

// Optional: show a tiny overlay
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
overlay.innerHTML = `Click to lock mouse • WASD move • Space jump • Shift sprint`;
document.body.appendChild(overlay);

// --- Register materials (simple colors) ---
noa.registry.registerMaterial("grass", {
  // [R,G,B] or [R,G,B,A] floats 0..1
  color: [0.25, 0.75, 0.25],
});

noa.registry.registerMaterial("stone", {
  color: [0.55, 0.55, 0.58],
});

// --- Register blocks (IDs must be 1..65535; 0 is air) ---
const GRASS_ID = 1;
const STONE_ID = 2;

noa.registry.registerBlock(GRASS_ID, {
  material: "grass",
  solid: true,
  opaque: true,
});

noa.registry.registerBlock(STONE_ID, {
  material: "stone",
  solid: true,
  opaque: true,
});

// --- World generation ---
// NOA asks you for chunk voxel data via `worldDataNeeded`.
// Fill the provided `data` (includes 1-voxel padding all around), then call setChunkData.
noa.world.on("worldDataNeeded", (chunkId: any, data: any, x: number, y: number, z: number) => {
  const shape: [number, number, number] = data.shape; // e.g. [chunkSize+2, chunkSize+2, chunkSize+2]

  for (let i = 0; i < shape[0]; i++) {
    for (let j = 0; j < shape[1]; j++) {
      for (let k = 0; k < shape[2]; k++) {
        // data includes 1-voxel padding, so subtract 1 to map to world coords
        const wx = x + i - 1;
        const wy = y + j - 1;
        const wz = z + k - 1;

        // Simple flat world:
        // - stone below -3
        // - grass from -3..0
        // - air above 0
        let id = 0; // air
        if (wy <= 0) id = GRASS_ID;
        if (wy <= -3) id = STONE_ID;

        data.set(i, j, k, id);
      }
    }
  }

  noa.world.setChunkData(chunkId, data);
});

// Optional: add a little "tick" log if you want
// noa.on("tick", (dt: number) => {});

// You should now see terrain generate and be able to move.
console.log("NOA started", noa.version);
