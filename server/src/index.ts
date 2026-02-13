/**
 * Self-hosted Colyseus Server Entry Point
 *
 * This file starts the Colyseus server using the configuration
 * defined in app.config.ts.
 *
 * It does NOT use Colyseus Cloud wrappers.
 */

import app from "./app.config.js";

// Use environment PORT or default to 2567
const port = Number(process.env.PORT ?? 2567);

// Start server
app.listen(port);

// Console output
console.log("=================================");
console.log("🚀 Colyseus Server Started");
console.log(`HTTP  : http://localhost:${port}`);
console.log(`WebSocket : ws://localhost:${port}`);
console.log("=================================");
