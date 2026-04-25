#!/usr/bin/env node

/**
 * pi-nostr-bridge — WebSocket server wrapping pi.
 *
 * No Nostr, no keypairs. Just a WebSocket over Tailscale.
 * Connect from the Android app, send messages, get streaming responses.
 *
 * Env vars:
 *   WS_PORT  (optional) WebSocket port (default: 3002)
 *   PI_CWD   (optional) Working directory (default: cwd)
 *   PI_AGENT_DIR (optional) pi agent config dir
 */

import { loadConfig } from "./config.js";
import { PiBridge } from "./bridge.js";

const config = loadConfig();
const bridge = new PiBridge(config);
bridge.start().catch((e) => { console.error("FATAL:", e); process.exit(1); });
