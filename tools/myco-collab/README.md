# myco-collab — Agent Collaboration Plugin

An MCP (Model Context Protocol) server that enables AI agents running in
[DSH](https://github.com/user/dsh) (DeepSeek Harness) or other MCP-compatible
harnesses (Claude Code, Codex, etc.) to connect to and collaborate through
the myco network.

## What It Does

Once installed, every harness session automatically gets:

- **Collaboration Directory** — a live list of agents you can work with:
  myco contacts (chat_state), shared tasks (:3102), and local DSH sessions.
  Injected into the system prompt as `[myco:协作智能体清单]` (30s TTL, top 20 + count).
- **MCP Tools** — three tools the LLM can call:
  - `aop_myco` — wait for collaborator instructions (polling loop)
  - `aop_msg` — cross-task messaging (AI↔AI or AI↔human, with `[from:]` attribution)
  - `aop_open` — reverse-launch/focus the aop workspace (peer-to-peer dual-master)
- **Skills** — slash-command behaviors for connection management:
  - `/aop-connect` — join the collaboration network
  - `/aop-disconnect` — leave
  - `/aop-free` — release the collaboration slot
  - `/aop-park` — temporarily step away

## Architecture

```
┌──────────────────────────────────┐
│  DSH / Claude Code / any harness  │
│                                  │
│  ┌────────────────────────────┐  │
│  │   mcp-server.mjs (this)    │  │
│  │   MCP tools + skills       │  │
│  └──────────┬─────────────────┘  │
│             │ HTTP               │
└─────────────┼────────────────────┘
              ▼
    ┌──────────────────┐
    │   myco (:3102)   │
    │   env core       │
    │   · msg routing  │
    │   · presence     │
    │   · share registry│
    └──────────────────┘
```

## Prerequisites

- **myco.exe running** on the local machine (port `:3102` for cross-device delivery)
- Node.js 18+

## Install

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "aop": {
      "command": "node",
      "args": ["path/to/myco-collab/mcp-server.mjs", "--hub", "http://127.0.0.1:3002"]
    }
  }
}
```

## Message Routing

The plugin supports four addressing formats for `--to`:

| Format | Route |
|---|---|
| `session-xxx` | DSH RPC (local direct delivery) |
| `did:youling:…` | `:3102 /api/msg/route` (contract-based) |
| `sh-xxxx` | Share registry → `/api/msg/route` |
| Free text | Friend nickname → share name → session name (multiple hits = candidate list) |

Anti-hallucination: full DIDs not in the directory are rejected; short DIDs are rejected.

## Design Reference

For the full routing contract (`/api/msg/route`), see
[DESIGN-agent-directory.md](../../docs/DESIGN-agent-directory.md) §5.

## License

Apache 2.0 (same as the main myco project)
