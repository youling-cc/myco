/**
 * beliefStore — phone/canvas 共用的 C 层融合 belief（s'，≡ ta 的 s）。单一源。
 *
 * 消费 ta 的 belief-events 观察事件流（o'），本地融合出显示 belief——
 * 对应 design/07-connectivity/BELIEF-SYNC-CONSISTENCY.md 的 o'→s'。
 * phone（经 webrtc_conn bridge 透传）与 canvas（经 SSE）订阅同一事件协议，融合逻辑必须
 * 单一源，避免协议演进时两处不同步导致 s'≢s。
 *
 * 数据源：
 *  - 实时：belief-events（phone=webrtc bridge / canvas=SSE）→ applyObservationEvent 融合
 *  - 历史补充：transport.history → appendHistory（lazy 拉更早，jsonl 权威）
 *
 * 导出双名：phone 用 useBeliefStore，canvas 用 useChatBeliefStore（同一 store 别名）。
 */
import { create } from 'zustand'
import type { ChatMessage, Attachment, AgentLive } from './transport'

export interface PendingTurn {
  appState: string
  workingSec: number
  startedAt?: number
  lastFrameSeq?: number
  /** 生成中的实时文本（gen_progress 推送，未落盘）。 */
  generatingText?: string
  /** spinner 状态行原文（✽ Determining… (8s · thinking · ↑1.2k tokens)，动词+计时+token）。 */
  statusText?: string
}

export interface SessionBelief {
  sessionId: string
  taskId: string
  messages: ChatMessage[]
  historyTotal: number
  historyLoadedFrom: number
  historyHasMore: boolean
  pending: PendingTurn | null
  conn: 'online' | 'reconnecting' | 'offline'
  /** claude 处于交互选择界面（Rewind//context 等 picker）——显示端据此显方向键面板。 */
  interactive: boolean
  /** picker 结构化状态（interactive 时）：标题/列表行/选中行/提示。 */
  picker?: PickerState | null
  /** 任务清单（终端底部 "N tasks (X done, Y open)" + ◻/✔ 列表当前态）。 */
  todos?: TodoState | null
  /** 后台 agent 运行集（Task/Agent spawn 的 subagent）；空=无——agents 事件/snapshot 镜像。 */
  agents: AgentLive[]
  /** ta 粗态（idle/working/waiting_input）——state 事件/snapshot 镜像。 */
  appState?: string | null
  /** H4 细态（11 态 snake_case；null=未命中 harness 规则）——三件套数据源。 */
  fineState?: string | null
  /** harness 标识（claude_code/kimi_code/codex…）——审批按键分派依据。 */
  appType?: string | null
  /** awaiting_approval 的审批内容摘要（屏幕提取；null=通用文案）。 */
  approval?: string | null
  /** 忙态动作（中文动词，spinner 行提炼；null=未生成/未识别）——状态胶囊条。 */
  hintAction?: string | null
  /** 本轮 token 用量（"Tokens: N" 提炼；null=未见）。 */
  tokensUsed?: number | null
}

/** 任务清单项（claude 终端底部的 todo 列表）。 */
export interface TodoItem {
  status: 'completed' | 'in_progress' | 'pending'
  text: string
}
export interface TodoState {
  items: TodoItem[]
  /** 最后一次任务事件时刻 epoch ms;0=未知(屏幕镜像兜底无时间信息) */
  lastAtMs?: number
  /** 最后任务事件之后的纯 user 轮数(模型多少轮没再碰计划);0=未知/无 */
  turnsAfter?: number
}

/** 交互选择界面（picker）结构：/rewind /resume /context 等共性。 */
export interface PickerState {
  title: string
  lines: string[]
  selectedIndex?: number
  hint: string
}

/** ta 观察事件（belief-events 载荷，camelCase）。phone/canvas 共用协议定义。 */
export interface ObservationEvent {
  kind: 'snapshot' | 'input_echo' | 'gen_start' | 'gen_progress' | 'message' | 'gen_end' | 'conn' | 'interactive' | 'picker' | 'todos' | 'agents' | 'state' | 'task_title'
  sessionId?: string
  belief?: {
    sessionMeta?: { sessionId?: string; taskId?: string }
    live?: { workingSinceMs?: number; generatingText?: string; statusText?: string; interactive?: boolean; picker?: PickerState | null; todos?: TodoState | null; agents?: AgentLive[]; appState?: string; fineState?: string | null; appType?: string | null; approval?: string | null; hintAction?: string | null; tokensUsed?: number | null }
    messages?: ChatMessage[]
    conn?: string
  }
  text?: string
  atMs?: number
  /** input_echo 的作者显示名（哪个 账号的人发的）。 */
  author?: string
  /** input_echo 的附件（图片等），让 echo 即时显示图片而非路径文本。 */
  attachments?: Attachment[]
  workingSinceMs?: number
  generatingText?: string
  statusText?: string
  workingSec?: number
  message?: ChatMessage
  totalWorkingSec?: number
  conn?: 'online' | 'reconnecting' | 'offline'
  interactive?: boolean
  picker?: PickerState | null
  todos?: TodoState | null
  /** agents 事件：后台 agent 运行集变化（新启动/完成；空=全部收尾）。 */
  agents?: AgentLive[]
  /** state 事件：应用粗态/细态/审批摘要变化。 */
  appState?: string
  fineState?: string | null
  appType?: string | null
  approval?: string | null
  /** state 事件：忙态动作（状态胶囊条）。 */
  hintAction?: string | null
  tokensUsed?: number | null
}

interface BeliefState {
  beliefs: Record<string, SessionBelief>
  ensureSession: (sessionId: string, taskId: string) => void
  /** 消费一个 ta 观察事件，融合进 s'（o'→s' 的核心）。 */
  applyObservationEvent: (e: ObservationEvent) => void
  /** lazy 拉更早历史（jsonl 权威），prepend 到 messages 前。 */
  appendHistory: (
    sessionId: string,
    page: { messages: ChatMessage[]; total: number; count: number },
    prepend: boolean,
  ) => void
  /** 全局 1s 工作时长累计（pending.workingSec +1，gen_progress 没推时也跳）。 */
  tickWorking: () => void
  setConn: (sessionId: string, conn: SessionBelief['conn']) => void
  clearSession: (sessionId: string) => void
}

const emptyBelief = (sessionId: string, taskId: string): SessionBelief => ({
  sessionId,
  taskId,
  messages: [],
  historyTotal: 0,
  historyLoadedFrom: 0,
  agents: [],
  // 初始 false(2026-09-05):快照先到、REST history 未回的窗口期不该显示
  // "上滑加载更早…"——确认有更多历史(applyHistory)后才翻 true。
  historyHasMore: false,
  pending: null,
  conn: 'online',
  interactive: false,
})

export const useBeliefStore = create<BeliefState>((set) => ({
  beliefs: {},

  ensureSession: (sessionId, taskId) =>
    set((s) =>
      s.beliefs[sessionId]
        ? s
        : { beliefs: { ...s.beliefs, [sessionId]: emptyBelief(sessionId, taskId) } },
    ),

  applyObservationEvent: (e) =>
    set((s) => {
      const sid = e.sessionId ?? e.belief?.sessionMeta?.sessionId
      if (!sid) return s
      const b = s.beliefs[sid] ?? emptyBelief(sid, e.belief?.sessionMeta?.taskId ?? '')
      const upd = (nb: Partial<SessionBelief>) => ({
        beliefs: { ...s.beliefs, [sid]: { ...b, ...nb } },
      })
      switch (e.kind) {
        case 'snapshot': {
          // snapshot 是 ta 的 jsonl 快照。生成中用户消息还没 flush 进 jsonl，
          // 直接覆盖会冲掉本地的 echo（input_echo 加的）→ 消息"闪一下消失"。
          // 保留未匹配上 snapshot 的 echo（仍待落盘的乐观消息）。
          const snapMsgs = e.belief?.messages ?? []
          const norm = (t?: string) => (t ?? '').replace(/@[^\s@]+/g, '').trim()
          const preservedEchos = b.messages.filter(
            (x) =>
              (x.origin === 'echo' || x.origin === 'terminal-input') &&
              !snapMsgs.some((s) => s.role === x.role && norm(s.text) === norm(x.text) && (norm(x.text) !== '' || (s.attachments && s.attachments.length > 0))),
          )
          const merged = [...snapMsgs, ...preservedEchos]
          // 全局去重：相同 role+text 只留一条（jsonl 权威 > echo/terminal-input）
          const seen = new Set<string>()
          const deduped = merged.filter((m) => {
            const key = m.role + '|' + norm(m.text)
            if (norm(m.text) === '' && !(m.attachments?.length)) return true // 空消息不去重
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          return upd({
            messages: deduped,
            conn: (e.belief?.conn as SessionBelief['conn']) ?? b.conn,
            interactive: e.belief?.live?.interactive ?? false,
            picker: e.belief?.live?.picker ?? null,
            todos: e.belief?.live?.todos ?? null,
            agents: e.belief?.live?.agents ?? [],
            appState: e.belief?.live?.appState ?? null,
            fineState: e.belief?.live?.fineState ?? null,
            appType: e.belief?.live?.appType ?? null,
            approval: e.belief?.live?.approval ?? null,
            hintAction: e.belief?.live?.hintAction ?? null,
            tokensUsed: e.belief?.live?.tokensUsed ?? null,
            pending: e.belief?.live?.workingSinceMs
              ? { appState: 'working', workingSec: 0, startedAt: e.belief.live.workingSinceMs, generatingText: e.belief.live.generatingText, statusText: e.belief.live.statusText }
              : b.pending,
          })
        }
        case 'input_echo': {
          const msg: ChatMessage = { role: 'user', text: e.text ?? '', timestamp: new Date(e.atMs ?? Date.now()).toISOString(), origin: 'echo', author: e.author, attachments: e.attachments }
          // ta 广播顺序固定:Message(terminal-input) 先、InputEcho 后。若已有同文本的
          // echo/terminal-input user 消息(author/attachments 已带),不重复追加——
          // 否则同一句用户消息显示两遍(实时双份)。
          const norm = (t?: string) => (t ?? '').replace(/@[^\s@]+/g, '').trim()
          const dup = b.messages.some(
            (x) =>
              (x.origin === 'echo' || x.origin === 'terminal-input') &&
              x.role === 'user' &&
              norm(x.text) === norm(msg.text) &&
              norm(msg.text) !== '',
          )
          if (dup) return s
          return upd({ messages: [...b.messages, msg] })
        }
        case 'gen_start':
          return upd({ pending: { appState: 'working', workingSec: 0, startedAt: e.workingSinceMs ?? Date.now() } })
        case 'gen_progress': {
          const base = b.pending ?? { appState: 'working', workingSec: 0 }
          return upd({
            pending: {
              ...base,
              generatingText: e.generatingText ?? base.generatingText,
              statusText: e.statusText ?? base.statusText,
              workingSec: e.workingSec ?? base.workingSec,
            },
          })
        }
        case 'message': {
          const m = e.message
          if (!m) return s
          const norm = (t?: string) => (t ?? '').replace(/@[^\s@]+/g, '').trim()
          // 去重优先级：① 同 uuid（jsonl 权威消息重复到达，如 snapshot+message 双发）② echo/terminal-input 替换
          // 注意：send_input 推的 echo 消息 origin=terminal-input（不是 'echo'），也要匹配去重
          let idx = -1
          if (m.uuid) idx = b.messages.findIndex((x) => x.uuid && x.uuid === m.uuid)
          if (idx < 0) idx = b.messages.findIndex((x) => (x.origin === 'echo' || x.origin === 'terminal-input') && x.role === m.role && norm(x.text) === norm(m.text) && (norm(x.text) !== '' || (m.attachments && m.attachments.length > 0)))
          const messages = idx >= 0
            ? b.messages.map((x, i) => (i === idx ? m : x))
            : [...b.messages, m]
          // 不在 message 里清 pending——pending 纯由 gen_end（spinner 消失）管理，
          // 避免被 gen_progress 重建导致闪烁（2行→1行）
          return upd({ messages, historyTotal: Math.max(b.historyTotal, messages.length) })
        }
        case 'gen_end':
          return upd({ pending: null })
        case 'conn':
          return upd({ conn: e.conn ?? b.conn })
        case 'interactive':
          return upd({ interactive: e.interactive ?? false })
        case 'picker':
          return upd({ picker: e.picker ?? null })
        case 'todos':
          return upd({ todos: e.todos ?? null })
        case 'agents':
          return upd({ agents: e.agents ?? [] })
        case 'state':
          // 粗/细态 + appType + 审批摘要（变化才推；审批卡片/error 条/细态徽章的消费点）
          // 如果 fineState 翻到非 generating（idle/approval/picker 等），也清 pending（spinner 消失）
          // 防 gen_end 和 state 事件的 1 帧时序差：state 先到时 badge 已翻空闲但 spinner 还在
          {
            const fs = e.fineState ?? null
            const clearPending = fs && fs !== 'generating'
            return upd({
              appState: e.appState ?? b.appState ?? null,
              fineState: fs,
              appType: e.appType ?? b.appType ?? null,
              approval: e.approval ?? null,
              // 忙态:动作缺省不回退(动词瞬间缺失≠不忙,防闪烁);tokens 缺省沿用上一帧
              hintAction: e.hintAction ?? null,
              tokensUsed: e.tokensUsed ?? b.tokensUsed ?? null,
              ...(clearPending ? { pending: null } : {}),
            })
          }
        default:
          return s
      }
    }),

  appendHistory: (sessionId, page, prepend) =>
    set((s) => {
      const b = s.beliefs[sessionId]
      if (!b) return s
      // 去重：snapshot 与 history 先后覆盖同一窗口、重复进入会话重拉首批，都会拿到
      // 已有消息——jsonl 权威消息都有 uuid；无 uuid 的兜底 role+timestamp+正文匹配。
      // 双路同轮消息（实时推送 vs jsonl 落盘重拉）uuid 不同（myco-xxx vs claude 原生）、
      // timestamp 精度不同（纳秒 vs 毫秒），只能靠「role+正文+60s 时间窗」合并：
      // 已有消息优先（保留带 author 的实时版）。跨分钟的同文本重复是用户真重发，不去重。
      const norm = (t?: string) => (t ?? '').replace(/@[^\s@]+/g, '').trim()
      const uuids = new Set(b.messages.map((x) => x.uuid).filter(Boolean))
      const fresh = page.messages.filter((m) => {
        if (m.uuid) {
          if (uuids.has(m.uuid)) return false
          // 时间窗双路合并：正文非空、role+norm 相同、时间差 ≤60s → 同一事件（如 jsonl 落盘重拉）
          if (norm(m.text) === '') return true
          const t = Date.parse(m.timestamp ?? '')
          if (!t) return true
          return !b.messages.some((x) => {
            if (x.role !== m.role || norm(x.text) !== norm(m.text)) return false
            const xt = Date.parse(x.timestamp ?? '')
            if (!xt) return false
            return Math.abs(t - xt) <= 60_000
          })
        }
        return !b.messages.some((x) => !x.uuid && x.role === m.role && (x.timestamp ?? '') === (m.timestamp ?? '') && norm(x.text) === norm(m.text))
      })
      // prepend（上滑加载更早）：fresh 整段比已有的旧，直接接头部。
      // append（首批/完整页补齐）：不能无脑接尾——急拉 12 条（最新段）先灌后，完整页
      // 去重剩下的更早消息无脑 append 会得到 [最新段, 更早段]（渲染后上半区完全倒序，
      // 2026-09-05 用户实测"气泡顺序错乱"）。按 timestamp 有序插入归位；无 timestamp
      // 的（echo 兜底）保持尾部追加（实时语义）。
      let messages: ChatMessage[]
      if (prepend) {
        messages = [...fresh, ...b.messages]
      } else if (fresh.length === 0) {
        messages = b.messages
      } else {
        const ts = (m: ChatMessage) => {
          const t = Date.parse(m.timestamp ?? '')
          return Number.isFinite(t) ? t : null
        }
        // 从尾部往前插：fresh 自身时间正序，绝大多数场景（实时增量）本来就比已有都新，
        // 从尾扫描首条插入点即 O(1) 快路径。
        messages = [...b.messages]
        for (let k = fresh.length - 1; k >= 0; k--) {
          const m = fresh[k]
          const mt = ts(m)
          let at = messages.length
          if (mt !== null) {
            while (at > 0) {
              const ht = ts(messages[at - 1])
              if (ht !== null && ht > mt) at--
              else break
            }
          }
          messages.splice(at, 0, m)
        }
      }
      // 分页偏移 = 实际持有的 jsonl 尾窗长度（uuid 计数，echo 不算）——不能按"本次新纳入"累加：
      // snapshot 先到时首批历史全去重、偏移仍是 0 → loadOlder(from=0) 无限重拉同一页（顶部一直闪）。
      const covered = messages.filter((x) => x.uuid).length
      return {
        beliefs: {
          ...s.beliefs,
          [sessionId]: {
            ...b,
            messages,
            historyTotal: page.total,
            historyLoadedFrom: covered,
            historyHasMore: covered < page.total,
          },
        },
      }
    }),

  tickWorking: () =>
    set((s) => {
      let changed = false
      const beliefs: typeof s.beliefs = {}
      for (const [id, b] of Object.entries(s.beliefs)) {
        if (b.pending?.appState === 'working') {
          beliefs[id] = { ...b, pending: { ...b.pending, workingSec: b.pending.workingSec + 1 } }
          changed = true
        } else {
          beliefs[id] = b
        }
      }
      return changed ? { beliefs } : s
    }),

  setConn: (sessionId, conn) =>
    set((s) => {
      const b = s.beliefs[sessionId]
      if (!b) return s
      return { beliefs: { ...s.beliefs, [sessionId]: { ...b, conn } } }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const beliefs = { ...s.beliefs }
      delete beliefs[sessionId]
      return { beliefs }
    }),
}))

/** canvas 别名（PC 端历史命名，指向同一 store）。 */
export const useChatBeliefStore = useBeliefStore
