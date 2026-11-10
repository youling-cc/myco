/**
 * transport.ts — 手机↔PC 数据面抽象。
 *
 * 四种实现，同一接口（换 transport 只动这里 + Pairing）：
 *   - DirectHttpTransport：IPv6 直连（主路径，PC HTTP 端口，无 NAT/无中转）。projection RPC over HTTP。
 *   - WebRtcTransport：WebRTC 直连（回退路径，服务器中介 SDP/ICE 信令）。
 *   - HttpTransport：直连 terminal-agent HTTP（dev /ta 代理）。
 *   - MockTransport：样例数据，无后端跑通 UI。
 *
 * 协议键：投影协议按 taskId 找会话；terminal-agent HTTP 按 sessionId。
 * 所以 snap/input 收整个 SessionInfo，各实现取自己要的 id。
 */

import { signAuthHeader, signAuthHeaderAsRoot, hasRootSigningIdentity, signRootAuth, currentIdentity } from './identity'
import { accountDidEq } from './didUtil'

export interface SessionInfo {
  sessionId: string
  taskId: string
  status: string
  command?: string
  title?: string
  startedAt?: string
  /** collab 会话（插件化 harness）的项目目录——消息轮询/指令投递的队列键源。 */
  cwd?: string
}

export interface ProjectInfo {
  id: string
  path: string
  name: string
  pinned?: boolean
}

/** 任务卡片（WorkTask）：把若干项目归组为一个工作单元。projectIds 外的项目=未分组。 */
export interface TaskInfo {
  id: string
  title: string
  projectIds: string[]
  updatedAt?: number | null
}

export interface Snapshot {
  cols?: number
  rows?: number
  lines: string[]
  cursorX?: number
  cursorY?: number
}

/** 控制台彩色单元格（CharInfoLite）。raw 终端模式用。 */
export interface CharInfo {
  ch: string
  fg: number   // 0-15 前景色索引
  bg: number   // 0-15 背景色索引
  inverse: boolean
  underline?: boolean
  /** truecolor 前景 [r,g,b]（仅 model 模式 24bit 色；无则退回 fg 索引查调色板）。 */
  fgRgb?: [number, number, number]
  /** truecolor 背景 [r,g,b]（语义同 fgRgb）。 */
  bgRgb?: [number, number, number]
}

/** ta 当前可见屏（P 层观察）：文本行 + 彩色单元格（cells?cells=1 才带）+ 光标。 */
export interface ScreenContent {
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  lines: string[]
  cells?: CharInfo[][]
}

/** console buffer 的任意区段（含 scrollback）——terminal 模式滚屏看历史用。
 *  直接按 offset 读 buffer，不动窗口（claude 重绘会把窗口 snap 回光标，移动窗口无效）。 */
export interface BufferRegion {
  cols: number
  rows: number
  lines: string[]
  cells?: CharInfo[][]
  cursorX: number
  cursorY: number
  regionTop: number      // 本区段在 buffer 里的起始行
  bufferSize: number     // buffer 总行数
  window: { top: number; bottom: number }  // 当前"实时"窗口位置（live）
  /** 数据来源：model=终端模型（带 wrapped/truecolor）；screen=抓屏（16 色，无 wrap 标记）。 */
  source?: 'model' | 'screen'
  /** 仅 model 模式：wrapped[i]=true 表示行 i 自动换行进行 i+1（同一逻辑行）——reflow 依据。 */
  wrapped?: boolean[]
}

/** 一条对话消息（claude jsonl 解析）。assistant 的 text 是 markdown（含代码块）。 */
export interface ChatMessage {
  role: 'user' | 'assistant' | string
  text: string
  timestamp?: string
  /** jsonl 权威消息的唯一 id（去重/稳定 key 用；echo 本地消息无）。 */
  uuid?: string
  /** 本条消息由哪个模型产出（多模型切换时历史可见归属；ta 按 LlmProxy 时间线回填）。 */
  model?: string
  /** assistant 的工具调用（可折叠展示）。 */
  toolUse?: ToolCall[]
  /** assistant 的思维链（默认折叠）。 */
  thinking?: string
  /** 富媒体附件（图片等，web 内嵌渲染）。 */
  attachments?: Attachment[]
  /** 本地即时回显（optimistic echo）标记：发送后立即显示，jsonl flush 后被真实消息替换。 */
  echo?: boolean
  /** 来源标注：echo（即时回显）/ jsonl（落盘权威）。ta belief 消息带。 */
  origin?: string
  /** 本条消息由哪个 harness 产出（多 harness 切换时历史可见归属；如 'claude-code'/'kimi-code'/'codex'）。 */
  harness?: string
  /** user 消息作者显示名（哪个 账号的人发的；无=本机直接输入，显示端兜底自己名）。 */
  author?: string
}

/** 一次工具调用。 */
export interface ToolCall {
  name: string
  summary?: string
  /** 完整参数（点击展开看全部；代码/命令用代码块版式）。 */
  input?: string
  /** 结构化参数 JSON(Edit={file_path,old_string,new_string};Task/Agent={subagentType,description})。 */
  params?: string
  /** 工具调用原生 id（call_xxx）——Task/Agent 生命周期配对键。 */
  id?: string
  /** 运行态（仅 Task/Agent）：running | completed。 */
  status?: string
  /** 后台 agent 报告（完成时回填，服务端截 8k）。 */
  result?: string
}

/** 后台 agent 运行态（Task/Agent spawn 的 subagent，agents 事件载荷）。 */
export interface AgentLive {
  id: string
  subagentType?: string
  description?: string
  sinceMs?: number
}

/** 富媒体附件。 */
export interface Attachment {
  kind: string  // image | video | audio | file
  mime: string
  ref: string   // 落盘绝对路径 / dataURL
  name?: string
  /** 本地即时回显用的 dataURL（echo 时图片还没经服务端，直接用本地 dataURL 显示）。 */
  previewDataUrl?: string
}

/** 历史拉取结果（lazy 分页：from=最近往前的偏移，count=本次条数，total=总数）。 */
export interface HistoryPage {
  lines: string[]
  messages: ChatMessage[]
  total: number
  from: number
  count: number
}

export interface Transport {
  readonly kind: string
  list(): Promise<SessionInfo[]>
  snap(session: SessionInfo): Promise<Snapshot>
  /** 拉当前可见屏的彩色单元格（raw 终端模式 P 层）。无实现的 transport（如 WebRTC）
   *  可不提供——TerminalView 退回 snap 的纯文本行。 */
  screen?(session: SessionInfo): Promise<ScreenContent>
  /** 读 console buffer 任意区段（含 scrollback）——terminal 模式滚屏看历史。
   *  from=起始 buffer 行，count=行数。返回的 window.top 即"实时"位置。 */
  buffer?(session: SessionInfo, from: number, count: number): Promise<BufferRegion>
  /** 注入文本。author=多人房间署名(本机 账号名;跨项目转发=「X 的 AI」;缺省=接入层兜底)。
   *  attachments=随行附件(多图发送:回显带图,ref 用 dataURL 直渲)。 */
  input(session: SessionInfo, text: string, author?: string, attachments?: Attachment[]): Promise<boolean>
  /** 注入特殊键（up/down/left/right/tab/enter/esc/ctrl+c …，透传 terminal-agent）。 */
  key(session: SessionInfo, keyName: string): Promise<boolean>
  /** 上传图片（data:image/...;base64,xxx 或裸 base64）→ PC 落盘 → 注入 @path。 */
  image(session: SessionInfo, base64: string): Promise<boolean>
  /** 取已落盘的图片附件（文件名）→ 可直接放进 <img src> 的 dataURL/URL。
   *  WebRTC 走 rpc 拉 dataURL；canvas/Http 直连 ta HTTP 返回 URL。 */
  fetchAsset(name: string): Promise<string>
  /** 拉历史对话（claude jsonl，结构化 messages）。lazy：from=从最新往前的偏移（0=最近 count 条），
   *  不传 from 取最近一批。远端不囤全部——滚动到顶时按需拉更早（from 增大）。 */
  history(session: SessionInfo, from?: number, count?: number): Promise<HistoryPage>
  /** 订阅推送（事件机制）：PC 主动推 OutputDelta JSON 行（50ms 检测、变化才推、没变化不同步）。
   * 返回取消函数。webrtc events channel 推送；http 暂 noop。 */
  subscribe(session: SessionInfo, onDelta: (deltaJson: string) => void): () => void
  /** 列出 myco 项目（未开终端的也能远程开）。webrtc/http 投影支持。 */
  projects(): Promise<ProjectInfo[]>
  /** 列出任务卡片（WorkTask：项目的归组——任务页一级列表）。 */
  tasks(): Promise<TaskInfo[]>
  /** 可选：任务看板（env /api/tasks_board 聚合：项目→任务行+目标灯；2026-09-04
   *  home/手机同脸呈现的数据源；直连 ta 的 http 模式到不了 env，返回 null 优雅降级）。 */
  tasksBoard?(): Promise<TasksBoard | null>
  /** 给一个项目开 claude 终端，返回新会话。webrtc/http 投影支持。 */
  open(projectId: string): Promise<SessionInfo>
  /** 会话细态(fineState/appType/approval 摘要;手机审批收件箱轮询)。
   *  走 projection `status <taskId>`——direct/webrtc/http 三实现共享同一协议面。 */
  status?(session: SessionInfo): Promise<{ fineState?: string | null; appType?: string | null; approval?: string | null }>
  /** 可选：连接路径信息（直连/中转/连接中）。WebRTC 实现用 getStats；其他 transport 可不实现。 */
  connInfo?(): Promise<'direct' | 'relay' | 'connecting'>
  /** 可选：断开并释放连接（WebRTC 关 peer/停信令轮询；HTTP 类无状态可不实现）。 */
  close?(): void
  /** 可选：@补全的模型清单（provider 配置：id/显示名/模型名/配色）。 */
  models?(): Promise<ModelOption[]>
  /** 可选：当前聊天的观看者 账号名列表（@补全用，已排除自己）。 */
  watchers?(session: SessionInfo): Promise<string[]>
  /** 可选：自己在对方 PC 上的授权信息（限时授权显示剩余；无记录/无限期→相应字段为空）。 */
  authInfo?(): Promise<AuthInfo | null>
  /** 可选：PM 今日待办（只读;纲领六 phone 卡数据源）。 */
  todos?(): Promise<PmTodo[]>
  /** 可选：HTTP 透传（WebRTC 隧道到 PC env :3002 / ta :8100——p 带 "ta:" 前缀选 ta）。
   *  手机远程的重开任务/collab 消息轮询/指令投递都走它；非隧道 transport 不实现。 */
  http?(method: string, path: string, body?: string): Promise<{ s: number; b: string }>
}

/** PM 待办项（只读镜像;写操作只在 canvas dock）。 */
export interface PmTodo {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'done'
  projectName?: string | null
  source?: string
  priority?: number
  rLink?: { skill?: string; resultText?: string; rScore?: number | null; rThreshold?: string | null } | null
}

/** 任务看板（env 聚合；2026-09-04 home/手机同脸：项目→任务行+目标灯）。 */
export interface BoardGoal {
  key: string
  layer?: string | null
  type: string
  period: string
  target: number
  cur: number | null
  ratioPct: number
  light: string
}
export interface BoardTask {
  taskKey: string
  title: string
  closed: boolean
  live: boolean
  /** 任务模式（task-meta 透传）："collab"=插件化管道（spawn 重开）；空/缺失=ta 会话
   *  （project_task_open resume 重开）。手机任务行点击分派用（2026-09-10）。 */
  mode?: string
  /** collab harness 名（spawn 参数；PC aop 的 SPAWN_HARNESS 同源语义）。 */
  harness?: string
  goal?: BoardGoal | null
}
export interface BoardProject {
  id: string
  name: string
  path: string
  light: string
  lightNote: string
  done: number
  total: number
  taskCount: number
  tasks: BoardTask[]
}
export interface TasksBoard {
  weekTotal: number
  projects: BoardProject[]
}

/** 自己在对方 PC 上的授权记录（projection authinfo）。 */
export interface AuthInfo {
  authState: 'pending' | 'allowed' | 'denied'
  /** 限时授权到期时刻 ms（null/undefined=不限期）。 */
  authExpiresAt?: number | null
  name?: string
}

/** @补全的模型项（provider 配置一条）。 */
export interface ModelOption {
  id: string
  name: string
  model?: string
  color?: string
}

/** terminal-agent 响应统一 {success,data,error}；抽出 data，失败抛错。 */
async function unwrap<T>(res: Response): Promise<T> {
  const json = (await res.json()) as { success?: boolean; data?: T; error?: string | null }
  if (!json.success) throw new Error(json.error || `主机处理失败了（${res.status}）——稍后再试，或检查 PC 端状态`)
  return json.data as T
}

/** HttpTransport。base 空=dev（走 vite /ta 代理）；填 PC 地址直连（需 CORS）。 */
export class HttpTransport implements Transport {
  readonly kind = 'http'
  private prefix: string
  constructor(base = '') {
    this.prefix = base ? base.replace(/\/$/, '') : '/ta'
  }
  async list(): Promise<SessionInfo[]> {
    return unwrap<SessionInfo[]>(await fetch(`${this.prefix}/api/session/list`))
  }
  async snap(s: SessionInfo): Promise<Snapshot> {
    const d = await unwrap<Snapshot>(await fetch(`${this.prefix}/api/session/${s.sessionId}/content?cells=true`))
    return { lines: d.lines ?? [], cols: d.cols, rows: d.rows }
  }
  async screen(s: SessionInfo): Promise<ScreenContent> {
    const d = await unwrap<ScreenContent>(await fetch(`${this.prefix}/api/session/${s.sessionId}/content?cells=true`))
    return {
      cols: d.cols ?? 80, rows: d.rows ?? 24,
      cursorX: d.cursorX ?? 0, cursorY: d.cursorY ?? 0,
      lines: d.lines ?? [], cells: d.cells,
    }
  }
  async buffer(s: SessionInfo, from: number, count: number): Promise<BufferRegion> {
    return unwrap<BufferRegion>(await fetch(`${this.prefix}/api/session/${s.sessionId}/buffer?from=${from}&count=${count}&cells=true`))
  }
  async input(s: SessionInfo, text: string, author?: string): Promise<boolean> {
    await unwrap<unknown>(await fetch(`${this.prefix}/api/session/${s.sessionId}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author: author || null }),
    }))
    return true
  }
  async key(s: SessionInfo, keyName: string): Promise<boolean> {
    await unwrap<unknown>(await fetch(`${this.prefix}/api/session/${s.sessionId}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyName }),
    }))
    return true
  }
  async image(): Promise<boolean> { throw new Error('http 模式暂不支持图片上传（用 webrtc 模式）') }
  async fetchAsset(name: string): Promise<string> { return `${this.prefix}/api/assets/${encodeURIComponent(name)}` }
  async imageStage(s: SessionInfo, base64: string): Promise<string | null> {
    try {
      const r = await fetch(`${this.prefix}/api/session/${s.sessionId}/image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, stage: true }),
      })
      const j = await r.json() as { success?: boolean; data?: { path?: string } }
      return j?.success ? (j.data?.path ?? null) : null
    } catch { return null }
  }
  async history(s: SessionInfo, from?: number, count?: number): Promise<HistoryPage> {
    const qs = new URLSearchParams()
    if (from != null) qs.set('from', String(from))
    if (count != null) qs.set('count', String(count))
    const q = qs.toString()
    const d = await unwrap<{ lines: string[]; messages?: ChatMessage[]; totalLines?: number; from?: number; count?: number }>(await fetch(`${this.prefix}/api/session/${s.sessionId}/history${q ? '?' + q : ''}`))
    return { lines: d.lines ?? [], messages: d.messages ?? [], total: d.totalLines ?? 0, from: d.from ?? 0, count: d.count ?? 0 }
  }
  subscribe(): () => void { return () => {} } // http 模式暂不支持推送（用 webrtc）
  async projects(): Promise<ProjectInfo[]> { return [] } // terminal-agent 没有项目概念，http 模式暂不支持
  async tasks(): Promise<TaskInfo[]> { return [] }
  async open(): Promise<SessionInfo> { throw new Error('打开项目需用 webrtc 模式（跨网 P2P）') }
}

export class MockTransport implements Transport {
  readonly kind = 'mock'
  private tick = 0
  async list(): Promise<SessionInfo[]> {
    return [
      { sessionId: 'mock-1', taskId: 'proj-mock-aaa', status: 'running', command: 'claude', title: 'myco · canvas', startedAt: '2026-07-24T00:00:00Z' },
      { sessionId: 'mock-ap', taskId: 'proj-mock-aaa', status: 'running', command: 'claude', title: 'AR · 审批演示', startedAt: '2026-08-25T00:00:00Z' },
      { sessionId: 'mock-2', taskId: 'proj-mock-bbb', status: 'running', command: 'claude', title: 'mushroom · viewer', startedAt: '2026-07-24T01:00:00Z' },
    ]
  }
  async status(s: SessionInfo): Promise<{ fineState?: string | null; appType?: string | null; approval?: string | null }> {
    if (s.sessionId === 'mock-ap') return { fineState: 'waiting_approval', appType: 'claude_code', approval: 'Bash: rm -rf /tmp/fixture (演示审批)' }
    return { fineState: 'generating', appType: 'claude_code', approval: null }
  }
  async snap(): Promise<Snapshot> {
    this.tick += 1
    return {
      cols: 80, rows: 8,
      lines: [
        '$ claude',
        '> 帮我把 README 补一节连通层说明',
        '⏺ 我来读取当前 README 和设计文档…',
        `⏺ 已写入 design/07-connectivity/PHONE-CLIENT.md (tick ${this.tick})`,
        '',
        '  ⎿  等待你的下一条指令',
      ],
    }
  }
  async input(): Promise<boolean> { return true }
  async key(): Promise<boolean> { return true }
  async image(): Promise<boolean> { return true }
  async fetchAsset(): Promise<string> { return '' }
  async history(): Promise<HistoryPage> { return { lines: [], messages: [], total: 0, from: 0, count: 0 } }
  subscribe(): () => void { return () => {} }
  async projects(): Promise<ProjectInfo[]> {
    return [
      { id: 'mock-aaa', path: 'D:/proj/aop', name: 'aop-task-designer', pinned: true },
      { id: 'mock-bbb', path: 'D:/proj/mushroom', name: 'mushroom' },
    ]
  }
  async tasks(): Promise<TaskInfo[]> {
    return [
      { id: 'wt-mock-1', title: 'myco 身份系统', projectIds: ['mock-aaa'] },
    ]
  }
  async open(projectId: string): Promise<SessionInfo> {
    return { sessionId: `mock-${projectId}`, taskId: `proj-${projectId}`, status: 'running', command: 'claude', title: '新工作区' }
  }
}

// ══ DirectHttpTransport：IPv6 直连（主路径）══
// 手机直连 PC 的 [IPv6]:PORT，经 POST /rpc 发 projection 文本协议。
// 每请求带 X-Myco-Auth（DID 签名，PC 验签）。无 NAT / 无中转 / 无 WebRTC。

/** PC 返回"设备未授权"（403 notAuthorized）——DID 没被 PC 添加，提示去让 PC 添加。 */
export class NotAuthorizedError extends Error {
  did: string
  constructor(did: string) {
    super('device not authorized')
    this.name = 'NotAuthorizedError'
    this.did = did
  }
}

/** 生成认证头：有 attestation（根账号）→ 根认证（X-Myco-Auth + X-Myco-Attest）；否则设备 DID 认证。 */
function authHeaders(rawBody: string): Record<string, string> {
  const root = signRootAuth(rawBody)
  if (root) return { 'X-Myco-Auth': root.auth, 'X-Myco-Attest': root.attest }
  return { 'X-Myco-Auth': signAuthHeader(rawBody) }
}

export class DirectHttpTransport implements Transport {
  readonly kind = 'direct'
  private base: string
  private sseCtrl: AbortController | null = null

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '')
  }

  private async rpc(line: string): Promise<any> {
    const raw = JSON.stringify({ line })
    // 有灵账号模型:双证出示——委任状(若有且未过期)随请求头;无则走旧单证路径
    let dlgHeader: Record<string, string> = {}
    try {
      const dl = await import('./delegation')
      const dlg = dl.loadDelegation()
      if (dlg && dlg.exp > Date.now()) dlgHeader = { 'X-Myco-Delegation': dl.present(dlg) }
    } catch { /* 静默 */ }
    const r = await fetch(`${this.base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(raw), ...dlgHeader },
      body: raw,
    })
    if (r.status === 403) {
      const body = await r.json().catch(() => null)
      if (body?.notAuthorized) throw new NotAuthorizedError(body.did ?? '')
      // 2026-09-10 用户体验：技术黑话翻译成用户能懂+能行动的话
      throw new Error(`主机拒绝了请求（${body?.error ?? '权限不足'}）——检查 PC 端是否在线、本机是否已授权`)
    }
    if (!r.ok) throw new Error(`连不上主机（HTTP ${r.status}）——检查 PC 端 myco 是否在运行、网络是否正常`)
    return r.json()
  }

  async list(): Promise<SessionInfo[]> { const d = await this.rpc('list'); return d?.data ?? [] }
  async status(s: SessionInfo): Promise<{ fineState?: string | null; appType?: string | null; approval?: string | null }> {
    const d = await this.rpc(`status ${s.taskId}`)
    return d?.data ?? {}
  }
  async snap(s: SessionInfo): Promise<Snapshot> {
    const d = await this.rpc(`snap ${s.taskId}`); const data = d?.data ?? {}
    return { lines: data.lines ?? [], cols: data.cols, rows: data.rows }
  }
  async screen(s: SessionInfo): Promise<ScreenContent> {
    const d = await this.rpc(`snap ${s.taskId}`); const data = d?.data ?? {}
    return { cols: data.cols ?? 80, rows: data.rows ?? 24, cursorX: data.cursorX ?? 0, cursorY: data.cursorY ?? 0, lines: data.lines ?? [], cells: data.cells }
  }
  async buffer(s: SessionInfo, _from: number, _count: number): Promise<BufferRegion> {
    // projection 暂无 buffer 命令——退回 snap（terminal 滚历史在直连模式暂只看 live）
    const d = await this.rpc(`snap ${s.taskId}`); const data = d?.data ?? {}
    return { cols: data.cols ?? 80, rows: data.rows ?? 24, cursorX: data.cursorX ?? 0, cursorY: data.cursorY ?? 0, lines: data.lines ?? [], regionTop: 0, bufferSize: data.rows ?? 24, window: { top: 0, bottom: (data.rows ?? 24) - 1 } }
  }
  async input(s: SessionInfo, text: string): Promise<boolean> {
    const d = await this.rpc(`input ${s.taskId} ${text}`); return d?.ok === true || d?.success === true
  }
  async key(s: SessionInfo, keyName: string): Promise<boolean> {
    const d = await this.rpc(`key ${s.taskId} ${keyName}`); return d?.ok === true || d?.success === true
  }
  async image(s: SessionInfo, b64: string): Promise<boolean> {
    const d = await this.rpc(`image ${s.taskId} ${b64}`); return d?.ok === true || d?.success === true
  }
  async fetchAsset(name: string): Promise<string> {
    const r = await fetch(`${this.base}/asset/${encodeURIComponent(name)}`, { headers: authHeaders('') })
    const d = await r.json(); return d?.dataUrl ?? ''
  }
  async history(s: SessionInfo, from?: number, count?: number): Promise<HistoryPage> {
    const parts = [`history ${s.taskId}`]
    if (from != null) parts.push(String(from)); else if (count != null) parts.push('0')
    if (count != null) parts.push(String(count))
    const d = await this.rpc(parts.join(' ')); const data = d?.data ?? {}
    return { lines: data.lines ?? [], messages: data.messages ?? [], total: data.totalLines ?? 0, from: data.from ?? 0, count: data.count ?? 0 }
  }
  subscribe(s: SessionInfo, onDelta: (deltaJson: string) => void): () => void {
    this.sseCtrl = new AbortController()
    fetch(`${this.base}/events/${s.taskId}`, {
      headers: authHeaders(''),
      signal: this.sseCtrl.signal,
    }).then(async (resp) => {
      const reader = resp.body?.getReader()
      if (!reader) return
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) onDelta(line.slice(6))
          }
        }
      }
    }).catch(() => { /* abort 或断线 */ })
    return () => this.sseCtrl?.abort()
  }
  async projects(): Promise<ProjectInfo[]> { const d = await this.rpc('projects'); return d?.data ?? [] }
  async tasks(): Promise<TaskInfo[]> { const d = await this.rpc('worktasks'); return d?.data ?? [] }
  async open(projectId: string): Promise<SessionInfo> { const d = await this.rpc(`open ${projectId}`); return d?.data }
  /** @补全：可选模型（projection models → provider 配置）。 */
  async models(): Promise<ModelOption[]> { const d = await this.rpc('models'); return d?.data ?? [] }
  /** @补全：当前聊天观看者（projection watchers <taskId>，已按自己 did 排除）。 */
  async watchers(s: SessionInfo): Promise<string[]> {
    const d = await this.rpc(`watchers ${s.taskId}`)
    return (d?.data ?? []).map((w: { name: string }) => w.name)
  }
  /** 自己在对方 PC 上的授权信息（限时剩余可见；projection authinfo，只回自己那条）。 */
  async authInfo(): Promise<AuthInfo | null> {
    const d = await this.rpc('authinfo')
    return (d?.data ?? null) as AuthInfo | null
  }
  async todos(): Promise<PmTodo[]> {
    const d = await this.rpc('todos')
    return (d?.data ?? []) as PmTodo[]
  }
  async connInfo(): Promise<'direct'> { return 'direct' }
}

// ═══════════════════════════════════════════════════════════════════════════
// WebRTCTransport — WebRTC 直连（IPv6 host 候选打洞；信令走 identity-svc /signal/*）。
//
// 为什么需要它：phone 是浏览器（web），浏览器做不了裸 UDP；IPv6 直连 HTTP（DirectHttpTransport）
// 要求 PC 入站开放，光猫/ISP 拦入站就不通。要打洞穿防火墙，浏览器里只有 WebRTC（ICE+DataChannel）。
// IPv6 让 host 候选直接是公网地址（跳过 STUN 地址发现）；TURN 只在蜂窝对称过滤时兜底。
//
// 信令（identity-svc /signal/*，服务器只转 SDP/ICE 元数据，不传业务）：
//   offer:  phone POST /signal/offer {to:pcDid, sdp}；PC 轮询 /signal/poll 收到后回 /signal/answer。
//   ice:    双方 POST /signal/ice {to, candidate} 互换候选。
//   poll:   GET /signal/poll（SSE，X-Myco-Auth）拉自己信箱。
// 数据面：DataChannel 'rpc' 传 projection 文本行（同 DirectHttpTransport 的 /rpc），'events' 推 delta。
// ═══════════════════════════════════════════════════════════════════════════

// typeof 守卫:Node(vitest/ReplayTransport 导入)无 location,浏览器行为不变
// 2026-09-28 第90轮:信令基址随 identity.ts DID_BASE 换固定域名(同 /signal/* 反代)。
// 旧 PWA 形态兼容:托管在 myco.youling.cc 本机时同源 '';myco.youling.cc 与其余环境走
// 绝对 https://myco.youling.cc/myco-id(nginx 443 反代 identity-svc:8321)。
const SIG_BASE = (import.meta.env?.VITE_DID_BASE as string | undefined)
  || (typeof location !== 'undefined' && location.hostname === 'myco.youling.cc'
    ? ''
    : 'https://myco.youling.cc/myco-id')

/** 诊断日志回传服务器 /tlog（journalctl 可查）——WebRTC 建联/死亡的现场取证。 */
function tlog(line: string): void {
  fetch(`${SIG_BASE}/tlog`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: line.slice(0, 280) }),
  }).catch(() => {})
}

/** 信令签名身份（2026-09-10 账户级任务授权）：'device'=设备钥（默认）；
 *  'root'=有灵账户钥——设备未授权但 PC 给账户开了任务权限时 connectWebRtc
 *  自动 fallback 切换，offer/poll/ice 全链同一身份（信箱按 did 路由）。 */
let sigAs: 'device' | 'root' = 'device'
const sigAuth = (raw: string): string => (sigAs === 'root' ? signAuthHeaderAsRoot(raw) : signAuthHeader(raw))

/** 投一条信令到 /signal/{offer|answer|ice}。payload 含 to + (sdp|candidate)。 */
async function sigDeposit(kind: 'offer' | 'answer' | 'ice', payload: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(payload)
  const r = await fetch(`${SIG_BASE}/signal/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Myco-Auth': sigAuth(raw) },
    body: raw,
  })
  if (!r.ok) throw new Error(`signal ${kind} ${r.status}`)
}

/** 拉自己信令信箱（SSE）。每条 data: 解析成 msg 回调；30s 超时/断线自动重连（信箱 5min 保留）。返回取消函数。 */
function sigPoll(onMsg: (msg: any) => void): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    while (!ctrl.signal.aborted) {
      try {
        const resp = await fetch(`${SIG_BASE}/signal/poll`, { headers: { 'X-Myco-Auth': sigAuth('') }, signal: ctrl.signal })
        const reader = resp.body?.getReader()
        if (!reader) return
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break // 服务端 30s 超时 → 出内层，外层重连
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try { onMsg(JSON.parse(line.slice(6))) } catch { /* 忽略坏行 */ }
            }
          }
        }
      } catch { /* 断线/abort */ }
      if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 300)) // 重连
    }
  })()
  return () => ctrl.abort()
}

interface RtcMsg { id: number; line?: string; data?: unknown; err?: string }

/** PC 应答了 denied（本机 did 未在该 PC 放行）——快速回退走 IPv6 直连配对/中转，不空等打洞超时。 */
export class WebRtcDeniedError extends Error {
  constructor() { super('对方未放行此设备（WebRTC denied）'); this.name = 'WebRtcDeniedError' }
}

export class WebRtcTransport implements Transport {
  readonly kind = 'webrtc'
  private pc: RTCPeerConnection | null = null
  private rpcCh: RTCDataChannel | null = null
  private evCh: RTCDataChannel | null = null
  private inputCh: RTCDataChannel | null = null
  private stopPoll: (() => void) | null = null
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private seq = 0
  private readyPromise: Promise<void> | null = null
  private pcDid: string
  /** 连接已死（网络切换/对方重启/通道关闭）——rpc 快速失败，不再傻等 10s 超时。 */
  private dead = false
  /** close() 后不再自愈(transport 生命周期结束)。 */
  private closed = false
  /** 断线自愈(2026-08-28):网络切换(WiFi↔蜂窝)/对端重启后自动重建隧道——退避重试。 */
  private reviveTry = 0
  private reviveTimer: ReturnType<typeof setTimeout> | null = null
  private _onOnline: (() => void) | null = null
  /** ICE 采集统计（诊断用：host/srflx/relay 各多少——受限 webview 无 host 候选即"只能中转"）。 */
  private iceGather = { host: 0, srflx: 0, relay: 0, prflx: 0 }
  /** 远程桌面 video 流（canvas 抓 PC 屏幕推来的）——ontrack 收到后存,DesktopView 挂 <video>。 */
  desktopStream: MediaStream | null = null
  /** PC 真实光标位置(RDP 式指针通道 30Hz 下行;DesktopView 指针层跟随)。 */
  onCursorPos: ((fx: number, fy: number) => void) | null = null
  /** ontrack 触发时通知 view（流就绪/重连换流）。 */
  onDesktopStream: ((s: MediaStream) => void) | null = null

  /** 远程桌面输入注入:DesktopView 的手势/按键 → input channel → PC SendInput。 */
  sendDesktopInput(msg: Record<string, unknown>): void {
    const ch = this.inputCh
    if (ch && ch.readyState === 'open') {
      try { ch.send(JSON.stringify(msg)) } catch { /* 输入丢一条无碍 */ }
    }
  }

  /** 远程桌面诊断:video inbound-rtp 统计(收没收到/解没解出/丢包),DesktopView 显示在状态栏。 */
  async desktopStats(): Promise<string> {
    const pc = this.pc
    if (!pc) return 'no-pc'
    try {
      const stats = await pc.getStats()
      let inb = '', pair = ''
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r as any).kind === 'video') {
          const a = r as any
          inb = `rx=${a.framesReceived ?? 0} dec=${a.framesDecoded ?? 0} drop=${a.framesDropped ?? 0} lost=${a.packetsLost ?? 0}`
        }
        if (r.type === 'candidate-pair' && (r as any).state === 'succeeded') {
          pair = ` ${(r as any).currentRoundTripTime != null ? 'rtt' + Math.round((r as any).currentRoundTripTime * 1000) : ''}`
        }
      })
      return (inb || 'no-inbound') + pair
    } catch { return 'stats-err' }
  }

  constructor(pcDid: string, opts?: { relay?: boolean }) {
    this.pcDid = pcDid
    this.relay = opts?.relay ?? true
    // 网络恢复事件(WiFi 关闭回落蜂窝/重连)立即触发重连,不等退避节拍
    this._onOnline = () => {
      if (!this.dead || this.closed) return
      this.reviveTry = 0
      void this.tryRevive()
    }
    window.addEventListener('online', this._onOnline)
  }

  /** 本端是否配 TURN(relay 候选)。两阶段建连/自愈降级由外部或 tryRevive 控制。 */
  private relay: boolean

  /** 断线自愈:清旧连接重建隧道。NotAuthorized(denied)不重试——授权态须用户侧改变。
   *  直连档(relay=false)连续 3 次复活失败 → 自动开 TURN 兜底(网络已变得直连不可达,
   *  不降级会无限空转;用户手动重连时 connectWebRtc 会重新从直连档试起)。 */
  private async tryRevive(): Promise<void> {
    if (!this.dead || this.closed || this.readyPromise) return
    this.pc?.close(); this.pc = null
    this.stopPoll?.(); this.stopPoll = null
    try {
      await this.ensureConnected()
      this.dead = false
      this.reviveTry = 0
      tlog('[rtc] revived ✓ (auto)')
    } catch (e) {
      if (e instanceof WebRtcDeniedError) return
      if (!this.relay && this.reviveTry >= 3) {
        this.relay = true
        this.reviveTry = 0
        tlog('[rtc] 直连复活连续失败 → 开 TURN 兜底档')
        void this.tryRevive()
        return
      }
      this.scheduleRevive()
    }
  }

  /** 退避重试:1s→2s→4s→8s→15s 封顶;reviveTimer 在飞则不重复排。 */
  private scheduleRevive(): void {
    if (this.closed || this.reviveTimer) return
    const delay = Math.min(1000 * 2 ** Math.min(this.reviveTry, 4), 15_000)
    this.reviveTry++
    tlog(`[rtc] revive #${this.reviveTry} in ${delay}ms`)
    this.reviveTimer = setTimeout(() => {
      this.reviveTimer = null
      void this.tryRevive()
    }, delay)
  }

  /** 等 dead 复位(400ms 轮询,最多 ms)——rpc 在隧道重建期间软等待而非立刻失败。 */
  private async waitRevive(ms: number): Promise<boolean> {
    const t0 = Date.now()
    while (this.dead && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 400))
    return !this.dead
  }

  /** 显式连接（可选；rpc 首次用时也会自动懒连接）。 */
  async connect(pcDid?: string): Promise<void> {
    if (pcDid) this.pcDid = pcDid
    return this.ensureConnected()
  }

  /** 懒连接：首次 rpc 前建立 WebRTC（offerer → PC answerer）。失败清状态允许下次重试。 */
  private ensureConnected(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this._connect(this.pcDid).catch((e) => {
        this.readyPromise = null
        this.stopPoll?.(); this.stopPoll = null
        this.pc?.close(); this.pc = null
        throw e
      })
    }
    return this.readyPromise
  }

  private async _connect(pcDid: string): Promise<void> {
    const myDid = currentIdentity()?.did
    if (!myDid) throw new Error('身份还没准备好——稍等片刻再试，或重新打开应用')
    // IPv6 host 候选即可（公网地址直连打洞）；TURN 兜底对称过滤。STUN 只作 host 补充。
    // 两阶段(2026-08-28):relay=false 时不配 TURN——本端 relay 候选不出场,直连对
    // 独占浏览器提名窗口(中继抢跑根除;canvas 侧 relay 候选仍在但优先级低于 host,
    // 直连通则必胜)。自愈连续失败自动翻 true(网络变化透明降级)。
    const iceServers: RTCIceServer[] = [
      // STUN：vnext 未部署 coturn（火山已退役）——公共 STUN 顶 srflx 位；
      // 同网/LAN 靠 host 候选直连不受影响，跨 NAT 媒体待 vnext 补 coturn 后换回。
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.qq.com:3478' },
    ]
    if (this.relay) {
      // TURN 兜底（蜂窝对称过滤时）：coturn 云服务器。
      // TURN：vnext 未部署 coturn，暂无 TURN 兜底（对称 NAT 极端场景降级，登录链不受影响）
    }
    const pc = new RTCPeerConnection({ iceServers })
    this.pc = pc

    // 连接状态监控：failed/disconnected/closed → 标记死亡 + 全部待答 rpc 立即失败
    // （不再傻等 10s 超时）。网络切换/对方重启/通道被回收都会走到这里。
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      tlog(`[rtc] connectionState=${st} gather=${JSON.stringify(this.iceGather)}`)
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (this.closed) return
        this.dead = true
        const err = new Error('与主机的连接断了，正在自动重连——不用操作，恢复后自动继续')
        for (const [, p] of this.pending) p.rej(err)
        this.pending.clear()
        this.scheduleRevive()
      }
    }

    const opened = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('连不上主机（网络打洞没穿通）——检查双方网络，或确认 PC 端 myco 在线')), 15000)
      this._rejectConnect = (e) => { clearTimeout(to); reject(e) }
      // 'rpc' channel：projection RPC
      this.rpcCh = pc.createDataChannel('rpc')
      this.rpcCh.onopen = () => {
        clearTimeout(to); resolve()
        // 委任取件(2026-09-03 闭环):连接建立即查 identity-svc 投递箱——离线期间
        // PC 确认/续签投的委任状在此补齐(在线直推的已走 input 通道落盘)。
        // 顺带到期检查:该续就投 renew——PC 在线时服务器推 renew-notify,重签秒回。
        void import('./delegation').then(async (dl) => {
          const d = await dl.pollDelegation()
          if (d) tlog('[rtc] 委任状已收(信箱)')
          const cur = dl.loadDelegation()
          if (cur && dl.isDueRenew(cur)) await dl.requestRenewal()
        }).catch(() => {})
      }
      this.rpcCh.onmessage = (ev) => this._onRpcMessage(ev)
      this.rpcCh.onerror = () => { clearTimeout(to); reject(new Error('与主机的数据通道出错了——稍等片刻再试，或断开重连')) }
      this.rpcCh.onclose = () => {
        if (this.closed || this.dead) return
        this.dead = true; tlog('[rtc] rpc channel closed')
        this.scheduleRevive()
      }
      // 'events' channel：推 delta（subscribe 用）；{d}单帧/分帧重组在 _onEvMessage
      this.evCh = pc.createDataChannel('events')
      // open 即重发订阅行(2026-09-03):opened 只等 rpc 通道,events 通道稍晚开时
      // watchAll 的首发送会因 connecting 态静默丢弃——曾致远程回复不上屏
      this.evCh.onopen = () => { this.sendWatchLine() }
      this.evCh.onmessage = (ev) => this._onEvMessage(ev)
      // 'input' channel：远程桌面输入注入(鼠标/键盘/触摸 → PC SendInput)。无序不可靠即可,
      // 输入丢了下一帧手势会补上;但默认 reliable 更稳,先按默认(不设选项)。
      this.inputCh = pc.createDataChannel('input')
      // RDP 式指针通道(下行):PC 30Hz 广播真实光标位置——指针层纯跟随 PC,
      // 单一真相源+亚帧级流畅,根除"手机虚拟指针+PC 画面指针"双指针错位。
      this.inputCh.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data as string) as { t?: string; fx?: number; fy?: number; d?: unknown }
          if (v.t === 'cursor' && typeof v.fx === 'number' && typeof v.fy === 'number') {
            this.onCursorPos?.(v.fx, v.fy)
          }
          // 委任状直推(2026-09-03 闭环):PC 确认/续签后在线直发——落盘,双证从此齐备
          if (v.t === 'delegation' && v.d && typeof v.d === 'object') {
            void import('./delegation').then((dl) => {
              try {
                // 字段名归一:直推体是 Rust serde camelCase(mycoDid),信箱/服务器
                // 形状是 accountDid——统一到 accountDid,续签 requestRenewal 才读得到
                const d = v.d as import('./delegation').Delegation & { mycoDid?: string }
                if (!d.accountDid && d.mycoDid) d.accountDid = d.mycoDid
                if (d.accountDid && d.exp > Date.now()) { dl.saveDelegation(d); tlog('[rtc] 委任状已收(直推)') }
              } catch { /* 坏载荷忽略 */ }
            }).catch(() => {})
          }
        } catch { /* 坏消息忽略 */ }
      }
    })

    // 远程桌面：收 canvas 推来的 video track（PC 屏幕画面）→ 存流 + 通知 view 挂 <video>。
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track])
      this.desktopStream = s
      this.onDesktopStream?.(s)
      tlog(`[rtc] ontrack kind=${e.track.kind} streams=${e.streams.length}`)
    }

    // ICE 候选 → 发给 PC（顺手统计类型：诊断"为什么走了中转"的关键现场）
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const m = / typ (host|srflx|relay|prflx) /.exec(e.candidate.candidate)
        if (m) (this.iceGather as Record<string, number>)[m[1]]++
        // 诊断（临时）：上报每个候选地址，定位手机侧 host 候选是 v4 还是 v6
        tlog(`[cand] ${e.candidate.candidate.slice(0, 130)}`)
        void sigDeposit('ice', { to: pcDid, candidate: e.candidate.toJSON() }).catch(() => {})
      }
    }

    // 先挂 poll 收 answer/ice/denied，再发 offer（防漏消息）。只收目标 PC 发来的（信箱是自己的，
    // 但可能同时向多台 PC 发 offer，answer/ice 按 from 过滤）。
    this.stopPoll = sigPoll(async (msg) => {
      try {
        // 2026-10-07：设备 did 也有历史形态（legacy 裸 base58 / canonical z multibase）——
        // 公钥级判等，否则老 PC 的 answer/ice 被静默丢弃（连不上/黑屏）。
        if (!accountDidEq(String(msg.from ?? ''), pcDid)) return
        if (msg.type === 'answer' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
        } else if (msg.type === 'ice' && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {})
        } else if (msg.type === 'denied') {
          this._rejectConnect?.(new WebRtcDeniedError())
        }
      } catch { /* 忽略信令错 */ }
    })

    // 远程桌面:offer 带 m=video recvonly —— canvas 才能 add_track 回 sendonly
    // (WebRTC 规则:answer 不能新增 offer 里没有的 m-line,所以必须 phone 侧先声明)。
    // audio 同理(M4 声音回传:PCMU 8k,浏览器全兼容)。
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await sigDeposit('offer', { to: pcDid, sdp: pc.localDescription?.sdp ?? offer.sdp })
    await opened
    // 建联(含断线自愈重建)成功:重发事件订阅行——events channel 是新建的,不重发
    // 则 revive 后实时流静默丢失
    this.sendWatchLine()
    // 建联成功：上报选中的候选对（local/remote 类型）——直连还是中转，服务器日志一看便知
    setTimeout(() => void this.logSelectedPair(), 1500)
  }

  /** 上报选中候选对到 /tlog（诊断用）：localType/remoteType + 协议。 */
  private async logSelectedPair(): Promise<void> {
    if (!this.pc) return
    try {
      const stats = await this.pc.getStats()
      let pair: any = null
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated) && !pair) pair = r
      })
      if (!pair) { tlog('[rtc] pair=none'); return }
      const lc: any = pair.localCandidateId ? stats.get(pair.localCandidateId) : null
      const rc: any = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null
      tlog(`[rtc] pair local=${lc?.candidateType ?? '?'}/${lc?.protocol ?? '?'} remote=${rc?.candidateType ?? '?'} gather=${JSON.stringify(this.iceGather)}`)
    } catch { /* 忽略 */ }
  }

  private _rejectConnect: ((e: Error) => void) | null = null

  // ── 应用层分帧重组（DataChannel 单条上限 64KB：大快照/snap cells/长 history/image 上传都超）──
  // 帧形 {g,c,n,d}；小消息走原生形状（rpc={id,data}/{id,line}，events={d:delta}）。
  private chunkBuf = new Map<number, { n: number; parts: string[]; got: number }>()
  private frameGroup = 0

  /** 收一帧：是分帧则入缓冲，凑齐返回完整文本；未凑齐返回 null；不是分帧返回 undefined。 */
  private _takeChunk(m: any): string | null | undefined {
    if (typeof m?.g !== 'number' || typeof m?.c !== 'number' || typeof m?.n !== 'number' || typeof m?.d !== 'string') return undefined
    let e = this.chunkBuf.get(m.g)
    if (!e || e.n !== m.n) { e = { n: m.n, parts: new Array(m.n).fill(''), got: 0 }; this.chunkBuf.set(m.g, e) }
    if (!e.parts[m.c]) { e.parts[m.c] = m.d; e.got++ }
    if (e.got < e.n) return null
    this.chunkBuf.delete(m.g)
    return e.parts.join('')
  }

  /** 发大消息：>阈值 切 {g,c,n,d} 分帧（按 UTF-16 码元切，CJK 最坏 3B/字 ×12k = 36KB 安全线内）。 */
  private _sendFramed(ch: RTCDataChannel, text: string): void {
    const MAX = 12_000
    if (text.length <= MAX) { ch.send(text); return }
    const g = ++this.frameGroup
    const n = Math.ceil(text.length / MAX)
    for (let c = 0; c < n; c++) {
      ch.send(JSON.stringify({ g, c, n, d: text.slice(c * MAX, (c + 1) * MAX) }))
    }
  }

  private _onDelta: ((deltaJson: string) => void) | null = null

  private _onRpcMessage(ev: MessageEvent) {
    try {
      let m = JSON.parse(String(ev.data)) as any
      if (m && typeof m.g === 'number') {
        const full = this._takeChunk(m)
        if (full == null) return
        m = JSON.parse(full) as RtcMsg
      }
      const msg = m as RtcMsg
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.err) p.rej(new Error(msg.err))
      else {
        // 未授权闸门：data 里带 notAuthorized → 抛 NotAuthorizedError（提示去 PC 添加 DID）
        const d = msg.data as { notAuthorized?: boolean; did?: string } | null
        if (d && typeof d === 'object' && d.notAuthorized) p.rej(new NotAuthorizedError(d.did ?? ''))
        else p.res(msg.data)
      }
    } catch { /* 忽略 */ }
  }

  /** events channel 入消息：{d:delta} 单帧 / {g,c,n,d} 分帧重组 → onDelta(raw)。 */
  private _onEvMessage(ev: MessageEvent) {
    try {
      const m = JSON.parse(String(ev.data))
      if (m && typeof m.g === 'number') {
        const full = this._takeChunk(m)
        if (full != null && this._onDelta) this._onDelta(full)
        return
      }
      if (m && typeof m.d === 'string' && this._onDelta) this._onDelta(m.d)
    } catch { /* 忽略 */ }
  }

  /** 泛化请求({id,...} 形状,行协议与 http 透传共用响应通道+分帧重组)。 */
  private async requestObj(obj: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    await this.ensureConnected()
    if (this.dead) {
      // 断线自愈:网络切换等隧道重建(≤15s);期间 UI 轮询(TaskList 5s/会话细态)自然恢复
      if (!(await this.waitRevive(15_000))) throw new Error('连接中断了，正在自动重连——网络恢复或 PC 重新上线后自动继续，不用操作')
    }
    if (!this.rpcCh || this.rpcCh.readyState !== 'open') throw new Error('与主机的连接还没建立好——稍等片刻再试，或检查网络')
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { res: resolve, rej: reject })
      // image 上传/透传 body 等大请求自动分帧(PC 端重组后按 {id,line}/{id,t} 处理)
      this._sendFramed(this.rpcCh!, JSON.stringify({ id, ...obj }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('主机响应太慢了（超时）——PC 可能正忙，稍后再试')) }, timeoutMs)
    })
  }

  /** projection RPC over DataChannel(同 DirectHttpTransport 的 /rpc 语义)。 */
  private async rpc(line: string): Promise<unknown> {
    return this.requestObj({ line })
  }

  /**
   * HTTP 透传(工作区远程模式,2026-08-31):本机方法/路径经 PC 转发到它的
   * canvas :3002 / ta :8100(p 可带 "ta:" 前缀选 ta;PC 侧白名单 /api/*、/env/*)。
   * 返回 {s:HTTP 状态, b:响应体文本}。chatwin 用它把 window.fetch 重定向到隧道。
   */
  async http(method: string, path: string, body?: string): Promise<{ s: number; b: string }> {
    // 2026-09-10 L40 根修：超时 30s——断网时用户等 30s 才知道失败。修=断网
    // 快速失败（navigator.onLine=false 时立即抛错，不等超时）。
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('网络已断开——消息未发送，恢复网络后重试')
    }
    const d = await this.requestObj({ t: 'http', m: method, p: path, b: body }, 30000) as { s?: number; b?: string }
    return { s: d?.s ?? 0, b: d?.b ?? '' }
  }

  // ── FB-4(2026-09-01):zcode 桥会话——此前 list() 只含 ta 会话,PC 上正在工作的
  // zcode 会话手机不可见,点项目只能"打开"新会话。经 http 隧道透传 canvas /api/zcode/*。
  private isZcode(s: SessionInfo): boolean { return s.command === 'zcode' }
  private async zcodeGet(path: string): Promise<unknown[] | null> {
    try {
      const r = await this.http('GET', path)
      if (r.s !== 200) return null
      const j = JSON.parse(r.b)
      return (j?.data ?? null) as unknown[] | null
    } catch { return null }
  }
  async list(): Promise<SessionInfo[]> {
    const d = (await this.rpc('list')) as { data?: SessionInfo[] }
    const out: SessionInfo[] = [...(d?.data ?? [])]
    const zs = await this.zcodeGet('/api/zcode/list')
    if (zs) for (const z of zs as { taskId?: string; status?: string; title?: string; workspace?: string }[]) {
      if (!z?.taskId) continue
      out.push({
        sessionId: z.taskId, taskId: z.taskId, command: 'zcode',
        status: z.status ?? 'ready', title: z.title || z.workspace || 'zcode', startedAt: '',
      } as SessionInfo)
    }
    return out
  }
  async status(s: SessionInfo): Promise<{ fineState?: string | null; appType?: string | null; approval?: string | null }> {
    const d = (await this.rpc(`status ${s.taskId}`)) as { data?: { fineState?: string | null; appType?: string | null; approval?: string | null } }
    return d?.data ?? {}
  }
  async snap(s: SessionInfo): Promise<Snapshot> {
    const d = (await this.rpc(`snap ${s.taskId}`)) as { data?: { lines?: string[]; cols?: number; rows?: number } }
    const data = d?.data ?? {}
    return { lines: data.lines ?? [], cols: data.cols, rows: data.rows }
  }
  async screen(s: SessionInfo): Promise<ScreenContent> {
    const d = (await this.rpc(`snap ${s.taskId}`)) as { data?: { lines?: string[]; cols?: number; rows?: number; cursorX?: number; cursorY?: number; cells?: unknown } }
    const data = d?.data ?? {}
    return { cols: data.cols ?? 80, rows: data.rows ?? 24, cursorX: data.cursorX ?? 0, cursorY: data.cursorY ?? 0, lines: data.lines ?? [], cells: data.cells as ScreenContent['cells'] }
  }
  async input(s: SessionInfo, text: string, author?: string): Promise<boolean> {
    if (this.isZcode(s)) {
      try {
        const r = await this.http('POST', '/api/zcode/send',
          JSON.stringify({ taskId: s.sessionId, content: text, author }))
        return r.s === 200
      } catch { return false }
    }
    const d = (await this.rpc(`input ${s.taskId} ${text}`)) as { ok?: boolean; success?: boolean }
    return d?.ok === true || d?.success === true
  }
  /** 终端 scrollback 区段(terminal 模式滚屏):projection 'buffer' → ta /buffer(带 cells)。 */
  async buffer(s: SessionInfo, from: number, count: number): Promise<BufferRegion> {
    const d = (await this.rpc(`buffer ${s.taskId} ${from} ${count}`)) as { data?: BufferRegion; error?: string | null }
    if (!d?.data || !Array.isArray(d.data.lines)) throw new Error(d?.error || 'buffer unavailable')
    return d.data
  }
  async key(s: SessionInfo, keyName: string): Promise<boolean> {
    const d = (await this.rpc(`key ${s.taskId} ${keyName}`)) as { ok?: boolean; success?: boolean }
    return d?.ok === true || d?.success === true
  }
  async image(s: SessionInfo, b64: string): Promise<boolean> {
    const d = (await this.rpc(`image ${s.taskId} ${b64}`)) as { ok?: boolean; success?: boolean }
    return d?.ok === true || d?.success === true
  }
  /** 粘贴图片落盘暂存(ta http 透传 stage 模式)——发送时以 @path 注入(2026-09-05 补齐)。 */
  async imageStage(s: SessionInfo, base64: string): Promise<string | null> {
    try {
      const r = await this.http('POST', 'ta:/api/session/' + s.sessionId + '/image',
        JSON.stringify({ base64, stage: true }))
      const j = JSON.parse(r.b) as { success?: boolean; data?: { path?: string } }
      return j?.success ? (j.data?.path ?? null) : null
    } catch { return null }
  }
  async fetchAsset(name: string): Promise<string> {
    const d = (await this.rpc(`asset ${name}`)) as { dataUrl?: string; data?: { dataUrl?: string } }
    return d?.dataUrl ?? d?.data?.dataUrl ?? ''
  }
  async history(s: SessionInfo, from?: number, count?: number): Promise<HistoryPage> {
    if (this.isZcode(s)) {
      const all = ((await this.zcodeGet(`/api/zcode/messages?taskId=${encodeURIComponent(s.sessionId)}`))
        ?? []) as { role?: string; text?: string; mid?: string; toolUse?: ChatMessage['toolUse']; thinking?: string }[]
      const cnt = count ?? 50
      const end = all.length - (from ?? 0)
      const start = Math.max(0, end - cnt)
      const slice = all.slice(start, Math.max(start, end))
      return {
        lines: [], total: all.length, from: from ?? 0, count: slice.length,
        messages: slice.map((m) => ({
          role: m.role ?? 'assistant', text: m.text ?? '', uuid: m.mid ?? undefined,
          toolUse: m.toolUse, thinking: m.thinking,
        } as ChatMessage)),
      }
    }
    const parts = [`history ${s.taskId}`]
    if (from != null) parts.push(String(from)); else if (count != null) parts.push('0')
    if (count != null) parts.push(String(count))
    const d = (await this.rpc(parts.join(' '))) as { data?: { lines?: string[]; messages?: ChatMessage[]; totalLines?: number; from?: number; count?: number } }
    const data = d?.data ?? {}
    return { lines: data.lines ?? [], messages: data.messages ?? [], total: data.totalLines ?? 0, from: data.from ?? 0, count: data.count ?? 0 }
  }
  /** 当前事件订阅行(watch <taskId> / watch-all)——断线自愈重建通道后自动重发,
   *  否则 revive 后实时流静默丢失(2026-08-31 工作区远程接入时补)。 */
  private _watchLine: string | null = null

  private sendWatchLine(): void {
    if (!this._watchLine) return
    const line = this._watchLine
    void this.ensureConnected()
      .then(() => this.evCh?.send(JSON.stringify({ line })))
      .catch(() => {})
  }

  subscribe(s: SessionInfo, onDelta: (deltaJson: string) => void): () => void {
    if (this.isZcode(s)) {
      // 轮询 2.5s:签名变化→合成 belief 'message' 事件(uuid=mid 与去重兼容);首轮只记基线
      let lastSig = ''
      let stopped = false
      const tick = async () => {
        if (stopped) return
        const arr = ((await this.zcodeGet(`/api/zcode/messages?taskId=${encodeURIComponent(s.sessionId)}`))
          ?? []) as { role?: string; text?: string; mid?: string; toolUse?: ChatMessage['toolUse']; thinking?: string }[]
        const sig = arr.map((m) => `${m.mid ?? ''}|${(m.text ?? '').length}`).join(';')
        if (sig !== lastSig) {
          const first = lastSig === ''
          lastSig = sig
          if (!first) for (const m of arr.slice(-5)) {
            onDelta(JSON.stringify({
              kind: 'message', sessionId: s.sessionId,
              message: { role: m.role ?? 'assistant', text: m.text ?? '', uuid: m.mid ?? undefined, toolUse: m.toolUse, thinking: m.thinking },
            }))
          }
        }
        if (!stopped) setTimeout(() => void tick(), 2500)
      }
      void tick()
      return () => { stopped = true }
    }
    this._onDelta = onDelta
    // 订阅走 events channel：PC 端收到 `watch <taskId>` 后桥 belief-events 推 delta。
    this._watchLine = `watch ${s.taskId}`
    this.sendWatchLine()
    return () => { if (this._onDelta === onDelta) this._onDelta = null }
  }

  /**
   * 全量事件订阅(工作区远程模式,2026-08-31):PC 端 watch-all 桥推
   * ta belief-events + canvas aop events 合并流。onDelta 收原始 SSE data 文本
   * (与本地 EventSource.onmessage 同料,客户端自分流)。
   */
  watchAll(onDelta: (deltaJson: string) => void): () => void {
    this._onDelta = onDelta
    this._watchLine = 'watch-all'
    this.sendWatchLine()
    return () => { if (this._onDelta === onDelta) this._onDelta = null }
  }
    /** 任务看板（env 聚合面经 http 隧道透传；PC 侧白名单 /api/*）。 */
  async tasksBoard(): Promise<TasksBoard | null> {
    try {
      const { s, b } = await this.http('POST', '/api/tasks_board', '{}')
      if (s !== 200) return null
      return ((JSON.parse(b) as { data?: TasksBoard }).data) ?? null
    } catch { return null }
  }
async projects(): Promise<ProjectInfo[]> { const d = (await this.rpc('projects')) as { data?: ProjectInfo[] }; return d?.data ?? [] }
  async tasks(): Promise<TaskInfo[]> { const d = (await this.rpc('worktasks')) as { data?: TaskInfo[] }; return d?.data ?? [] }
  async open(projectId: string): Promise<SessionInfo> { const d = (await this.rpc(`open ${projectId}`)) as { data?: SessionInfo }; return d?.data as SessionInfo }
  /** @补全：可选模型（projection models → provider 配置）。 */
  async models(): Promise<ModelOption[]> { const d = (await this.rpc('models')) as { data?: ModelOption[] }; return d?.data ?? [] }
  /** @补全：当前聊天观看者（projection watchers <taskId>，已按自己 did 排除）。 */
  async watchers(s: SessionInfo): Promise<string[]> {
    const d = (await this.rpc(`watchers ${s.taskId}`)) as { data?: { name: string }[] }
    return (d?.data ?? []).map((w) => w.name)
  }
  /** 自己在对方 PC 上的授权信息（限时剩余可见；projection authinfo，只回自己那条）。 */
  async authInfo(): Promise<AuthInfo | null> {
    const d = (await this.rpc('authinfo')) as { data?: AuthInfo | null }
    return d?.data ?? null
  }

  async todos(): Promise<PmTodo[]> {
    const d = (await this.rpc('todos')) as { data?: PmTodo[] | null }
    return d?.data ?? []
  }

  async connInfo(): Promise<'direct' | 'relay' | 'connecting'> {
    if (!this.pc) return 'connecting'
    try {
      const stats = await this.pc.getStats()
      // 找被选中的 candidate-pair，再看它本地候选类型：relay=中转，host/srflx=直连。
      let pair: unknown = null
      stats.forEach((r) => {
        const rr = r as unknown as { type?: string; state?: string; selected?: boolean; nominated?: boolean }
        if (rr.type === 'candidate-pair' && rr.state === 'succeeded' && (rr.selected || rr.nominated) && !pair) {
          pair = r
        }
      })
      const pairId = (pair as { localCandidateId?: string } | null)?.localCandidateId
      const lc = pairId ? stats.get(pairId) : null
      const ctype = (lc as unknown as { candidateType?: string } | null)?.candidateType
      return ctype === 'relay' ? 'relay' : 'direct'
    } catch { return 'connecting' }
  }

  /** 断开。 */
  close(): void {
    this.closed = true
    if (this.reviveTimer) { clearTimeout(this.reviveTimer); this.reviveTimer = null }
    if (this._onOnline) { window.removeEventListener('online', this._onOnline); this._onOnline = null }
    this.stopPoll?.()
    this.pc?.close()
    this.pc = null; this.rpcCh = null; this.evCh = null; this.readyPromise = null
  }
}

/** 两阶段建连(2026-08-28 设计定稿语义:中转只兜底,不抢跑):
 *  ① STUN-only——本端 relay 候选不出场,直连对独占浏览器提名窗口(12s);
 *  ② 不通再带 TURN 兜底档重试。返回【已连通】的 transport 实例(免 App 重复重建)。
 *  胜出档位记 localStorage(youling.rtcRelay),诊断与后续重建参考。 */
export async function connectWebRtc(did: string, timeoutMs = 12000): Promise<WebRtcTransport> {
  tlog(`connectWebRtc start did=${did.slice(-12)} identity=${currentIdentity()?.did?.slice(-8) ?? 'NULL'} timeout=${timeoutMs}`)
  const attempt = (relay: boolean, as: 'device' | 'root' = 'device'): Promise<WebRtcTransport> => {
    sigAs = as
    tlog(`connectWebRtc attempt relay=${relay} as=${as}`)
    const t = new WebRtcTransport(did, { relay })
    // 探活=GET /api/ping（http 透传读面——desktop.view ∨ session.input 均可）。
    // 2026-09-09 读写分层：曾用 t.list() rpc 探活=行协议 session.input 闸——
    // 只读设备（desktop.view+task:ro，无 session.input）建连必死「对方未放行」。
    return Promise.race([
      t.http('GET', '/api/ping').then(() => undefined),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('连不上主机（建立连接超时）——检查网络，或确认 PC 端 myco 在线')), timeoutMs)),
    ]).then(() => t, (e) => { t.close(); throw e })
  }
  // 账户身份优先（2026-09-11 定稿）：本机关联有灵账号时先以账户身份 offer——
  // 干净首连（曾实现「设备失败→fallback 账户重试」，第二次 WebRTC PC 建立在
  // 旧 transport close 竞态上，DataChannel 打开超时间歇复现）。账户被拒（PC 没给
  // 该账户开权限）→ 回设备身份；两者都未授权才报 NotAuthorized。
  const rootFirst = hasRootSigningIdentity()
  const first = rootFirst ? 'root' : 'device'
  const second = rootFirst ? 'device' : 'root'
  try {
    const t = await attempt(false, first)
    localStorage.setItem('youling.rtcRelay', '0')
    tlog(`connectWebRtc direct OK as=${first}`)
    return t
  } catch (e) {
    tlog(`connectWebRtc direct fail as=${first}: ${String(e).slice(0, 120)}`)
    if (e instanceof NotAuthorizedError && second === 'device') {
      try {
        const t = await attempt(false, 'device')
        localStorage.setItem('youling.rtcRelay', '0')
        tlog('connectWebRtc direct OK as=device(回退)')
        return t
      } catch (e2) {
        tlog(`connectWebRtc device fail: ${String(e2).slice(0, 120)}`)
        if (e2 instanceof NotAuthorizedError) throw e2
      }
      throw e
    }
    if (e instanceof NotAuthorizedError) { tlog('connectWebRtc NOT_AUTHORIZED'); throw e }
  }
  // 2026-10-10 用户要求：强制直连模式下不做 TURN 中转兜底——直连不通就直接报错。
  const forceDirect = (() => {
    try { return localStorage.getItem('myco.forceDirect') === '1' } catch { return false }
  })()
  if (forceDirect) {
    tlog('connectWebRtc: 强制直连模式开启——跳过 TURN 中转兜底')
    throw new Error('直连不通（已开启强制直连）。请确保双方在同一网络或有可达的直连地址')
  }
  const t = await attempt(true)
  localStorage.setItem('youling.rtcRelay', '1')
  tlog('connectWebRtc relay OK')
  return t
}

// ═══════════════ ReplayTransport — 回放数据集(P/A 能力评测/调试,零 UI 改动)═══════════════
// 消费 ta 传感器录制语料(.aop/sensors/<session>.jsonl):
//   - event_out 载荷就是 ObservationEvent JSON —— pump() 按录制节拍喂
//     belief-store.applyObservationEvent,聊天视图/细态徽章零改动渲染历史任意时刻;
//   - terminal 传感器帧供 screen() —— 终端视图(P 的字面通道)回放;
//   - input()/key() 为记录性 no-op(回放不产生副作用)。
// 用法(浏览器 console / 测试):
//   const corpus = parseSensorCorpus(text)
//   const t = new ReplayTransport(corpus)
//   await t.pump(useBeliefStore.getState().applyObservationEvent, { speed: 4 })

export interface SensorCorpusHeader {
  v: number
  session: string
  cwd: string
  harness: string
  createdAt: string
}

export interface SensorTerminalFrame {
  cursorX: number
  cursorY: number
  lines: string[]
  at: number
}

export interface SensorCorpus {
  header: SensorCorpusHeader
  /** ObservationEvent 流(kind!=sensor 的事件,golden 复放)。 */
  events: Record<string, unknown>[]
  /** 终端帧(按 at 升序)。 */
  frames: SensorTerminalFrame[]
  /** 输入事件计数(诊断用)。 */
  inputs: number
}

/** 解析 ta 传感器录制文件文本 → 结构化语料。容忍坏行(jsonl 局部损坏不整体弃用)。 */
export function parseSensorCorpus(text: string): SensorCorpus {
  const header = { v: 2, session: '', cwd: '', harness: '', createdAt: '' }
  const events: Record<string, unknown>[] = []
  const frames: SensorTerminalFrame[] = []
  let inputs = 0
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(l) } catch { continue }
    if (d.kind === 'header') {
      Object.assign(header, d)
    } else if (d.kind === 'sensor') {
      const p = (d.payload ?? {}) as Record<string, unknown>
      // __at:sensor 记录外层时刻(节拍源)——payload 里的 atMs 多数事件没有,
      // 泵按它对齐真实节奏(曾漏:零间隔跑完,关键帧全拍成终态)。
      if (d.source === 'event_out') {
        // 归一(2026-09-09):管道录制器(collab_pipe record_line)落的 payload 是
        // harness 协议原始事件(claude stream-json 等,有 type 无 kind)——回放
        // 播放器 apply 的是 ObservationEvent(kind:message/…)——不转=影子会话空,
        // 回放打开无内容。在此统一转成 message 事件(单一转换点,新旧语料通吃)。
        events.push({ ...normalizeProtocolEvent(p), __at: Date.parse(String(d.at ?? '')) || 0 })
      }
      else if (d.source === 'terminal') {
        frames.push({
          cursorX: Number(p.cursorX ?? 0), cursorY: Number(p.cursorY ?? 0),
          lines: Array.isArray(p.lines) ? (p.lines as string[]) : [],
          at: Date.parse(String(d.at ?? '')) || 0,
        })
      } else inputs++
    }
  }
  return { header, events, frames, inputs }
}

/** harness 协议原始事件 → ObservationEvent 形态（回放渲染归一）。
 * claude stream-json：assistant→assistant 消息（content 数组提取文本）、
 * user→user 消息、result→回合完成摘要、system/init→忽略（元数据）。
 * 已是 ObservationEvent（有 kind）或无法识别的原样返回（不丢数据）。 */
function normalizeProtocolEvent(p: Record<string, unknown>): Record<string, unknown> {
  if (typeof p.kind === 'string' && p.kind) return p // 已是 ObservationEvent
  const t = p.type as string | undefined
  if (t === 'assistant' || t === 'user') {
    const content = p.message && typeof p.message === 'object'
      ? (p.message as Record<string, unknown>).content
      : p.content
    const text = Array.isArray(content)
      ? content.filter((c) => (c as Record<string, unknown>)?.type === 'text')
          .map((c) => String((c as Record<string, unknown>).text ?? '')).join('')
      : typeof content === 'string' ? content : ''
    if (!text) return { kind: 'state', appState: `${t} (无文本)`, at: 0 }
    return { kind: 'message', message: { role: t, text }, sessionId: p.session_id ?? '', at: 0 }
  }
  if (t === 'result') {
    const sub = typeof p.subtype === 'string' ? p.subtype : ''
    return { kind: 'message', message: { role: 'assistant', text: `〔回合完成${sub ? '·' + sub : ''}〕` }, at: 0 }
  }
  if (t === 'system') return { kind: 'state', appState: `system/${p.subtype ?? ''}`, at: 0 }
  // JSON-RPC 家族（kimi/zcode/codex 协议帧）:留原始（后续按需扩展归一）
  return p
}

export class ReplayTransport {
  readonly kind = 'replay'
  private corpus: SensorCorpus
  private speed: number

  constructor(corpus: SensorCorpus, opts?: { speed?: number }) {
    this.corpus = corpus
    this.speed = opts?.speed ?? 1
  }

  /** 回放会话句柄(与真实 transport 的 list() 同形)。 */
  session(): SessionInfo {
    return {
      sessionId: this.corpus.header.session || 'replay',
      taskId: 'replay',
      status: 'running',
      command: 'replay',
      startedAt: this.corpus.header.createdAt,
    }
  }

  /** 终端帧(P 字面通道):最近一帧(at ≤ 时刻;缺省最新)。 */
  screen(at?: number): ScreenContent {
    const f = this.frameAt(at)
    return {
      cols: Math.max(1, ...f.lines.map((l) => l.length)),
      rows: f.lines.length || 1,
      cursorX: f.cursorX, cursorY: f.cursorY,
      lines: f.lines,
    }
  }

  private frameAt(at?: number): SensorTerminalFrame {
    const fs = this.corpus.frames
    if (!fs.length) return { cursorX: 0, cursorY: 0, lines: [], at: 0 }
    if (at == null) return fs[fs.length - 1]
    let lo = 0
    for (let i = 0; i < fs.length; i++) if (fs[i].at <= at) lo = i
    return fs[lo]
  }

  /** 节拍泵:按事件原始间隔(÷speed)把 golden 事件喂给消费端(belief-store 的
   *  applyObservationEvent)。返回喂入数量。onEvent 可拦截(回放断言/截图钩子)。 */
  async pump(
    apply: (e: Record<string, unknown>) => void,
    opts?: { onEvent?: (e: Record<string, unknown>, i: number) => void; maxGapMs?: number },
  ): Promise<number> {
    const maxGap = opts?.maxGapMs ?? 5000
    let prevAt = 0
    let n = 0
    for (let i = 0; i < this.corpus.events.length; i++) {
      const e = this.corpus.events[i]
      const at = Number(e.__at ?? 0) || Date.parse(String(e.atMs ?? '')) || 0
      if (prevAt && at > prevAt) {
        const gap = Math.min(at - prevAt, maxGap) / Math.max(this.speed, 0.001)
        if (gap > 1) await new Promise((r) => setTimeout(r, gap))
      }
      if (at) prevAt = at
      apply(e)
      opts?.onEvent?.(e, i)
      n++
    }
    return n
  }
}
