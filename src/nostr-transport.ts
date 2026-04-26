/**
 * Nostr DM transport for agent frames.
 *
 * Implements the Transport interface so the bridge can send/receive
 * agent frames (text_delta, tool_call, thinking, etc.) over NIP-44
 * encrypted Nostr DMs instead of WebSocket or WebRTC.
 *
 * This replaces Tailscale entirely — no NAT issues, no ports, no VPN.
 */

import { nip44, finalizeEvent, Relay, type Event } from "nostr-tools";
import { type Transport } from "./transport.js";
import type { BridgeIdentity } from "./identity.js";

/** Hex-string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/**
 * Nostr-based transport — sends/receives JSON frames as NIP-44 encrypted
 * Nostr DMs. Pair with the Android NostrTransport.
 */
export class NostrTransport implements Transport {
  readonly peerId: string;
  private identity: BridgeIdentity;
  private appPubkey: string;
  private relays: string[];
  private relay: Relay | undefined;
  private convKey: Uint8Array | undefined;
  private unsub: (() => void) | undefined;

  onOpen?: () => void;
  onMessage?: (type: string, data: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;

  constructor(identity: BridgeIdentity, appPubkey: string, relays: string[]) {
    this.peerId = appPubkey.slice(0, 16);
    this.identity = identity;
    this.appPubkey = appPubkey;
    this.relays = relays;

    // Pre-compute conversation key
    const skBytes = hexToBytes(identity.privkey);
    this.convKey = nip44.getConversationKey(skBytes, appPubkey);
  }

  /** Connect to relay and subscribe for incoming frames. */
  async start(): Promise<void> {
    for (const url of this.relays) {
      try {
        this.relay = await Relay.connect(url);
        console.log(`[nostr-transport] Connected to ${url}`);

        // Subscribe for events from the app
        const sub = this.relay.subscribe(
          [{ kinds: [1059], "#p": [this.identity.pubkey] }],
          { onevent: (event: Event) => this.handleIncoming(event) },
        );
        this.unsub = () => sub.close();

        console.log(`[nostr-transport] Listening for frames from ${this.appPubkey.slice(0, 12)}...`);
        this.onOpen?.();
        return;
      } catch (e) {
        console.warn(`[nostr-transport] Failed ${url}: ${(e as Error).message}`);
      }
    }
    this.onError?.(new Error("No relays available"));
  }

  send(type: string, data: Record<string, unknown>): void {
    if (!this.relay || !this.convKey) return;

    const payload = JSON.stringify({ type: "frame", frameType: type, data });
    const ciphertext = nip44.encrypt(payload, this.convKey);

    const event = finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.appPubkey]],
        content: ciphertext,
      },
      hexToBytes(this.identity.privkey),
    );

    this.relay.publish(event).catch((e) =>
      console.warn(`[nostr-transport] Publish failed: ${(e as Error).message}`),
    );
  }

  close(): void {
    this.unsub?.();
    try { this.relay?.close(); } catch {}
  }

  // ── Private ──

  private handleIncoming(event: Event): void {
    if (!this.convKey) return;

    // Check p-tag targets us
    const pTags = event.tags.filter((t) => t[0] === "p");
    if (!pTags.some((t) => t[1] === this.identity.pubkey)) return;
    if (event.pubkey !== this.appPubkey) return;

    // Decrypt
    let plaintext: string;
    try {
      plaintext = nip44.decrypt(event.content, this.convKey);
    } catch {
      return;
    }

    // Parse frame
    let frame: any;
    try {
      frame = JSON.parse(plaintext);
    } catch {
      return;
    }

    if (frame.type === "frame") {
      this.onMessage?.(frame.frameType ?? "send", frame.data ?? {});
    }
  }
}
