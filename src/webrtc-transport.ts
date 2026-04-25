/**
 * WebRTC DataChannel transport — implements the Transport interface
 * using node-datachannel PeerConnection + DataChannel.
 *
 * This replaces WebSocket as the transport between bridge and Android app.
 * Signaling (offer/answer/ICE) is handled by NostrSignaler.
 */

import * as nd from "node-datachannel";
import { type Transport } from "./transport.js";
import { NostrSignaler, type SignalingMessage } from "./signaler.js";
import type { BridgeIdentity } from "./identity.js";

/** STUN servers for NAT traversal (Google's public STUN). */
const STUN_SERVERS = ["stun:stun.l.google.com:19302"];

/**
 * Wraps a node-datachannel DataChannel into the Transport interface.
 */
export class DataChannelTransport implements Transport {
  readonly peerId: string;
  private dc: nd.DataChannel;

  onOpen?: () => void;
  onMessage?: (type: string, data: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;

  constructor(dc: nd.DataChannel, peerId: string) {
    this.dc = dc;
    this.peerId = peerId;

    dc.onOpen(() => {
      console.log(`[webrtc] DataChannel open: ${peerId}`);
      this.onOpen?.();
    });

    dc.onMessage((msg) => {
      try {
        const parsed =
          typeof msg === "string" ? JSON.parse(msg) : JSON.parse(Buffer.from(msg as ArrayBuffer).toString());
        const type = parsed.type ?? "unknown";
        const data = parsed.data ?? {};
        this.onMessage?.(type, data);
      } catch {
        // ignore malformed frames
      }
    });

    dc.onClosed(() => {
      console.log(`[webrtc] DataChannel closed: ${peerId}`);
      this.onClose?.();
    });

    dc.onError((err) => {
      this.onError?.(new Error(err));
    });
  }

  send(type: string, data: Record<string, unknown>): void {
    this.dc.sendMessage(JSON.stringify({ type, data }));
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Manages WebRTC peer connections created from Nostr signaling.
 *
 * Flow:
 *   1. Android sends "webrtc-offer" over Nostr → bridge creates PeerConnection
 *   2. Bridge sets remote description, creates answer, sends "webrtc-answer"
 *   3. Both sides exchange ICE candidates over Nostr
 *   4. DataChannel opens → DataChannelTransport is ready
 */
export class WebRtcManager {
  private identity: BridgeIdentity;
  private signaler: NostrSignaler;
  private peers = new Map<string, nd.PeerConnection>();
  private iceBuffer = new Map<string, Array<{ candidate: string; mid: string }>>();

  /** Called when a new P2P transport is ready. */
  onTransport?: (transport: DataChannelTransport) => void;

  constructor(identity: BridgeIdentity, signaler: NostrSignaler) {
    this.identity = identity;
    this.signaler = signaler;

    // Wire up signaling callbacks
    signaler.on({
      onOffer: (msg, fromPubkey) => this.handleOffer(msg, fromPubkey),
      onAnswer: (msg, fromPubkey) => this.handleAnswer(msg, fromPubkey),
      onIce: (msg, fromPubkey) => this.handleIce(msg, fromPubkey),
      onPairingRequest: (msg, fromPubkey) => {
        console.log(`[webrtc] Pairing request from ${fromPubkey.slice(0, 12)}...`);
        // Send acknowledgment back to confirm Nostr DM round-trip works
        signaler.sendMessage(fromPubkey, { type: "pairing-ack", pairingCode: identity.pairingCode });
        console.log(`[webrtc] Sent pairing-ack to ${fromPubkey.slice(0, 12)}`);
      },
    });

    console.log("[webrtc] Manager ready");
  }

  /** Stop all peer connections. */
  stop(): void {
    for (const pc of this.peers.values()) {
      try {
        pc.close();
      } catch {}
    }
    this.peers.clear();
    this.iceBuffer.clear();
  }

  // ── Offer (Android → Bridge) ──

  private async handleOffer(msg: SignalingMessage & { type: "webrtc-offer" }, fromPubkey: string): Promise<void> {
    console.log(`[webrtc] Offer from ${fromPubkey.slice(0, 12)}...`);

    const peerId = fromPubkey.slice(0, 16);

    // Create PeerConnection with STUN
    const pc = new nd.PeerConnection(peerId, { iceServers: STUN_SERVERS });
    this.peers.set(peerId, pc);

    let transport: DataChannelTransport | undefined;

    // Wire callbacks BEFORE setting descriptions
    // When local description (answer) is ready, send it
    pc.onLocalDescription((sdp, type) => {
      console.log(`[webrtc] Local description: ${type}`);
      if (type === "answer") {
        // Flush any buffered ICE candidates
        const buffer = this.iceBuffer.get(peerId);
        if (buffer) {
          for (const ic of buffer) {
            pc.addRemoteCandidate(ic.candidate, ic.mid);
          }
          this.iceBuffer.delete(peerId);
        }

        this.signaler.sendMessage(fromPubkey, { type: "webrtc-answer", sdp }).catch(() => {});
      }
    });

    // Send ICE candidates back over Nostr
    pc.onLocalCandidate((candidate, mid) => {
      console.log(`[webrtc] ICE candidate: ${candidate.slice(0, 30)}...`);
      this.signaler.sendMessage(fromPubkey, {
        type: "webrtc-ice",
        candidate: `${candidate}|${mid}`,
      }).catch(() => {});
    });

    // Answerer side: receive DataChannel from the offerer, don't create one
    pc.onDataChannel((dc) => {
      console.log(`[webrtc] DataChannel received`);
      transport = new DataChannelTransport(dc, peerId);
    });

    // Set remote description (the app's offer), then create answer
    try {
      pc.setRemoteDescription(msg.sdp, "offer");
      console.log(`[webrtc] Remote description set, creating answer...`);
    } catch (e) {
      console.error(`[webrtc] setRemoteDescription failed: ${(e as Error).message}`);
      return;
    }

    try {
      pc.setLocalDescription("answer");
      console.log(`[webrtc] Answer created`);
    } catch (e) {
      console.error(`[webrtc] setLocalDescription failed: ${(e as Error).message}`);
    }

    // Monitor ICE connection state for connectivity
    pc.onIceStateChange((state) => {
      console.log(`[webrtc] ICE state: ${state}`);
      if (state === "connected" || state === "completed") {
        console.log(`[webrtc] P2P connected: ${peerId}`);
        if (transport) {
          this.onTransport?.(transport);
        }
      }
    });
  }

  // ── Answer (Bridge → Android) — used when bridge initiates  ──

  private handleAnswer(msg: SignalingMessage & { type: "webrtc-answer" }, fromPubkey: string): void {
    const peerId = fromPubkey.slice(0, 16);
    const pc = this.peers.get(peerId);
    if (!pc) {
      console.warn(`[webrtc] No PC for answer from ${peerId}`);
      return;
    }
    pc.setRemoteDescription(msg.sdp, "answer");
    console.log(`[webrtc] Remote description set for ${peerId}`);
  }

  // ── ICE candidates ──

  private handleIce(msg: SignalingMessage & { type: "webrtc-ice" }, fromPubkey: string): void {
    const peerId = fromPubkey.slice(0, 16);
    const [candidate, mid] = (msg.candidate ?? "").split("|");
    if (!candidate || !mid) return;

    const pc = this.peers.get(peerId);
    if (pc) {
      pc.addRemoteCandidate(candidate, mid);
    } else {
      // Buffer ICE candidates until PC is created
      const buffer = this.iceBuffer.get(peerId) ?? [];
      buffer.push({ candidate, mid });
      this.iceBuffer.set(peerId, buffer);
    }
  }
}
