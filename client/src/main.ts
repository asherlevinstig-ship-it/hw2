/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 */

import { Client, Room } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core/Legacy/legacy";
import * as NoaModule from "noa-engine";

type Vec3 = { x: number; y: number; z: number };

type WorldDataNeededMsg = {
  chunkSize: number;
  coords: { x: number; y: number; z: number } | Record<string, unknown>;
};

type ChunkDataMsg = {
  coords: { x: number; y: number; z: number } | Record<string, unknown>;
  voxels: number[] | Uint8Array | string;
  palette?: number[];
};

type YouJoinedMsg = { id: string };
type PlayerJoinedMsg = { id: string; position?: Vec3 };
type PlayerLeftMsg = { id: string };
type PlayerUpdateMsg = { id: string; position: Vec3; heading?: number; pitch?: number };

declare global {
  interface Window {
    BABYLON?: typeof BABYLON;
  }
}

void (async function boot(): Promise<void> {
  try {
    // expose BABYLON global for any code that expects it
    window.BABYLON = BABYLON;

    const canvas = ensureCanvas();

    const endpoint =
      (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_COLYSEUS_ENDPOINT ||
      `${location.protocol}//${location.hostname}:2567`;

    const client = new Client(endpoint);

    // Change "world" if your room name differs
    const room = await joinRoom(client, "world");

    console.log("✅ Joined room successfully");

    const noa = createNoaEngine({ canvas });

    ensureBasicLighting(noa);
    keepCanvasSized(noa, canvas);

    const avatars = new Map<string, BABYLON.TransformNode>();

    setupWorldStreaming(noa, room);
    setupPlayerNetworking(noa, room, avatars);
    setupLocalControls(noa, room);

    console.log("✅ Client booted", { endpoint });
  } catch (err) {
    console.error("❌ Boot error:", err);
    showFatalOverlay(err);
  }
})();

/* ----------------------------- */
/* Canvas helpers */
/* ----------------------------- */

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.querySelector("canvas#game") as HTMLCanvasElement | null;
  if (existing) {
    sizeCanvas(existing);
    window.addEventListener("resize", () => sizeCanvas(existing));
    return existing;
  }

  const canvas = document.createElement("canvas");
  canvas.id = "game";
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.display = "block";
  canvas.style.background = "#000";

  document.body.style.margin = "0";
  document.body.appendChild(canvas);

  sizeCanvas(canvas);
  window.addEventListener("resize", () => sizeCanvas(canvas));

  return canvas;
}

function sizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/* ----------------------------- */
/* Colyseus helpers */
/* ----------------------------- */

async function joinRoom(client: Client, roomName: string): Promise<Room> {
  try {
    const room = await client.joinOrCreate(roomName);
    return room;
  } catch (e) {
    console.warn(`⚠️ joinOrCreate("${roomName}") failed, trying join("${roomName}")...`, e);
    const room = await client.join(roomName);
    return room;
  }
}

/* ----------------------------- */
/* noa-engine creation */
/* ----------------------------- */

function createNoaEngine(opts: { canvas: HTMLCanvasElement }): any {
  const modAny = NoaModule as unknown as Record<string, unknown>;

  const createNoa =
    (modAny.default as unknown as ((o: unknown) => any) | undefined) ??
    (modAny as unknown as (o: unknown) => any);

  if (typeof createNoa !== "function") {
    throw new Error("noa-engine import is not callable. Check noa-engine version/bundler.");
  }

  const noa = createNoa({
    debug: true,
    canvas: opts.canvas,
    showFPS: true,
  });

  // Click to pointer-lock (optional)
  opts.canvas.addEventListener("click", () => {
    opts.canvas.requestPointerLock?.();
  });

  return noa;
}

/* ----------------------------- */
/* Rendering / lighting safety */
/* ----------------------------- */

function ensureBasicLighting(noa: any): void {
  const scene: BABYLON.Scene | undefined =
    (noa?.rendering?.getScene?.() as BABYLON.Scene | undefined) ||
    (noa?.rendering?._scene as BABYLON.Scene | undefined);

  if (!scene) {
    console.warn("⚠️ Babylon scene not found on noa.rendering.");
    return;
  }

  const hasLight = Array.isArray(scene.lights) && scene.lights.length > 0;
  if (!hasLight) {
    const hemi = new BABYLON.HemisphericLight(
      "hemi",
      new BABYLON.Vector3(0.2, 1, 0.2),
      scene
    );
    hemi.intensity = 0.9;

    const dir = new BABYLON.DirectionalLight(
      "dir",
      new BABYLON.Vector3(-0.4, -1, -0.2),
      scene
    );
    dir.intensity = 0.6;
  }
}

function keepCanvasSized(noa: any, canvas: HTMLCanvasElement): void {
  window.addEventListener("resize", () => {
    sizeCanvas(canvas);
    try {
      noa?.rendering?.resize?.();
    } catch {
      // ignore
    }
  });
}

/* ----------------------------- */
/* World streaming */
/* ----------------------------- */

function setupWorldStreaming(noa: any, room: Room): void {
  noa.world?.on?.("worldDataNeeded", (chunk: unknown) => {
    const cAny = chunk as Record<string, unknown>;
    const msg: WorldDataNeededMsg = {
      chunkSize: (cAny.chunkSize as number) ?? 24,
      coords: (cAny.coords as any) ?? { x: 0, y: 0, z: 0 },
    };

    room.send("worldDataNeeded", msg);
  });

  room.onMessage("chunkData", (data: ChunkDataMsg) => {
    applyChunkToNoa(noa, data);
  });

  room.onMessage("worldData", (data: ChunkDataMsg) => {
    applyChunkToNoa(noa, data);
  });
}

function applyChunkToNoa(noa: any, data: ChunkDataMsg): void {
  try {
    const coords = data.coords as any;

    if (typeof noa.world?.setChunkData === "function") {
      noa.world.setChunkData(coords, data.voxels);
      return;
    }

    console.warn("⚠️ Received chunk data but noa.world.setChunkData is missing.", data);
  } catch (e) {
    console.error("❌ Failed applying chunk:", e, data);
  }
}

/* ----------------------------- */
/* Player networking / avatars */
/* ----------------------------- */

function setupPlayerNetworking(
  noa: any,
  room: Room,
  avatars: Map<string, BABYLON.TransformNode>
): void {
  let myId: string | null = null;

  room.onMessage("youJoined", (msg: YouJoinedMsg) => {
    myId = msg.id;
    console.log("🟦 youJoined:", msg);
  });

  room.onMessage("existingPlayers", (players: PlayerJoinedMsg[]) => {
    console.log("👋 Existing players:", players);
    for (const p of players) {
      if (!avatars.has(p.id)) {
        avatars.set(p.id, createAvatar(noa, p.id, p.position));
      }
    }
  });

  room.onMessage("playerJoined", (p: PlayerJoinedMsg) => {
    if (avatars.has(p.id)) return;
    avatars.set(p.id, createAvatar(noa, p.id, p.position));
  });

  room.onMessage("playerLeft", (p: PlayerLeftMsg) => {
    const node = avatars.get(p.id);
    if (node) node.dispose();
    avatars.delete(p.id);
  });

  room.onMessage("playerUpdate", (u: PlayerUpdateMsg) => {
    if (myId && u.id === myId) return;

    const node = avatars.get(u.id);
    if (!node) return;

    node.position.set(u.position.x, u.position.y, u.position.z);

    if (typeof u.heading === "number") node.rotation.y = u.heading;
    if (typeof u.pitch === "number") node.rotation.x = u.pitch;
  });
}

function createAvatar(noa: any, id: string, pos?: Vec3): BABYLON.TransformNode {
  const scene: BABYLON.Scene | undefined =
    (noa?.rendering?.getScene?.() as BABYLON.Scene | undefined) ||
    (noa?.rendering?._scene as BABYLON.Scene | undefined);

  if (!scene) {
    throw new Error("Babylon scene not available. Cannot create avatar.");
  }

  const root = new BABYLON.TransformNode(`avatar:${id}`, scene);
  root.position.set(pos?.x ?? 0, pos?.y ?? 2, pos?.z ?? 0);

  const body = BABYLON.MeshBuilder.CreateBox(
    `avatarBody:${id}`,
    { width: 0.8, height: 1.6, depth: 0.8 },
    scene
  );
  body.parent = root;
  body.position.y = 0.8;

  return root;
}

/* ----------------------------- */
/* Local controls */
/* ----------------------------- */

function setupLocalControls(noa: any, room: Room): void {
  const keys = new Set<string>();

  window.addEventListener("keydown", (e: KeyboardEvent) => keys.add(e.code));
  window.addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.code));

  window.addEventListener("mousemove", (e: MouseEvent) => {
    const canvasEl = (noa?.rendering?.canvas as Element | undefined) ?? null;
    if (document.pointerLockElement !== canvasEl) return;

    const sensitivity = 0.0025;
    const dx = e.movementX * sensitivity;
    const dy = e.movementY * sensitivity;

    if (typeof noa.camera?.heading === "number") noa.camera.heading -= dx;

    if (typeof noa.camera?.pitch === "number") {
      noa.camera.pitch = clamp(noa.camera.pitch - dy, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    }
  });

  const tickHz = 20;
  let acc = 0;

  noa.on?.("tick", (dt: number) => {
    acc += dt;
    if (acc < 1 / tickHz) return;
    acc = 0;

    const input = {
      forward: keys.has("KeyW"),
      back: keys.has("KeyS"),
      left: keys.has("KeyA"),
      right: keys.has("KeyD"),
      jump: keys.has("Space"),
      heading: noa.camera?.heading ?? 0,
      pitch: noa.camera?.pitch ?? 0,
    };

    room.send("input", input);
  });
}

/* ----------------------------- */
/* Fatal overlay */
/* ----------------------------- */

function showFatalOverlay(err: unknown): void {
  const msg =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);

  const pre = document.createElement("pre");
  pre.textContent = msg;
  pre.style.position = "fixed";
  pre.style.left = "0";
  pre.style.top = "0";
  pre.style.right = "0";
  pre.style.bottom = "0";
  pre.style.margin = "0";
  pre.style.padding = "16px";
  pre.style.background = "rgba(0,0,0,0.92)";
  pre.style.color = "#fff";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  pre.style.zIndex = "99999";
  document.body.appendChild(pre);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
