/**
 * Nostr DM transport for agent frames.
 *
 * Implements the Transport interface so the bridge can send/receive
 * agent frames over NIP-44 encrypted Nostr DMs.
 *
 * Buffers streaming frames during a turn and sends the complete
 * response as a single Nostr DM — no streaming over relays.
 */

import { nip44, finalizeEvent, Relay, type Event } from "nostr-tools";
import { type Transport } from "./transport.js";
import type { BridgeIdentity } from "./identity.js";

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** A single agent frame. */
interface Frame {
  type: string;
  data: Record<string, unknown>;
}

/** Inbound Nostr messages wrap the original WS frame. */
interface InboundMessage {
  type: string;
  data: Record<string, unknown>;
}

export class NostrTransport implements Transport {
  readonly peerId: string;
  private identity: BridgeIdentity;
  private appPubkey: string;
  private relays: string[];
  private relay: Relay | undefined;
  private convKey: Uint8Array | undefined;
  private unsub: (() => void) | undefined;

  // Buffer frames per turn
  private frameBuffer: Frame[] = [];
  private hasPendingResponse = false;

  onOpen?: () => void;
  onMessage?: (type: string, data: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;

  constructor(identity: BridgeIdentity, appPubkey: string, relays: string[]) {
    this.peerId = appPubkey.slice(0, 16);
    this.identity = identity;
    this.appPubkey = appPubkey;
    this.relays = relays;
    const skBytes = hexToBytes(identity.privkey);
    this.convKey = nip44.getConversationKey(skBytes, appPubkey);
  }

  async start(): Promise<void> {
    for (const url of this.relays) {
      try {
        this.relay = await Relay.connect(url);
        console.log(`[nostr] Connected to ${url}`);

        const sub = this.relay.subscribe(
          [{ kinds: [1059], "#p": [this.identity.pubkey] }],
          { onevent: (event: Event) => this.handleIncoming(event) },
        );
        this.unsub = () => sub.close();

        console.log(`[nostr] Listening for frames from ${this.appPubkey.slice(0, 12)}...`);
        this.onOpen?.();
        return;
      } catch (e) {
        console.warn(`[nostr] Failed ${url}: ${(e as Error).message}`);
      }
    }
    this.onError?.(new Error("No relays available"));
  }

  /** Send a frame. Buffers streaming frames, sends complete response on turn_complete. */
  send(type: string, data: Record<string, unknown>): void {
    // Buffer text/thinking/tool frames
    if (type === "text_delta" || type === "thinking" || type === "tool_call") {
      this.hasPendingResponse = true;
      this.frameBuffer.push({ type, data });
      return;
    }

    // On turn_complete, flush the buffer as one DM
    if (type === "turn_complete") {
      this.frameBuffer.push({ type, data });
      this.flushResponse();
      return;
    }

    // For other types (state_sync, error, dir_list), send immediately
    this.publishFrame({ type, data });
  }

  close(): void {
    this.unsub?.();
    try { this.relay?.close(); } catch {}
  }

  // ── Private ──

  /** Publish a single frame as an encrypted Nostr DM. */
  private publishFrame(frame: Frame): void {
    if (!this.relay || !this.convKey) return;

    const payload = JSON.stringify({ type: "frame", frames: [frame] });
    const ciphertext = nip44.encrypt(payload, this.convKey);

    const event = finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [["p", this.appPubkey]], content: ciphertext },
      hexToBytes(this.identity.privkey),
    );

    this.relay.publish(event).catch(() => {});
  }

  /** Send buffered frames as a single Nostr DM. */
  private flushResponse(): void {
    if (!this.relay || !this.convKey || this.frameBuffer.length === 0) return;

    const payload = JSON.stringify({ type: "frame", frames: this.frameBuffer });
    const ciphertext = nip44.encrypt(payload, this.convKey);

    const event = finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [["p", this.appPubkey]], content: ciphertext },
      hexToBytes(this.identity.privkey),
    );

    this.relay.publish(event).catch(() => {});
    this.frameBuffer = [];
    this.hasPendingResponse = false;
  }

  private handleIncoming(event: Event): void {
    if (!this.convKey) return;

    const pTags = event.tags.filter((t) => t[0] === "p");
    if (!pTags.some((t) => t[1] === this.identity.pubkey)) return;
    if (event.pubkey !== this.appPubkey) return;

    let plaintext: string;
    try { plaintext = nip44.decrypt(event.content, this.convKey); } catch { return; }

    let msg: InboundMessage;
    try { msg = JSON.parse(plaintext); } catch { return; }

    this.onMessage?.(msg.type ?? "send", msg.data ?? {});
  }
}
