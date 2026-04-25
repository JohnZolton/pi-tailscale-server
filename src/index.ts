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
import * as qrcode from "qrcode";

import { loadConfig } from "./config.js";
import { PiBridge } from "./bridge.js";
import { loadOrCreateIdentity, getPairingData } from "./identity.js";
import { NostrSignaler } from "./signaler.js";
import { WebRtcManager } from "./webrtc-transport.js";

async function main() {
  const config = loadConfig();

  // ── 1. Identity ──
  const identity = loadOrCreateIdentity();
  console.log(`Pubkey: ${identity.pubkey}`);
  console.log(`Relays: ${identity.relays.join(", ")}`);

  // ── 2. PiBridge (WebSocket path for Tailscale/dev) ──
  const bridge = new PiBridge(config);
  await bridge.start();

  // ── 3. Nostr signaling + WebRTC ──
  const signaler = new NostrSignaler(identity);
  const webrtc = new WebRtcManager(identity, signaler);

  // When a WebRTC DataChannel opens, plug it into the bridge
  webrtc.onTransport = (transport) => {
    console.log(`[index] WebRTC transport ready: ${transport.peerId}`);
    bridge.addTransport(transport);
  };

  signaler.start().catch((e) => console.warn("[signal] start error:", e.message));

  // ── 4. Local HTTP endpoint for pairing data + QR ──
  const httpPort = parseInt(process.env.HTTP_PORT ?? "3003", 10);
  const httpServer = http.createServer(async (req, res) => {
    const pairingJson = JSON.stringify(getPairingData(identity));

    if (req.url === "/pairing") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(pairingJson);
    } else if (req.url === "/qr" || req.url === "/qr.png") {
      try {
        const png = await qrcode.toBuffer(pairingJson, { type: "png", margin: 2, width: 400 });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": png.length,
        });
        res.end(png);
      } catch {
        res.writeHead(500).end("QR generation failed");
      }
    } else {
      res.writeHead(404).end("Not found");
    }
  });
  httpServer.listen(httpPort, "0.0.0.0", () => {
    console.log(`Pairing data: http://localhost:${httpPort}/pairing`);
    console.log(`QR code:      http://localhost:${httpPort}/qr`);
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
