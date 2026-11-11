# myco 插件设计：协作智能体清单（Agent Directory）

> 版本：draft-v1（2026-11-07）
> 作者：DSH插件会话（session-181a6a6d）
> 状态：设计稿，待用户确认后实施

## 1. 问题

当前 DSH 会话里的 AI 只知道自己是谁（identity.js 注入 sessionId/账号），但**不知道能跟谁协作**：
- 不知道主人有哪些好友（各有昵称/DID）
- 不知道有哪些活跃的分享任务（任务卡名/shareId/绑定的会话）
- 不知道对方设备上有哪些可联系的 DSH 会话
- 因此 AI 无法主动发起跨会话/跨账号沟通——用户必须手动告诉它"发给 xxx"

## 2. 目标

让每个 DSH 会话的 AI **开箱即知协作对象**：
- 启动时自动收到一份**协作智能体清单**（含好友、分享任务、可联系会话）
- 发消息时不需要用户告知 DID/sessionId——清单里有
- 清单随状态变化自动更新（好友上线/新分享/会话关闭）

## 3. 数据模型

### 3.1 协作智能体条目（Agent Entry）

每个可协作的对象是一条 Agent Entry：

```jsonc
{
  "id": "agent-001",                          // 唯一标识（自动生成）
  "kind": "friend" | "share" | "session",     // 三类来源
  "displayName": "小王",                       // 人话名称（优先级见 §3.2）
  "did": "did:youling:z6Mk...",               // 对方 youling 账号 DID
  "deviceDid": "did:myco:z6Mk...",            // 对方设备 DID（可选）
  "online": true,                              // 当前在线状态
  "presence": "active" | "idle" | "offline",   // 在场状态

  // friend 类型专有
  "friendNickname": "小王",

  // share 类型专有
  "shareId": "sh-xxxx",
  "taskTitle": "DSH协议应用开发",
  "boundSessionId": "session-yyy",             // 分享绑定的会话
  "myRole": "owner" | "collaborator",          // 我在这个分享里的角色
  "ownerDid": "did:youling:...",               // 分享者的 DID

  // session 类型专有（本机或对方设备上的 DSH 会话）
  "sessionId": "session-zzz",
  "sessionTitle": "聊天",
  "sessionDevice": "本机" | "小王的笔记本",      // 会话在哪台设备上
}
```

### 3.2 displayName 的优先级

```
分享任务的自定义名（用户改过） > 任务卡原始名 > 好友昵称 > 会话标题 > DID 尾4位
```

示例：用户把一个分享任务改名为"协议对接"，则 displayName = "协议对接"（不是原始的"DSH协议应用开发"）。

### 3.3 清单数据来源

| 来源 | 提供什么 | 从哪拿 |
|---|---|---|
| **myco 好友列表** | 好友昵称、DID、在线状态 | `chat_state` → `friends[]` |
| **myco 分享注册表** | 分享任务名、shareId、owner、绑定会话、我的角色 | `:3102/api/dshShare/list` |
| **本机 DSH 会话列表** | 本机会话（可跨会话发消息） | DSH RPC `session/list` |
| **对方分享的会话** | 对方设备上绑定的会话（可给对方会话发消息） | share 注册表 → `boundSessionId` + owner DID |

## 4. 呈现方式

### 4.1 systemPrompt 注入（AI 读的）

每次 DSH 会话启动时，插件的 identity.js 在注入 session identity 的同时，注入协作智能体清单：

```
[myco:协作智能体清单]
你可以向以下对象发送跨会话/跨账号消息（用 myco skill 的 send 功能）：

好友：
- 小王 (did:youling:z6Mk...sHaW) — 在线
- 李四 (did:youling:z6Mk...f2Bd) — 离线

分享任务：
- "DSH协议应用开发" (shareId=sh-xxx, owner=我, 绑定会话=session-cd8a3c33)
- "协议对接" (shareId=sh-yyy, owner=小王, 他的会话=session-abf0f38c)

本机其他会话：
- "有灵myco" (session-27bcef7c)
- "群体智能" (session-43d66686)

发消息：调 myco skill / send.py --to <名称或ID> --stdin
对方会话的 AI 会立即收到你的消息并处理。
```

**长度控制**：条目多时截断（默认前 20 条 + "…另有 N 个"），避免 prompt 膨胀。

### 4.2 定期刷新

- 插件通过 `ctx.effect` 定期（建议 30s）拉取最新清单
- 有变化时**不重新注入 systemPrompt**（那会导致 context 重建），
  而是更新一个 lightweight context 变量供 AI 查询
- AI 需要最新清单时可调 skill 查询（`myco directory` 命令）

### 4.3 MCP 工具（AI 主动查询的）

```
mcp__myco__list_agents() → Agent Entry[]
mcp__myco__send_message(to: string, body: string, mode?: "steer"|"queue")
```

`to` 参数自动识别：
- `"session-xxx"` → 本机 DSH RPC
- `"did:youling:..."` → 跨账号 P2P
- `"sh-xxxx"` → 按分享路由 → owner 的绑定会话
- `"小王"` → 先查好友昵称匹配 → 再查分享任务名匹配 → 再查会话标题匹配

## 5. 消息路由

### 5.1 路由决策

```
AI 调 send_message(to="小王", body="你好")
  │
  ├─ 匹配好友昵称 → 找到 DID → 跨账号路由
  │   ├─ 对方在线 → myco P2P 直达对方设备
  │   └─ 对方离线 → myco 信箱兜底
  │
  ├─ 匹配分享任务名 → 找到 shareId → 查 share 注册表
  │   ├─ 我是 owner → 给协作者的会话发（协作者 DID → P2P）
  │   └─ 我是协作者 → 给 owner 的绑定会话发（owner DID → P2P）
  │
  ├─ 匹配本机会话标题 → DSH RPC 直投
  │
  └─ 匹配 session-xxx → DSH RPC 直投
```

### 5.2 到达对方后

对方设备上的 myco 收到 P2P 消息：
1. 判断消息类型是"DSH 会话消息"（而非普通聊天）
2. 解析目标 session ID（或按 sender 上下文路由到相关会话）
3. 通过 DSH RPC 投递到目标会话（steer 模式，对方 AI 立即处理）

## 6. 实现分工

| 模块 | 改什么 | 在哪个仓 |
|---|---|---|
| **identity.js** | 注入协作智能体清单到 systemPrompt | `dsh-plugin-identity` |
| **skill.js** | 更新 skill 文档（清单查询命令、send 的 `--to` 语义） | `dsh-plugin-identity` |
| **send.py** | `--to` 支持昵称/DID/shareId 自动识别与路由；`--file` 保留给文件 | `dsh-plugin-identity/lib/` |
| **myco.exe 网关** | `/api/msg/route` 端点：接收路由请求 → P2P 投递 | `myco-thin-node` |
| **myco.exe 接收端** | P2P 消息到达后判断并投递到 DSH 会话 | `myco-thin-node` |
| **MCP server** | `list_agents` + `send_message` 带 DID/shareId 路由 | `dsh-plugin-identity/lib/mcp-server` |

## 7. --file 的新定位

保留 `--file`，但**仅用于发送真正的文件**（图片/视频/文档），不再作为文字消息的推荐通道：

```
# 文字消息（推荐 --stdin）
$msg | python send.py --to "小王" --stdin

# 文件消息（--file 指向实际文件路径，不是临时写的正文文件）
python send.py --to "小王" --file D:\photos\shared\chart.png --kind file
```

skill 文档明确标注：
- `--stdin`：文字消息首选
- `--file`：仅用于发送文件附件（路径指向真实文件，非临时文件）
- `--text`：极短无引号文字的快捷方式

## 8. 安全与权限

- 清单只包含**主人已授权分享的对象**（不会列出陌生人的会话）
- 跨账号发消息需要对方在好友列表或分享协作列表中（防止向任意 DID 发消息）
- 发送前 send.py 校验目标 DID 是否在清单中（防 AI 幻觉 DID）

## 9. 后续演进

- **v2**：清单加入对方的在线会话实时状态（对方 myco 定期推送其活跃会话列表）
- **v3**：AI 可主动发起分享/邀请协作（不仅仅是发消息）
- **v4**：多人任务群（一条消息路由到多个协作者）
