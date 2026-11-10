---
description: 连接 aop 协作网络——后台 aop-collab 代理处理消息，主对话不受影响
---

用户要求连接 aop（协作网络）。立即执行以下步骤：

> **形态前提**：本命令只对**交互式终端会话**（你正在和用户持续对话的 TUI）有意义。
> 如果你当前是被一次性调用（print/headless/脚本模式，答完即退），不要 spawn 后台代理
> ——它随主进程退出即死，接了也活不过本轮。直接告知用户：「共驾需要交互式终端，
> 请在普通 claude 会话里运行 /aop-connect」。

> **登录前提（2026-09-10 实测）**：如果你发现自己未登录（执行任何操作都报
> 「Not logged in」），不要继续——先告知用户：「当前 claude 未登录（未配 API key
> 或未走 aop 的 proxy 路由）。请先 /login 登录，或从 aop 工作区启动任务（自动
> 带 proxy 路由=已登录），再 /aop-connect」。不要试图绕过登录。

## 第一步：确认 MCP 插件与 agent 定义可用

检查项目目录下 `.mcp.json` 含 aop server，且 `.claude/agents/aop-collab.md` 存在。缺任一 → 告诉用户需要先在 aop 工作区将此项目设为任务（注册管线自动装齐三件套），暂无法连接。

## 第二步：向用户报告连接状态

输出以下格式的分界提示：

```
🔗 已连接 aop 协作网络
━━━━━━━━━━━━━━━━━━━━
本会话现在：
• aop 工作区可见并可交互（含远程协作者）
• aop 指令由后台 aop-collab 代理处理（带 [aop] 标记回流）
• 你可以继续跟我正常对话，两边互不影响
• 随时说「断开 aop」即可退出
```

## 第三步：spawn 后台代理

用 Agent tool（后台模式）spawn 自定义 agent **aop-collab**。参数：
- `subagent_type` 或 agent 名 = `aop-collab`
- `prompt` = `"开始你的 aop 协作循环。"`（Agent tool 要求 prompt 必填——aop-collab 的
  system prompt 已含完整循环体，这里只给启动触发语，别写长、别重复循环规则）

spawn 后终端应立即回到输入提示符。

## 第四步：回到正常对话

连接完成。此后：
- aop-collab 的消息以 `[aop]` 前缀回流——用户问起时转述，用户指示时配合
- **不要自己调 aop_myco**——那是后台代理的活，你调了等于抢它的感知面（还可能在
  会话关闭时撞上 MCP 连接竞态）
- **收到 aop-collab 完成通知**（它退出了）→ 询问用户是否重连（回答「重连」就再
  spawn 一次；它可能因网络不可达自行退出，这是护栏不是故障）
- 用户说「断开 aop」→ 执行 /aop-disconnect

