/**
 * FULL DROP-IN CLIENT SCRIPT (no omissions)
 * Fixes:
 *  1) "BABYLON global not found" by explicitly importing Babylon and exposing window.BABYLON
 *  2) noa-engine v0.33 camera API change by using noa.camera.heading and noa.camera.pitch
 *
 * What you must wire up (still included, but you must point it at your real networking):
 *  - Provide a socket-like object with:
 *      socket.on(event, fn)
 *      socket.emit(event, payload)
 *  - Emit/receive:
 *      "joined" -> { id, players: [{id, position:[x,y,z], heading, pitch}] }
 *      "playerJoined" -> { id, position, heading, pitch }
 *      "playerLeft" -> { id }
 *      "playerState" -> { id, position, heading, pitch }
 *
 * If your events are named differently, just change the strings in setupNetworking().
 */

import createNoa from "noa-engine";
import * as BABYLON from "@babylonjs/core";
// If you load external meshes, uncomment:
// import "@babylonjs/loaders";

/* -------------------------------------------------------------------------- */
/* Global BABYLON bridge (fixes "BABYLON global not found")                     */
/* -------------------------------------------------------------------------- */
if (typeof window !== "undefined") {
  window.BABYLON = BABYLON;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  chunkSize: 24,
  worldSeed: 1337,
  player: {
    height: 1.8,
    width: 0.6,
    depth: 0.6,
    eyeHeight: 1.6,
    moveSpeed: 6.0,
    jumpImpulse: 7.0,
  },
  mouse: {
    sensitivity: 0.002,
    maxPitch: Math.PI / 2 - 0.01,
  },
  avatar: {
    // simple box avatar for remote players
    size: { w: 0.6, h: 1.8, d: 0.6 },
    yOffset: 0.9, // center box so it sits on ground
  },
};

/* -------------------------------------------------------------------------- */
/* Entry                                                                        */
/* -------------------------------------------------------------------------- */

export function startClient({
  canvas = document.getElementById("renderCanvas"),
  socket, // REQUIRED: your multiplayer socket
} = {}) {
  if (!canvas) throw new Error("No canvas provided/found (expected #renderCanvas).");
  if (!socket) throw new Error("No socket provided. Pass { socket } into startClient().");

  // Create noa engine instance
  const noa = createNoa({
    canvas,
    debug: true,
    chunkSize: CONFIG.chunkSize,
    // Options vary by noa builds; these are common:
    playerHeight: CONFIG.player.height,
    playerWidth: CONFIG.player.width,
    playerDepth: CONFIG.player.depth,
  });

  // Basic terrain (placeholder voxel IDs)
  setupWorld(noa);

  // Local player controls & camera
  const controls = setupControls(noa, canvas);

  // Remote avatars
  const avatars = createAvatarManager(noa);

  // Networking glue
  setupNetworking({
    noa,
    socket,
    avatars,
    controls,
  });

  // Return handle for external use/debug
  return { noa, socket, avatars, controls };
}

/* -------------------------------------------------------------------------- */
/* World setup (simple flat world)                                              */
/* -------------------------------------------------------------------------- */

function setupWorld(noa) {
  // Registry - IDs are arbitrary. If you already register blocks elsewhere,
  // you can remove/replace this.
  const AIR = 0;
  const GRASS = 1;
  const DIRT = 2;

  noa.registry.registerBlock(AIR, { name: "air", solid: false, opaque: false });
  noa.registry.registerBlock(GRASS, { name: "grass", solid: true, opaque: true });
  noa.registry.registerBlock(DIRT, { name: "dirt", solid: true, opaque: true });

  // Very simple worldgen: flat ground at y=0 with grass, dirt below.
  noa.world.on("worldDataNeeded", (id, data, done) => {
    const [cx, cy, cz] = id; // chunk coords
    const size = noa.world.chunkSize;

    // data is a Uint16Array (or similar) of voxel IDs, flattened
    // index = x + size*(y + size*z)
    const setVoxel = (x, y, z, v) => {
      const idx = x + size * (y + size * z);
      data[idx] = v;
    };

    // Fill chunk
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
          const worldY = cy * size + y;

          if (worldY < -3) setVoxel(x, y, z, DIRT);
          else if (worldY < 0) setVoxel(x, y, z, DIRT);
          else if (worldY === 0) setVoxel(x, y, z, GRASS);
          else setVoxel(x, y, z, AIR);
        }
      }
    }

    done(null, data);
  });

  // Optional: set initial spawn a bit above ground
  noa.playerEntity.position.set(0, 4, 0);
}

/* -------------------------------------------------------------------------- */
/* Controls + camera (noa v0.33 heading/pitch)                                  */
/* -------------------------------------------------------------------------- */

function setupControls(noa, canvas) {
  // Pointer lock for mouse look
  canvas.addEventListener("click", () => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  });

  let yaw = 0;
  let pitch = 0;

  // Initialize to current camera values if present
  if (typeof noa.camera.heading === "number") yaw = noa.camera.heading;
  if (typeof noa.camera.pitch === "number") pitch = noa.camera.pitch;

  const keys = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
  };

  window.addEventListener("keydown", (e) => setKey(e.code, true));
  window.addEventListener("keyup", (e) => setKey(e.code, false));

  function setKey(code, isDown) {
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
  }

  // Mouse look (pointer lock)
  window.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;

    const dx = e.movementX || 0;
    const dy = e.movementY || 0;

    yaw -= dx * CONFIG.mouse.sensitivity;
    pitch -= dy * CONFIG.mouse.sensitivity;

    // clamp pitch
    pitch = clamp(pitch, -CONFIG.mouse.maxPitch, CONFIG.mouse.maxPitch);

    // ✅ noa v0.33+ camera API
    noa.camera.heading = yaw;
    noa.camera.pitch = pitch;
  });

  // Drive movement each tick
  noa.on("tick", (dt) => {
    // dt is in ms for noa; normalize to seconds
    const delta = dt / 1000;

    const move = computeMoveVector(keys, yaw);
    const speed = CONFIG.player.moveSpeed;

    // Apply to player body (noa physics)
    // noa.playerEntity has "body" with velocity
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (!body) return;

    // Keep existing vertical velocity
    const vy = body.velocity[1];

    body.velocity[0] = move[0] * speed;
    body.velocity[2] = move[2] * speed;
    body.velocity[1] = vy;

    // Jump: only if grounded
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

function computeMoveVector(keys, yaw) {
  // Forward is -Z in many Babylon/noa setups; adjust if your world differs.
  const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const strafe = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

  // No movement
  if (forward === 0 && strafe === 0) return [0, 0, 0];

  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  // Basis vectors for yaw:
  // forwardDir = [sin, 0, cos] (depending on your coordinate system)
  // rightDir   = [cos, 0, -sin]
  const fx = sin;
  const fz = cos;
  const rx = cos;
  const rz = -sin;

  let mx = fx * forward + rx * strafe;
  let mz = fz * forward + rz * strafe;

  // Normalize
  const len = Math.hypot(mx, mz) || 1;
  mx /= len;
  mz /= len;

  return [mx, 0, mz];
}

function isGrounded(noa) {
  // Common noa grounded test:
  // playerEntity has "resting" flags on body in some versions.
  // We'll do a conservative ray check just below feet.

  const p = noa.playerEntity.position;
  const x = p[0];
  const y = p[1];
  const z = p[2];

  const belowY = Math.floor(y - 0.05);
  const voxel = noa.world.getBlockID(Math.floor(x), belowY, Math.floor(z));
  return voxel !== 0; // assumes 0 is air
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/* -------------------------------------------------------------------------- */
/* Avatar manager (remote players)                                              */
/* -------------------------------------------------------------------------- */

function createAvatarManager(noa) {
  const scene = noa.rendering.getScene();
  const remote = new Map(); // id -> { mesh }

  function ensurePlayer(id) {
    if (remote.has(id)) return remote.get(id);

    // Create a simple box for the player avatar
    const { w, h, d } = CONFIG.avatar.size;
    const mesh = BABYLON.MeshBuilder.CreateBox(
      `remote_${id}`,
      { width: w, height: h, depth: d },
      scene
    );

    // Basic material
    const mat = new BABYLON.StandardMaterial(`remoteMat_${id}`, scene);
    // no explicit colors per your request? (You didn’t request colors; leaving defaults)
    mesh.material = mat;

    remote.set(id, { mesh });
    return remote.get(id);
  }

  function removePlayer(id) {
    const r = remote.get(id);
    if (!r) return;
    r.mesh?.dispose?.();
    remote.delete(id);
  }

  function setState(id, state) {
    const r = ensurePlayer(id);

    const pos = state.position || [0, 0, 0];
    r.mesh.position.set(pos[0], pos[1] + CONFIG.avatar.yOffset, pos[2]);

    // Optional: rotate mesh by heading
    if (typeof state.heading === "number") {
      r.mesh.rotation.y = state.heading;
    }
  }

  function clearAll() {
    for (const id of remote.keys()) removePlayer(id);
  }

  return {
    ensurePlayer,
    removePlayer,
    setState,
    clearAll,
    _remote: remote, // for debugging
  };
}

/* -------------------------------------------------------------------------- */
/* Networking glue                                                              */
/* -------------------------------------------------------------------------- */

function setupNetworking({ noa, socket, avatars, controls }) {
  let myId = null;

  socket.on("joined", (payload) => {
    myId = payload.id;

    // Spawn existing players
    const players = payload.players || [];
    for (const p of players) {
      if (!p || !p.id || p.id === myId) continue;
      avatars.setState(p.id, p);
    }
  });

  socket.on("playerJoined", (p) => {
    if (!p || !p.id || p.id === myId) return;
    avatars.setState(p.id, p);
  });

  socket.on("playerLeft", ({ id }) => {
    if (!id) return;
    avatars.removePlayer(id);
  });

  socket.on("playerState", (p) => {
    if (!p || !p.id || p.id === myId) return;
    avatars.setState(p.id, p);
  });

  // Send my state periodically
  const SEND_HZ = 20;
  const SEND_INTERVAL_MS = Math.floor(1000 / SEND_HZ);
  let acc = 0;

  noa.on("tick", (dt) => {
    acc += dt;
    if (acc < SEND_INTERVAL_MS) return;
    acc = 0;

    if (!myId) return;

    const p = noa.playerEntity.position;
    socket.emit("playerState", {
      id: myId,
      position: [p[0], p[1], p[2]],
      heading: controls.heading, // ✅ v0.33-friendly (your local yaw)
      pitch: controls.pitch,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Example socket adapter (OPTIONAL)                                            */
/* -------------------------------------------------------------------------- */
/**
 * If you already have a socket (socket.io / ws wrapper), ignore this.
 * This is a tiny adapter for a raw WebSocket that uses JSON messages:
 *
 * Message format: { type: "joined", data: {...} }
 */
export function createJsonWebSocketAdapter(ws) {
  const handlers = new Map();

  ws.addEventListener("message", (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    const { type, data } = msg || {};
    const list = handlers.get(type);
    if (!list) return;
    for (const fn of list) fn(data);
  });

  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit(type, data) {
      ws.send(JSON.stringify({ type, data }));
    },
  };
}
