/**
 * pi-bridge — Server wrapping pi.
 * Supports multiple threads per connection, keyed by thread ID.
 *
 * Transport-agnostic: receives and sends frames through a Transport
 * interface (WebSocket, WebRTC DataChannel, etc.).
 */

import { WebSocketServer } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as pathLib from "node:path";

import {
  type AgentSession, type AgentSessionEvent,
  AuthStorage, createAgentSession, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";

import type { BridgeConfig } from "./config.js";
import { type Transport, WebSocketTransport } from "./transport.js";

interface ThreadState {
  session: AgentSession;
  sessionManager: SessionManager;
  cwd: string;
  currentModel: string;
  lastActivity: number;
}

// Sessions keyed by thread ID
const threadSessions = new Map<string, ThreadState>();

export class PiBridge {
  constructor(private config: BridgeConfig) {}

  async start() {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      const transport = new WebSocketTransport(ws, `ws_${Date.now()}`);
      this.setupTransport(transport);
      transport.onOpen?.();
    });

    const cfg = this.config;
    server.listen(cfg.wsPort, "0.0.0.0", () => {
      console.log(`pi-bridge on port ${cfg.wsPort}`);
    });
  }

  /**
   * Register an external transport (e.g. from WebRTC DataChannel).
   * The transport's onMessage/onClose/onError callbacks are wired
   * the same way as WebSocket connections.
   */
  addTransport(transport: Transport): void {
    this.setupTransport(transport);
    transport.onOpen?.();
  }

  /** Shared setup for any Transport — wires message dispatch. */
  private setupTransport(transport: Transport): void {
    transport.onMessage = (type, data) => {
      if (type === "send" && (data.text as string)?.trim()) {
        const threadId = (data.thread as string) ?? "default";
        this.handleSend(transport, threadId, (data.text as string).trim()).catch(() => {});
      } else if (type === "list_dir") {
        this.handleListDir(transport, (data.path as string) ?? "/").catch(() => {});
      }
    };
  }

  // ── Send ────────────────────────────────────────────────────────────

  private async handleSend(transport: Transport, threadId: string, text: string) {
    const tid = threadId;
    let ts: ThreadState | undefined | null = threadSessions.get(threadId);

    // Handle /dir specially — creates new session with new cwd
    const cmd = text.toLowerCase();
    if (cmd.startsWith("/dir ") || cmd.startsWith("!dir ")) {
      const newCwd = text.split(/[\s]+/).slice(1).join(" ").trim();
      if (!newCwd) return;
      const resolved = pathLib.resolve(newCwd);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        transport.send("text_delta", { text: `❌ Not a directory: ${resolved}`, seq: 0, more: false });
        return;
      }
      // Dispose old session for this thread, create new one
      if (ts) try { ts.session.dispose(); } catch {}
      const created = await this.createSession(resolved);
      if (created) {
        threadSessions.set(threadId, created);
        transport.send("state_sync", { cwd: resolved });
      }
      return;
    }

    if (!ts) {
      ts = await this.createSession(this.config.cwd);
      if (!ts) { transport.send("error", { message: "Failed to create session" }); return; }
      threadSessions.set(threadId, ts);
    }

    if (await this.handleCommand(ts, transport, text)) return;
    ts.lastActivity = Date.now();
    await this.runPrompt(ts, transport, text, threadId);
  }

  // ── List directory ─────────────────────────────────────────────────

  private async handleListDir(transport: Transport, dirPath: string) {
    try {
      const resolved = pathLib.resolve(dirPath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, path: pathLib.join(resolved, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      transport.send("dir_list", { path: resolved, entries });
    } catch (e: any) {
      transport.send("dir_list", { path: dirPath, entries: [], error: e?.message });
    }
  }

  // ── Create pi session ─────────────────────────────────────────────

  private async createSession(cwd: string): Promise<ThreadState | null> {
    try {
      const cfg = this.config;
      const sm = SessionManager.create(cwd);
      const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
      const auth = AuthStorage.create();
      const registry = ModelRegistry.create(auth);
      const { session } = await createAgentSession({
        cwd, agentDir: cfg.agentDir || undefined,
        sessionManager: sm, settingsManager: settings,
        authStorage: auth, modelRegistry: registry,
      });
      return { session, sessionManager: sm, cwd, currentModel: session.model ? `${session.model.provider}/${session.model.id}` : "default", lastActivity: Date.now() };
    } catch (e: any) { console.error(`[session] ${e?.message}`); return null; }
  }

  // ── Commands ──────────────────────────────────────────────────────

  private async handleCommand(ts: ThreadState, transport: Transport, text: string): Promise<boolean> {
    const cmd = text.toLowerCase();
    const send = (t: string) => transport.send("text_delta", { text: t, seq: 0, more: false });

    if (cmd === "/help" || cmd === "!help") { send("Commands: /model <name>, /models, /dir <path>, /reset, /stats"); return true; }
    if (cmd === "/stats" || cmd === "!stats") { send(`Model: ${ts.currentModel}\nCWD: ${ts.cwd}`); return true; }

    if (cmd === "/reset" || cmd === "!reset") {
      try { await ts.session.abort(); ts.session.dispose(); } catch {}
      const newTs = await this.createSession(ts.cwd);
      if (newTs) Object.assign(ts, newTs);
      send("🔄 Reset."); return true;
    }

    if (cmd === "/models" || cmd === "!models") {
      try {
        const available = await ModelRegistry.create(AuthStorage.create()).getAvailable();
        const lines = available.slice(0, 30).map((m: any) => `  ${m.provider}/${m.id}${m.id === ts.currentModel ? " ◀" : ""}`);
        send(`${available.length} available:`);
        for (const l of lines) send(l);
      } catch { send("❌ Could not list models"); }
      return true;
    }

    if (cmd.startsWith("/model ") || cmd.startsWith("!model ")) {
      const name = text.split(/[\s]+/).slice(1).join(" ").trim();
      if (!name) { send(`Current: ${ts.currentModel}`); return true; }
      try {
        const available = await ModelRegistry.create(AuthStorage.create()).getAvailable();
        const model = available.find((m: any) => `${m.provider}/${m.id}`.toLowerCase().includes(name.toLowerCase()) || m.id.toLowerCase().includes(name.toLowerCase()));
        if (model) { await ts.session.setModel(model); ts.currentModel = `${model.provider}/${model.id}`; send(`✅ ${ts.currentModel}`); }
        else send(`❌ No model matching "${name}"`);
      } catch (e: any) { send(`❌ ${e?.message}`); }
      return true;
    }
    if (cmd === "/model" || cmd === "!model") { send(`Current: ${ts.currentModel}`); return true; }

    return false;
  }

  // ── Run prompt ────────────────────────────────────────────────────

  private async runPrompt(ts: ThreadState, transport: Transport, promptText: string, tid: string) {
    let responseText = "", thinkingText = "", deltaSeq = 0;
    let currentMessageId: string | undefined;
    let unsub: (() => void) | undefined;
    const send = (type: string, data: any) => transport.send(type, { ...data, thread: tid });

    /** Flush the current accumulated responseText as a completed segment. */
    function flushResponse() {
      if (responseText !== "" || deltaSeq > 0) {
        send("text_delta", { text: responseText, seq: deltaSeq, more: false });
        responseText = "";
        thinkingText = "";
        deltaSeq = 0;
        currentMessageId = undefined;
      }
    }

    try {
      unsub = ts.session.subscribe((event: AgentSessionEvent) => {
        // When a new assistant message starts (e.g. from an inner chat tool),
        // flush the previous message's text so it becomes its own bubble.
        if (event.type === "message_start" && (event as any).message?.role === "assistant") {
          const msgId = (event as any).message?.responseId;
          if (msgId && msgId !== currentMessageId && currentMessageId !== undefined) {
            flushResponse();
          }
          currentMessageId = msgId ?? `msg_${Date.now()}_${Math.random()}`;
        }

        if (event.type === "message_update" && "assistantMessageEvent" in event) {
          const e = (event as any).assistantMessageEvent;
          if (e?.type === "thinking_delta") { thinkingText += e.delta ?? ""; send("thinking", { text: thinkingText }); }
          if (e?.type === "text_delta") { responseText += e.delta ?? ""; deltaSeq++; send("text_delta", { text: responseText, seq: deltaSeq, more: true }); }
        }
        if (event.type === "tool_execution_start") {
          const ev = event as any;
          send("tool_call", { id: ev.toolCallId ?? "", name: ev.toolName ?? "", args: ev.args ?? {}, status: "running" });
          console.log(`→ ${ev.toolName}`);
        }
        if (event.type === "tool_execution_end") {
          const ev = event as any;
          send("tool_call", { id: ev.toolCallId ?? "", name: ev.toolName ?? "", status: ev.isError ? "error" : "complete" });
          console.log(`← ${ev.toolName} ${ev.isError ? "❌" : "✓"}`);
        }
        // When a turn ends (tool results processed, starting a new LLM call),
        // flush so the next assistant message starts a fresh text bubble.
        if (event.type === "turn_end") {
          flushResponse();
        }
      });

      ts.lastActivity = Date.now();
      await ts.session.prompt(promptText);
      if (unsub) unsub();
      flushResponse();
      send("turn_complete", {});
    } catch (e: any) {
      if (unsub) unsub();
      console.error(`[session] ${e?.message}`);
    }
  }
}
