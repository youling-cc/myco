# P/A 终态架构契约（2026-11-10 三方对齐版）

> 参与方：**DSH 插件**（本文维护方）· **DSH协议应用（myco 网关/host）** · **vnet**
> 变更纪律：任一方改动本契约涉及的接口，先在会话里对齐，再改代码，再更新本文件。
> 目的：避免"代码没禁干净 / 两处同名逻辑 / 端口漂移"类干扰（2026-11-10 用户明确要求）。

## 0. 一句话分工

```
myco（含 vnet）：把流量送进来 + 说明"谁在看"      →  插件：按"谁"执行 P/A 与署名
```

| 方 | 职责 | 明确不做 |
|---|---|---|
| **vnet** | 传输（隧道/P2P/VNETP 前导）、链路保活与 ARQ | 不解析 DSH web 协议、不做 P/A 判定、不签名言 |
| **myco** | 路由（24011→13911/15200）、VNETP 身份、DID grant、票据验签、**授权数据源**（grants/devicePolicies/viewerLabel→17877）、**注入连接身份头** | 不解析 web body、不判 RPC、不自己签发言（`MYCO_SIGN_PROMPT` 永久关） |
| **DSH 插件** | DSH 会话凭据铸造（dsh-auth cookie）、P/A 判定执行、可见性过滤、发言署名、DSH 登录态（upstream 跟随/自愈）、连接身份验签 | 不认设备、不验票、不算授权 |

## 1. 数据面链路（2026-11-10 实际形态）

```
remote 浏览器
  ▼
myco 网关 24011 ── vnet 隧道 / VNETP 垫片（本机自拨走 127.0.0.1:15200 + 前导）
  ▼
13911 → proxy_http（myco 侧保活/重连页）
  │  · 注入 x-myco-viewer-did: <浏览者 DID>      ← 连接级身份（关键）
  ▼
DSH 插件 owner 口（状态文件里的 port，当前 17879/17878）
  │  · 验连接身份 → 查策略 → P/A 判定（§5）
  │  · 可见性过滤（session/list）
  │  · 发言署名【label】：正文
  │  · 每请求现铸 dsh-auth cookie
  ▼
DSH web（真上游，随机口）
```

### 1.1 **per-viewer 分口已删除**（2026-11-10 用户决定）

- 旧机制：`openPort:true` → 插件开 17901+ 的独立口
- **新机制：不再有任何 viewer 分口**。理由：端口漂移/抢口/脏状态造成大量 debug 成本
- 兼容行为：控制面收到 `openPort` **接受但忽略**，响应不再返回 `port`
- `closePort:true` 语义 = **撤销该 viewer 的策略条目**（删 entry）；连接级身份查不到 policy 时按无策略处理（owner 口不签名不判定）
- 因此：**179xx 端口不再出现**；`web-listener.json` 只有 owner port + controlPort

## 2. 控制面协议（myco → 插件）

`POST http://127.0.0.1:17877/policy`，HMAC-SHA256（`~/.dsh/web-proxy-control.key`），nonce + ±60s 时间窗。

```jsonc
{
  "viewerDid": "did:myco:...",          // 被授权方（DID grant 受让方）
  "authz": {
    "taskCaps": { "o": [...], "a": [...] },   // 任务声明（原始数据，不推结果表）
    "taskVis":  { "o": [...], "a": [...] },
    "grant":    { "caps": {...}, "visibility": {...}, "admin": false },
    "viewerLabel": "设备·笔记本·6Cqf"          // 署名用标签（myco 算）
  }
}
// 响应: { "ok": true, "viewerDid": "..." }   // 不再有 port
// 撤销: { viewerDid, closePort: true } → 删策略
// 快照: GET /policy → { ok, viewers: [{ viewerDid, kind, label, updatedAt }] }
```

- **插件重启会清空内存策略表** → myco 需检测（状态文件 pid 变化或 `/policy` 为空）后重推（幂等）
- 状态文件 `~/.dsh/web-listener.json` = 插件单写、myco 单读，**只做端口发现**：`{port, pid, since, basePath, upstream, controlPort}`

## 3. 连接级身份（2026-11-10 新增，替代分口）

插件接受两种头，**签名头优先**：

| 头 | 形态 | 信任级别 | 说明 |
|---|---|---|---|
| `x-myco-viewer` | `<did>.<unix-ms>.<base64url HMAC-SHA256(controlKey, did+"\n"+ts)>` | 高（±5min 时间窗防重放） | 未来升级用 |
| `x-myco-viewer-did` | `did:myco:...` | 低（本机回环域内等价可信） | **myco 现网形态，立即可用** |
| 无 | — | — | 口级回退：owner 口 = 不判定、不签名（本机直连行为不变） |

- 有效头 → 按 did 查策略 → 该连接的 P/A 与署名都按**这个人**
- 这解决了"本机浏览器直连也能被签成某 viewer"的归因错误（口级 → 连接级）
- 严格模式：`webListener.requireViewerHeader: true` → 无有效头 403（默认关）

## 4. 判定语义（插件 `judge-engine.js`，Rust 权威对拍）

从 `dsh_share.rs` 1:1 移植，共享向量 `eval/vnet/judge-vectors.json`（15 条/28 用例，Rust 与 JS 逐位一致）：

1. `effective_caps`：owner→全 `*`；grant flags→逐能力（缺项继承、显式空从、四全开带 `model.select`、目录外 id 丢弃）；否则任务声明
2. 方法门控五步：admin → 非 RPC → 读豁免面（commands/llm/settings/permissionPresets）→ 高风险族（按能力 id 认，`*` 不认）→ 声明通配 → `CAPS_DENIED` 31 条兜底 → **名单外放行**
3. 可见性：`merge_vis` 只收紧；`session/list` 按白名单过滤
4. 拒绝信封：HTTP 200 + `{"type":"server-response","result":{"ok":false,"error":{...}}}`；P 面 `不在可见范围`、A 面 `受保护`

## 5. 发言署名

- 格式：`【设备·DESKTOP-DEV·x7oj】：正文` / `【MYCO·昵称·6Cqf】：正文`（中文冒号、同行紧凑）
- label 由 myco 计算（设备名册/账号归属/client assert），随 `authz.viewerLabel` 下发
- 签名点在插件 `forwardBuffered`（prompt 写路径）；`WS` 不参与（0.2.x RPC 走 fetch POST）
- **防叠加**：已带本连接权威头 → 跳过
- **防伪造（剥头）暂不启用**（用户 2026-11-09 决定，代码保留 `STRIP_FORGED=false`，对外分享前再开）
- myco 侧 `sign_prompt_body` 默认关（`MYCO_SIGN_PROMPT=1` 仅回滚用）——**双签已消除**

## 6. 上游解析与自愈（`da12e430`）

顺序：`$DSH_WEB_URL` → `config.dshWebUrl` → `%LOCALAPPDATA%\Youling\dsh-port.txt`（watchdog 每 2min 刷）→ netstat+probe。

- **有界重试**：启动窗口内 2s×15（≈30s），就绪即用；全失败才 `no-upstream`
- **排除 listener 段口**（basePort..+220 与状态文件口）——防 listener→listener 串联
- heartbeat 30s 自愈 + 多 host 接管（接管时整体重写状态文件，含 controlPort）

## 7. 现状 vs 终态（2026-11-10 17:30）

| # | 项 | 状态 |
|---|---|---|
| 1 | 判定引擎迁入插件 + 双端对拍 | ✅ 完成 |
| 2 | 控制面 authz + viewerLabel | ✅ 完成（真推送验证过） |
| 3 | 发言署名（插件盖头） | ✅ 完成（PC/笔记本两身份各验一次） |
| 4 | 连接级身份（签名头 + 纯 DID 头） | ✅ 插件侧完成；myco 现网头即可用 |
| 5 | **per-viewer 分口** | ✅ **代码已删**（2026-11-10） |
| 6 | 上游自愈（重试 + port 文件） | ✅ 完成 |
| 7 | myco 侧撤 `sign_prompt_body` | ✅ 已做（`MYCO_SIGN_PROMPT` 关） |
| 8 | **clean-proxy 物理删除** | ⏳ myco 侧进行中（子 agent） |
| 9 | **真连接级 P/A（accept 侧按 peer DID 判定）** | ⏳ 需 **vnet 提供 inbound 鉴权钩子**（见 §8） |
| 10 | 笔记本"重新连接中" | ⏳ vnet ARQ 12s 静默判死（已定位，vnet 侧修） |

## 8. 对 vnet 的两条需求（2026-11-10）

1. **inbound 鉴权钩子**：accept 时给出 peer DID 并允许 host 决定接受/拒绝（当前 C1–C4 只能在网关层"连上后拒绝"）；`connection::set_local_identity/set_inbound_auth_hook/session_generation` 在 dev 2e876a34 不存在 → myco 侧实现已回滚，等 vnet 提供。
2. **ARQ 静默判死**：控制帧丢失 → 12s 无数据判死 → 整条传输 reset（笔记本侧 0/25 命中"插件"假设，证据在 vnet 日志）。期望：控制帧重传或更长心跳窗，避免误杀。

## 9. 测试基线（插件侧，改动必跑）

```
node scripts/build.mjs            # 必须以 build: OK 结尾（缺一行说明构建被截断，禁止部署）
node test/judge-vectors.test.js   # 1  双端向量
node test/judge-engine.test.js    # 15 判定引擎
node test/policy-proxy.test.js    # 10 控制面/策略
node test/web-listener.test.js    # 18 监听/代理/连接身份/自愈
node test/signature.test.js       # 9  署名
node test/directory.test.js       # 21 目录/身份
```

## 10. 变更记录

- 2026-11-09：判定引擎迁入 + 控制面 authz + 署名（只盖头）
- 2026-11-10：**删除 per-viewer 分口**；owner 口认连接身份（签名头 + 纯 DID 头）；上游解析有界重试 + dsh-port.txt 兜底；职责三方契约（本文）
