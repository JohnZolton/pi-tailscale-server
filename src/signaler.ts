/**
 * Nostr signaling layer.
 *
 * Exchanges WebRTC handshake messages (offer, answer, ICE candidates)
 * over NIP-44 encrypted Nostr events.
 *
 * No app data flows through Nostr — only connection metadata.
 */

import { nip44, finalizeEvent, Relay, type Event } from "nostr-tools";
import type { BridgeIdentity } from "./identity.js";

/** Hex-string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** Signaling message types exchanged over Nostr DMs. */
export type SignalingMessage =
  | { type: "webrtc-offer"; pairingCode: string; sdp: string; sessionPubkey: string }
  | { type: "webrtc-answer"; sdp: string }
  | { type: "webrtc-ice"; candidate: string }
  | { type: "pairing-request"; appPubkey: string; pairingCode: string }
  | { type: "pairing-ack"; pairingCode: string };

/** Callbacks invoked when a signaling message arrives. */
export interface SignalingCallbacks {
  onOffer?: (msg: SignalingMessage & { type: "webrtc-offer" }, fromPubkey: string) => void;
  onAnswer?: (msg: SignalingMessage & { type: "webrtc-answer" }, fromPubkey: string) => void;
  onIce?: (msg: SignalingMessage & { type: "webrtc-ice" }, fromPubkey: string) => void;
  onPairingRequest?: (msg: SignalingMessage & { type: "pairing-request" }, fromPubkey: string) => void;
}

/**
 * Manages Nostr relay connections for signaling.
 */
export class NostrSignaler {
  private identity: BridgeIdentity;
  private relays: Relay[] = [];
  private callbacks: SignalingCallbacks = {};
  private convCache = new Map<string, Uint8Array>();
  private activeSubs: Array<{ close: () => void }> = [];

  constructor(identity: BridgeIdentity) {
    this.identity = identity;
  }

  /** Set callbacks for incoming messages. */
  on(cb: SignalingCallbacks): void {
    this.callbacks = cb;
  }

  /** Connect to relays and subscribe for incoming DMs. */
  async start(): Promise<void> {
    const identity = this.identity;
    const skBytes = hexToBytes(identity.privkey);

    // Connect to each relay
    for (const url of identity.relays) {
      try {
        const relay = await Relay.connect(url, { enablePing: true });
        this.relays.push(relay);
        console.log(`[signaler] Connected to ${url}`);

        // Subscribe for NIP-44 encrypted events directed at our pubkey
        const sub = relay.subscribe(
          [{ kinds: [1059], "#p": [identity.pubkey] }],
          {
            onevent: (event: Event) => {
              this.handleIncoming(event, skBytes).catch((e) =>
                console.warn("[signaler] handle error:", e.message)
              );
            },
          },
        );
        this.activeSubs.push(sub);
      } catch (e) {
        console.warn(`[signaler] Failed ${url}: ${(e as Error).message}`);
      }
    }

    if (this.relays.length === 0) {
      console.warn("[signaler] No relays connected");
      return;
    }

    console.log(`[signaler] Listening on ${identity.pubkey.slice(0, 12)}...`);
  }

  /** Stop all relay connections. */
  stop(): void {
    for (const sub of this.activeSubs) {
      try { sub.close(); } catch {}
    }
    this.activeSubs = [];
    for (const r of this.relays) {
      try { r.close(); } catch {}
    }
    this.relays = [];
  }

  /** Send an encrypted signaling message to a peer's pubkey. */
  async sendMessage(toPubkey: string, msg: SignalingMessage): Promise<void> {
    const identity = this.identity;
    const skBytes = hexToBytes(identity.privkey);
    const convKey = this.getConversationKey(skBytes, toPubkey);
    const ciphertext = nip44.encrypt(JSON.stringify(msg), convKey);

    const signedEvent = finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", toPubkey]],
        content: ciphertext,
      },
      skBytes,
    );

    for (const relay of this.relays) {
      try {
        await relay.publish(signedEvent);
      } catch (e) {
        console.warn(`[signaler] Publish to ${relay.url}: ${(e as Error).message}`);
      }
    }
  }

  // ── Private ──

  private async handleIncoming(event: Event, skBytes: Uint8Array): Promise<void> {
    const identity = this.identity;

    // Only handle events addressed to us
    const pTags = event.tags.filter((t) => t[0] === "p");
    if (!pTags.some((t) => t[1] === identity.pubkey)) return;

    // Decrypt with NIP-44
    let plaintext: string;
    try {
      const convKey = this.getConversationKey(skBytes, event.pubkey);
      plaintext = nip44.decrypt(event.content, convKey);
    } catch {
      return; // couldn't decrypt
    }

    // Parse signaling message
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(plaintext);
    } catch {
      return; // not a signaling message
    }

    // Route to callback
    switch (msg.type) {
      case "webrtc-offer":
        this.callbacks.onOffer?.(msg, event.pubkey);
        break;
      case "webrtc-answer":
        this.callbacks.onAnswer?.(msg, event.pubkey);
        break;
      case "webrtc-ice":
        this.callbacks.onIce?.(msg, event.pubkey);
        break;
      case "pairing-request":
        this.callbacks.onPairingRequest?.(msg, event.pubkey);
        break;
    }
  }

  /** Get or cache a NIP-44 conversation key for a peer. */
  private getConversationKey(skBytes: Uint8Array, pubkey: string): Uint8Array {
    const key = `conv:${pubkey.slice(0, 16)}`;
    let convKey = this.convCache.get(key);
    if (!convKey) {
      convKey = nip44.getConversationKey(skBytes, pubkey);
      this.convCache.set(key, convKey);
    }
    return convKey;
  }
}
