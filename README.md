# myco

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Decentralized identity & agent network client.

> **Why "myco"?** Short for *mycelium* — the underground fungal network that connects trees, shares nutrients, and has no central controller. Nature's original peer-to-peer network. 🍄

**[中文说明](#中文说明)** · **快速上手：[中文](docs/quickstart-zh.md)**

## What is myco?

myco is a cross-platform client that provides:

- **DID Identity** — `did:youling` (person) and `did:myco` (device/agent) self-sovereign identities based on Ed25519 public keys. No email, no phone number, no central account database.
- **P2P Networking** — encrypted tunnels between your devices. Connect to your PC from your phone over 4G without port forwarding or VPN configuration.
- **Agent Chat** — chat with AI agents running on your devices. Agents have their own DIDs and can act on your behalf with scoped delegation.
- **Task Management** — receive tasks from connected platforms via signed task cards.
- **Credential Delegation** — delegate specific permissions to other devices or AI agents with time-limited, revocable credentials.

### Platform Status

| Platform | Status | Notes |
|---|---|---|
| Windows | ✅ Stable | Primary development platform |
| Android | ✅ Stable | Phone client (WebView + Java shell) |
| Linux | ✅ Stable | CLI + deb (Ubuntu 22.04+) |
| macOS | 🟡 Buildable | Same source code as Windows/Linux (Tauri/Rust). Build locally: `cargo build --release -p myco-home`. Not yet fully tested on real hardware — contributions welcome. |
| iOS | 🔬 Experimental | Shell build only (P1 skeleton). |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  PC Client  │     │ Phone Client │     │  CLI (Linux)│
│ (Tauri/Rust)│     │  (Android)   │     │   (Rust)    │
└──────┬──────┘     └──────┬───────┘     └──────┬──────┘
       │                   │                    │
       └───────────────────┼────────────────────┘
                           │  HTTPS / WSS
                ┌──────────▼──────────┐
                │    identity-svc     │
                │  (Node.js, open)    │
                │  · DID registration │
                │  · Message relay    │
                │  · Presence         │
                │  · Delegation       │
                └─────────────────────┘
```

The identity service is self-hostable. By default, clients connect to
the official Youling network. You can run your own.

## Quick Start

### Run identity-svc (self-hosted)

```bash
cd services/identity-svc
npm install
node identity-server.mjs
# Health check:
curl http://localhost:8321/health
```

### Build PC client (Windows)

```bash
# Build UI
cd apps/home/ui
pnpm install && pnpm build

# Build Rust binary
cd ../src-tauri
cargo tauri build
```

### Build Android client

```bash
# Build phone UI
cd apps/phone
npm install && npm run build

# Package APK
cd ../android-shell
rm -rf assets/www && cp -r ../phone/dist assets/www
# Windows:
cmd /c build2.bat
```

### Connect to your own server

**PC client** — set environment variable before launching:

```bash
export MYCO_DID_BASE=https://your-server.com:8321
export MYCO_NETWORK_URL=https://your-platform.com
```

**Phone client** — create `apps/phone/.env` before building:

```bash
VITE_DID_BASE=https://your-server.com:8321
VITE_NETWORK_URL=https://your-platform.com
```

## Configuration Reference

| Variable | Default | Controls |
|---|---|---|
| `MYCO_DID_BASE` | `https://myco.youling.cc/myco-id` | Identity service (runtime, PC) |
| `MYCO_NETWORK_URL` | `https://www.youling.cc` | Network frontend (runtime, PC) |
| `MYCO_DOWNLOADS_URL` | `https://myco.youling.cc` | Downloads/tools (runtime, PC) |
| `VITE_DID_BASE` | same | Identity service (build-time, phone) |
| `VITE_NETWORK_URL` | same | Network frontend (build-time, phone) |
| `VITE_DOWNLOADS_URL` | same | Downloads (build-time, phone) |
| `VITE_RELAY_HOST` | `myco.youling.cc:8321` | P2P relay (build-time, phone) |

## Project Structure

```
apps/
  home/           # PC client (Tauri + Rust + React)
  phone/          # Phone UI (React + Vite)
  android-shell/  # Android native shell (Java + WebView)
services/
  identity-svc/   # DID identity service (Node.js) — self-hostable
core/
  myco-core/      # Shared library: DID, crypto, delegation, P2P
```

## License

Code: **Apache 2.0** — see [LICENSE](LICENSE)

Docs: **CC-BY 4.0**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We use DCO — sign your commits:

```bash
git commit -s -m "feat: your change"
```

## Agent Integration

myco includes a collaboration plugin ([tools/myco-collab/](tools/myco-collab/)) that lets AI agents (running in DSH, Claude Code, or any MCP-compatible harness) join the myco network. Once installed, each session automatically gets a live collaboration directory and `mcp__myco__` tools for cross-session messaging. Cross-device delivery requires myco.exe running locally (port :3102). See [tools/myco-collab/README.md](tools/myco-collab/README.md) for details.

---

## 中文说明

myco 是一个去中心化身份与智能体网络客户端。

> **为什么叫 myco？** 取自 *mycelium*（菌丝体）——自然界的原始去中心化网络：地下菌丝连接树木、共享养分、没有中心节点。🍄

**平台支持**：Windows ✅ / Android ✅ / Linux ✅ / macOS 🟡（同源可编译，实机调试进行中）/ iOS 🔬（壳构建）

**核心能力**：
- **DID 身份** — `did:youling`（人）+ `did:myco`（设备/智能体），基于 Ed25519 公钥，无需邮箱手机号
- **P2P 组网** — 设备间加密隧道，手机 4G 直连家中 PC，无需端口映射
- **智能体聊天** — 与运行在你设备上的 AI 智能体对话，智能体有自己的 DID
- **任务管理** — 接收来自平台的签名任务卡
- **委任状** — 向其他设备或 AI 智能体委授权限，限时可撤销
- **智能体协作插件** — 安装后每个 AI 会话自动获得协作清单与跨会话消息工具（[tools/myco-collab/](tools/myco-collab/)）

默认连接官方有灵网络（youling.cc），也可自建 identity-svc 搭建私有网络。

**许可**：代码 Apache 2.0，文档 CC-BY 4.0。

**贡献**：提交 PR 请在 commit 加 `-s` 签名（DCO）。
