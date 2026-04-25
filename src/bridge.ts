/**
 * pi-nostr-bridge — pure WebSocket server wrapping pi.
 * No Nostr, no keypairs, no relays. Just TypeScript, pi SDK, and a WebSocket.
 *
 * Architecture:
 *   Phone ──Tailscale──► WebSocket ──► pi session ──► streaming JSON frames
 */

import { WebSocketServer, type WebSocket } from "ws";
import * as http from "node:http";

import {
  type AgentSession, type AgentSessionEvent,
  AuthStorage, createAgentSession, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";

import type { BridgeConfig } from "./config.js";

// ── Per-connection state ─────────────────────────────────────────────

interface ConnState {
  ws: WebSocket;
  session: AgentSession;
  sessionManager: SessionManager;
  currentModel: string;
  lastActivity: number;
}

// ── Bridge ───────────────────────────────────────────────────────────

export class PiBridge {
  private connections = new Map<string, ConnState>();

  constructor(private config: BridgeConfig) {}

  async start() {
    const cfg = this.config;
    const server = http.createServer((req, res) => {
      res.writeHead(200).end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws: WebSocket) => {
      const connId = crypto.randomUUID().slice(0, 8);
      console.log(`[ws] ${connId} connected`);

      ws.send(JSON.stringify({ type: "state_sync", data: { connId } }));

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "send" && msg.data?.text?.trim()) {
            await this.handleSend(connId, ws, msg.data.text.trim());
          }
        } catch (e: any) {
          ws.send(JSON.stringify({ type: "error", data: { message: e?.message ?? "parse error" } }));
        }
      });

      ws.on("close", () => {
        const state = this.connections.get(connId);
        if (state) try { state.session.dispose(); } catch {}
        this.connections.delete(connId);
        console.log(`[ws] ${connId} disconnected`);
      });

      ws.on("error", () => this.connections.delete(connId));
    });

    server.listen(cfg.wsPort, "0.0.0.0", () => {
      console.log(`pi-bridge listening on port ${cfg.wsPort}`);
      console.log(`Connect via Tailscale: ws://100.x.x.x:${cfg.wsPort}`);
    });
  }

  // ── Handle a message ──────────────────────────────────────────────

  private async handleSend(connId: string, ws: WebSocket, text: string) {
    // Get or create session for this connection
    let conn = this.connections.get(connId);
    if (!conn) {
      const created = await this.createSession(ws);
      if (!created) {
        ws.send(JSON.stringify({ type: "error", data: { message: "Failed to create pi session" } }));
        return;
      }
      this.connections.set(connId, created);
      conn = created;
    }

    // Check for commands
    if (await this.handleCommand(conn, ws, text)) return;

    // Run prompt
    conn.lastActivity = Date.now();
    await this.runPrompt(conn, text);
  }

  // ── Create pi session ─────────────────────────────────────────────

  private async createSession(ws: WebSocket): Promise<ConnState | null> {
    try {
      const cfg = this.config;
      const sm = SessionManager.create(cfg.cwd);
      const settings = SettingsManager.inMemory({
        compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 },
      });
      const auth = AuthStorage.create();
      const registry = ModelRegistry.create(auth);

      const { session } = await createAgentSession({
        cwd: cfg.cwd, agentDir: cfg.agentDir || undefined,
        sessionManager: sm, settingsManager: settings,
        authStorage: auth, modelRegistry: registry,
      });

      const model = session.model;
      const label = model ? `${model.provider}/${model.id}` : "default";

      return { ws, session, sessionManager: sm, currentModel: label, lastActivity: Date.now() };
    } catch (e: any) {
      console.error(`[session] ${e?.message}`);
      return null;
    }
  }

  // ── Commands ──────────────────────────────────────────────────────

  private async handleCommand(state: ConnState, ws: WebSocket, text: string): Promise<boolean> {
    const cmd = text.toLowerCase();
    const send = (t: string) => ws.send(JSON.stringify({
      type: "text_delta", data: { text: t, seq: 0, more: false },
    }));

    if (cmd === "/help" || cmd === "!help") {
      send("Commands: /model <name>, /models, /model, /reset, /stats");
      return true;
    }

    if (cmd === "/stats" || cmd === "!stats") {
      send(`Model: ${state.currentModel}`);
      send(`Messages: ${state.sessionManager.getEntries().length}`);
      return true;
    }

    if (cmd === "/reset" || cmd === "!reset") {
      try { await state.session.abort(); state.session.dispose(); } catch {}
      const newState = await this.createSession(state.ws);
      if (newState) {
        this.connections.set([...this.connections.entries()].find(([, s]) => s === state)?.[0] ?? "", newState);
        state.session = newState.session;
        state.sessionManager = newState.sessionManager;
        state.currentModel = newState.currentModel;
      }
      send("🔄 Reset.");
      return true;
    }

    if (cmd === "/models" || cmd === "!models") {
      try {
        const registry = ModelRegistry.create(AuthStorage.create());
        const available = await registry.getAvailable();
        const lines = available.slice(0, 30).map((m: any) =>
          `  ${m.provider}/${m.id}${m.id === state.currentModel ? " ◀" : ""}`
        );
        send(`${available.length} available:`);
        for (const l of lines) send(l);
      } catch { send("❌ Could not list models"); }
      return true;
    }

    if (cmd.startsWith("/model ") || cmd.startsWith("!model ")) {
      const name = text.split(/[\s]+/).slice(1).join(" ").trim();
      if (!name) { send(`Current: ${state.currentModel}`); return true; }
      try {
        const registry = ModelRegistry.create(AuthStorage.create());
        const available = await registry.getAvailable();
        const model = available.find((m: any) =>
          `${m.provider}/${m.id}`.toLowerCase().includes(name.toLowerCase()) ||
          m.id.toLowerCase().includes(name.toLowerCase())
        );
        if (model) {
          await state.session.setModel(model);
          state.currentModel = `${model.provider}/${model.id}`;
          send(`✅ ${state.currentModel}`);
        } else {
          send(`❌ No model matching "${name}"`);
        }
      } catch (e: any) { send(`❌ ${e?.message}`); }
      return true;
    }

    if (cmd === "/model" || cmd === "!model") {
      send(`Current: ${state.currentModel}`);
      send(`/models to list, /model <name> to switch`);
      return true;
    }

    return false;
  }

  // ── Run prompt ────────────────────────────────────────────────────

  private async runPrompt(state: ConnState, promptText: string) {
    const ws = state.ws;
    let responseText = "", thinkingText = "", deltaSeq = 0;
    let unsub: (() => void) | undefined;

    try {
      unsub = state.session.subscribe((event: AgentSessionEvent) => {
        if (event.type !== "message_update" || !("assistantMessageEvent" in event)) return;
        const e = (event as any).assistantMessageEvent;
        if (e?.type === "thinking_delta") {
          thinkingText += e.delta ?? "";
          ws.send(JSON.stringify({ type: "thinking", data: { text: thinkingText } }));
        }
        if (e?.type === "text_delta") {
          responseText += e.delta ?? ""; deltaSeq++;
          ws.send(JSON.stringify({ type: "text_delta", data: { text: responseText, seq: deltaSeq, more: true } }));
        }
      });

      state.lastActivity = Date.now();
      await state.session.prompt(promptText);
      if (unsub) unsub();

      ws.send(JSON.stringify({ type: "text_delta", data: { text: responseText, seq: deltaSeq, more: false } }));
      ws.send(JSON.stringify({ type: "turn_complete", data: {} }));

      // Extract diffs
      const diffRegex = /```diff\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = diffRegex.exec(responseText)) !== null) {
        const fileMatch = match[1].match(/^[+]{3} [ab]\/(.+)$/m);
        ws.send(JSON.stringify({ type: "diff", data: { file: fileMatch?.[1]?.trim() ?? "file", diff: match[1], status: "modified" } }));
      }
    } catch (e: any) {
      if (unsub) unsub();
      console.error(`[session] ${e?.message}`);
    }
  }
}
