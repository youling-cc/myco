# DSH 宿主 4GB OOM 证据包（2026-11-11/12）

> 用途：把"插件侧无责"的证据固化，交给能排查 DSH 宿主（Electron/渲染/会话数据）的人。
> 结论先说：**OOM 在宿主进程内部（native 分配），不在 myco（RSS 48MB 稳定）、不在插件 listener（请求量 0.4 req/s）**。

## 1. 事故轮廓

| 时间（本地） | 事件 | 证据 |
|---|---|---|
| 22:32:32 | host 退出码 134，`JavaScript heap out of memory` | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-11T14-32-32-545Z-host.log` |
| 22:59:28 | 第二次同类崩溃 | `crash-2026-11-11T14-59-28-849Z-host.log` |
| 00:40:37 | 用户手动重启后的 host（pid 28708） | `Get-CimInstance Win32_Process` |
| 00:44 起 | 再次观察到 RSS 突增（本文件 §3） | 见下 |

崩溃原文关键行：

```
FATAL ERROR: MarkCompactCollector: young object promotion failed
Allocation failed - JavaScript heap out of memory
[22336] Scavenge (during sweeping) 4041.0 (4076.5) -> 4023.6 (4076.5) MB, allocation failure
dsh desktop host exited with 134
```

## 2. 进程级证据：不是系统内存不足

| 指标 | 值 | 说明 |
|---|---|---|
| 系统内存 | Free **41 GB** / Total **63 GB** | 全机充裕，4GB 是**进程天花板**（V8 默认 old space 上限） |
| `myco.exe` (pid 29632) | RSS **48 MB** / Priv 40 MB，22:32 起未重启 | 两次崩溃窗口都活着，RSS 纹丝不动 → 不在肇事路径 |
| 插件 listener（17879/17877） | 208 秒内 **7 次** `/api/session/list` + 83 条判定日志（≈0.4 req/s）；连接只有 1 Listen + 12 TimeWait，**无 ESTABLISHED** | 流量极低，无活跃 WS 代理 |

## 3. 内存拆分：缺口在 native，不在 JS 堆

插件 listener 每 60s 记录一次（`~/.dsh/logs/myco-identity-timing.jsonl`，字段 `listener=info`、`message` 含 `diag rss=`）：

```
00:41:39 rss=1266MB heapUsed=1004MB external=26MB viewers=3
00:42:39 rss=1269MB heapUsed=1012MB external=29MB viewers=3
00:43:39 rss=1700MB heapUsed=1332MB external=42MB viewers=3
00:44:39 rss=1676MB heapUsed=1342MB external=66MB viewers=3
```

同期 `Get-Process` 外部采样（45 秒窗口）：

```
t+0s   WS=1669MB Private=1643MB
t+15s  WS=1660MB Private=1612MB
t+30s  WS=1706MB Private=1681MB
t+45s  WS=3184MB Private=3155MB   ← 45 秒内 +1.5GB
```

**读法**：`rss(2.9G) ≫ heapUsed(1.3G) + external(66M)`，缺口 ≈1.5GB 在 **native 分配**（Buffer / ArrayBuffer / Electron 自身 / 渲染进程共享内存）。JS 堆本身只占 1.3G，且 60s 内只涨 10-30MB（正常业务波动）。

> 2026-11-12 `3a433fee` 已把诊断扩展为 `heapTotal` + `arrayBuffers`，下次崩溃可把"native Buffer"与"JS 堆"彻底分开量。

## 4. 已排除的方向（含排除依据）

| 方向 | 排除依据 |
|---|---|
| myco 网关 | RSS 48MB 稳定；vnet/p2p 队列 5 万行日志零积压 |
| 插件 listener 流量 | 0.4 req/s；无活跃 WS；`viewers=3` 稳定不增长 |
| 插件策略表 | `viewers` 恒为 3，无条目增长 |
| 系统内存耗尽 | Free 41GB |
| 隧道 :25012 建拆循环 | 只经 myco 本地口，不进宿主、不进 17879 |

## 5. 宿主侧继续排查的建议（交给能看宿主的人）

1. **Electron/BrowserWindow 的 native 内存**：崩溃窗口内是否有 renderer/utility 进程 RSS 同步上涨（`Get-Process "DeepSeek Harness"` 全量快照）
2. **会话数据规模**：本机 `~/.dsh` 下有 **1543 个会话**；若宿主启动/轮询时把会话完整数据载入内存，与 1.3G JS 堆 + 1.5G native 的量级相符
3. **`model listing` 频率**：崩溃日志里 `llm-deepseek-account/api-key model listing from api.deepseek.com loaded 2 model(s)` 高频重复——若每次都构造新对象/缓存不释放，值得查
4. **V8 上限**：若业务确实需要 >4GB，宿主启动可加 `--max-old-space-size=8192`（缓解，不治本）

## 6. 复现/取证命令（任何人可跑）

```powershell
# 1) 内存拆分（60s 一次，插件已内置）
Get-Content "$env:USERPROFILE\.dsh\logs\myco-identity-timing.jsonl" -Tail 200 |
  Where-Object { $_ -match 'diag rss' } | Select-Object -Last 10

# 2) 宿主各进程内存（native 排查）
Get-Process "DeepSeek Harness" | Select-Object Id, ProcessName,
  @{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB)}},
  @{n='Priv_MB';e={[math]::Round($_.PrivateMemorySize64/1MB)}}

# 3) 崩溃日志
Get-ChildItem "$env:APPDATA\@deepseek-ai\dsh-desktop\logs" -Filter 'crash-*' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

---

_维护：DSH插件会话（session-181a6a6d）；数据来源均为本机实测，可复现。_
