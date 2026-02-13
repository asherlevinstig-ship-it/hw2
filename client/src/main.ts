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
overlay.innerHTML = `Click to lock mouse • WASD move • Space jump<br/>Endpoint: ${ENDPOINT}<br/>Connecting...`;
document.body.appendChild(overlay);

/* ===============================
   Block IDs
================================ */

const AIR_ID = 0;
const GRASS_ID = 1;
const STONE_ID = 2;

/* ===============================
   NOA Engine boot
================================ */

const noa = new Engine({
  debug: true,
  // make sure NOA uses #app as its container
  container: appEl,
  // start close to ground so you can see terrain immediately
  playerStart: [0, 6, 0],
  tickRate: 30,
  maxRenderRate: 0,
});

/* ===============================
   Register materials + blocks (simple colors)
================================ */

noa.registry.registerMaterial("grass", { color: [0.25, 0.75, 0.25] });
noa.registry.registerMaterial("stone", { color: [0.55, 0.55, 0.58] });

noa.registry.registerBlock(GRASS_ID, { material: "grass", solid: true, opaque: true });
noa.registry.registerBlock(STONE_ID, { material: "stone", solid: true, opaque: true });

/* ===============================
   World generation (THIS is the key)
   NOA v0.33 expects you to handle `noa.world` event: worldDataNeeded
================================ */

// TS typings in some builds don’t expose EventEmitter methods on `World`,
// but runtime supports `.on`. Cast to any to hook events cleanly.
const worldAny = noa.world as any;

let loggedOnce = false;

worldAny.on(
  "worldDataNeeded",
  (requestID: any, dataArr: any, x: number, y: number, z: number, _worldName: string) => {
    if (!loggedOnce) {
      console.log("worldDataNeeded fired:", { x, y, z, shape: dataArr.shape });
      loggedOnce = true;
    }

    const shape: [number, number, number] = dataArr.shape;

    for (let i = 0; i < shape[0]; i++) {
      for (let j = 0; j < shape[1]; j++) {
        for (let k = 0; k < shape[2]; k++) {
          // dataArr includes 1-voxel padding around the chunk
          const wy = y + j - 1;

          let id = AIR_ID;
          if (wy <= 0) id = GRASS_ID;
          if (wy <= -3) id = STONE_ID;

          dataArr.set(i, j, k, id);
        }
      }
    }

    // Provide the chunk back to NOA
    noa.world.setChunkData(requestID, dataArr);
  }
);

/* ===============================
   Colyseus connect + handlers
================================ */

async function connectToServer() {
  try {
    room = await colyseus.joinOrCreate("my_room");

    overlay.innerHTML = `Click to lock mouse • WASD move • Space jump<br/>Endpoint: ${ENDPOINT}<br/>Connected ✔ (${room.sessionId})`;
    console.log("Connected:", room.name, room.sessionId);

    room.onMessage("playerTransform", (data: any) => {
      if (!data) return;
      noa.ents.setPosition(noa.playerEntity, data.x, data.y, data.z);
    });

    room.onMessage("*", (messageType: string | number, payload: unknown) => {
      console.log("Server message:", messageType, payload);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    overlay.innerHTML = `Click to lock mouse • WASD move • Space jump<br/>Endpoint: ${ENDPOINT}<br/>Connection failed ❌`;
  }
}

connectToServer();

/* ===============================
   Send position to server each tick (temporary)
================================ */

// Engine is an EventEmitter; typings may not show it, so cast for .on
const noaAny = noa as any;

noaAny.on("tick", () => {
  if (!room) return;

  const pos = noa.ents.getPosition(noa.playerEntity);
  room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
});

console.log("NOA + Colyseus client started.");
