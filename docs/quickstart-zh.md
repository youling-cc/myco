# Myco 快速上手（内部测试版）

> 面向首批测试伙伴。产品迭代快，本文以仓库最新代码为准。
> 反馈：直接在测试群说，或提 [Issues](https://github.com/youling-cc/myco/issues)。

## 一句话

**给设备和你上面的 AI agent 修一条加密直连**：免管理员虚拟网卡 + DID 身份鉴权的 UDP/TCP 互联——你的个人电脑可以当服务器，别人经你授权就能连（分享出去的网页/agent 会话，理论上万人可连）。

## 现在能干什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 设备组网 | ✅ 已验证 | 手机蜂窝网络（4G/5G）↔ 家里 PC 直连，走 IPv6 P2P，无需端口映射/公网 IP；IPv6 不通时自动回落中继 |
| DID 身份 | ✅ 已验证 | 每设备独立身份（Ed25519），不绑手机号邮箱 |
| 任务卡分享 | ✅ 已验证 | 发一张卡给对方，点开即达你机器上的网页/远程桌面（IP:port 经 DID 授权） |
| DSH web 会话分享 | ✅ 已验证 | 把你 PC 上的 DSH / agent 网页会话分享给其他设备或他人——手机上直接操作你电脑里的 agent |
| 远程桌面 | ✅ 已验证（Win）| mac 上推荐 RDP 路线，支持全键盘 |
| 多账号 agent 互聊 | 🧪 已开发未实测 | 多个用户的 AI 会话经 myco 直接互聊——**本轮测试重点**，边用边改 |
| mac 客户端 | 🧪 可编译 | 同源码 `cargo build`，未实机验证，欢迎踩坑 |

## 上手（三步）

```bash
git clone https://github.com/youling-cc/myco.git
cd myco

# ① 跑身份服务（自用可跳过——默认连官方网络）
cd services/identity-svc && npm ci && node identity-server.mjs

# ② 编译 PC 客户端（Windows）
cd ../../apps/home/ui && pnpm install && pnpm build
cd ../src-tauri && cargo tauri build          # 产物在 target/release/

# ③ 手机端
cd ../../phone && npm ci && npm run build     # PWA
# Android APK：见群内下载地址或 www.youling.cc/downloads
```

**macOS**：同 ②，`cargo build --release -p myco-home`；遇到问题直接群里发（我们正缺 mac 实测）。

## 这轮测试想请你们重点试

1. **多账号 agent 互聊**：两个人各自带 AI 会话，经 myco 直接对话（昕杰提的"手动转发卡点"就是解这个的）
2. **mac 路线**：编译、设备关联、RDP 全键盘（润泽/凯峰方向）
3. 日常用着不顺手的任何地方——闪退、连不上、显示怪，都算

## 边界

- 0.3 早期版本，Windows/Android 最稳
- 多账号功能刚具备条件，遇问题直接发截图，别客气
- 代码 Apache 2.0，随便看随便改

## DSH 插件：跨会话消息与协作清单（进阶）

> 代码在 `tools/dsh-plugin/`

**解决什么**：DSH 是单机、单用户的桌面 harness；一旦多人多设备协作，AI 会话之间就既没有身份、也没有地址、更没有授权边界。这个插件把三件事做进 DSH 运行时——**「我是谁」（会话身份 + DID）、「我认识谁」（协作智能体清单）、「我怎么安全地找到并给对方发一句话」（跨会话消息）**。

### 装完每个会话自动获得

- **会话身份**：每步注入 `[myco:session-identity]`（sessionId / 标题 / youling 账号 DID / 设备 DID）——AI 知道自己以谁的身份说话
- **协作智能体清单**：`[myco:协作智能体清单]`——本机其他会话 + myco 好友 + 分享任务（最多 30 条，30s 缓存）

### 跨会话发消息

```bash
python tools/dsh-plugin/tools/send.py --to <目标> --stdin
```

`--to` 四种格式：会话名 / 完整 sessionId / 短 id / 名字模糊匹配。
默认 **steer（插队）**——对方当前步跑完即送达；`--queue` 等对方整轮结束。
跨设备/跨账号自动走 myco（好友 DID 或分享任务），本机则直接走 DSH RPC。

### MCP 工具（可选）

| 工具 | 用法 |
|---|---|
| `mcp__myco__list_agents` | 列出可协作对象（`filter` 过滤 / `full` 不截断） |
| `mcp__myco__send_message` | 发消息（语义同 send.py，`queue` 可选） |

### 安装

```bash
dsh plugin --profile desktop add link:<repo>/tools/dsh-plugin
# 再往 cordis.patch.yml 追加 myco 插件段（片段见 tools/dsh-plugin/README.md）
node tools/dsh-plugin/scripts/build.mjs     # 必须以 "build: OK" 结尾
```

---
*myco = mycelium（菌丝体）：自然界的去中心化网络。🍄*
