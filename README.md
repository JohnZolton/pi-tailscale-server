# pi-nostr-bridge

**Talk to [pi](https://pi.dev) coding agent from your phone via Nostr encrypted DMs (NIP-17).**

Each conversation thread gets its own Nostr keypair and npub. DM the main bot to spawn a new thread; DM a thread npub to continue that conversation. Multiple threads run concurrently, each with independent identity and session.

## How it works

```
┌─────────────────────┐      NIP-17 DM       ┌──────────────────────┐
│  Your Phone         │ ◄──────────────────► │  pi-nostr-bridge     │
│  (Primal, Amethyst, │                      │                      │
│   0xchat, etc.)     │                      │  ┌─ thread npub #1 ─┐│
│                     │                      │  │ pi session #1    ││
│  DM bot npub        │  ── !new "refactor"  │  └──────────────────┘│
│       │             │                      │  ┌─ thread npub #2 ─┐│
│       ▼             │  ── "add tests"      │  │ pi session #2    ││
│  thread npub #1 ◄───┤  ◄── response        │  └──────────────────┘│
│  thread npub #2 ◄───┤  ◄── response        │  ── thread npub #3 ─┐│
│                     │                      │    pi session #3    ││
└─────────────────────┘                      └──────────────────────┘
```

## Quick Start

### 1. Generate a Nostr keypair for the bridge

```bash
# Using nostr-tools
node -e "
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { bytesToHex } from 'nostr-tools/utils';
const sk = generateSecretKey();
console.log('BOT_NSEC=' + bytesToHex(sk));
console.log('BOT_NPUB=' + npubEncode(getPublicKey(sk)));
" --input-type=module
```

Or use any Nostr tool to generate an nsec.

### 2. Set up environment

```bash
export BOT_NSEC="nsec1... or hex key"          # Your bridge's identity (REQUIRED)
export AUTH_NPUB="npub1... or hex pubkey"      # Your pubkey (REQUIRED — only you can DM)
export RELAYS="wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://relay.primal.net"
export PI_CWD="/path/to/your/project"          # Where pi works
```

### 3. Run

```bash
npx tsx src/index.ts
```

Or install globally:

```bash
npm install -g .
pi-nostr-bridge
```

### 4. DM from your phone

- Open any NIP-17 Nostr client (Primal, Amethyst, 0xchat, etc.)
- DM the bot's npub with any message
- You'll get a DM back **from a new thread npub**
- Reply to that thread npub to continue the conversation
- DM the main bot again to start another thread

## Commands

Anywhere:
| Command | Description |
|---------|-------------|
| `!help` | Show available commands |
| `!stats` | Bridge statistics |
| `!stop` | Stop the current task (in a thread) |
| `!reset` | Reset the session (in a thread) |
| `!new <prompt>` | Start a new thread with a prompt |
| `!kill` | Remove the thread entirely |

## Architecture

- **Per-thread keypairs** — Each conversation gets its own Nostr identity. Thread keypairs are persisted in `.pi-nostr-threads.json` so they survive restarts.
- **NIP-17 encryption** — All DMs use NIP-44 encryption inside NIP-59 gift wraps (kind 1059 → kind 13 → kind 14).
- **Inbox relay discovery** — The bridge publishes kind 10050 and 10002 events so other clients know where to send DMs. It also discovers recipient inbox relays before replying.
- **Session management** — Uses pi's SDK (`createAgentSession`) with per-sender sessions stored in `~/.pi/agent/sessions/`.
- **Stale cleanup** — Sessions idle for >30 minutes are automatically closed.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_NSEC` | ✅ | Bridge's secret key (hex or nsec1) |
| `AUTH_NPUB` | ✅ | Your pubkey (hex or npub1) — only DM recipient |
| `RELAYS` | ❌ | Comma-sep relay URLs (default: 6 common relays) |
| `PI_CWD` | ❌ | pi working directory (default: cwd) |
| `PI_AGENT_DIR` | ❌ | pi agent directory (default: ~/.pi/agent) |
| `RECONNECT_INTERVAL_MS` | ❌ | Relay reconnect interval (default: 60000) |

## Dependencies

- **[@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)** — pi's SDK for agent sessions
- **[nostr-tools](https://github.com/nbd-wtf/nostr-tools)** — NIP-17, NIP-44, NIP-59 implementation
- Node.js 22+

## Comparison with t3code

| Feature | t3code-orchestrator | pi-nostr-bridge |
|---------|-------------------|-----------------|
| Underlying agent | Claude agent SDK | pi (any provider/model) |
| Per-thread npubs | ✅ | ✅ |
| Thread persistence | SQLite | JSON file |
| NIP-17 DMs | ✅ | ✅ |
| Streaming responses | ✅ | ✅ (full response) |
| Phone → code agent | ✅ | ✅ |
| Ubuntu stability | ❌ (crashes) | ✅ (standalone Node) |
| Multi-provider | Claude only | Any pi-supported model |

## License

MIT
