/**
 * Identity management for the bridge.
 *
 * Generates a secp256k1 keypair on first launch, persists to
 * ~/.pi-bridge/identity.json, and exports it as a pairing data
 * (served as JSON over a local HTTP endpoint or QR).
 */

import * as fs from "node:fs";
import * as pathLib from "node:path";
import * as crypto from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools";

export interface BridgeIdentity {
  /** Hex-encoded secp256k1 private key. */
  privkey: string;
  /** Hex-encoded secp256k1 public key. */
  pubkey: string;
  /** Nostr relays the bridge will listen for signaling on. */
  relays: string[];
  /** Random pairing code for this bridge instance. */
  pairingCode: string;
}

const IDENTITY_DIR = pathLib.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".pi-bridge",
);
const IDENTITY_FILE = pathLib.join(IDENTITY_DIR, "identity.json");
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function loadOrCreateIdentity(): BridgeIdentity {
  // Try loading existing identity
  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      const raw = fs.readFileSync(IDENTITY_FILE, "utf8");
      const parsed = JSON.parse(raw) as BridgeIdentity;
      if (parsed.privkey && parsed.pubkey) {
        console.log(`[identity] Loaded ${parsed.pubkey.slice(0, 12)}...`);
        return parsed;
      }
    } catch {
      // fall through to regenerate
    }
  }

  // Generate new identity
  const sk = generateSecretKey();
  const privkey = hex(sk);
  const pubkey = getPublicKey(sk);
  const pairingCode = hex(crypto.randomBytes(32));

  const identity: BridgeIdentity = {
    privkey,
    pubkey,
    relays: DEFAULT_RELAYS,
    pairingCode,
  };

  // Persist
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  console.log(`[identity] Generated ${pubkey.slice(0, 12)}...`);
  return identity;
}

/**
 * Get the pairing data that the Android app needs to scan/read.
 * Served as JSON by a local HTTP endpoint.
 */
export function getPairingData(identity: BridgeIdentity): Record<string, unknown> {
  return {
    pubkey: identity.pubkey,
    relays: identity.relays,
    pairingCode: identity.pairingCode,
    name: "pi-bridge",
  };
}
