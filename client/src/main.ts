/* client/src/main.ts
 * FULL FILE - paste exactly as-is
 *
 * Fixes included:
 * 1) Colyseus room name: uses "my_room" (matches your server defineServer rooms key)
 * 2) noa-engine import: uses Engine class (noa-engine is not callable)
 * 3) Networking message alignment with your server:
 *    - client sends: "playerMove"
 *    - client receives: "playerTransformOther", "playersSnapshot", "playerJoined", "playerLeft", "existingPlayers", "youJoined"
 *
 * Notes:
 * - Your server currently does NOT implement chunk streaming messages ("worldDataNeeded", "chunkData", "worldData"),
 *   so this client does not request them. When you add server support later, you can re-add world streaming.
 */

import { Client, Room } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core/Legacy/legacy";
import { Engine as NoaEngine } from "noa-engine";

type Vec3 = { x: number; y: number; z: number };

type YouJoinedMsg = { id: string; x?: number; y?: number; z?: number; yaw?: number };
type PlayerJoinedMsg = { id: string; x?: number; y?: number; z?: number; yaw?: number };
type PlayerLeftMsg = { id: string };

type PlayerTransformOtherMsg = { id: string; x: number; y: number; z: number; yaw?: number };
type PlayersSnapshotMsg = Array<{ id: string; x: number; y: number; z: number; yaw?: number }>;

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

    // MUST match your server rooms key: rooms: { my_room: defineRoom(MyRoom) }
    const room = await joinRoom(client, "my_room");

    console.log("✅ Joined room successfully");

    const noa = createNoaEngine({ canvas });

    ensureBasicLighting(noa);
    keepCanvasSized(noa, canvas);

    const avatars = new Map<string, BABYLON.TransformNode>();

    setupPlayerNetworking(noa, room, avatars);
    setupLocalControls(noa, room);

    console.log("✅ Client booted", { endpoint, roomName: room.name, roomId: room.id });
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
  // noa-engine exports an Engine class. Instantiate with "new".
  const noa = new NoaEngine({
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
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.2), scene);
    hemi.intensity = 0.9;

    const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-0.4, -1, -0.2), scene);
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

    // If server provides a spawn, move local player there (optional)
    if (typeof msg.x === "number" && typeof msg.y === "number" && typeof msg.z === "number") {
      trySetLocalPlayerPosition(noa, { x: msg.x, y: msg.y, z: msg.z });
    }
  });

  room.onMessage("existingPlayers", (players: PlayerJoinedMsg[]) => {
    console.log("👋 Existing players:", players);
    for (const p of players) {
      if (!avatars.has(p.id)) {
        avatars.set(p.id, createAvatar(noa, p.id, toVec3(p)));
      }
    }
  });

  room.onMessage("playerJoined", (p: PlayerJoinedMsg) => {
    if (avatars.has(p.id)) return;
    avatars.set(p.id, createAvatar(noa, p.id, toVec3(p)));
  });

  room.onMessage("playerLeft", (p: PlayerLeftMsg) => {
    const node = avatars.get(p.id);
    if (node) node.dispose();
    avatars.delete(p.id);
  });

  // Server broadcast when someone else moves
  room.onMessage("playerTransformOther", (u: PlayerTransformOtherMsg) => {
    if (myId && u.id === myId) return;
    const node = avatars.get(u.id);
    if (!node) return;

    node.position.set(u.x, u.y, u.z);
    if (typeof u.yaw === "number") node.rotation.y = u.yaw;
  });

  // Server periodic snapshot of all players
  room.onMessage("playersSnapshot", (all: PlayersSnapshotMsg) => {
    for (const p of all) {
      if (myId && p.id === myId) continue;

      let node = avatars.get(p.id);
      if (!node) {
        node = createAvatar(noa, p.id, { x: p.x, y: p.y, z: p.z });
        avatars.set(p.id, node);
      } else {
        node.position.set(p.x, p.y, p.z);
      }
      if (typeof p.yaw === "number") node.rotation.y = p.yaw;
    }
  });
}

function toVec3(p: { x?: number; y?: number; z?: number }): Vec3 {
  return { x: p.x ?? 0, y: p.y ?? 2, z: p.z ?? 0 };
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
/* Local controls -> sends "playerMove" */
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

  const tickHz = 16; // server rate-limit is ~60ms, so 16Hz is safe
  let acc = 0;

  noa.on?.("tick", (dt: number) => {
    // Basic local movement (optional). If you already have noa movement controls, remove this.
    applyBasicNoaMovement(noa, keys, dt);

    acc += dt;
    if (acc < 1 / tickHz) return;
    acc = 0;

    const pos = getLocalPlayerPosition(noa);
    if (!pos) return;

    const yaw = typeof noa.camera?.heading === "number" ? noa.camera.heading : 0;

    // Send to server using message name it expects
    room.send("playerMove", { x: pos.x, y: pos.y, z: pos.z, yaw });
  });
}

/**
 * Minimal WASD movement so something actually moves even if noa controls aren't configured.
 * If you already have player physics/controls configured elsewhere, you can delete this.
 */
function applyBasicNoaMovement(noa: any, keys: Set<string>, dt: number): void {
  const speed = 6; // units per second
  const jumpSpeed = 7;

  const forward = keys.has("KeyW") ? 1 : 0;
  const back = keys.has("KeyS") ? 1 : 0;
  const left = keys.has("KeyA") ? 1 : 0;
  const right = keys.has("KeyD") ? 1 : 0;

  const dz = forward - back;
  const dx = right - left;

  const heading = typeof noa.camera?.heading === "number" ? noa.camera.heading : 0;

  // rotate input by camera heading
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const vx = (dx * cos - dz * sin) * speed;
  const vz = (dx * sin + dz * cos) * speed;

  // Try common noa player entity access patterns
  const ent = noa?.playerEntity;
  const bodies = noa?.entities?.getPhysicsBody ? noa.entities.getPhysicsBody(ent) : null;

  // If noa physics body is available, set velocity
  if (bodies?.velocity) {
    bodies.velocity[0] = vx;
    bodies.velocity[2] = vz;

    if (keys.has("Space")) {
      // naive jump, only if nearly not moving vertically
      if (Math.abs(bodies.velocity[1]) < 0.01) bodies.velocity[1] = jumpSpeed;
    }
    return;
  }

  // Fallback: if we can directly mutate position array
  const posArr: number[] | undefined =
    (noa?.entities?.getPosition && ent != null ? (noa.entities.getPosition(ent) as number[]) : undefined) ??
    (noa?.playerEntity?.position as number[] | undefined);

  if (!posArr || posArr.length < 3) return;

  posArr[0] += vx * dt;
  posArr[2] += vz * dt;
  if (keys.has("Space")) posArr[1] += jumpSpeed * dt * 0.15;
}

function getLocalPlayerPosition(noa: any): Vec3 | null {
  // Common patterns in noa for player position:
  // - noa.playerEntity + entities.getPosition(entityId)
  // - noa.playerEntity.position array
  const ent = noa?.playerEntity;

  try {
    if (noa?.entities?.getPosition && ent != null) {
      const p = noa.entities.getPosition(ent) as number[] | undefined;
      if (Array.isArray(p) && p.length >= 3) return { x: p[0], y: p[1], z: p[2] };
    }
  } catch {
    // ignore
  }

  const arr = noa?.playerEntity?.position as number[] | undefined;
  if (Array.isArray(arr) && arr.length >= 3) return { x: arr[0], y: arr[1], z: arr[2] };

  return null;
}

function trySetLocalPlayerPosition(noa: any, pos: Vec3): void {
  const ent = noa?.playerEntity;

  try {
    if (noa?.entities?.setPosition && ent != null) {
      noa.entities.setPosition(ent, [pos.x, pos.y, pos.z]);
      return;
    }
  } catch {
    // ignore
  }

  const arr = noa?.playerEntity?.position as number[] | undefined;
  if (Array.isArray(arr) && arr.length >= 3) {
    arr[0] = pos.x;
    arr[1] = pos.y;
    arr[2] = pos.z;
  }
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
