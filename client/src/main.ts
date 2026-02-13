import { Engine } from "noa-engine";
import { Client, Room } from "@colyseus/sdk";

const ENDPOINT =
  import.meta.env.VITE_COLYSEUS_ENDPOINT ?? "ws://localhost:2567";

const colyseus = new Client(ENDPOINT);
let room: Room | null = null;

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";

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

const AIR_ID = 0;
const GRASS_ID = 1;
const STONE_ID = 2;

const noa = new Engine({
  debug: true,
  playerStart: [0, 20, 0],
  tickRate: 30,
  maxRenderRate: 0,

  worldDataNeeded: (id: any, data: any, _x: number, y: number, _z: number) => {
    const shape: [number, number, number] = data.shape;

    for (let i = 0; i < shape[0]; i++) {
      for (let j = 0; j < shape[1]; j++) {
        for (let k = 0; k < shape[2]; k++) {
          const wy = y + j - 1;

          let block = AIR_ID;
          if (wy <= 0) block = GRASS_ID;
          if (wy <= -3) block = STONE_ID;

          data.set(i, j, k, block);
        }
      }
    }

    noa.world.setChunkData(id, data);
  },

  tick: () => {
    if (!room) return;

    const pos = noa.ents.getPosition(noa.playerEntity);
    room.send("playerMove", { x: pos[0], y: pos[1], z: pos[2] });
  },
});

noa.registry.registerMaterial("grass", { color: [0.25, 0.75, 0.25] });
noa.registry.registerMaterial("stone", { color: [0.55, 0.55, 0.58] });

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

console.log("NOA + Colyseus client started.");
