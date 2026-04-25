/**
 * pi-bridge — WebSocket server wrapping pi.
 * Supports multiple threads per connection, keyed by thread ID.
 */

import { WebSocketServer, type WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as pathLib from "node:path";

import {
  type AgentSession, type AgentSessionEvent,
  AuthStorage, createAgentSession, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";

import type { BridgeConfig } from "./config.js";

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

    wss.on("connection", (ws: WebSocket) => {
      ws.send(JSON.stringify({ type: "state_sync", data: {} }));

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const data = msg.data ?? {};

          if (msg.type === "send" && data.text?.trim()) {
            const threadId = data.thread ?? "default";
            await this.handleSend(ws, threadId, data.text.trim());
          } else if (msg.type === "list_dir") {
            await this.handleListDir(ws, data.path ?? "/");
          }
        } catch (e: any) {
          ws.send(JSON.stringify({ type: "error", data: { message: e?.message ?? "error" } }));
        }
      });
    });

    const cfg = this.config;
    server.listen(cfg.wsPort, "0.0.0.0", () => {
      console.log(`pi-bridge on port ${cfg.wsPort}`);
    });
  }

  // ── Send ────────────────────────────────────────────────────────────

  private async handleSend(ws: WebSocket, threadId: string, text: string) {
    const tid = threadId;
    let ts: ThreadState | undefined | null = threadSessions.get(threadId);

    // Handle /dir specially — creates new session with new cwd
    const cmd = text.toLowerCase();
    if (cmd.startsWith("/dir ") || cmd.startsWith("!dir ")) {
      const newCwd = text.split(/[\s]+/).slice(1).join(" ").trim();
      if (!newCwd) return;
      const resolved = pathLib.resolve(newCwd);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        ws.send(JSON.stringify({ type: "text_delta", data: { text: `❌ Not a directory: ${resolved}`, seq: 0, more: false } }));
        return;
      }
      // Dispose old session for this thread, create new one
      if (ts) try { ts.session.dispose(); } catch {}
      const created = await this.createSession(resolved);
      if (created) {
        threadSessions.set(threadId, created);
        ws.send(JSON.stringify({ type: "state_sync", data: { cwd: resolved } }));
      }
      return;
    }

    if (!ts) {
      ts = await this.createSession(this.config.cwd);
      if (!ts) { ws.send(JSON.stringify({ type: "error", data: { message: "Failed" } })); return; }
      threadSessions.set(threadId, ts);
    }

    if (await this.handleCommand(ts, ws, text)) return;
    ts.lastActivity = Date.now();
    await this.runPrompt(ts, ws, text, threadId);
  }

  // ── List directory ─────────────────────────────────────────────────

  private async handleListDir(ws: WebSocket, dirPath: string) {
    try {
      const resolved = pathLib.resolve(dirPath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, path: pathLib.join(resolved, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      ws.send(JSON.stringify({ type: "dir_list", data: { path: resolved, entries } }));
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "dir_list", data: { path: dirPath, entries: [], error: e?.message } }));
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

  private async handleCommand(ts: ThreadState, ws: WebSocket, text: string): Promise<boolean> {
    const cmd = text.toLowerCase();
    const send = (t: string) => ws.send(JSON.stringify({ type: "text_delta", data: { text: t, seq: 0, more: false } }));

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

  private async runPrompt(ts: ThreadState, ws: WebSocket, promptText: string, tid: string) {
    let responseText = "", thinkingText = "", deltaSeq = 0;
    let currentMessageId: string | undefined;
    let unsub: (() => void) | undefined;
    const send = (type: string, data: any) => ws.send(JSON.stringify({ type, data: { ...data, thread: tid } }));

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
