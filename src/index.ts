#!/usr/bin/env node

/**
 * pi-nostr-bridge — P2P bridge for pi coding agent.
 *
 * Three pieces:
 *   1. PiBridge — WebSocket server (Tailscale/dev path, also transport abstraction)
 *   2. Identity — secp256k1 keypair, paired with Android via Nostr signaling
 *   3. NostrSignaler — exchanges WebRTC handshake over NIP-44 encrypted DMs
 *
 * Env vars:
 *   WS_PORT        WebSocket port for tailscale/dev path  (default: 3002)
 *   HTTP_PORT      Local HTTP for pairing QR data         (default: 3003)
 *   PI_CWD         Working directory for pi sessions
 *   PI_AGENT_DIR   pi agent config directory
 */

import * as http from "node:http";

import { loadConfig } from "./config.js";
import { PiBridge } from "./bridge.js";
import { loadOrCreateIdentity, getPairingData } from "./identity.js";
import { NostrSignaler } from "./signaler.js";

async function main() {
  const config = loadConfig();

  // ── 1. Identity ──
  const identity = loadOrCreateIdentity();
  console.log(`Pubkey: ${identity.pubkey}`);
  console.log(`Relays: ${identity.relays.join(", ")}`);

  // ── 2. Nostr signaling ──
  const signaler = new NostrSignaler(identity);
  signaler.on({
    onOffer: (msg, fromPubkey) => {
      console.log(`[signal] Offer from ${fromPubkey.slice(0, 12)}...`);
      // Phase 3: create WebRTC peer, send answer
    },
    onAnswer: (msg, fromPubkey) => {
      console.log(`[signal] Answer from ${fromPubkey.slice(0, 12)}...`);
    },
    onIce: (msg, fromPubkey) => {
      console.log(`[signal] ICE from ${fromPubkey.slice(0, 12)}...`);
    },
  });
  signaler.start().catch((e) => console.warn("[signal] start error:", e.message));

  // ── 3. PiBridge (WebSocket path) ──
  const bridge = new PiBridge(config);
  await bridge.start();

  // ── 4. Local HTTP endpoint for pairing data ──
  const httpPort = parseInt(process.env.HTTP_PORT ?? "3003", 10);
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/pairing" || req.url === "/qr") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(getPairingData(identity)));
    } else {
      res.writeHead(404).end("Not found");
    }
  });
  httpServer.listen(httpPort, "0.0.0.0", () => {
    console.log(`Pairing data: http://localhost:${httpPort}/pairing`);
  });

  // ── 5. Cleanup ──
  const cleanup = () => {
    console.log("\nShutting down...");
    signaler.stop();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
