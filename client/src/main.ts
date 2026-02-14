/* ============================================================================
   main.ts (FULL, NO OMITS) - TypeScript-safe noa-engine + Babylon + multiplayer
   Fixes:
    - window.BABYLON typing
    - socket typing / destructure typing
    - noa-engine "no call signatures" typings mismatch
    - implicit any everywhere
    - noa v0.33 camera heading/pitch migration
    - TS2367 pointerLockElement vs HTMLCanvasElement comparison
============================================================================ */

import * as BABYLON from "@babylonjs/core";
// import "@babylonjs/loaders"; // enable if you load .glb/.gltf/etc
import * as NoaImport from "noa-engine";

/* -------------------------------------------------------------------------- */
/* Global window augmentation for BABYLON                                      */
/* -------------------------------------------------------------------------- */
declare global {
  interface Window {
    BABYLON: typeof BABYLON;
  }
}
window.BABYLON = BABYLON;

/* -------------------------------------------------------------------------- */
/* Minimal socket interface                                                    */
/* -------------------------------------------------------------------------- */
export type Handler<T = unknown> = (data: T) => void;

export interface SocketLike {
  on<T = unknown>(event: string, fn: Handler<T>): void;
  emit<T = unknown>(event: string, payload: T): void;
}

/* -------------------------------------------------------------------------- */
/* Player state types                                                         */
/* -------------------------------------------------------------------------- */
export type Vec3 = [number, number, number];

export interface NetPlayerState {
  id: string;
  position: Vec3;
  heading?: number;
  pitch?: number;
}

export interface JoinedPayload {
  id: string;
  players: NetPlayerState[];
}

/* -------------------------------------------------------------------------- */
/* Start options                                                              */
/* -------------------------------------------------------------------------- */
export interface StartClientOptions {
  canvas?: HTMLCanvasElement | null;
  socket: SocketLike;
}

/* -------------------------------------------------------------------------- */
/* noa minimal typing (only what we use)                                      */
/* -------------------------------------------------------------------------- */
type NoaLike = {
  debug?: boolean;
  world: {
    chunkSize: number;
    on: (
      event: "worldDataNeeded",
      fn: (
        id: [number, number, number],
        data: Uint16Array,
        done: (err: unknown, data?: Uint16Array) => void
      ) => void
    ) => void;
    getBlockID: (x: number, y: number, z: number) => number;
  };
  registry: {
    registerBlock: (
      id: number,
      opts: { name: string; solid: boolean; opaque: boolean }
    ) => void;
  };
  playerEntity: {
    position: {
      set: (x: number, y: number, z: number) => void;
      [i: number]: number;
    };
  };
  camera: {
    heading: number;
    pitch: number;
  };
  entities: {
    getPhysicsBody: (ent: unknown) => { velocity: [number, number, number] } | null;
  };
  rendering: {
    getScene: () => BABYLON.Scene;
  };
  on: (event: "tick", fn: (dt: number) => void) => void;
};

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */
const CONFIG = {
  chunkSize: 24,
  player: {
    height: 1.8,
    width: 0.6,
    depth: 0.6,
    moveSpeed: 6.0,
    jumpImpulse: 7.0,
  },
  mouse: {
    sensitivity: 0.002,
    maxPitch: Math.PI / 2 - 0.01,
  },
  avatar: {
    size: { w: 0.6, h: 1.8, d: 0.6 },
    yOffset: 0.9,
  },
};

/* -------------------------------------------------------------------------- */
/* Helper: create noa instance (TS-safe)                                      */
/* -------------------------------------------------------------------------- */
function createNoaInstance(opts: {
  canvas: HTMLCanvasElement;
  debug: boolean;
  chunkSize: number;
  playerHeight: number;
  playerWidth: number;
  playerDepth: number;
}): NoaLike {
  const anyImport = NoaImport as unknown as { default?: unknown } & Record<string, unknown>;
  const maybeDefault = anyImport.default;

  const candidate =
    (typeof maybeDefault === "function" ? maybeDefault : null) ??
    (typeof (NoaImport as unknown) === "function" ? (NoaImport as unknown) : null);

  if (typeof candidate !== "function") {
    return (NoaImport as any)(opts) as NoaLike;
  }

  return (candidate as any)(opts) as NoaLike;
}

/* -------------------------------------------------------------------------- */
/* Pointer lock helper (fixes TS2367)                                         */
/* -------------------------------------------------------------------------- */
function isPointerLockedTo(canvas: HTMLCanvasElement): boolean {
  const el = document.pointerLockElement;
  if (!el) return false;
  // compare as Element to satisfy TS, while still correct at runtime
  return el === (canvas as unknown as Element);
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                               */
/* -------------------------------------------------------------------------- */
export function startClient(options: StartClientOptions): {
  noa: NoaLike;
  socket: SocketLike;
  avatars: AvatarManager;
  controls: ControlsHandle;
} {
  const canvas =
    options.canvas ??
    (document.getElementById("renderCanvas") as HTMLCanvasElement | null);

  if (!canvas) {
    throw new Error("No canvas found. Provide options.canvas or an element with id='renderCanvas'.");
  }

  const socket = options.socket;
  if (!socket) throw new Error("No socket provided.");

  const noa = createNoaInstance({
    canvas,
    debug: true,
    chunkSize: CONFIG.chunkSize,
    playerHeight: CONFIG.player.height,
    playerWidth: CONFIG.player.width,
    playerDepth: CONFIG.player.depth,
  });

  setupWorld(noa);
  const controls = setupControls(noa, canvas);
  const avatars = createAvatarManager(noa);

  setupNetworking({ noa, socket, avatars, controls });

  return { noa, socket, avatars, controls };
}

/* -------------------------------------------------------------------------- */
/* World setup                                                                */
/* -------------------------------------------------------------------------- */
function setupWorld(noa: NoaLike): void {
  const AIR = 0;
  const GRASS = 1;
  const DIRT = 2;

  noa.registry.registerBlock(AIR, { name: "air", solid: false, opaque: false });
  noa.registry.registerBlock(GRASS, { name: "grass", solid: true, opaque: true });
  noa.registry.registerBlock(DIRT, { name: "dirt", solid: true, opaque: true });

  noa.world.on("worldDataNeeded", (id, data, done) => {
    const cy = id[1];
    const size = noa.world.chunkSize;

    const setVoxel = (x: number, y: number, z: number, v: number): void => {
      const idx = x + size * (y + size * z);
      data[idx] = v;
    };

    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
          const worldY = cy * size + y;

          if (worldY < 0) setVoxel(x, y, z, DIRT);
          else if (worldY === 0) setVoxel(x, y, z, GRASS);
          else setVoxel(x, y, z, AIR);
        }
      }
    }

    done(null, data);
  });

  noa.playerEntity.position.set(0, 4, 0);
}

/* -------------------------------------------------------------------------- */
/* Controls + camera (noa v0.33 uses heading/pitch)                           */
/* -------------------------------------------------------------------------- */
type ControlsHandle = { readonly heading: number; readonly pitch: number };

function setupControls(noa: NoaLike, canvas: HTMLCanvasElement): ControlsHandle {
  canvas.addEventListener("click", () => {
    if (!isPointerLockedTo(canvas)) {
      canvas.requestPointerLock?.();
    }
  });

  let yaw = noa.camera.heading ?? 0;
  let pitch = noa.camera.pitch ?? 0;

  const keys = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
  };

  const setKey = (code: string, isDown: boolean): void => {
    switch (code) {
      case "KeyW":
        keys.forward = isDown;
        break;
      case "KeyS":
        keys.back = isDown;
        break;
      case "KeyA":
        keys.left = isDown;
        break;
      case "KeyD":
        keys.right = isDown;
        break;
      case "Space":
        keys.jump = isDown;
        break;
      default:
        break;
    }
  };

  window.addEventListener("keydown", (e: KeyboardEvent) => setKey(e.code, true));
  window.addEventListener("keyup", (e: KeyboardEvent) => setKey(e.code, false));

  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isPointerLockedTo(canvas)) return;

    const dx = e.movementX || 0;
    const dy = e.movementY || 0;

    yaw -= dx * CONFIG.mouse.sensitivity;
    pitch -= dy * CONFIG.mouse.sensitivity;

    pitch = clamp(pitch, -CONFIG.mouse.maxPitch, CONFIG.mouse.maxPitch);

    noa.camera.heading = yaw;
    noa.camera.pitch = pitch;
  });

  noa.on("tick", () => {
    const move = computeMoveVector(keys, yaw);
    const speed = CONFIG.player.moveSpeed;

    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (!body) return;

    const vy = body.velocity[1];

    body.velocity[0] = move[0] * speed;
    body.velocity[2] = move[2] * speed;
    body.velocity[1] = vy;

    if (keys.jump && isGrounded(noa)) {
      body.velocity[1] = CONFIG.player.jumpImpulse;
    }
  });

  return {
    get heading() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
  };
}

function computeMoveVector(
  keys: { forward: boolean; back: boolean; left: boolean; right: boolean },
  yaw: number
): Vec3 {
  const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const strafe = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

  if (forward === 0 && strafe === 0) return [0, 0, 0];

  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  // Forward is +Z here (tweak if your world faces another direction)
  const fx = sin;
  const fz = cos;
  const rx = cos;
  const rz = -sin;

  let mx = fx * forward + rx * strafe;
  let mz = fz * forward + rz * strafe;

  const len = Math.hypot(mx, mz) || 1;
  mx /= len;
  mz /= len;

  return [mx, 0, mz];
}

function isGrounded(noa: NoaLike): boolean {
  const p = noa.playerEntity.position as unknown as number[];
  const x = p[0];
  const y = p[1];
  const z = p[2];

  const belowY = Math.floor(y - 0.05);
  const voxel = noa.world.getBlockID(Math.floor(x), belowY, Math.floor(z));
  return voxel !== 0;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

/* -------------------------------------------------------------------------- */
/* Avatar manager                                                             */
/* -------------------------------------------------------------------------- */
type AvatarManager = {
  ensurePlayer: (id: string) => { mesh: BABYLON.Mesh };
  removePlayer: (id: string) => void;
  setState: (id: string, state: NetPlayerState) => void;
  clearAll: () => void;
};

function createAvatarManager(noa: NoaLike): AvatarManager {
  const scene = noa.rendering.getScene();
  const remote = new Map<string, { mesh: BABYLON.Mesh }>();

  const ensurePlayer = (id: string): { mesh: BABYLON.Mesh } => {
    const existing = remote.get(id);
    if (existing) return existing;

    const { w, h, d } = CONFIG.avatar.size;
    const mesh = BABYLON.MeshBuilder.CreateBox(
      `remote_${id}`,
      { width: w, height: h, depth: d },
      scene
    );

    const mat = new BABYLON.StandardMaterial(`remoteMat_${id}`, scene);
    mesh.material = mat;

    const obj = { mesh };
    remote.set(id, obj);
    return obj;
  };

  const removePlayer = (id: string): void => {
    const r = remote.get(id);
    if (!r) return;
    r.mesh.dispose();
    remote.delete(id);
  };

  const setState = (id: string, state: NetPlayerState): void => {
    const r = ensurePlayer(id);
    const pos = state.position ?? ([0, 0, 0] as Vec3);
    r.mesh.position.set(pos[0], pos[1] + CONFIG.avatar.yOffset, pos[2]);
    if (typeof state.heading === "number") r.mesh.rotation.y = state.heading;
  };

  const clearAll = (): void => {
    for (const id of remote.keys()) removePlayer(id);
  };

  return { ensurePlayer, removePlayer, setState, clearAll };
}

/* -------------------------------------------------------------------------- */
/* Networking glue                                                            */
/* -------------------------------------------------------------------------- */
function setupNetworking(args: {
  noa: NoaLike;
  socket: SocketLike;
  avatars: AvatarManager;
  controls: ControlsHandle;
}): void {
  const { noa, socket, avatars, controls } = args;

  let myId: string | null = null;

  socket.on<JoinedPayload>("joined", (payload) => {
    myId = payload.id;

    for (const p of payload.players || []) {
      if (!p?.id || p.id === myId) continue;
      avatars.setState(p.id, p);
    }
  });

  socket.on<NetPlayerState>("playerJoined", (p) => {
    if (!p?.id || p.id === myId) return;
    avatars.setState(p.id, p);
  });

  socket.on<{ id: string }>("playerLeft", ({ id }) => {
    if (!id) return;
    avatars.removePlayer(id);
  });

  socket.on<NetPlayerState>("playerState", (p) => {
    if (!p?.id || p.id === myId) return;
    avatars.setState(p.id, p);
  });

  const SEND_HZ = 20;
  const SEND_INTERVAL_MS = Math.floor(1000 / SEND_HZ);
  let accMs = 0;

  noa.on("tick", (dt: number) => {
    accMs += dt;
    if (accMs < SEND_INTERVAL_MS) return;
    accMs = 0;

    if (!myId) return;

    const pos = noa.playerEntity.position as unknown as number[];
    socket.emit<NetPlayerState>("playerState", {
      id: myId,
      position: [pos[0], pos[1], pos[2]],
      heading: controls.heading,
      pitch: controls.pitch,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Optional: JSON WebSocket adapter (typed)                                   */
/* -------------------------------------------------------------------------- */
export function createJsonWebSocketAdapter(ws: WebSocket): SocketLike {
  const handlers = new Map<string, Array<Handler<any>>>();

  ws.addEventListener("message", (evt: MessageEvent) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const type = (msg as any).type as string | undefined;
    const data = (msg as any).data as unknown;

    if (!type) return;
    const list = handlers.get(type);
    if (!list) return;
    for (const fn of list) fn(data);
  });

  return {
    on<T = unknown>(event: string, fn: Handler<T>) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn as Handler<any>);
    },
    emit<T = unknown>(event: string, payload: T) {
      ws.send(JSON.stringify({ type: event, data: payload }));
    },
  };
}
