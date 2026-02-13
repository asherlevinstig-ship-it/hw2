import { Client } from "@colyseus/sdk";

const serverUrl = "ws://localhost:2567";
const client = new Client(serverUrl);

const el = document.querySelector<HTMLDivElement>("#app")!;
el.innerHTML = `
  <h1>Colyseus Client</h1>
  <button id="join">Join Room</button>
  <pre id="log"></pre>
`;

const logEl = document.querySelector<HTMLPreElement>("#log")!;
function log(...args: any[]) {
  logEl.textContent += args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ") + "\n";
}

document.querySelector<HTMLButtonElement>("#join")!.onclick = async () => {
  try {
    // NOTE: use a room name that exists on your server scaffold
    const room = await client.joinOrCreate("my_room");
    log("Joined:", room.name, "sessionId:", room.sessionId);

    room.onMessage("*", (type, message) => {
      log("Message:", type, message);
    });

    room.send("ping", { t: Date.now() });
    log("Sent: ping");
  } catch (e) {
    log("ERROR:", e);
  }
};
