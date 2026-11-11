/**
 * Built-in `myco` skill for the identity plugin.
 *
 * 2026-11-04 起本 skill 同时是**完整操作手册**：原来在用户级
 * `~/.agents/skills/myco/` 的 send.py/dsh_rpc.py/mcp-server.mjs 已随本插件
 * 发布（`tools/` 目录），skill 内容里的路径在模块加载时从
 * `import.meta.url` 动态解析——装在哪台机器都是插件自身路径。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __plugin_dir = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS = join(__plugin_dir, "tools");

/** The skill name exposed to users and the model. */
export const MYCO_SKILL_NAME = "myco";

/** Full skill definition registered through `ctx.skills.register()`. */
export const mycoSkill = Object.freeze({
  name: MYCO_SKILL_NAME,
  description: "myco session identity, agent directory (collaboration targets), DID semantics, and cross-session collaboration rules.",
  whenToUse: "Use when the user mentions myco, did:youling, did:myco, session identity, the [myco:协作智能体清单] agent-directory block, cross-session messaging, sharing a DSH session, or multi-agent collaboration, or when picking a `--to` target (好友昵称 / shareId / session-xxx / 会话标题). 🔴 MUST invoke this skill before calling send.py or any myco tool — the tools path is resolved at plugin load time. When a `--to` target is ambiguous (e.g. the same nickname matches several shares/sessions), ask the user to choose instead of guessing.",
  invocation: Object.freeze({
    modelInvocable: true,
    userInvocable: true,
  }),
  source: "@myco/dsh-plugin",
  content: `# myco — 会话身份与跨会话协作

## 这个插件提供什么

当前会话的自身身份会作为 runtime context 注入，块名是：

\`\`\`text
[myco:session-identity]
\`\`\`

正常登录时包含：
- \`sessionId\`
- 会话 \`title\`（没有标题时整行省略）
- \`youling账号\`：账号名 + \`<did:youling:…>\`
- \`myco设备\`：设备名 + \`<did:myco:…>\`

## 使用规则

1. **这是本会话自己的身份**，不是对话对方或用户的身份。
2. 身份块缺失时，不要猜测；直接按"myco 身份不可用"处理。
3. 只有 \`sessionId\` / \`title\` 而没有 DID 行时，表示 myco 未登录或身份查询失败。
4. 需要精确引用身份时，始终使用完整 DID 字符串，不要截断。
5. 跨会话通信优先使用宿主提供的 myco 工具；没有工具时，先说明缺少通道，不要虚构发送结果。
6. 不要把私钥、凭据或账号秘密写进任何会话、日志或分享内容。

## 协作语义

- \`did:youling\` 表示当前登录的账号身份。
- \`did:myco\` 表示当前设备身份。
- 账号名和设备名是便于人读的附加信息；DID 才是权威标识。
- 在多智能体协作中，先确认"我是谁"，再讨论"发给谁"。

## 协作智能体清单（agent directory）

systemPrompt 里的这个块列出**当前可协作的对象**（与 session identity 同一次注入）：

\`\`\`text
[myco:协作智能体清单]
\`\`\`

三类来源（好友 > 分享任务 > 本机其他会话）：

- **好友**：昵称 + 短 DID + 在线/离线 —— 跨账号 P2P 消息的目标
- **分享任务**：任务名 + shareId + owner（我/他人）+ 绑定会话 —— 协作入口
- **本机其他会话**：标题 + sessionId —— 本机跨会话直投的目标

规则：

1. **发消息不需要用户告知 DID/sessionId**——清单里都有；块缺失时才降级询问。
2. \`--to\` 参数可接受四种目标：**好友昵称**、**shareId**（如 \`sh-abc\`）、
   **sessionId**（\`session-xxx\` 完整形态）、**会话标题**。
3. **目标模糊时必须反问用户**：同一称呼命中多个对象（如"小王"既是好友又有多条
   会话/分享，或多个会话同标题）→ 列出候选让用户选，不要猜。
4. 清单有 **30s 缓存**，可能略滞后于现实；要最新会话列表用
   \`send.py --list\`（\`--grep 关键词\`）现场查。

## 跨会话消息工具（随本插件发布，路径自动适配安装位置）

### 工具位置（本机解析结果）

\`\`\`text
${TOOLS}
\`\`\`

### 列出本机所有会话

\`\`\`powershell
C:\\Python314\\python.exe "${TOOLS}\\\\send.py" --list
# 按名字搜：--list --grep 关键词
\`\`\`

### 发送消息（三种方式）

**方式 1（推荐）：here-string + --stdin**

\`\`\`powershell
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # PS 5.1 必设
$msg = @'
<正文：中文、引号、多行都安全。唯一禁忌：单独一行的 '@ 结束符>
'@
$msg | C:\\Python314\\python.exe "${TOOLS}\\\\send.py" --to "<会话名或sessionId>" --stdin
\`\`\`

**方式 2：从文件读**

\`\`\`powershell
# ⚠️ 必须带 -Encoding UTF8——中文 Windows 的 PS 默认按 GBK 读文件，
# UTF-8 文件不带该参数在内存里就已是乱码（2026-11-04 真案：发给 vnet 全乱码）
Get-Content msg.md -Raw -Encoding UTF8 | C:\\Python314\\python.exe "${TOOLS}\\\\send.py" --to "目标" --stdin
\`\`\`

**方式 3：短句 --text（引号会被拒绝，长文别用）**

\`\`\`powershell
C:\\Python314\\python.exe "${TOOLS}\\\\send.py" --to "目标" --text "短句"
\`\`\`

### 投递模式

- **steer（默认）**= 插队：对方当前步跑完后立即进入上下文，不等整轮结束
- **queue** = 排队：等对方整轮完整结束再处理（显式加 \`--queue\`）
- 对方空闲时两者等价

### 自动署名

send.py 自动加两行头（调用方不用管）：

\`\`\`text
[from: 发送方名字 · 10-19 19:16]
reply-to: session-xxxx-...

正文
\`\`\`

### 收到跨会话消息

以 \`[from: 会话名 · 时间]\` 开头、第二行 \`reply-to: session-<id>\` 的消息 =
另一个 DSH 会话发来的协作消息（**不是用户输入**）。要回应就调本 skill 的
send.py 回给 reply-to 里的 sessionId，不需要问用户"回给谁"。

## DSH RPC 直调（调试/工具面）

\`\`\`powershell
C:\\Python314\\python.exe "${TOOLS}\\\\dsh_rpc.py" 'session/list' '{}'
\`\`\`

## 宿主集成

- 有 MCP 工具时**优先用它**——结构化参数，没有 shell 引号/编码坑。
  本插件提供 \`mcp__myco__send_message / list_sessions / whoami\`（tools/mcp-server.mjs）。
- 没有结构化工具时，用上面 send.py 的路径直接调。
- **编码纪律（三层）**：
  1. 管道端：\`$OutputEncoding = New-Object System.Text.UTF8Encoding($false)\`（PS 5.1 必须）
  2. 读文件端：\`Get-Content -Raw -Encoding UTF8\`（GBK 误读在内存里就坏了，管子端救不回来）
  3. 正文来源：长文/含引号**必须**用 --stdin 或 --file，不用 --text
`,
});
