/**
 * Pluggable transport for sending/receiving JSON frames.
 *
 * Implementations:
 *   - WebSocketTransport  (Tailscale / direct WS, the current path)
 *   - WebRtcTransport     (P2P data channel)   — coming soon
 *
 * The bridge uses this interface so any transport
 * can be swapped in without changing the agent logic.
 */

export interface Transport {
  /** Unique identifier for this peer (used for logging). */
  readonly peerId: string;

  /** Send a JSON-serializable object. */
  send(type: string, data: Record<string, unknown>): void;

  /** Close the connection. */
  close(): void;

  // ── Lifecycle callbacks (set by the bridge) ──

  onOpen?: () => void;
  onMessage?: (type: string, data: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

/**
 * WebSocket-based transport — wraps a `ws` WebSocket into the Transport interface.
 */
import { type WebSocket } from "ws";

export class WebSocketTransport implements Transport {
  readonly peerId: string;
  private ws: WebSocket;

  onOpen?: () => void;
  onMessage?: (type: string, data: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;

  constructor(ws: WebSocket, peerId?: string) {
    this.ws = ws;
    this.peerId = peerId ?? `ws_${Date.now()}`;

    ws.on("open", () => this.onOpen?.());
    ws.on("close", () => this.onClose?.());
    ws.on("error", (err) => this.onError?.(err));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const type = msg.type ?? "unknown";
        const data = msg.data ?? {};
        this.onMessage?.(type, data);
      } catch (e) {
        // ignore malformed frames
      }
    });
  }

  send(type: string, data: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ type, data }));
  }

  close(): void {
    this.ws.close(1000, "Bridge closing");
  }
}
