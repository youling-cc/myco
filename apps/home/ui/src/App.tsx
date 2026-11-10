/** myco home — 根窗口(Root Window):时间视角的驾驶舱。
 * 身份区(Youling/DID,v1 经 canvas)+今日/待办+新建任务+红黄绿灯墙+舰队调度。 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { TitleBar, IconFleet, IconSearch, IconSettings, IconExplore, IconArrow, IconMoon, IconSun } from '@myco/ui-kit'
// 2026-10-06 凭据徽章图标（NAMING-RATIONALE 定稿：主设备=KeyRound / 成员=User）
import { KeyRound, User } from 'lucide-react'
import './demo.css'
// Youling 身份/设备管理面板:单一源码直引 canvas(完整迁移,别重复造轮子)
import { IdentityPanel } from '@wsui/components/IdentityPanel'
import { bootIdentitySync, useIdentityStore } from '@wsui/stores/identityStore'
import { LEGACY_FORMAT_TITLE, LEGACY_FORMAT_BODY, LEGACY_FORMAT_ACTION, LEGACY_FORMAT_ACTION_BACKUP } from './lib/legacyAccount'
import { YoulingAuth } from './YoulingAuth'
import { QrImage } from '@wsui/components/Qr'
// 第81轮：好友+聊天+任务卡分享（智能体 Tab 好友区 / 任务 Tab peer 任务卡）
import { FriendsZone, PeerTasksCard, type ChatState, type PeerTask } from './FriendsZone'
import { shortDid } from './ChatBubble'
// 批三：聊天系统通知 + 会话偏好（免打扰过滤）
import { bindNotifAction, ensureNotifPermission, notifEnabled, sendChatNotif, setNotifEnabled } from './notify'
import { loadConvPrefs } from './chatOps'
// 第88轮：我的能力值视图（youling 简历渲染器——Beta(α,β) 技能画像）
import { MyResume, parseResume, ROLE_LABEL, type YoulingAbility } from './MyResume'
// 2026-09-29 DID 前缀语义收敛：账号出示归一 did:youling: + 前缀不敏感同判定
import { normalizeAccountDid, sameAccountDid } from './didUtil'
// 2026-09-30 昵称显示兜底链（共享源 env/ui）：空/哨兵→未命名，短标 昵称 ·…尾4，省略号统一 …
// 2026-10-01 批：accountTail=全页尾号唯一格式 …尾4；credText=本机凭据状态文案（不再用主设备/分身短词当徽章）
import { accountDisplayName, accountShortLabel, accountTail, credText, nicknameValue } from '@wsui/lib/accountDisplay'
// 2026-10-01 批A：恢复码导入内联表单（method 屏）——纯逻辑抽出可测
import { restoreFormInit, restoreFormReduce, submitRestoreImport } from './restoreImport'
// 2026-10-05 复制可靠性加固：复制 DID 前完整性校验（非法串禁止复制）+ 复制后回读比对
import { copyDidVerified, copyDidToastText } from './didCheck'
// 2026-10-13 P0：智能体 Tab 升为设备操作层（在线态三档 + 放行/授权/除名/复制DID）
import { AgentDevices } from './components/AgentDevices'
// 账号格式停用模态的「清除此账号」等内联调用（此前 client 未 import = 运行时 ReferenceError + tsc 基线 2 条）
import { client } from './api/client'
// 2026-10-01 账号页重排：切换账号真下拉（菜单纯逻辑 + clampMenuPos 防出窗，同 chatOps 右键菜单）
// 2026-10-03 批：+ 单行账号卡（acctCardLine/ACCT_LINE_SHRINK）与首登/切换反馈分叉
// （acctFeedbackRoute/switchToastText）——纯函数合同，测试钉在 acctLayout.test.ts
import { acctMenuItems, acctMenuHeight, ACCT_MENU_W, switchMenuVisible, acctCardLine, ACCT_LINE_SHRINK, SWITCH_ACCT_KEY, acctFeedbackRoute, switchToastText, avatarHue } from './acctLayout'
import { clampMenuPos } from './chatOps'

interface TodoItem { id: string; text: string; status: string; projectId?: string | null; projectName?: string | null; priority: number; due?: string | null }
// 任务看板行(env /api/tasks_board;与手机 TaskList 同构)
interface BoardGoalRow { key: string; layer?: string | null; type: string; period: string; target: number; cur: number | null; ratioPct: number; light: string }
interface BoardTaskRow { taskKey: string; title: string; closed: boolean; live: boolean; goal?: BoardGoalRow | null }
interface BoardProjectRow { id: string; name: string; path: string; light: string; lightNote: string; done: number; total: number; taskCount: number; tasks: BoardTaskRow[] }
interface BoardRow { name: string; light?: string; lightNote?: string; done: number; total: number }
interface Health { [k: string]: boolean }
// B4a 身份/设置
interface YoulingState { rootDid: string | null; deviceDid: string | null; role: string; name?: string }
interface Device { did: string; name: string; online: boolean; revoked: boolean; isEmbodiment: boolean; lastSeen?: number | null; kind?: string | null; pubkeyB64?: string }
interface Provider { id: string; name: string; baseUrl: string; authToken?: string; model?: string | null }
const HARNESS_LABEL: Record<string, string> = { claude: 'Claude Code', kimi: 'Kimi Code', codex: 'Codex', aop: 'AOP' }

const CANVAS_API = 'http://127.0.0.1:3102'
const TA_BASE = 'http://127.0.0.1:8100'
const EMBED = new URLSearchParams(location.search).get('embed') === '1'

/** 平台前端基址（自动登录页/任务卡链接/任务入口）。构建期 `VITE_PLATFORM_URL` 覆盖
 *  （换环境改构建 env 不改代码），缺省=HBL 平台真身 www.youling.cc。
 *  2026-10-08 设计定稿：平台页入口从 myco 域改指 www（"探索有灵去打开 www"）——
 *  myco.youling.cc 是登录器服务域（身份服务/下载面），平台页在 www。 */
const PLATFORM_BASE: string = (((import.meta.env.VITE_PLATFORM_URL as string | undefined) || 'https://www.youling.cc').replace(/\/+$/, ''))

/** 登录器服务域基址（更新包下载等）——2026-10-08 与平台页基址分离：
 *  下载面 /downloads/ 归 myco 域，平台页归 www，此前两者混用一个常量。 */
const MYCO_BASE: string = (((import.meta.env.VITE_MYCO_URL as string | undefined) || 'https://myco.youling.cc').replace(/\/+$/, ''))

/** fetch-based SSE 订阅(与 aop sseFetch 同方案:EventSource 增量不达,2026-09-03
 *  实测 fetch 流收全事件)。onData 收每条 data: 载荷;断流 2s 重连。 */
function sseFetch(url: string, onData: (data: string) => void, stopped: () => boolean): () => void {
  const ctrl = new AbortController()
  void (async () => {
    while (!stopped()) {
      try {
        const resp = await fetch(url, { signal: ctrl.signal })
        if (!resp.ok || !resp.body) throw new Error('SSE ' + resp.status)
        const rd = resp.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await rd.read()
          if (done) break
          buf += dec.decode(value)
          let i: number
          while ((i = buf.indexOf(String.fromCharCode(10, 10))) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            for (const line of block.split(String.fromCharCode(10))) {
              if (line.startsWith('data: ')) onData(line.slice(6))
            }
          }
        }
      } catch { /* 断流重连 */ }
      if (stopped()) break
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()
  return () => ctrl.abort()
}

const LIGHT_CLS: Record<string, string> = { red: 'lt-red', yellow: 'lt-yellow', green: 'lt-green', gray: 'lt-gray', blue: 'lt-blue' }
/** 灯语义 tooltip(v2 定稿;黑灯=静默项目,蓝灯=探索) */
const LIGHT_TIP: Record<string, string> = {
  red: '红:有超期承诺或失败未处理——展开看待办',
  yellow: '黄:临近 deadline(<24h)或 R 评审未达标',
  green: '绿:全部承诺按时、评审达标',
  gray: '灰/黑:静默项目(无承诺无活动,纯观察)',
  blue: '蓝:探索中(轻目标未收束)',
}
const PORT_OF: Record<string, number> = { 'ui-chat': 17894, 'ui-media': 17898 }
// v3 三窗(2026-08-27 设计定稿):学习回顾/任务画布并入工作区(「放」/「图」视图)。
// 编队=home+canvas(无窗)+工作区+远程,链序 工作区→远程。monitor/graph exe 保留
// (dev standalone),但不再入编队/微导航。
const CORE_MEMBERS: { key: string; label: string; exe: string; layer: string }[] = [
  { key: 'ui-chat', label: '工作区', exe: 'aop.exe', layer: 'PA' },
  { key: 'ui-media', label: '远程桌面', exe: 'youling.exe', layer: 'PA' },
]
const MEMBERS = [...CORE_MEMBERS]

/** 舰队微导航(2026-08-23 图标版,K3 定稿方案;v3 收缩为双成员):窗口钮=描边
 * 线性 SVG,「全」=实心宫格(风格差异=操作/对象分层);三态=右下状态点
 * (实心=在线/空心环=最小化/压暗 0.35=离线——12px 下虚线必糊,opacity 是唯一
 * 可靠手段)。分组:v3 双成员 | 分隔 | 全钮(accent)。 */
const FLEET_ICONS: Record<string, React.ReactNode> = {
  // 工作区:纯 >_ 提示符(无外框——与远程的显示器框在 12px 下彻底拉开;
  // k3 三轮:stroke 3.0(物理 1.5px)防下划线在深底糊没)
  'ui-chat': (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
      <path d="M4 6l6 6-6 6" />
      <path d="M13 18h7" />
    </svg>
  ),
  // 远程:显示器+屏内斜箭头(画面来自别处)
  'ui-media': (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M12 16.5V20" />
      <path d="M8.5 20h7" />
      <path d="M10 13.5L14.5 9" />
      <path d="M10.8 9H14.5V12.7" />
    </svg>
  ),
}

/** 全钮宫格:全部就位可用=实心(满=展开)/全在线=空心(空=收起),形变即语义 */
function FleetGridIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" style={{ flexShrink: 0 }} aria-hidden
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 2}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  )
}

/** 窗口钮:图标+右下状态点(在线=实心绿+背景描边 / 最小化=空心环 / 离线=无点
 * +图标压暗 0.5——k3 二轮:绿点与全钮蓝色解耦,与灯情绿=健康同语义) */
function FleetBtn({ m, on, min, onClick }: { m: { key: string; label: string }; on: boolean; min: boolean; onClick: () => void }) {
  return (
    <button className="fleetbtn" onClick={onClick} aria-label={m.label}
      title={`${m.label} · ${!on ? '离线——点击拉起' : min ? '已最小化——点击恢复' : '在线——点击收起'}`}
      style={{
        position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 18, padding: 0, borderRadius: 4,
        border: '1px solid var(--bd, #2d333b)', background: 'transparent',
        color: 'var(--tx, #e6edf3)', opacity: on ? 1 : 0.5,
        cursor: 'pointer',
      }}>
      {FLEET_ICONS[m.key]}
      {on && !min && (
        <span style={{ position: 'absolute', right: 1.5, bottom: 0.5, width: 4, height: 4, borderRadius: '50%', background: 'var(--ok, #3fb950)', boxShadow: '0 0 0 1px var(--bg, #0d1117)' }} />
      )}
      {on && min && (
        <span style={{ position: 'absolute', right: 1.5, bottom: 0.5, width: 4, height: 4, borderRadius: '50%', border: '1.2px solid var(--ok, #3fb950)', boxSizing: 'border-box', boxShadow: '0 0 0 1px var(--bg, #0d1117)' }} />
      )}
    </button>
  )
}

/** 滚动渐隐提示:内容溢出且未到底时,底部渐变+▾ 小箭头示意下方还有(2026-09-05 用户反馈)。 */
function ScrollFade({ children, maxH = 240 }: { children: React.ReactNode; maxH?: number }) {
  const [more, setMore] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const check = () => {
    const el = ref.current
    if (!el) return
    setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 8)
    setUp(el.scrollTop > 8)
  }
  useEffect(() => { check() })
  return (
    <div style={{ position: 'relative' }}>
      {up && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, pointerEvents: 'none', display: 'flex', justifyContent: 'center', paddingTop: 1, paddingBottom: 12, background: 'linear-gradient(var(--chrome-bg), transparent)', zIndex: 2 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>▲</span>
        </div>
      )}
      <div ref={ref} onScroll={check} style={{ maxHeight: maxH, overflowY: 'auto', paddingBottom: 6 }}>{children}</div>
      {more && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'none', display: 'flex', justifyContent: 'center', paddingBottom: 1, paddingTop: 16, background: 'linear-gradient(transparent, var(--chrome-bg))' }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>▼</span>
        </div>
      )}
    </div>
  )
}

function FleetStrip({ health, refresh, open }: { health: Record<string, boolean>; refresh: () => void; open: (m: { key: string; exe: string }) => void }) {
  const [minimized, setMinimized] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    const poll = () => {
      void Promise.all(MEMBERS.map(async (m) => {
        const port = PORT_OF[m.key]
        if (!port || !health[m.key]) return [m.key, false] as const
        try {
          const r = await fetch(`http://127.0.0.1:${port}/myco/agent`, { signal: AbortSignal.timeout(1500) })
          const j = await r.json()
          return [m.key, !!j?.minimized] as const
        } catch { return [m.key, false] as const }
      })).then((rows) => {
        if (!alive) return
        const next: Record<string, boolean> = {}
        for (const [k, v] of rows) next[k] = v
        setMinimized(next)
      }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [health])
  const click = (m: { key: string; exe: string }) => {
    const port = PORT_OF[m.key]
    if (!port) return
    if (!health[m.key]) {
      open(m)
    } else {
      // 2026-08-26 根修:在线窗点击→tier=off(完全不占位;stow 曾留 188s 磁贴列空隙)
      // off=零空间,companion=正常占位;window_state minimize 只是物理最小化
      const restore = minimized[m.key]
      void fetch(`${CANVAS_API}/api/formation/tier`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, tier: restore ? 'companion' : 'off' }),
      }).catch(() => {})
      if (restore) {
        // stow→companion 后恢复窗口+前台
        void fetch(`http://127.0.0.1:${port}/myco/window_state`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'restore', focus: true }),
        }).catch(() => {})
      } else {
        // companion→stow 后最小化窗口
        void fetch(`http://127.0.0.1:${port}/myco/window_state`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'minimize' }),
        }).catch(() => {})
      }
      setTimeout(refresh, 800)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 3, padding: '3px 8px', borderBottom: '1px solid var(--bd, #2d333b)', userSelect: 'none' }}>
      {CORE_MEMBERS.map((m) => (
        <FleetBtn key={m.key} m={m} on={health[m.key]} min={minimized[m.key]} onClick={() => click(m)} />
      ))}
      <span style={{ flex: 1 }} />
      <button onClick={() => {
        // 全钮管全部成员(v3 双成员)
        const anyOff = CORE_MEMBERS.some((m) => !health[m.key])
        if (anyOff) { for (const m of CORE_MEMBERS) if (!health[m.key]) open(m) }
        else {
          // 全在线→全收(整队最小化,与其他钮同语义可来回切);收完重排不占位
          void fetch(`${CANVAS_API}/api/formation/team_minimize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 17995 }),
          }).catch(() => {}).finally(() => setTimeout(refresh, 1200))
        }
      }}
        title={CORE_MEMBERS.some((m) => !health[m.key]) ? '全部就位(拉起离线的常驻成员)' : '整队收起(全最小化,可再点恢复)'} style={{
          flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 18, padding: 0, borderRadius: 4, border: '1px solid var(--bd, #2d333b)',
          background: 'transparent', color: 'var(--ac, #6b7bff)', cursor: 'pointer',
        }}>
        <FleetGridIcon filled={CORE_MEMBERS.some((m) => !health[m.key])} />
      </button>
    </div>
  )
}

/** 周用量目标默认值(2026-08-30):R 已下沉为任务行目标(due 编码 R:usage-week:<N>,
 * 建任务时写入;此常量仅为缺省回退)。
 * 灯=配速灯(达成/应达 比值,<0.6红/<0.8黄/≥0.8绿——与灯墙三档同语义);
 * byProject/byModel 是归因观测(O)不是分目标,防 Goodhart(挂机刷时长刷不出 token)。
 * 数据源:canvas /api/usage_get_summary → llm-proxy 账本(权威源,日×项目×模型 JSONL)。 */
const WEEKLY_TOKEN_GOAL = 500_000_000

/** 项目投入权重(2026-08-30 v1):精力/资源分配(如 myco 60%)。作用三件事:
 * ①灯墙按权重排序 ②行内简要呈现 ③把周北极星分解为项目配额(GOAL×w%)——
 * 配额是 R 的分解视图(归因观测),不是独立子目标,防多目标博弈。存 localStorage(单机 v1)。 */
const W_LS = 'myco-proj-weights'
type Weights = Record<string, number>
// 出厂默认(2026-08-30 用户定 myco=60;其余按近30天文件改动活跃度代填,合计100):
// docs=12(545 md 写作/战略) AR=10(~300 py+md) weekly-report=8(128 文件稳定投入)
// youling.cc=5(43 commits 官网) mushroom=3(7 commits 但数采战略实验) wuxing=1(11 commits)
// 活跃为零(writer/sim/hermes/meeting-aop/myco-inbox)不填——⚙面板随时改,存储后以此为准
const DEFAULT_WEIGHTS: Weights = {
  myco: 60, docs: 12, AR: 10, 'weekly-report': 8, 'youling.cc': 5, mushroom: 3, wuxing: 1,
}
const loadWeights = (): Weights => {
  let stored: Weights = {}
  try { stored = JSON.parse(localStorage.getItem(W_LS) || '{}') } catch { /* 忽略坏数据 */ }
  return { ...DEFAULT_WEIGHTS, ...stored }
}

function fmtTok(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return Math.round(n / 1e4) + '万'
  return String(n)
}

// ── 第91轮：youling 能力值卡/任务卡的共用展示工具 ──
/** 三态中文标签（mode_matrix 的 task_mode → 人话）。 */
const MODE_LABEL: Record<string, string> = { production: '正式', practice: '练习', exam: '考核' }
/** 0-1 小数 → 百分数文本（服务端可能给 0.72 或 72，≤1 一律视为比例；阈值/CI 同规则）。 */
const fmtPct = (v: number): string => `${Math.round(v <= 1.0001 ? v * 100 : v)}%`
const pctClamped = (v: number): number => Math.min(100, Math.max(0, v <= 1.0001 ? v * 100 : v))

interface UsageSummary {
  today?: { total?: number }
  daily?: { date: string; total: number }[]
}

function mondayStart(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (d.getDay() + 6) % 7 // 周一=0
  d.setDate(d.getDate() - dow)
  return d
}

/** 待办子行:due 灯(超期红/<24h 黄/未来绿/无 due 灰,SMART-T 与灯墙同语义)+勾选完成+文字召唤 todo 窗 */function TodoRow({ t, onToggle, onOpen, onOpenWs, weekUsage, weekBy }: { t: TodoItem; onToggle: (t: TodoItem) => void; onOpen?: () => void; onOpenWs?: (project: string, task?: string) => void; weekUsage: { weekTokens: number; today: number } | null; weekBy: Record<string, number> | null }) {
  // ── R 目标行 v2(2026-08-30):due 结构化编码,统一度量,万物皆可评 ──
  // 语法: R[@<PCDATR层>]:<metric>[:<type>]:<target>[:<period>]
  //   layer  ∈ P|C|D|A|T|R(可选,分形标注:此R属于哪类能力代理)
  //   type   ∈ bool|count|ratio(默认 count;bool=0/1 也是量,"是否完成"即评测)
  //   period ∈ daily|weekly|once(count 默认 weekly,bool 默认 once)
  // 采集器 v1:usage-week-all=全局周用量;usage-week=本项目归因周用量;其余=未接(灰)
  // 求真演化:R 亦被智能体代理,评价函数随认知升维,此语法即其载体。
  // 语法 v3:R[@层]:metric[:type]:target[:period][|Key] —— |Key=自定义指标短名(行内只显示 Key+数值)
  const rm = t.due ? /^R(?:@([PCDATR]))?:([a-z0-9-]+)(?::(bool|count|ratio))?(?::([\d.]+))?(?::(daily|weekly|once))?(?:\|(.+))?$/.exec(t.due.trim()) : null
  if (rm) {
    const layer = rm[1] ?? ''
    const metric = rm[2]
    const type = rm[3] ?? 'count'
    const target = Number(rm[4] ?? (type === 'bool' ? 1 : 0)) || (type === 'bool' ? 1 : 0)
    const period = rm[5] ?? (type === 'bool' ? 'once' : 'weekly')
    const metricLabel2: Record<string, string> = { 'usage-week-all': '周用量', 'usage-week': '用量·本项' }
    const key = (rm[6] ?? metricLabel2[metric] ?? metric).trim()
    // 当前值解析(采集器注册表 v1)
    let cur: number | null = null
    if (metric === 'usage-week-all') cur = weekUsage?.weekTokens ?? null
    else if (metric === 'usage-week') cur = weekBy?.[t.projectName ?? ''] ?? null
    if (type === 'bool') cur = t.status === 'done' ? 1 : 0
    // 应达(pace):weekly=周流逝占比;daily=今日流逝;once=无配速(达成即绿)
    const now = new Date()
    let expected: number | null = null
    if (period === 'weekly') {
      const frac = Math.max(0.5 / 7, Math.min(1, (Date.now() - mondayStart().getTime()) / (7 * 86400e3)))
      expected = target * frac
    } else if (period === 'daily') {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const frac = Math.max(0.02, Math.min(1, (Date.now() - dayStart) / 86400e3))
      expected = target * frac
    }
    const ratio = cur != null && expected != null && expected > 0 ? cur / expected
      : cur != null && expected == null ? (cur >= target ? 1 : 0) : -1
    const light = ratio < 0 ? 'lt-gray' : ratio < 0.6 ? 'lt-red' : ratio < 0.8 ? 'lt-yellow' : 'lt-green'
    const fmtV = (n: number) => type === 'bool' ? (n >= 1 ? '达成' : '未达') : type === 'ratio' ? `${(n * 100).toFixed(0)}%` : fmtTok(n)
    const periodLabel = period === 'weekly' ? '周' : period === 'daily' ? '今日' : ''
    const metricLabel: Record<string, string> = { 'usage-week-all': '周用量(全局)', 'usage-week': '周用量(本项归因)' }
    return (
      <div className="row" title={`R 目标${layer ? ` · ${layer} 层能力代理` : ''}: ${metricLabel[metric] ?? metric} | ${periodLabel || '一次性'}目标 ${type === 'ratio' ? (target * 100).toFixed(0) + '%' : type === 'bool' ? '达成' : fmtTok(target)}${cur != null ? ` | 当前 ${fmtV(cur)}` : ''}${expected != null ? ` | 应达 ${fmtV(expected)}` : ''} | 配速 ${ratio >= 0 ? (ratio * 100).toFixed(0) + '%' : '—'}(灯:<60%红/<80%黄/≥80%绿;采集=${metric === 'usage-week-all' || metric === 'usage-week' ? 'llm-proxy 账本' : type === 'bool' ? '完成勾选' : '未接采集器'})`}>
        <span className="chk" onClick={() => onToggle(t)} title={type === 'bool' ? '评测器:勾选=1' : '完成'} />
        <span className={`lt ${light}`} />
        {layer && <span className="chip" style={{ cursor: 'default', flexShrink: 0, fontSize: 10 }} title={`PCDATR ${layer} 层子任务的 R`}>{layer}</span>}
        {t.priority > 0 && <span className="muted small" style={{ flexShrink: 0 }} title={`任务权重 ${t.priority}(priority;项目行「共」即它的和)`}>w{t.priority}</span>}
        <span className="name" style={{ cursor: 'pointer', fontWeight: 600 }} onClick={() => (onOpenWs ?? onOpen)?.(t.projectName ?? '', t.text?.trim() || undefined)} title={`${t.text}
${'R 驱动:点击进工作区(干活/设计都在那),自动打开本项目'}`}>{key}</span>
        <span className="muted flex1" />
        <span className="small">{cur != null ? fmtV(cur) : '—'}</span>
        <span className="muted small">/{type === 'bool' ? '达成' : fmtTok(target)}</span>
        <span className={ratio >= 0 && ratio < 0.8 ? (ratio < 0.6 ? 'due red' : 'due yellow') : 'due'}>{ratio >= 0 ? `${(Math.max(0, cur != null && target > 0 ? cur / target : 0) * 100).toFixed(0)}%` : '—'}</span>
      </div>
    )
  }

  const dl = (() => {
    if (!t.due) return { lt: 'lt-gray', label: '' }
    const raw = t.due.trim()
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59`) : new Date(raw)
    if (isNaN(d.getTime())) return { lt: 'lt-gray', label: raw }
    const ms = d.getTime() - Date.now()
    if (ms < 0) return { lt: 'lt-red', label: `超期${Math.max(1, Math.floor(-ms / 86400000))}天` }
    if (ms < 86400000) return { lt: 'lt-yellow', label: `剩${Math.ceil(ms / 3600000)}h` }
    return { lt: 'lt-green', label: `${d.getMonth() + 1}/${d.getDate()}` }
  })()
  return (
    <div className="row" title={t.text}>
      <span className="chk" onClick={() => onToggle(t)} title="勾选完成" />
      <span className={`lt ${dl.lt}`} />
      <span className="name flex1 truncate" style={{ cursor: 'pointer', fontWeight: 400 }} onClick={() => (onOpenWs ?? onOpen)?.(t.projectName ?? '', t.text?.trim() || undefined)} title={`${t.text}
点击进工作区(myco-todo 窗已退役,读写都在工作区)`}>{t.text}</span>
      {dl.label && <span className={`due${dl.lt === 'lt-red' ? ' red' : dl.lt === 'lt-yellow' ? ' yellow' : ''}`}>{dl.label}</span>}
    </div>
  )
}

export default function App() {
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [projectNames, setProjectNames] = useState<string[]>([])
  // 有灵账号·委任状(我的设备:7 天期,吊销=停喂;design/08-identity/MYCO-ACCOUNT-MODEL.md)
  const [delegations, setDelegations] = useState<{ delegation: { deviceName: string; exp: number }; revoked: boolean }[]>([])
  const revokeDelegation = (pubkeyB64: string) => {
    void import('@tauri-apps/api/core').then((m) => m.invoke('delegation_revoke', { devicePubkeyB64: pubkeyB64 })).then(() => loadDelegations())
  }
  const loadDelegations = () => {
    // 第63轮 env 合并：委任状改 invoke 直调（原 fetch :3102 已死）
    void import('@tauri-apps/api/core').then((m) => m.invoke('delegation_list')).then((j) => {
      setDelegations(((j as { data?: { delegation: { deviceName: string; devicePubkeyB64: string; exp: number }; revoked: boolean }[] } | null)?.data ?? []).map((r) => ({ delegation: { deviceName: r.delegation.deviceName, devicePubkeyB64: r.delegation.devicePubkeyB64, exp: r.delegation.exp }, revoked: r.revoked })))
    }).catch(() => {})
  }
  useEffect(() => {
    loadDelegations()
    // 30s 周期刷新 + 标签页切回时刷新(委任状可能由 env 侧操作变化)
    const t = setInterval(loadDelegations, 30_000)
    const onVis = () => { if (!document.hidden) loadDelegations() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  const [boards, setBoards] = useState<BoardRow[]>([])
  const [health, setHealth] = useState<Health>({})
  const [note, setNote] = useState<string | null>(null)

  // ── B4a:Youling 身份 + 设置(从 canvas 迁入;数据面全走 canvas HTTP) ──
  const [youling, setSoul] = useState<YoulingState | null>(null)
  const [accountName, setYoulingName] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [backedUp, setBackedUp] = useState(false)
  const [idOpen, setIdOpen] = useState(false)
  const [setOpen, setSetOpen] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [defProvider, setDefProvider] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [about, setAbout] = useState<string | null>(null)
  // P2: 搜索(实时筛选项目+待办,不弹窗)
  const [searchQuery, setSearchQuery] = useState('')
  // 仪表栏弹层(demo v3):lamp=灯墙全景 fleet=舰队 search=搜索下沉;more=简洁化收纳(第16轮)
  const [pop, setPop] = useState<'lamp' | 'fleet' | 'search' | null>(null)
  // 简洁化顶栏(第16轮拍板):灯墙缩影/舰队/搜索收进 ⋯ 弹层,默认视野=账号+⋯+设置
  const [moreOpen, setMoreOpen] = useState(false)
  const [accountView, setAccountView] = useState(false)
  // 批 B：账号抽屉 accountsOpen 已废——账号管理收编为页内③区块（一页滚动）
  // 智能体 tab「本机 / 我的设备」设备行的展开/复制态已收进 AgentDevices 组件（2026-10-13 P0：
  // 该 Tab 升为操作层——本文件不再持有 devDidOpen/devDidCopied）
  const [llmOpen, setLlmOpen] = useState(false)
  // 第47轮 设置：开机自启（注册表 Run 键）+ 贴边；第52轮：贴边改 home 自研平移式
  // （旧 formation API 参数名 enabled/on 不匹配且作用对象是 env 编队窗——双重无效）。
  const [autoStart, setAutoStart] = useState<boolean | null>(null)
  const [autoHideOn, setAutoHideOn] = useState(() => { try { return localStorage.getItem('myco-autohide') === '1' } catch { return false } })
  const [autohidePeeking, setAutohidePeeking] = useState(false)
  const loadAutoStart = () => { void import('@tauri-apps/api/core').then((m) => m.invoke<boolean>('autostart_get')).then((v) => setAutoStart(!!v)).catch(() => {}) }
  const toggleAutoStart = async () => {
    const next = !(autoStart ?? false)
    try { await (await import('@tauri-apps/api/core')).invoke('autostart_set', { enable: next }); setAutoStart(next) } catch { /* 容错 */ }
  }
  const toggleAutoHideSetting = async () => {
    const next = !autoHideOn
    setAutoHideOn(next)
    try { localStorage.setItem('myco-autohide', next ? '1' : '0') } catch { /* 容错 */ }
    try { await (await import('@tauri-apps/api/core')).invoke('autohide_set', { on: next }) } catch { /* 容错 */ }
  }
  // 批三：新消息通知全局开关（设置页持久化；开启时先确保系统权限，被拒则保持关）
  const [notifOn, setNotifOn] = useState(() => notifEnabled())
  const toggleNotif = async () => {
    const next = !notifOn
    if (next && !(await ensureNotifPermission())) { setNotifEnabled(false); setNotifOn(false); return }
    setNotifEnabled(next); setNotifOn(next)
  }
  // 2026-10-18 关闭→托盘（微信式常驻）：设置项 + 托盘「设置」菜单直达。
  // 值域 'tray'（默认，关闭=进托盘，进程常驻）/ 'quit'（关闭=退出应用，原行为）。
  // 「最小化」不是选项——要最小化点最小化按钮（2026-10-18 用户二次拍板）。
  const [closeBehavior, setCloseBehavior] = useState<'tray' | 'quit'>('tray')
  const setCloseBehaviorTo = async (b: 'tray' | 'quit') => {
    setCloseBehavior(b)
    try { await (await import('@tauri-apps/api/core')).invoke('close_behavior_set', { behavior: b }) } catch { /* 容错 */ }
  }
  // 托盘菜单「设置」→ 直达设置页（同顶栏 ⚙️）
  useEffect(() => {
    let off: (() => void) | undefined
    void import('@tauri-apps/api/event').then((m) => {
      const un = m.listen('tray-open-settings', () => { setAccountView(true); setPageView('settings') })
      off = () => { void un.then((f) => f()) }
    }).catch(() => {})
    return () => { off?.() }
  }, [])
  /** 条化态 hover 展开/收回：鼠标进入窗口(任意部位)=滑入全显；离开窗口=滑回磁条。 */
  const autohidePeek = async (expand: boolean) => {
    if (!autoHideOn || autohidePeeking === expand) return
    setAutohidePeeking(expand)
    try { await (await import('@tauri-apps/api/core')).invoke('autohide_peek', { expand }) } catch { /* 容错 */ }
  }
  useEffect(() => { if (accountView) loadAutoStart() }, [accountView])
  // 2026-10-18：进账号/设置视图时读关闭行为（托盘/退出）
  useEffect(() => {
    if (accountView) {
      void import('@tauri-apps/api/core').then((m) => m.invoke<string>('close_behavior_get'))
        .then((v) => setCloseBehavior(v === 'quit' ? 'quit' : 'tray')).catch(() => {})
    }
  }, [accountView])
  // 启动恢复贴边态（上次开着 → 直接条化）
  useEffect(() => {
    if (autoHideOn) { void import('@tauri-apps/api/core').then((m) => m.invoke('autohide_set', { on: true })).catch(() => {}) }
  }, [])
  // 条化态:鼠标离开窗口 → 滑回磁条（document mouseleave 覆盖全窗,比 DOM 容器事件稳）
  // 第91轮——hover 任意窗体部位唤出：原先只挂 TitleBar 的 onMouseEnter,但贴边后磁条
  // 纵向大部分是主内容区的边（不在 TitleBar 上）→ hover 无事件源。对称加 document
  // mouseenter（与 mouseleave 成对、语义准;WebView2 下同为 document 级事件,同样可靠）。
  // 第91轮用户实测：光标压屏幕极边缘时窗口边界像素 enter/leave 交替翻转 → peek 往复
  // 闪烁。300ms 收回防抖(hover-intent)消除——leave 只定时不立即收,期间 enter 到来即
  // clearTimeout 取消;展开(enter)不防抖,保响应。
  // 沿用本 effect 刻意无依赖数组模式:每次渲染重挂,捕获新鲜闭包(autoHideOn/peeking)。
  // timer 定义在 effect 闭包内,随每次重挂新建/清理,不会被渲染重置丢失。
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const onEnter = () => { clearTimeout(hideTimer); void autohidePeek(true) }
    const onLeave = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { void autohidePeek(false) }, 300) }
    document.addEventListener('mouseenter', onEnter)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      clearTimeout(hideTimer)
      document.removeEventListener('mouseenter', onEnter)
      document.removeEventListener('mouseleave', onLeave)
    }
  })
  // 第44轮 demo 三屏：exe 账号页 method(三方式)/show(出示码)/create(创建)——demo html 中原样有,补齐还原
  const [pageView, setPageView] = useState<'page' | 'method' | 'show' | 'create' | 'settings'>('page')
  // 2026-09-30 批A：恢复码导入内联表单（method 屏）——点卡就地展开，不再跳 page 屏死链
  const [restoreForm, dispatchRestore] = useReducer(restoreFormReduce, restoreFormInit)
  const [newAcctName, setNewAcctName] = useState('')
  // methodd 真选中态（批 B：替代写死的 on 推荐高亮）
  const [methodSel, setMethodSel] = useState<number | null>(null)
  const [showMyDid, setShowMyDid] = useState(false)
  const [didCopied, setDidCopied] = useState(false)
  const identityStore = useIdentityStore()
  // ── 账号格式停用：模态阻断（2026-10-09 与手机端对齐——设计定稿：不说"旧格式"，
  //    说"格式无效，不支持"；模态不可关闭，只有两个出口）──
  const [regOpen, setRegOpen] = useState(false)
  const [regName, setRegName] = useState('')
  const [regBusy, setRegBusy] = useState(false)
  const [regErr, setRegErr] = useState<string | null>(null)
  // 2026-10-13（用户实测"上下按钮点了没反应/停留"）：格式停用模态的两个出口
  // ——白色"去备份"按钮此前只 setAccountView，模态(z9999)还盖在账号页上＝原地踏步。
  // 本 state = 会话内放行开关：置真后模态收起，用户能真到账号页备份/处理。
  const [legacyModalOff, setLegacyModalOff] = useState(false)
  // 恢复码导入提交（批A）：成功→回 page 屏（importYouling 内部已走 loadYouling 刷新账号状态）；
  // 失败→错误行显示后端原文（备份格式不对/密码不对/无此账号）。
  // 2026-10-01 修：成功瞬间就地换身份（rootDid 立变/旧昵称即清）+ 立即重拉顶栏数据
  // ——双保险，不依赖 Rust 侧 account-changed 事件的时序。
  const doRestoreImport = async () => {
    dispatchRestore({ type: 'submit' })
    const r = await submitRestoreImport({ text: restoreForm.text, password: restoreForm.password }, identityStore.importYouling)
    if (r.ok) {
      dispatchRestore({ type: 'done' }); setPageView('page')
      setSoul((s) => (s ? { ...s, rootDid: r.rootDid, role: 'embodiment', name: '' } : { rootDid: r.rootDid, deviceDid: null, role: 'embodiment', name: '' }))
      setYoulingName('')
      void refreshIdentity()
      loadAccounts()
    } else dispatchRestore({ type: 'fail', error: r.error })
  }
  // demo done 屏（第41轮）：登录/切换成功后一次性展示（reload 传参走 sessionStorage）
  const [doneAcct, setDoneAcct] = useState<{ name: string; tail: string } | null>(() => {
    try { const m = sessionStorage.getItem('myco.doneAcct'); sessionStorage.removeItem('myco.doneAcct'); return m ? JSON.parse(m) as { name: string; tail: string } : null } catch { return null }
  })
  // 第27轮:首屏身份状态——false=首次刷新未返回(配合 accounts>0 显示「登录中…」)
  const [idReady, setIdReady] = useState(false)
  // 第47轮：主题五色（亮白/暗黑/粉/绿/蓝），demo.css 按 [data-theme] 映射
  type ThemeName = 'light' | 'dark' | 'pink' | 'green' | 'blue'
  const [theme, setTheme] = useState<ThemeName>(() => (localStorage.getItem('myco-theme') as ThemeName) || 'light')
  const setThemeTo = (next: ThemeName) => {
    setTheme(next)
    document.documentElement.dataset.theme = next
    localStorage.setItem('myco-theme', next)
  }

  // 强制直连（2026-10-10 用户要求；**2026-10-11 补 state+handler——d4005f4 只加了渲染没加逻辑**，
  //  merge 后 React 渲染到设置页那行即 ReferenceError → 白屏）。
  //  语义：开启后取票跳过信令中转路径、WebRTC 不做 TURN 兜底。
  //  ⚠️ 联动逻辑（transport/WebRTC 层读此标志跳过中转）待后续补——本修复只保证页面可开、状态可存。
  const [forceDirect, setForceDirect] = useState<boolean>(() => { try { return localStorage.getItem('myco-forceDirect') === '1' } catch { return false } })
  const toggleForceDirect = () => {
    const next = !forceDirect
    setForceDirect(next)
    try { localStorage.setItem('myco-forceDirect', next ? '1' : '0') } catch { /* 忽略 */ }
  }
  // 双 tab(2026-09-05 ADR-002 定稿:任务/智能体,与手机同构)
  const [mainTab, setMainTab] = useState<'tasks' | 'agents'>('tasks')
  // ── 第81轮：好友聊天域（peer 任务卡列表跨 Tab 共享：任务 Tab 徽章行 + 智能体 Tab 好友区）──
  const [peerTasks, setPeerTasks] = useState<PeerTask[]>([])
  const onPeerTasks = useCallback((t: PeerTask[]) => setPeerTasks((prev) => JSON.stringify(prev) === JSON.stringify(t) ? prev : t), [])
  const refreshPeerTasks = useCallback(() => {
    void (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<{ tasks?: PeerTask[] }> } })
      .__TAURI_INTERNALS__?.invoke('chat_poll')
      .then((s) => { if (s?.tasks) onPeerTasks(s.tasks) })
      .catch(() => {})
  }, [onPeerTasks])
  // 第81轮补：App 级后台轮询——好友消息/请求的收件不再依赖智能体 Tab 可见
  // （FriendsZone 挂在 agents Tab 内，此前停在任务 Tab 时信箱无人拉）。
  useEffect(() => {
    if (!youling?.rootDid) return
    const t = setInterval(refreshPeerTasks, 5000)
    return () => clearInterval(t)
  }, [youling?.rootDid, refreshPeerTasks])
  // ── 第83轮：任务卡事件 toast（App 级——任意 Tab 下"任务卡到达/完成"都有通知）──
  // diff 检测同 FriendsZone detectFriendEvents 模式：新 pending 卡 → 分享通知；
  // status→done → 完成通知（本地点完成或对方回执都会触发，温馨确认）。
  const [taskToasts, setTaskToasts] = useState<{ id: number; text: string }[]>([])
  const prevPeerTasksRef = useRef<PeerTask[] | null>(null)
  const pushTaskToast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setTaskToasts((ts) => [...ts, { id, text }])
    setTimeout(() => setTaskToasts((ts) => ts.filter((t) => t.id !== id)), 4600)
  }, [])
  useEffect(() => {
    const prev = prevPeerTasksRef.current
    prevPeerTasksRef.current = peerTasks
    if (!prev) return // 首帧快照不通知（防启动时存量任务刷屏）
    for (const t of peerTasks) {
      const p = prev.find((x) => x.taskId === t.taskId)
      if (!p && t.status === 'pending') pushTaskToast(`📋 ${shortDid(t.fromName || '') || '好友'} 给你分享了任务《${t.title}》`)
      if (p && p.status !== 'done' && t.status === 'done') pushTaskToast(`🎉 《${t.title}》已完成`)
    }
  }, [peerTasks, pushTaskToast])
  // 2026-10-03 切换账号轻反馈：handleRelogin 的切换路径写 myco.switchAcct 后 reload，
  // 这里消费一次性 toast（「已切换到 Fan」）——替代原 doneAcct 全屏页（首登才保留）。
  // 同 taskToast 样式/时长（4.6s 自动消失，不挡操作）。
  useEffect(() => {
    try {
      const m = sessionStorage.getItem(SWITCH_ACCT_KEY)
      sessionStorage.removeItem(SWITCH_ACCT_KEY)
      if (!m) return
      pushTaskToast(`✅ ${switchToastText(JSON.parse(m) as { name?: string; tail?: string })}`)
    } catch { /* 容错 */ }
  }, [pushTaskToast])
  // 待接受数（任务 Tab 底栏角标 + peer 任务区标题高亮）
  const peerPendingN = peerTasks.filter((t) => t.status === 'pending').length
  // ── 批三：聊天系统通知（IM 及格线：窗口外收消息可达）──
  // 语义（微信对齐）：窗口聚焦静默；免打扰会话跳过；全局开关（设置页）；
  // 标题=发送者昵称/群名，正文=预览（[图片]/[文件]/[任务卡]/文本截 60）；
  // 点击 → 聚焦主窗 + 切智能体 Tab + 跳该会话。diff 基线只在事件里推（自己发的
  // 消息/首轮快照不通知；多设备自发 from==rootDid 跳过）。
  // ── 分享页在场感知 → 点在线协作者圆圈 → 跳该好友对话 ──
  // 分享的 harness web 页面里注入的头像栏点某人时发 myco://chat?did=…，
  // 登录器把深链接派发成 `myco-open-chat` 事件（冷启动走 take_pending_chat_did）。
  // 复用通知点击那条通道：切智能体 Tab → myco:open-conv（FriendsZone 支持传好友 did，
  // 会话不存在时按好友档案开空会话）。
  useEffect(() => {
    let un: (() => void) | undefined
    const openChat = (did: string) => {
      if (!did) return
      setMainTab('agents')
      setTimeout(() => window.dispatchEvent(new CustomEvent('myco:open-conv', { detail: did })), 400)
    }
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ did?: string }>('myco-open-chat', (ev) => openChat(ev.payload?.did ?? '')).then((u) => { un = u }),
    )
    void (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<{ did?: string } | null> } })
      .__TAURI_INTERNALS__?.invoke('take_pending_chat_did')
      .then((r) => { if (r?.did) openChat(r.did) })
      .catch(() => {})
    return () => { un?.() }
  }, [])

  // ── §3.19 任务群组：任务卡右键「打开任务群」→ 切智能体 Tab 并打开该群会话 ──
  // 入口在任务 Tab（PeerTasksCard），群会话屏在智能体 Tab（FriendsZone）——复用上面
  // 通知点击那条导航通道（切 Tab + myco:open-conv）。这里只做导航，不碰任何后端命令：
  // groupId 由 PeerTasksCard 调 share_ensure_group（§3.19.3）拿到后随事件带过来；
  // 后端未就绪时 PeerTasksCard 已就地降级提示，本通道不会被触发。
  useEffect(() => {
    const onOpenTaskGroup = (e: Event) => {
      const id = (e as CustomEvent<{ groupId?: string }>).detail?.groupId
      if (!id) return
      setMainTab('agents')
      // FriendsZone 挂载后消费；若事件先到（st 未就绪）由 FriendsZone 侧模块级暂存兜住
      setTimeout(() => window.dispatchEvent(new CustomEvent('myco:open-conv', { detail: id })), 400)
    }
    window.addEventListener('myco:open-task-group', onOpenTaskGroup)
    return () => window.removeEventListener('myco:open-task-group', onOpenTaskGroup)
  }, [])

  const [unreadChatN, setUnreadChatN] = useState(0)
  const convSnapRef = useRef<Record<string, number> | null>(null)
  useEffect(() => {
    if (!youling?.rootDid) return
    void bindNotifAction((convId) => {
      setMainTab('agents')
      // FriendsZone 挂载+st 就绪后消费跳转事件（400ms 经验值，事件丢失无妨——用户看到列表红点了）
      setTimeout(() => window.dispatchEvent(new CustomEvent('myco:open-conv', { detail: convId })), 400)
    })
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ msgId?: string; kind?: string; from?: string }>('chat-incoming', (ev) => {
        void (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<ChatState> } })
          .__TAURI_INTERNALS__?.invoke('chat_poll')
          .then((s) => {
            if (!s) return
            if (s.tasks) onPeerTasks(s.tasks)
            const convs = s.convs ?? []
            const prev = convSnapRef.current
            const fromMe = !!ev.payload?.from && ev.payload.from === youling.rootDid
            if (prev && !fromMe) {
              const prefs = loadConvPrefs()
              for (const c of convs) {
                const was = prev[c.id]
                if (was !== undefined && c.lastTs > was && c.unread) void sendChatNotif(c, prefs)
              }
            }
            convSnapRef.current = Object.fromEntries(convs.map((c) => [c.id, c.lastTs]))
          })
          .catch(() => {})
      }),
    ).then((u) => { un = u }).catch(() => {})
    return () => { un?.() }
  }, [youling?.rootDid, onPeerTasks])
  // 批三：未读总数 → 窗口标题（任务栏/alt-tab 可见的角标替代；智能体 Tab 角标同数据）
  useEffect(() => {
    const t = unreadChatN > 0 ? `myco · ${unreadChatN > 99 ? '99+' : unreadChatN} 条新消息` : 'myco'
    document.title = t
    void import('@tauri-apps/api/window').then((w) => w.getCurrentWindow().setTitle(t)).catch(() => {})
  }, [unreadChatN])
  // ── 第88轮：youling 领取任务同步显示 + 我的能力值（观察面协议化：每次拉
  // ENV 感知面 API 渲染，myco 不存任务状态；30s 周期同 Rust 层缓存频率）──
  // 第91轮（2026-09-28 产品定稿）：只显示**已领取**的任务——响应是全题池投影视图
  // （47 条三态卡），客户端按 modes.{production|practice|exam} 的领取信号过滤；
  // 标题优先服务端 name，缺失回退 task_id（不再显示"未命名任务"）。
  type YoulingTask = { taskId: string; title: string; slaText: string; pending: number; answeredToday: number; mode: string; entry: string; threshold: number | null; role: string }
  const [youlingTasks, setYoulingTasks] = useState<YoulingTask[]>([])
  const [youlingTasksErr, setYoulingTasksErr] = useState(false)
  const [myResumeOpen, setMyResumeOpen] = useState(false)
  // 第91轮：能力值紧凑卡数据（resume.abilities；null=拉取失败藏卡，[]=尚无画像）
  const [myAbilities, setMyAbilities] = useState<YoulingAbility[] | null>(null)
  const [myGate, setMyGate] = useState<number | null>(null)
  const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  /** 任务门槛宽容解析（服务端路径未定稿：task_threshold/gateThreshold/profile_filter 下各门槛键 / modes 内门槛字段多键兜底）。 */
  const pickThreshold = (t: Record<string, unknown>, m: Record<string, unknown> | null): number | null => {
    const pf = (t.profile_filter ?? t.profileFilter) as Record<string, unknown> | undefined
    const pfObj = pf && typeof pf === 'object' ? pf : {}
    const cands: unknown[] = [
      t.task_threshold, t.gate_threshold, t.gateThreshold, t.threshold,
      pfObj.gateThreshold, pfObj.gate_threshold, pfObj.threshold, pfObj.gate, pfObj.min_ability, pfObj.min_mean,
      m?.task_threshold, m?.gate_threshold, m?.gateThreshold, m?.threshold,
    ]
    for (const c of cands) { const n = numOf(c); if (n != null) return n }
    return null
  }
  /** 防御性解析（API 字段未定稿，多键名适配；两层信封：Rust {ok,data} + 你灵 {code,data}）。 */
  const parseYoulingTasks = (res: unknown): YoulingTask[] => {
    const r = res as { ok?: boolean; data?: unknown } | null
    if (!r?.ok) return []
    const env = r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : {}
    const d = env.data && typeof env.data === 'object' ? env.data as Record<string, unknown> : env
    let arr: unknown[] = []
    if (Array.isArray(d)) arr = d
    else if (Array.isArray(d.tasks)) arr = d.tasks
    else if (Array.isArray(d.items)) arr = d.items
    return arr.flatMap((x): YoulingTask[] => {
      if (!x || typeof x !== 'object') return []
      const t = x as Record<string, unknown>
      const taskId = String(t.task_id ?? t.taskId ?? t.id ?? '')
      if (!taskId) return []
      // 第91轮：无 name/title 回退 task_id（题池条目本就有可读 id，别再"未命名任务"）
      const title = String(t.name ?? t.title ?? '') || taskId
      // 新形态：modes{practice/exam/production} 三态视图——只留已领取/已派单/已作答的态
      if (t.modes && typeof t.modes === 'object' && !Array.isArray(t.modes)) {
        const out: YoulingTask[] = []
        for (const [mode, mv] of Object.entries(t.modes as Record<string, unknown>)) {
          if (!mv || typeof mv !== 'object') continue
          const m = mv as Record<string, unknown>
          const claim = m.my_claim ?? m.myClaim
          const assigned = Number(m.my_assigned ?? m.myAssigned ?? 0) || 0
          const answered = Number(m.my_answered ?? m.myAnswered ?? 0) || 0
          // 已领取判定（第91轮产品定稿）：production=my_claim 登记或已派单；exam/practice
          // 无领取概念，用 my_answered>0 视为参与（practice 恒 0 不误纳，服务端 notes 明示）
          if (claim == null && assigned <= 0 && answered <= 0) continue
          const claimObj = (claim && typeof claim === 'object' ? claim : {}) as Record<string, unknown>
          out.push({
            taskId,
            title,
            slaText: String(t.sla_text ?? t.slaText ?? t.sla ?? m.sla_text ?? ''),
            pending: assigned,
            answeredToday: answered,
            mode,
            entry: String(t.entry ?? t.entry_url ?? t.url ?? ''),
            threshold: pickThreshold(t, m),
            role: String(t.role ?? t.worker_role ?? claimObj.role ?? ''),
          })
        }
        return out
      }
      // 旧扁平形态（字段未定稿期兼容；旧响应语义本就是"我的任务"全集）
      return [{
        taskId,
        title,
        slaText: String(t.sla_text ?? t.slaText ?? t.sla ?? ''),
        pending: Number(t.pending_count ?? t.pendingCount ?? t.pending ?? 0) || 0,
        answeredToday: Number(t.answered_today ?? t.answeredToday ?? 0) || 0,
        mode: String(t.task_mode ?? t.mode ?? ''),
        entry: String(t.entry ?? t.entry_url ?? t.url ?? ''),
        threshold: pickThreshold(t, null),
        role: String(t.role ?? t.worker_role ?? ''),
      }]
    })
  }
  const refreshYoulingTasks = useCallback(() => {
    void (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__?.invoke('youling_tasks_list')
      .then((res) => { setYoulingTasksErr(!((res as { ok?: boolean })?.ok)); setYoulingTasks(parseYoulingTasks(res)) })
      .catch(() => setYoulingTasksErr(true))
  }, [])
  useEffect(() => {
    if (!youling?.rootDid) return
    refreshYoulingTasks()
    const t = setInterval(refreshYoulingTasks, 30_000)
    return () => clearInterval(t)
  }, [youling?.rootDid, refreshYoulingTasks])
  // 第91轮：能力值卡数据——登录后拉一次 resume（复用 MyResume 的 parseResume 基建；
  // 能力画像慢变，不跟任务列表 30s 轮询打服务端，完整视图内自有刷新）
  useEffect(() => {
    if (!youling?.rootDid) { setMyAbilities(null); setMyGate(null); return }
    let alive = true
    const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__
    if (!invoke) return // embed/浏览器预览模式无 tauri ipc → 藏卡不报错
    invoke.invoke('youling_my_resume')
      .then((res) => {
        if (!alive) return
        const p = parseResume(res as Parameters<typeof parseResume>[0])
        setMyAbilities(p ? p.abilities : null) // null=拉取失败（藏卡）；[]=尚无画像（空态文案）
        setMyGate(p ? p.gateThreshold : null)
      })
      .catch(() => { if (alive) setMyAbilities(null) })
    return () => { alive = false }
  }, [youling?.rootDid])
  // 第91轮：能力值卡取值——主显 role 优先匹配领取任务对应 role（匹配不上显第一条+role 名）；
  // 目标门槛优先领取任务的门槛，无领取任务时兜底账号全局门槛（再无 → "—"）
  const claimedThreshold = youlingTasks.map((t) => t.threshold).find((v) => v != null) ?? myGate ?? null
  const claimedRole = youlingTasks.find((t) => t.role)?.role ?? ''
  const myAbility: YoulingAbility | null = myAbilities == null ? null
    : (claimedRole ? myAbilities.find((a) => a.role === claimedRole) : undefined) ?? myAbilities[0] ?? null
  // ── 投入权重(v1):配置+周用量归因(home tauri 只读 llm-proxy 账本)──
  const [weights, setWeights] = useState<Weights>(loadWeights)
  const [weekBy, setWeekBy] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void import('@tauri-apps/api/core').then((m) => m.invoke('usage_week_by_project'))
        .then((r) => { if (alive) setWeekBy(((r as { byProject?: Record<string, number> })?.byProject) ?? null) })
        .catch(() => { if (alive) setWeekBy(null) }) // embed/浏览器模式无 tauri ipc → 只隐藏归因,不报错
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const saveWeight = (name: string, v: number | null) => {
    setWeights((w) => {
      const next = { ...w }
      if (v == null || Number.isNaN(v) || v <= 0) delete next[name]
      else next[name] = Math.min(100, Math.round(v * 10) / 10)
      localStorage.setItem(W_LS, JSON.stringify(next))
      return next
    })
  }
  const weightOf = (n: string) => weights[n] ?? 0
  // ── 任务看板(2026-09-04 与手机同脸:项目→任务行+目标灯;env /api/tasks_board
  //    一份服务端口径:task-meta 权威×活会话×R 目标配速灯)──
  const [boardProjs, setBoardProjs] = useState<BoardProjectRow[]>([])
  const loadBoard = useCallback(() => {
    void fetch(`${CANVAS_API}/api/tasks_board`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((j: { data?: { projects?: BoardProjectRow[] } }) => { if (j?.data?.projects) setBoardProjs(j.data.projects) })
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadBoard()
    const t = setInterval(loadBoard, 30_000)
    return () => clearInterval(t)
  }, [loadBoard])
  // 实时刷新(2026-09-04 实测反馈"打开任务,myco 列表看不到变活"——30s 轮询太钝,
  // ENV 铁律事件主路):订阅 ta belief-events(fetch 流,EventSource 增量不达坑同
  // aop sseFetch 方案),task_title 事件(create/kill/set_title 都 emit)即刷;
  // 窗口 focus/回可见也刷(从 aop/别的窗回来扫一眼=观察意图)。30s 轮询只兜底。
  useEffect(() => {
    let stopped = false
    const stop = sseFetch(`${TA_BASE}/api/belief-events`, (data) => {
      try {
        const ev = JSON.parse(data) as { kind?: string }
        if (ev?.kind === 'task_title') setTimeout(() => { if (!stopped) loadBoard() }, 600)
      } catch { /* 非 JSON 载荷忽略 */ }
    }, () => stopped)
    const onFocus = () => loadBoard()
    const onVis = () => { if (document.visibilityState === 'visible') loadBoard() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      stop()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [loadBoard])
  const [allExpanded, setAllExpanded] = useState(false)
  const toggleAllGroups = () => {
    const next = !allExpanded
    setAllExpanded(next)
    const map: Record<string, boolean> = {}
    for (const g of groups) map[g.key] = next
    setClosedMap(map)
  }
  const newProject = async () => {
    // pick_folder 现场选/建目录
    const r = await post('/api/pick_folder').catch(() => null)
    const dir = (r as { data?: string } | null)?.data
    if (!dir) return
    const name = dir.split(/[\/]/).pop() || '新项目'
    await post('/api/upsert_project', { path: dir, name })
    void refresh()
  }
  // P1 账号登出/账号清单
  const [accounts, setAccounts] = useState<{ did: string; name: string; lastLogin?: string; loggedOut?: boolean }[]>([])
  const handleLogout = async () => {
    // 第65轮：env 合并后 :3102 已死——改 invoke（identity_service::myco_logout）
    try { await invokeT('myco_logout') } catch { /* 静默 */ }
    void refreshIdentity()
    void loadAccounts()
  }
  const loadAccounts = () => {
    // 第65轮：env 合并后 :3102 已死（清单恒空=抽屉不可用的根因）——改 invoke。
    void invokeT('myco_accounts').then((r) => {
      const list = (r as { accounts?: typeof accounts } | null)?.accounts ?? []
      setAccounts(list)
    }).catch(() => {})
  }
  useEffect(() => { loadAccounts() }, [])
  const [reloginMsg, setReloginMsg] = useState('')
  const [exploreHint, setExploreHint] = useState(false)
  useEffect(() => {
    if (!youling?.rootDid) return
    let seen = false
    try { seen = !!localStorage.getItem('myco.exploreHintSeen') } catch { /* 容错 */ }
    if (!seen) {
      try { localStorage.setItem('myco.exploreHintSeen', '1') } catch { /* 容错 */ }
      setExploreHint(true)
    }
  }, [youling?.rootDid])
  const handleRelogin = async (did: string) => {
    // 第33轮多账号：账号槽切换（active.txt 路由种子/委任状，本地直切秒登）；
    // 第65轮：env 合并后 :3102 已死——改 invoke（core 槽机制已随本轮移植）。
    const j = await invokeT('myco_switch_account', { did }).catch((e: unknown) => ({ error: String(e) })) as { ok?: boolean; error?: string }
    if (j?.ok) {
      setReloginMsg('')
      // 2026-10-03 首登/切换分叉（用户：切换不用"已登录"全屏页，顶栏换名即可）：
      // 首登=登录器此前无账号（欢迎屏账号列表/未登录态进来）→ doneAcct 庆祝+引导；
      // 切换=已登录态换账号 → 不写 doneAcct，改写 switchAcct 让 reload 后 toast
      // 轻反馈「已切换到 X」。reload 本身就把账号页关掉回主界面（accountView 是
      // 组件态），顶栏由 account-changed 事件 + refreshIdentity 即时换新名。
      const acct = accounts.find((a) => a.did === did)
      try {
        const route = acctFeedbackRoute(!!youling?.rootDid, acct?.name, did.slice(-4))
        if (route) sessionStorage.setItem(route.key, route.payload)
      } catch { /* 容错 */ }
      void refreshIdentity()
      window.location.reload()   // 全状态随账号切换（会话/名册/委任状重载）
      return
    }
    setReloginMsg(j?.error || '该账号凭据已不在本机——请走「登录已有」重新授权')
  }
  // ── 2026-10-01 账号页重排：顶部卡「切换账号 ▾」真下拉浮层（取代假 scrollIntoView+页底列表双入口）──
  // 两段式定位：打开时按估算高度 clamp 出首帧位置；useLayoutEffect 量真实尺寸二次 clamp 校正。
  const [acctMenu, setAcctMenu] = useState<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
  const [acctMenuAnchor, setAcctMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const acctMenuRef = useRef<HTMLDivElement>(null)
  const closeAcctMenu = useCallback(() => { setAcctMenu((m) => ({ ...m, open: false })); setAcctMenuAnchor(null) }, [])
  const openAcctMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    void loadAccounts() // 开菜单即刷新清单（role/新登录账号即时可见）
    const r = e.currentTarget.getBoundingClientRect()
    const est = clampMenuPos(r.left, r.bottom + 4, ACCT_MENU_W, acctMenuHeight(accounts.length), window.innerWidth, window.innerHeight, 4)
    setAcctMenuAnchor({ x: r.left, y: r.bottom + 4 })
    setAcctMenu({ open: true, ...est })
  }
  useEffect(() => {
    if (!acctMenu.open || !acctMenuAnchor || !acctMenuRef.current) return
    const r = acctMenuRef.current.getBoundingClientRect()
    const fixed = clampMenuPos(acctMenuAnchor.x, acctMenuAnchor.y, r.width, r.height, window.innerWidth, window.innerHeight, 4)
    setAcctMenu((m) => (m.open && (m.x !== fixed.x || m.y !== fixed.y)) ? { open: true, ...fixed } : m)
  }, [acctMenu.open, acctMenuAnchor])
  // Esc 关闭（键盘可达性；菜单是焦点陷阱外的浮层，全局监听即可）
  useEffect(() => {
    if (!acctMenu.open) return
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeAcctMenu() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [acctMenu.open, closeAcctMenu])
  // S2 探索模式(v2 设计定稿):点「探索」进入编辑态,项目行尾出 checkbox;
  // 勾选=该项目 deadline 写 "explore: 轻目标"(蓝灯);再点「探索」退出。
  const [exploreMode, setExploreMode] = useState(false)
  const [exploreGoal, setExploreGoal] = useState('')
  const [exploreBusy, setExploreBusy] = useState<string | null>(null)
  const toggleExploreProject = (g: { key: string; name: string; light?: string }) => {
    const isBlue = g.light === 'blue'
    if (isBlue) {
      // 已在探索→收束(清 deadline,回正常灯)
      setExploreBusy(g.key)
      void post('/api/update_task_status', { taskId: g.key, status: 'active', deadline: '' }).catch(() => {})
        .finally(() => { setExploreBusy(null); refresh() })
      return
    }
    // 进入探索:轻目标必填(强制一行,防半途而废——设计定稿默认)
    const goal = exploreGoal.trim() || `${g.name} 探索`
    setExploreBusy(g.key)
    void post('/api/update_task_status', { taskId: g.key, status: 'active', deadline: `explore: ${goal}` }).catch(() => {})
      .finally(() => { setExploreBusy(null); setExploreGoal(''); refresh() })
  }
  // 外观配置(缝宽/动画,经 canvas /api/ui/appearance 读写,写后 canvas 立即重排)
  const [gapVal, setGapVal] = useState('8')
  const [animate, setAnimate] = useState(true)
  const loadAppearance = () => {
    void post('/api/ui/appearance').then((j) => {
      const d = (j as { data?: { gap?: number; animate?: boolean } } | null)?.data
      if (d) { setGapVal(String(d.gap ?? 8)); setAnimate(d.animate !== false) }
    }).catch(() => {})
  }
  const saveAppearance = (gap: number, anim: boolean) => {
    void post('/api/ui/appearance', { gap, animate: anim })
    setAnimate(anim); setGapVal(String(gap))
  }
  const [hint, setHint] = useState<string | null>(null)
  // 窗队补齐(去中心化审计):provider 测试连接 + harness 未安装时的配置动作
  const testProvider = async (id: string) => {
    setTesting(id); setHint(null)
    try {
      const r = await post('/api/provider_test', { providerId: id }).catch(() => null)
      const d = (r as { data?: { success?: boolean; message?: string; model?: string } } | null)?.data
      setHint(`测试 ${id}: ${d?.success ? `通过(${d.model ?? ''})` : `失败——${d?.message ?? '无返回'}`}`)
    } finally { setTesting(null) }
  }
  const configureHarness = async (id: string) => {
    setHint(null)
    const pid = defProvider ?? providers[0]?.id
    if (!pid) { setHint('先在上方添加一个模型服务商,再配置 harness'); return }
    const r = await post('/api/harness_configure', { harnessId: id, providerId: pid }).catch(() => null)
    const j = r as { success?: boolean; data?: string; error?: string } | null
    setHint(j?.success ? `harness ${id}: ${j.data}` : `harness ${id} 配置失败——${j?.error ?? '无返回'}`)
  }
  const [harnesses, setHarnesses] = useState<Record<string, boolean>>({})
  // Harness Agent 原生界面配置(2026-08-29):default=默认隐藏,overrides=单 harness 覆盖
  const [harnessUi, setHarnessUi] = useState<{ default?: boolean; overrides?: Record<string, boolean> }>({})
  const [pForm, setPForm] = useState<Provider | null>(null)

  // 第65轮：直调 Tauri 底层 invoke（与 env-ui client.ts 同款——动态 import 在部分
  // WebView 运行时解析失败，__TAURI_INTERNALS__ 是 @tauri-apps/api 内部同走的通道）
  const invokeT = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<T> } })
      .__TAURI_INTERNALS__.invoke(cmd, args)

  const post = useMemo(() => async (path: string, body?: unknown) => {
    const r = await fetch(`${CANVAS_API}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
    return r.json()
  }, [])

  // 逐 exe 更新(2026-09-03 设计定稿):按文件大小比对,同版本同大小=跳过。
  // 启动 8s 后自动查(不阻塞首屏);有差异→顶栏提示+确认即更(全 exe 一次换完)。
  // 2026-09-22 v2:清单新增 sha256/size 透传给下载端做完整性校验。
  const [updPer, setUpdPer] = useState<{ localVersion: string; serverVersion: string; version: string; notes: string; zip?: string; sha256?: string; size?: number; hasUpdate: boolean } | null>(null)
  const [updNotesOpen, setUpdNotesOpen] = useState(false) // 更新说明展开态（点击 ▾ 展开/▴ 折叠）
  const [updBusy, setUpdBusy] = useState(false)
  const [updMsg, setUpdMsg] = useState('')
  // v2:分类后的人话错误(替代 JS alert;Rust 侧 kind→msg 已翻译,这里兜底解析)
  const [updErr, setUpdErr] = useState('')
  // v2:真进度(事件主通道+轮询兜底双发,同一 ProgressSnap 结构)
  const [updProg, setUpdProg] = useState<{ phase: string; pct: number; got: number; total: number; speedBps: number; attempt: number; detail: string } | null>(null)
  const fmtMB = useCallback((b: number) => (b > 0 ? (b / 1048576).toFixed(1) : '0'), [])
  const updProgressText = useCallback((p: { phase: string; pct: number; got: number; total: number; speedBps: number; attempt: number; detail: string } | null) => {
    if (!p) return ''
    if (p.phase === 'downloading') {
      const spd = p.speedBps > 0 ? ` · ${(p.speedBps / 1048576).toFixed(2)}MB/s` : ''
      return p.total > 0 ? `下载中 ${fmtMB(p.got)}/${fmtMB(p.total)}MB ${p.pct}%${spd}` : `下载中 ${fmtMB(p.got)}MB${spd}`
    }
    if (p.phase === 'waiting') return p.detail || '网络不稳，准备重试…'
    if (p.phase === 'verifying') return '下载完成，校验完整性…'
    if (p.phase === 'downloaded' || p.phase === 'extracting') return '校验通过，解压更新包…'
    if (p.phase === 'applying') return '替换文件并重启（约 20 秒）…'
    return p.detail || ''
  }, [fmtMB])
  // v2 主通道:Tauri 事件 update-progress(Rust 流式下载节流回调)
  useEffect(() => {
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ phase: string; pct: number; got: number; total: number; speedBps: number; attempt: number; detail: string }>('update-progress', (ev) => {
        setUpdProg(ev.payload)
        setUpdMsg(updProgressText(ev.payload))
      }),
    ).then((u) => { un = u }).catch(() => {})
    return () => { un?.() }
  }, [updProgressText])
  // v2 兜底通道:progress.json 轮询(事件丢失时保险,如 webview 事件桥异常)
  useEffect(() => {
    if (!updBusy) return
    const t = setInterval(async () => {
      try {
        const p = await invokeT<{ phase?: string; pct?: number; detail?: string }>('update_progress')
        if (p?.phase === 'failed' && !updErr) setUpdErr('更新失败，请稍后再试或截图反馈')
      } catch { /* 轮询失败静默 */ }
    }, 1500)
    return () => clearInterval(t)
  }, [updBusy, updErr])
  // v2:统一更新入口——sha256/size 透传;错误 JSON 解析成人话(弃 alert)
  const startUpdate = useCallback(() => {
    if (!updPer || updBusy) return
    setUpdBusy(true); setUpdErr(''); setUpdMsg(''); setUpdProg(null)
    // invokeT 直调底层(第65轮:动态 import 在部分 WebView 运行时解析失败)
    invokeT<string>('run_prod_update', {
      zipUrl: updPer.zip || `${MYCO_BASE}/downloads/youling-myco-windows-update-${updPer.version}.zip`,
      sha256: updPer.sha256 || null,
      size: updPer.size || null,
    }).catch((e) => {
      setUpdBusy(false)
      try {
        const j = JSON.parse(String(e)) as { msg?: string; detail?: string; kind?: string }
        setUpdErr(j.msg || '更新失败，请稍后再试')
        if (j.detail) console.warn('[update]', j.kind, j.detail)
      } catch { setUpdErr(String(e).slice(0, 120)) }
    })
  }, [updPer, updBusy])
  // 第27轮:启动 2s 快查 + 每 10 分钟自动重查(服务器随时发新版,只查一次=程序不退出
  // 永远看不到,用户实测);手动「检查更新」绑同一函数随时可点。
  // 第47轮修「检查中」卡死：失败入 updFailed（显示「检查失败·重试」），5s 自动重试一次
  const [updFailed, setUpdFailed] = useState(false)
  const updRetried = useRef(false)
  const checkUpdateRef = useRef<() => void>(() => {})
  const checkUpdate = useCallback(() => {
    void import('@tauri-apps/api/core').then((m) => m.invoke('update_check_per_exe'))
      .then((r) => { if (r) { setUpdPer(r as typeof updPer); setUpdFailed(false) } })
      .catch(() => {
        setUpdFailed(true)
        setUpdPer(null) // 第57轮：失败时清掉旧数据——否则旧 hasUpdate=true 的确认按钮与新检查失败提示矛盾共存
        if (!updRetried.current) { updRetried.current = true; setTimeout(() => checkUpdateRef.current(), 5000) }
      })
  }, [])
  useEffect(() => {
    checkUpdateRef.current = checkUpdate
    const t = setTimeout(checkUpdate, 2000)
    const t10 = setInterval(checkUpdate, 10 * 60 * 1000)
    return () => { clearTimeout(t); clearInterval(t10) }
  }, [checkUpdate])
  // 旧版全局检查(2026-08-31):保留兜底(per-exe 失败时还能比对 VERSION.txt)
  const [upd, setUpd] = useState<{ current: string; latest: string; notes?: string; hasUpdate: boolean } | null>(null)
  // 关于(env 版本,任何形态可见):挂载即拉——曾只在开设置面板时拉,账号行版本号
  // 常显需要它先到(exe 的 upd 走 Tauri invoke,浏览器形态拿不到)。
  // GET:/api/about 路由只有 GET,post() 统一 POST 打它=405(静默,关于段永远'…')。
  useEffect(() => {
    void fetch(`${CANVAS_API}/api/about`).then((r) => r.json()).then((j) => setAbout((j as { data?: { version?: string } })?.data?.version ?? null)).catch(() => {})
  }, [])
  useEffect(() => {
    let alive = true
    const load = () => {
      void import('@tauri-apps/api/core').then((m) => m.invoke('prod_update_info'))
        .then((r) => { if (alive) setUpd(r as { current: string; latest: string; notes?: string; hasUpdate: boolean }) })
        .catch(() => { if (alive) setUpd(null) })
    }
    load()
    const t = setInterval(load, 30 * 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  // 当前程序版本（2026-10-23 用户要求：即使「已是最新」也要能看到当前版本号）。
  // get_build_info 是**本地**命令（不联网）→ 离线 / 检查更新失败时版本号照样显示。
  // （2026-10-23 同日设计定稿：**不显示构建时间**——"版本号相同但构建不同"是开发者视角，
  //   用户不关心；exeMtime 仍保留在 get_build_info 返回里供 agent/CLI 诊断用，不进 UI。）
  const [buildInfo, setBuildInfo] = useState<{ version: string; name?: string; exeMtime?: number } | null>(null)
  useEffect(() => {
    let alive = true
    void import('@tauri-apps/api/core').then((m) => m.invoke('get_build_info'))
      .then((r) => { if (alive) setBuildInfo(r as { version: string; name?: string; exeMtime?: number }) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const curVersion = (updPer?.localVersion || upd?.current || buildInfo?.version || '').replace(/^v/, '')

  // 周用量全局事实(供任务行 R:usage-week 目标消费;原顶层卡已撤,2026-08-30)
  const [weekUsage, setWeekUsage] = useState<{ weekTokens: number; today: number } | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void post('/api/usage_get_summary').then((j) => {
        if (!alive) return
        const d = (j as { success?: boolean; data?: UsageSummary } | null)
        if (d?.success && d.data) {
          const mon = mondayStart()
          const days = (d.data.daily ?? []).filter((x) => new Date(`${x.date}T00:00:00`) >= mon)
          setWeekUsage({ weekTokens: days.reduce((a, x) => a + (x.total || 0), 0), today: d.data.today?.total ?? 0 })
        } else setWeekUsage(null)
      }).catch(() => { if (alive) setWeekUsage(null) })
    }
    load()
    const t = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [post])

  const refreshIdentity = useMemo(() => async () => {
    // 第63轮 env 合并：身份查询改 invoke 直调（原 post :3102 已死）
    try {
      const m = await import('@tauri-apps/api/core')
      const s = await m.invoke('myco_get').catch(() => null)
      if (s) {
        setSoul(s as YoulingState)
        const d = await m.invoke('myco_list_devices').catch(() => null)
        if (d) {
          setDevices((d.devices ?? []) as Device[])
          setYoulingName(d.name ?? '')
          setBackedUp(!!d.backedUp)
        }
      }
    } catch { /* 静默 */ }
  }, [])
  const refreshSettings = useMemo(() => async () => {
    loadAppearance()
    void fetch(`${CANVAS_API}/api/about`).then((r) => r.json()).then((j) => setAbout((j as { data?: { version?: string } })?.data?.version ?? null)).catch(() => {})
    const c = await post('/api/provider_config').catch(() => null)
    if (c?.success) {
      setProviders((c.data?.providers ?? []) as Provider[])
      setDefProvider(c.data?.defaultProvider ?? null)
    }
    const h = await post('/api/get_harness_statuses').catch(() => null)
    if (h?.success) setHarnesses(h.data as Record<string, boolean>)
    const u = await post('/api/harness_ui_config').catch(() => null)
    if (u?.success) setHarnessUi(u.data as { default?: boolean; overrides?: Record<string, boolean> })
  }, [post])

  const saveProvider = async () => {
    if (!pForm) return
    const body = { ...pForm, id: pForm.id || pForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') }
    const r = await post('/api/provider_save', body)
    if (r?.success) { setPForm(null); await refreshSettings() }
  }

  useEffect(() => {
    // 默认亮色(2026-09-12 第16轮拍板8:对齐 youling 新主页浅色);localStorage 覆盖
    // 批三修：pink/green/blue 不再被强制抹成 light——五色主题持久化原样应用
    const t = localStorage.getItem('myco-theme')
    document.documentElement.dataset.theme = t && ['light', 'dark', 'pink', 'green', 'blue'].includes(t) ? t : 'light'
    setIdReady(true)
  }, [])

  const [tiers, setTiers] = useState<Record<string, string>>({})
  const refresh = useMemo(() => () => {
    void fetch(`${CANVAS_API}/api/pm/todos`).then((r) => r.json()).then((j) => setTodos(j?.data ?? [])).catch(() => {})
    void fetch(`${CANVAS_API}/api/boards_dock`).then((r) => r.json()).then((j) => setBoards(j?.data ?? [])).catch(() => {})
    // 仪表盘本职=全项目可见(boards 只含有任务墙的;注册名单兜底,空项目也能分诊跳转)
    void fetch(`${CANVAS_API}/api/list_projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json()).then((j) => setProjectNames(((j?.data ?? []) as { name: string }[]).map((x) => x.name))).catch(() => {})
    void fetch(`${CANVAS_API}/api/agents/health`).then((r) => r.json()).then((j) => setHealth(j?.data ?? {})).catch(() => {})
    // 交互层级(D1 四态):formation state 的 members[].tier
    void fetch(`${CANVAS_API}/api/formation/state`).then((r) => r.json()).then((j) => {
      const ms = j?.data?.members
      if (Array.isArray(ms)) {
        const m: Record<string, string> = {}
        for (const it of ms) if (it?.port) m[String(it.port)] = it.tier ?? 'companion'
        setTiers(m)
      }
    }).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    void refreshIdentity()
    void refreshSettings()
    // canvas 身份 store 首拉(IdentityPanel 消费 rootDid/accountStatus,同 canvas App 启动序列)
    bootIdentitySync()
    const t = setInterval(refresh, 15_000)
    const t2 = setInterval(() => void refreshIdentity(), 30_000)
    // 第24轮"秒连":冷启动 env 要 5-8s 才就绪——身份未就绪时 1s 快速重试(最多 15 次),
    // 就绪即停。用户实测"登录特别慢"=固定等 30s 轮询拍。canvas 数据同理 2s 快探。
    let fast = 0
    const tf = setInterval(async () => {
      fast += 1
      if (fast > 30) { clearInterval(tf); return }
      void refreshIdentity()
      try {
        const r = await fetch('http://127.0.0.1:3102/api/myco_get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(900) })
        if (r.ok) { clearInterval(tf); refresh() }
      } catch { /* env 未起,继续重试 */ }
    }, 500)
    return () => { clearInterval(t); clearInterval(t2); clearInterval(tf) }
  }, [refresh, refreshIdentity, refreshSettings])

  // 账号已切换（Rust myco_import 成功即广播 account-changed）——2026-10-01 修：
  // 导入新账号后顶栏昵称 ~30s 才切（只能等上面的 30s 轮询）。事件到达先就地换身份
  // （rootDid 立变、旧昵称即清——显示链兜底「未命名 ·…尾4」），再重跑拉取链让
  // myco_get/myco_list_devices 把真名册补回来（缓存已在 core 层失效，~1 个网络往返）。
  useEffect(() => {
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ rootDid: string }>('account-changed', (ev) => {
        const did = ev.payload?.rootDid
        if (!did) return
        setSoul((s) => (s ? { ...s, rootDid: did, role: 'embodiment', name: '' } : { rootDid: did, deviceDid: null, role: 'embodiment', name: '' }))
        setYoulingName('')
        void refreshIdentity()
        loadAccounts()
      }),
    ).then((u) => { un = u }).catch(() => {})
    return () => { un?.() }
  }, [refreshIdentity])

  // 2026-10-06 任务2：被收编端轮询环收下委任状即广播 delegation-received——
  // 账号抽屉/顶栏清单即时出现新成员条目（role=agent），不等下次手动刷新。
  // 身份不切（还是原账号），只补清单。
  // 2026-10-06 补：myco 内 toast（原只有系统通知一道——Windows 通知被拦截/免打扰时
  // 用户完全无感知，实测"什么提示都没有"）。toast 是 myco 内可见的兜底主动信号。
  useEffect(() => {
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ rootDid: string; name: string; isEmbodiment?: boolean; refreshed?: boolean }>('delegation-received', (ev) => {
        loadAccounts()
        // 2026-10-06 三场景提示（用户明确要求三场景都要可见）：
        // isEmbodiment=已是主设备 / refreshed=授权已刷新（重复添加）/ 默认=已被收编为成员
        const p = ev.payload
        pushTaskToast(p?.isEmbodiment
          ? `✅ 你已是 ${p?.name || '该账号'} 的主设备`
          : p?.refreshed
            ? `✅ ${p?.name || '对方'} 的授权已刷新`
            : `🎉 你已被 ${p?.name || '对方'} 收编为成员——账号抽屉已出现，可切换使用`)
        // 2026-10-06：收编完成时若停在"出示本机码→等待主设备确认"屏（show/method），
        // 自动跳回主屏——否则 spinner 原地不动，用户以为没反应（诊断实测的直接体感）
        setPageView((v) => (v === 'show' || v === 'method' ? 'page' : v))
      }),
    ).then((u) => { un = u }).catch(() => {})
    return () => { un?.() }
  }, [pushTaskToast])

  // 排序:超期项钉到最上(红灯优先),其余按 priority。合并视图要全量,不截断。
  const openTodos = todos
    .filter((t) => t.status !== 'done')
    .sort((a, b) => {
      const over = (t: TodoItem) => {
        if (!t.due) return false
        const d = /^\d{4}-\d{2}-\d{2}$/.test(t.due.trim()) ? new Date(`${t.due.trim()}T23:59:59`) : new Date(t.due.trim())
        return !isNaN(d.getTime()) && d.getTime() < Date.now()
      }
      const oa = over(a), ob = over(b)
      if (oa !== ob) return oa ? -1 : 1
      return a.priority - b.priority
    })

  // ── B2.5 合并视图:项目灯墙 + 其下开口待办 ──
  // 分组键=projectName(boards 只有 name;projectId 已回填,改名后 name 失配时仍归一组待修)
  interface ProjGroup { key: string; name: string; light?: string; lightNote?: string; done: number; total: number; todos: TodoItem[]; hasBoard: boolean }
  const groups: ProjGroup[] = (() => {
    const byProj = new Map<string, TodoItem[]>()
    for (const t of openTodos) {
      const k = t.projectName ?? ''
      if (!k) continue
      const arr = byProj.get(k) ?? []
      arr.push(t)
      byProj.set(k, arr)
    }
    const gs: ProjGroup[] = boards.map((b) => ({
      key: b.name, name: b.name, light: b.light, lightNote: b.lightNote,
      done: b.done, total: b.total, todos: byProj.get(b.name) ?? [], hasBoard: true,
    }))
    for (const [k, ts] of byProj) {
      if (!boards.some((b) => b.name === k)) gs.push({ key: k, name: k, done: 0, total: 0, todos: ts, hasBoard: false })
    }
    // 注册名单兜底:空项目(无墙无待办)也要有行——分诊双跳转的可达性
    for (const n of projectNames) {
      if (!gs.some((g) => g.name === n)) gs.push({ key: n, name: n, done: 0, total: 0, todos: [], hasBoard: false })
    }
    return gs
  })()
  // P2: 搜索过滤(实时,匹配项目名/待办文字/Task 标题)
  // 投入权重排序(2026-08-30):权重降序钉前,同权/无权保持原相对序(稳定排序)
  const sortedGroups = [...groups].sort((a, b) => weightOf(b.name) - weightOf(a.name))
  const q = searchQuery.trim().toLowerCase()
  const filteredGroups = q ? sortedGroups.filter((g) =>
    g.name.toLowerCase().includes(q) ||
    g.todos.some((t) => (t.text ?? '').toLowerCase().includes(q))
  ) : sortedGroups
  const looseTodos = openTodos.filter((t) => !t.projectName && (!q || (t.text ?? '').toLowerCase().includes(q)))
  // 展开状态:红灯默认展开,其余默认收起;「未挂项目」默认展开
  const [closedMap, setClosedMap] = useState<Record<string, boolean>>({})
  const isClosed = (g: { key: string; light?: string }) => closedMap[g.key] ?? (g.light !== 'red')
  const toggleGroup = (key: string, def: boolean) => setClosedMap((m) => ({ ...m, [key]: !(m[key] ?? def) }))


  // 根窗窗管:打开(幂等拉起)/关闭(进程退出,可随时再开)其他成员窗
  // 分诊跳转(2026-08-25 仪表盘定稿):拉起目标窗 + 意图中转(canvas /api/ui/intent,
  // 成员窗 2s 轮询消费)——▶ 工作区干活 / ◫ 画布规划。
  const jumpTo = (win: 'chatwin' | 'graph', project: string, task?: string, taskKey?: string) => {
    // 2026-09-04 修:aop 已收编 chatwin/graph 两窗——统一拉 aop.exe(唯一工作区壳),
    // 投意图(aop 轮询 /api/ui/intent:chatwin=选会话/开项目,graph=切图视图+设计),
    // 并把 aop 窗带到前台(旧实现拉 myco-chatwin/myco-graph.exe——exe 已退役,
    // 拉起必失败且窗口不前置=点着"没反应";意图通道本身 aop 一直在消费)。
    // 任务直达双锚(2026-09-04 定稿):taskKey=机器锚(精确对位,改名/异步零风险,
    // home 从 tasks_board 拿到的就是它);task 名=兼容字段(无 key 时按名找,兜底)。
    void fetch(`${CANVAS_API}/api/agents/launch?exe=aop.exe`, { method: 'POST' }).catch(() => {})
    void fetch(`${CANVAS_API}/api/ui/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window: win, action: 'open-project', project, ...(task ? { task } : {}), ...(taskKey ? { taskKey } : {}) }),
    }).catch(() => {})
    // 已在跑:立即前置;刚拉起:1.5s 后补一次(等窗口就绪,晚到无害)
    const focus = () => void fetch(`http://127.0.0.1:${PORT_OF['ui-chat']}/myco/window_state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'restore', focus: true }),
    }).catch(() => {})
    focus()
    setTimeout(focus, 1500)
  }
  const open = (m: { key: string; exe: string }) => {
    // 打开≠入队:拉起即用,自由窗;入队用窗口标题栏◆归队钮
    void fetch(`${CANVAS_API}/api/agents/launch?exe=${m.exe}`, { method: 'POST' })
      .catch(() => {}).finally(() => setTimeout(refresh, 2500))
  }
  const close = (m: { key: string; exe: string }) => {
    // 真实杀进程(2026-09-03 设计定稿):点关闭=真的关,不是最小化/藏窗
    void import('@tauri-apps/api/core').then((t) => t.invoke('kill_member', { exe: m.exe }))
      .catch(() => {}).finally(() => setTimeout(refresh, 1500))
  }
  const openAll = () => { for (const m of CORE_MEMBERS) if (!health[m.key]) open(m) }
  // 四态切换(D1):focus=主工作面/companion=伴生/stow=收成右缘磁贴/off=不占位
  const setTier = (m: { key: string }, tier: string) => {
    const port = PORT_OF[m.key]
    if (!port) return
    setTiers((prev) => ({ ...prev, [String(port)]: tier }))
    void fetch(`${CANVAS_API}/api/formation/tier`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, tier }),
    }).catch(() => {}).finally(() => setTimeout(refresh, 900))
  }
  const setMode = (mode: 'work' | 'patrol') => {
    void fetch(`${CANVAS_API}/api/formation/mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
    }).catch(() => {}).finally(() => setTimeout(refresh, 1200))
  }
  // B4-3 canvas 无窗化召唤:已随 canvas 巨石搁置(2026-09-04 清理)——env 无
  // /api/canvas_window 路由,挂载探测 404+toggleCanvas 无 UI 引用=纯死代码。
  // 待办写入口(2026-09-04):myco-todo 窗已退役——行点击一律跳工作区(aop),
  // 增/删/改在工作区/接口做;summonTodo(拉 myco-todo.exe+未定义端口)已删。

  // 实时状态摘要 → 助手 system prompt(回答项目问题的依据,防编造)
  const buildCtx = () => {
    const L: string[] = []
    L.push(`舰队在线 ${Object.values(health).filter(Boolean).length}/${Object.keys(health).length}`)
    if (boards.length) {
      L.push('项目灯墙:')
      for (const b of boards) L.push(`- ${b.name}:${b.light ?? 'gray'}${b.lightNote ? `(${b.lightNote})` : ''}${b.total > 0 ? ` 进度${b.done}/${b.total}` : ''}`)
    }
    if (openTodos.length) {
      L.push(`开口待办 ${openTodos.length} 条:`)
      for (const t of openTodos.slice(0, 20)) L.push(`- [${t.projectName ?? '未挂项目'}] ${t.text}${t.due ? `(期限 ${t.due})` : ''}`)
    }
    return L.join('\n')
  }
  // 展开=召唤 aop 工作区看完整历史(幂等拉起+前台;chatwin 已退役,壳=aop.exe)
  const summonChat = () => {
    void fetch(`${CANVAS_API}/api/agents/launch?exe=aop.exe`, { method: 'POST' })
      .catch(() => {})
      .finally(() => setTimeout(() => {
        void fetch(`http://127.0.0.1:${PORT_OF['ui-chat']}/myco/window_state`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'restore', focus: true }),
        }).catch(() => {})
      }, 900))
  }
  // home 允许勾选完成(高频轻操作);增/删/改仍走 todo 窗(点击文字召唤)
  const toggleTodo = (t: TodoItem) => {
    void fetch(`${CANVAS_API}/api/pm/todos/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).then(() => refresh()).catch(() => {})
  }
  // 舰队调度默认收成摘要(home 加聊天后变长;点标题展开明细)
  // 完整身份面板(Youling 改名/备份/密码/解绑 + 设备授权/扫码/配对)
  // 设备残留清理(2026-09-03):可吊销数=离线且未吊销且非具身(本机 did 由后端安全闸兜底)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeMsg, setRevokeMsg] = useState('')
  const myDeviceDid = youling?.deviceDid ?? ''
  const revocableCount = devices.filter((d) => !d.revoked && !d.online && !d.isEmbodiment && d.did !== myDeviceDid).length
  const redCount = boards.filter((b) => b.light === 'red').length
  // 身份区文案(2026-09-03 设计定稿):启动/解析中=「连接中…」——已配对分身不再闪
  // 「未注册」;分身(agent)=主账号昵称·已连接(昵称给自己看,不上 DID 尾号);
  // 本体=账号名/已连接;查实无归属(rootDid=null 已返回)才显示「未注册」。
  const identityText = youling === null
    ? '连接中…'
    : !youling.rootDid
      ? '未注册'
      : youling.role === 'agent'
        ? ((youling.name || accountName) ? `${youling.name || accountName} · 已连接` : '已连接')
        : (accountName || youling.name || '已连接')

  // 2026-10-03：顶部账号卡单行数据（acctCardLine 纯函数——显示合同测试钉住）
  const acctTopLine = youling?.rootDid ? acctCardLine(accountName || youling?.name, normalizeAccountDid(youling.rootDid)) : null

  return (
    <>
      {!EMBED && (
        <TitleBar title="myco" port={17995} ah bare>
          {/* 有新版小标识(2026-09-03 统一自更新):常驻红点徽标,详情在主面板提示卡确认 */}
          {updPer?.hasUpdate && (
          <section className="sec" style={{ padding: '6px 10px' }}>
            <div className="row" title={`本地 ${updPer.localVersion} → 服务器 ${updPer.serverVersion}${updPer.notes ? `\n${updPer.notes}` : ''}`}>
              <span className="name" style={{ fontWeight: 600, color: 'var(--ac, #6b7bff)' }}>⬆ 新版 {updPer.serverVersion}</span>
              <span className="muted small">当前 {updPer.localVersion}</span>
              {/* 更新说明：点击展开全文/再点折叠（▾ 必须在 truncate span 外，否则被省略号裁切一起裁掉——真机实测） */}
              <span className="muted small truncate flex1" onClick={() => setUpdNotesOpen((v) => !v)} style={{ cursor: 'pointer' }}>{updPer.notes}</span>
              <span className="muted small" onClick={() => setUpdNotesOpen((v) => !v)} style={{ flexShrink: 0, cursor: 'pointer', color: 'var(--ac, #6b7bff)', fontWeight: 700 }}>{updNotesOpen ? '▴' : '▾'}</span>
              {updBusy ? <span className="muted small truncate" style={{ flexShrink: 1, minWidth: 0, color: 'var(--ac, #6b7bff)' }}>{updMsg || '更新启动中…窗口将重启'}</span> : (
                <button style={{ flexShrink: 0 }} onClick={startUpdate}>确认更新</button>
              )}
            </div>
            {updErr && (
              <div className="tinyd" style={{ marginTop: 2, padding: '4px 8px', color: '#e5534b', userSelect: 'text' }} title="点击关闭">{updErr}</div>
            )}
            {updNotesOpen && updPer.notes && (
              <div className="tinyd" style={{ marginTop: 4, padding: '6px 8px', background: 'rgba(107,123,255,.06)', borderRadius: 8, lineHeight: 1.6, wordBreak: 'break-word', userSelect: 'text' }}>{updPer.notes}</div>
            )}
          </section>
        )}
        {upd?.hasUpdate && (
            <span title={`有新版 ${upd.latest}(当前 ${upd.current})——主面板确认更新`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, borderRadius: 8, background: '#e5534b',
                color: '#fff', fontSize: 10, fontWeight: 700, cursor: 'default',
                flexShrink: 0, marginLeft: 4,
              }}>⬆</span>
          )}
        </TitleBar>
      )}
      {/* ══ 第47轮（设计定稿两行顶栏）：窗口栏=myco+窗控(TitleBar)；应用栏=账号▾(左,开账号页+抽屉)+⚙️设置(右) ══ */}
      {!EMBED && !accountView && !myResumeOpen && (
        <div className="demo-topbar">
          {/* 2026-10-06 设计定稿：未登录态不再显示"未登录"三字及其点击入口——
              功能与欢迎屏的「登录有灵账号/创建新账号」重复，且 12px 中文在该位
              有笔画粘连观感问题（直接去掉最干净）。已登录态账号名入口保留。 */}
          {youling?.rootDid && (
            <span className="st-wrap" onClick={() => { setAccountView(true); setPageView('page') }} title={`${accountDisplayName(accountName || youling?.name)} · ${normalizeAccountDid(youling.rootDid)}（点进账号页）`}>
              {/* 2026-10-11：圆点在 .st-wrap（overflow:visible）不被裁；.st 的 overflow:hidden
                  只管文字 ellipsis；flex 约束由 .st-wrap 继承（flex:0 1 220px）。 */}
              <span className="myco-dot" />
              {/* 2026-10-11 类名冲突修复：原 class="st" 与 index.html 内联的 agent/fleet 面板
                  CSS `.st{border-radius:50%}` 撞名 ⇒ 本元素同时吃到 border-radius:50% 与
                  demo.css 的 overflow:hidden ⇒ 208×21 的【椭圆】裁切框把文字左端（首字母）
                  上下切掉（用户实测"C 像被白色遮住/两条斜线切去一块"）。
                  改名 acct-name 彻底脱离该冲突。 */}
              <span className="acct-name" style={{ fontWeight: 600 }}>{accountShortLabel(accountName || youling?.name, youling.rootDid)} ▾</span>
            </span>
          )}
          {/* 旧格式账号警示标（2026-10-07 清档闸门）：accountFormatLegacy=true 时账号名旁
              常驻红标——点进账号页看处理引导（解绑重注册/导恢复码再导入）。数据源
              identityStore（loadYouling/unlock 的延迟复核兜住异步检出）。
              2026-10-09 设计定稿：**升级为模态阻断**（与手机对齐——账号已死，没的选，
              强制清除当前账号）。红标保留作点击入口（点开模态）。 */}
          {identityStore.accountFormatLegacy && youling?.rootDid && !regOpen && !legacyModalOff && (
            <span data-testid="legacy-format-chip" title="格式无效，不支持——点开处理" onClick={() => setRegOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 8, background: '#dc2626', color: '#fff', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', flexShrink: 0, marginLeft: 2 }}>
              ⚠️ 格式无效
            </span>
          )}
          <span style={{ flex: 1 }} />
          {/* 第52轮：主题切换收进设置五色——顶栏二元月亮/太阳与五色主题语义冲突已删 */}
          <button className="ico" onClick={() => { setAccountView(true); setPageView('settings') }} title="设置——检查更新/主题/贴边/自启">⚙️</button>
        </div>
      )}



      <YoulingAuth />

      <main className="col demo-scr">
        {/* 第23轮:账号与设置全屏页——点账号胶囊/设置进入,左上返回主界面。 */}
        {/* 第88轮:能力值全屏视图(仿账号页模式;与 accountView 互斥——打开时收账号页) */}
        {myResumeOpen && <MyResume onClose={() => setMyResumeOpen(false)} />}
        {accountView && !myResumeOpen && (
          <section className="sec grow demo-scr" style={{ overflowY: 'auto', padding: '14px 13px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {/* ── 第44轮 demo 还原：method/show/create 三屏（账号页内视图机） ── */}
            {pageView === 'method' && (
            <>
            <div className="backrowd"><button className="bk" onClick={() => setPageView('page')}>‹ 返回</button><span className="h2d nav-title">登录已有账号</span></div>
            <div className="subd">选择一种方式证明「你是老账号的主人」：</div>
            <div className={'methodd' + (methodSel === 0 ? ' on' : '')} onClick={() => { setMethodSel(0); setPageView('show') }}><span className="ic">🔳</span><span><div className="t">我的识别码</div><div className="d">本机出码，主设备扫并确认——电脑上最省事</div></span><span className="rec">推荐</span></div>
            {/* ── 「📷 扫主设备的码」卡已下线（2026-09-30 设计定稿）──
                exe 无摄像头，该卡从无实现（纯占位死卡，点了没反应）。
                复开条件=摄像头场景复现（如外接摄像头扫码授权普及）后随设置页重开。 */}
            {/* 恢复码导入（批A 真链通）：点卡就地展开表单——原死链 setPageView('page') 已废，
                page 屏恢复码折叠区（IdentityPanel unlinked 专属）也已随本内联表单下线。
                选中态=restoreForm.open（展开即选中），语义同批B的 methodSel 真选中。 */}
            <div className={'methodd' + (restoreForm.open ? ' on' : '')} onClick={() => dispatchRestore({ type: 'toggle' })}><span className="ic">🔑</span><span><div className="t">恢复码导入</div><div className="d">输入备份的恢复码（成为主设备）</div></span><span className="rec">{restoreForm.open ? '收起 ▴' : '展开 ▾'}</span></div>
            {restoreForm.open && (
            <div className="cardd" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="tinyd">粘贴创建账号时备份的恢复码（三行或单行都行）。导入后本机成为该账号的<b>主设备</b>。</div>
              <textarea className="textaread" rows={3} value={restoreForm.text} onChange={(e) => dispatchRestore({ type: 'text', v: e.target.value })} placeholder={'恢复码三行（或一整行）\n加密备份则连同 ct=/salt=/iv= 一起粘贴'} disabled={restoreForm.busy} />
              <input className="inpd" type="password" value={restoreForm.password} onChange={(e) => dispatchRestore({ type: 'password', v: e.target.value })} placeholder="密码（加密备份才需要）" disabled={restoreForm.busy} />
              <button className="btnd" onClick={() => void doRestoreImport()} disabled={restoreForm.busy}>{restoreForm.busy ? '导入中…' : '🔑 导入并登录'}</button>
              {restoreForm.error && <div className="tinyd" style={{ color: '#dc2626', lineHeight: 1.5, userSelect: 'text' }}>{restoreForm.error}</div>}
            </div>
            )}
            <div className="tinyd">说明：出示本机识别码=本机成为该账号的<b>成员</b>（主设备点一下确认即可）；恢复码=把账号钥匙带回本机（成为主设备），适合换机。</div>
            </>
            )}
            {pageView === 'show' && (
            <>
            <div className="backrowd"><button className="bk" onClick={() => setPageView('method')}>‹ 换方式</button></div>
            <div className="h2d">我的识别码</div>
            <div className="tinyd centerd">用<b>主设备</b>的 myco：「账号 → 添加设备 → 添加识别码」扫这个码</div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
              {myDeviceDid ? <QrImage text={JSON.stringify({ v: 1, type: 'myco-add', did: myDeviceDid, name: '我的电脑' })} size={172} /> : <div className="tinyd">正在生成本机码…</div>}
            </div>
            {!didCopied ? (
            <div className="cardd info-cardd">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>📋</span>
                <span style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 600 }}>主设备不方便扫这个码？</div>
                <div className="tinyd" style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setShowMyDid((v) => !v)}>本机识别码 {accountTail(myDeviceDid)} {showMyDid ? '▾' : '▸'} 点开核对</div></span>
              </div>
              {showMyDid && (
              <>
              <div className="tinyd" style={{ marginTop: 6, padding: '7px 9px', background: '#fff', border: '1px dashed #c7d2fe', borderRadius: 8, fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', lineHeight: 1.5, userSelect: 'all' }}>{myDeviceDid}</div>
              <div className="tinyd" style={{ marginTop: 4 }}>↑ 这就是要发给主设备的完整识别码（本设备的公钥身份）。核对无误再复制——发错码=授权给错的设备。</div>
              </>
              )}
              <button className="btnd ghost" style={{ marginTop: 8, borderColor: '#6b7bff', color: 'var(--accent)' }} onClick={() => { void copyDidVerified(myDeviceDid).then((r) => {
                pushTaskToast(copyDidToastText(r))
                if (r === 'ok') setDidCopied(true) // 异常/不完整不进入"已复制"下一步引导
              }) }}>复制本机识别码（完整DID）</button>
            </div>
            ) : (
            <div className="cardd go-cardd">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: '#15803d' }}>✓ 已复制，接下来去主设备：</div>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="stepnumd">1</span><span className="subd">打开<b>主设备上的 myco</b>（如手机上的登录器）</span></div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="stepnumd">2</span><span className="subd">点顶部<b>账号名</b> → <b>添加设备</b> → <b>添加识别码</b> → 粘贴</span></div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="stepnumd">3</span><span className="subd">粘贴后核对显示的设备名，点<b>确认添加</b></span></div>
              </div>
              <div className="tinyd" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #d1fae5' }}>💡 手机和电脑不在一起？把识别码用<b>微信/QQ 发给自己</b>，在电脑上复制粘贴即可</div>
              <button className="btnd ghost" style={{ marginTop: 8 }} onClick={() => setDidCopied(false)}>‹ 返回二维码</button>
            </div>
            )}
            <div className="cardd info-cardd centerd">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><span className="spinnerd" /><span className="subd">等待主设备扫这个码/粘贴并确认…</span></div>
            </div>
            <button className="btnd ghost" onClick={() => setPageView('method')}>取消</button>
            </>
            )}
            {pageView === 'create' && (
            <>
            <div className="backrowd"><button className="bk" onClick={() => setPageView('page')}>‹ 返回</button><span className="h2d nav-title">创建账号</span></div>
            <div className="cardd"><input className="inpd" value={newAcctName} onChange={(e) => setNewAcctName(e.target.value.replace(/[^一-龥\w]/g, '').trim().slice(0, 32))} placeholder="给它起个名（可选，之后也能改）" /></div>
            <div className="tinyd">创建后强制备份恢复码（沿用既有流程）。</div>
            <button className="btnd" onClick={() => { void identityStore.createYouling(newAcctName || undefined).then((d) => { if (d) { setPageView('page'); setAccountView(false); try { const route = acctFeedbackRoute(!!youling?.rootDid, newAcctName, d.slice(-4)); if (route) sessionStorage.setItem(route.key, route.payload) } catch { /* 容错 */ } window.location.reload() } }) }}>✨ 创建</button>
            </>
            )}
            {pageView === 'settings' && (<>
            <div className="backrowd"><button className="bk" onClick={() => { setAccountView(false); setPageView('page') }}>‹ 返回</button><span className="h2d nav-title">设置</span></div>
            <div className="cardd">
              {/* 检查更新（2026-10-10 删卡片头「⚙️ 设置」——导航栏已有居中标题，避免两个"设置"） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span className="dot" style={{ background: updPer?.hasUpdate ? '#6b7bff' : '#94a3b8' }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  版本更新
                  {/* 2026-10-23 用户要求：已是最新时也要能看到当前版本号（本地命令取值，离线也有） */}
                  <span className="muted small" style={{ display: 'block', marginTop: 1, userSelect: 'text' }}>
                    当前版本 {curVersion ? `v${curVersion}` : '读取中…'}
                  </span>
                </span>
                <span className={'endchip' + (updPer?.hasUpdate ? ' yl' : '')} style={{ cursor: 'pointer' }} onClick={() => { updRetried.current = false; setUpdFailed(false); checkUpdate() }}>
                  {updBusy ? '检查中…' : updFailed ? '检查失败·点重试' : !updPer ? '检查中…' : updPer.hasUpdate ? `有新版本 ${updPer.serverVersion} →` : '已是最新'}
                </span>
              </div>
              {updPer?.hasUpdate && (
                <button className="btnd" style={{ marginTop: 6 }} disabled={updBusy} onClick={startUpdate}>{updBusy ? '更新中…' : '确认更新'}</button>
              )}
              {updBusy && updMsg && (
                <div className="tinyd" style={{ marginTop: 4, color: '#6b7bff' }}>{updMsg}</div>
              )}
              {updErr && (
                <div className="tinyd" style={{ marginTop: 4, color: '#e5534b', lineHeight: 1.5, userSelect: 'text' }} title="点击重试" onClick={() => setUpdErr('')}>{updErr}</div>
              )}
              {/* 下载其他设备版本（2026-09-30 设计定稿：本机升级 vs 别的设备装——去下载中心 /apps） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>下载其他设备版本<span className="tinyd">（手机 / Mac / Linux —— 去下载中心）</span></span>
                <span className="endchip go" style={{ cursor: 'pointer' }} title="用系统浏览器打开下载中心" onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
                  const url = PLATFORM_BASE + '/apps'
                  try { await m.invoke('open_external', { url }) } catch { window.open(url) }
                })}>打开 →</span>
              </div>
              {/* 其他工具（vnet 会话 2026-10-24 交付）：下载中心附加工具页（远程桌面 App + myco skill） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>其他工具<span className="tinyd">（附加下载：远程桌面 App · myco skill）</span></span>
                <span className="endchip go" style={{ cursor: 'pointer' }} title="用系统浏览器打开附加工具页" onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
                  const url = PLATFORM_BASE + '/downloads/tools.html'
                  try { await m.invoke('open_external', { url }) } catch { window.open(url) }
                })}>打开 →</span>
              </div>
              {/* 主题五色 */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>主题颜色</span>
                {([['light', '#f8fafc', '#d7dfeb'], ['dark', '#1a2130', '#1a2130'], ['pink', '#ec5f9b', '#ec5f9b'], ['green', '#16a34a', '#16a34a'], ['blue', '#2563eb', '#2563eb']] as const).map(([k, c, b]) => (
                  <span key={k} title={{ light: '亮白', dark: '暗黑', pink: '粉', green: '绿', blue: '蓝' }[k]}
                    onClick={() => setThemeTo(k)}
                    style={{ width: 20, height: 20, borderRadius: '50%', background: c, border: `2px solid ${theme === k ? '#4338ca' : b}`, cursor: 'pointer', flexShrink: 0 }} />
                ))}
              </div>
              {/* 自动贴边（窗口缩成边缘磁条） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>窗口自动贴边隐藏<span className="tinyd">（移上临时展开）</span></span>
                <span className={'endchip' + (autoHideOn ? ' go' : '')} style={{ cursor: 'pointer' }} onClick={() => void toggleAutoHideSetting()}>{autoHideOn ? '已开启' : '已关闭'}</span>
              </div>
              {/* 新消息通知（批三：系统通知全局开关） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>新消息通知<span className="tinyd">（窗口外收消息时系统提醒；窗口正看着不打扰）</span></span>
                <span className={'endchip' + (notifOn ? ' go' : '')} style={{ cursor: 'pointer' }} onClick={() => void toggleNotif()}>{notifOn ? '已开启' : '已关闭'}</span>
              </div>
              {/* 开机自启 */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>开机自动启动</span>
                <span className={'endchip' + (autoStart ? ' go' : '')} style={{ cursor: 'pointer' }} onClick={() => void toggleAutoStart()}>{autoStart === null ? '读取中…' : autoStart ? '已开启' : '已关闭'}</span>
              </div>
              {/* 强制直连（2026-10-10 用户要求）：不走云端中转，直连不通时明确提示 */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>强制直连<span className="tinyd">（不走云端中转，直连不通时明确提示）</span></span>
                <span className={'endchip' + (forceDirect ? ' go' : '')} style={{ cursor: 'pointer' }} onClick={toggleForceDirect}>{forceDirect ? '已开启' : '已关闭'}</span>
              </div>
              {/* 关闭按钮行为（2026-10-18 微信式常驻；用户二次拍板：选项是 进托盘/退出应用，
                  最小化不在此——要最小化点最小化按钮） */}
              <div className="devline" style={{ marginTop: 6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>点关闭按钮时<span className="tinyd">（进托盘=后台常驻，聊天/分享不中断；要最小化请点最小化按钮）</span></span>
                <span className={'endchip' + (closeBehavior === 'tray' ? ' go' : '')} style={{ cursor: 'pointer' }} onClick={() => void setCloseBehaviorTo('tray')}>进托盘</span>
                <span className={'endchip' + (closeBehavior === 'quit' ? ' go' : '')} style={{ cursor: 'pointer', marginLeft: 4 }} onClick={() => void setCloseBehaviorTo('quit')}>退出应用</span>
              </div>
            </div>

            </>)}
            {pageView === 'page' && (<>
            {/* ── 账号页（2026-09-30 批 B 起两区块一页滚动；2026-10-01 重排）──
                ① 账号区（我是谁）→ ② 设备区（本机是谁）；③ 账号管理区已随「切换账号 ▾」
                真下拉上线而整区下线（切换/登录/创建收进顶部卡下拉浮层）。
                IdentityPanel embed 承载①资料/备份+②设备+危险区，顶部账号卡经 topSlot 注入。 */}
            <div className="backrowd"><button className="bk" onClick={() => setAccountView(false)}>‹ 返回</button><span className="h2d nav-title">账号</span></div>
            <IdentityPanel
              onClose={() => setAccountView(false)}
              embed
              onLogin={() => setPageView('method')}
              /* 2026-10-13 P1：设备名单/在线状态已让给「🤖 智能体」Tab——账号页设备区只留一句
                 引导，点「去查看 →」直接切到该 Tab（关账号页 + 切 mainTab，不留半屏残影）。 */
              onOpenAgentsTab={() => { setAccountView(false); setMainTab('agents') }}
              /* 退出登录（2026-10-06 补入口）：接已有 handleLogout（myco_logout 只清会话，
                 种子槽保留）+ 收起账号页回欢迎屏（未登录首屏）。 */
              onLogout={() => { void handleLogout(); setAccountView(false) }}
              /* 2026-10-01 重排：顶部卡=头像+名+尾号+切换入口。role 徽章删——凭据状态是
                 「本机对该账号持有什么凭据」，改由下拉菜单行文案（credText）表达；
                 ③账号管理区（accountsSlot）整区下线——切换/登录/创建全收进下拉。 */
              topSlot={acctTopLine ? (
                <div className="cardd" style={{ borderColor: '#b9c6ff' }}>
                  {/* 2026-10-03 单行布局（用户实测：名/尾号上下两行+右侧大片空白）：
                      [头像] 名 ·…尾4 [弹性空白] [切换账号 ▾]。名长→ellipsis 收缩
                      （同顶栏 accountShortLabel 拼接口径），极端窄才吃尾号；
                      title 悬停看全名+完整 did 兜底。样式合同=ACCT_LINE_SHRINK。 */}
                  {/* 2026-10-03 二轮（用户实测：名与图标空白大/上下不齐/头像要彩色）：
                      [彩色圆头像 28px] 紧跟 名·…尾4（alignItems center 整行垂直居中，
                      名与尾号同 baseline 由行内天然对齐）。gap 从 9 收到 7 去空白；
                      头像色按名字 hash 散列（复用 scanAddOrder 同款 palette 思路，加本地实现）。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }} title={acctTopLine.full}>
                    <span style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff', background: avatarHue(acctTopLine.nm) }}>{acctTopLine.nm.slice(0, 1).toUpperCase()}</span>
                    <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      <span className="acct-cardd nm" style={{ fontSize: 13.5, fontWeight: 700, ...ACCT_LINE_SHRINK.nm }}>{acctTopLine.nm}</span>
                      <span className="acct-cardd didt" style={ACCT_LINE_SHRINK.tail}>{acctTopLine.tail}</span>
                    </span>
                    {/* 2026-10-06 凭据徽章（NAMING-RATIONALE 定稿：主设备=embodiment 持账号钥可管理；
                        成员=agent 受委任只读）。状态标识唯一位=本顶部卡（防处处提醒）；
                        'saved'（有种子）按主设备，unlinked/空不显示。 */}
                    {youling?.role === 'embodiment' || youling?.role === 'saved' ? (
                      <span className="chipd green" style={{ fontSize: 10.5, padding: '1px 7px', gap: 3, flexShrink: 0 }} title="主设备——本机持有账号钥匙，可管理设备"><KeyRound size={11} />主设备</span>
                    ) : youling?.role === 'agent' ? (
                      <span className="chipd amber" style={{ fontSize: 10.5, padding: '1px 7px', gap: 3, flexShrink: 0 }} title="成员——能用、只读；管理请到主设备"><User size={11} />成员</span>
                    ) : null}
                    <span style={{ flexShrink: 0 }}>
                      {switchMenuVisible(accounts, youling?.rootDid, sameAccountDid) ? (
                        <button className="btnd ghost small" onClick={openAcctMenu}>切换账号 ▾</button>
                      ) : (
                        /* 单账号：无可选账号，空下拉反模式——只放登录入口小链接 */
                        <span className="linkish" style={{ fontSize: 11.5 }} onClick={() => setPageView('method')}>＋ 登录另一个账号</span>
                      )}
                    </span>
                  </div>
                </div>
              ) : undefined}
            />

            {/* ── 切换账号下拉浮层（2026-10-01 真下拉）：账号列表+凭据状态文案+登录/创建入口 ──
                定位=clampMenuPos（同 chatOps 右键菜单，贴边翻转不出窗）；当前账号置顶灰显不可点。 */}
            {acctMenu.open && youling?.rootDid && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 89 }} onClick={closeAcctMenu} />
                <div ref={acctMenuRef} className="cardd" style={{
                  position: 'fixed', left: acctMenu.x, top: acctMenu.y, zIndex: 90,
                  width: ACCT_MENU_W, maxWidth: 'calc(100vw - 8px)', maxHeight: '70vh', overflowY: 'auto',
                  display: 'flex', flexDirection: 'column', gap: 2, padding: 6, boxShadow: '0 8px 28px rgba(20,30,60,.16)',
                }}>
                  {acctMenuItems(accounts, youling.rootDid, sameAccountDid).map((m) => (
                    <div key={m.did} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8,
                      cursor: m.current ? 'default' : 'pointer', opacity: m.current ? 0.55 : 1 }}
                      onClick={() => { if (!m.current) { closeAcctMenu(); void handleRelogin(m.did) } }}
                      title={normalizeAccountDid(m.did) + ' · 最后登录 ' + (m.lastLogin?.slice(0, 10) ?? '?')}
                      onMouseEnter={(e) => { if (!m.current) e.currentTarget.style.background = 'var(--chip-bg)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      <span className="acct-cardd av" style={{ width: 28, height: 28, fontSize: 13 }}>{(nicknameValue(m.name) || '灵').slice(0, 1).toUpperCase()}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{accountDisplayName(m.name)} <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 11, color: 'var(--txm)', fontWeight: 400 }}>{accountTail(m.did)}</span></div>
                        <div className="tinyd" style={{ marginTop: 1 }}>{credText(m.role)}</div>
                      </span>
                      {m.current && <span style={{ fontSize: 11, color: 'var(--ok, #16a34a)', fontWeight: 600, flexShrink: 0 }}>● 当前</span>}
                    </div>
                  ))}
                  <div className="dividerd" />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--accent)' }}
                    onClick={() => { closeAcctMenu(); setPageView('method') }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--chip-bg)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>＋ 登录另一个账号</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--accent)' }}
                    onClick={() => { closeAcctMenu(); setPageView('create') }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--chip-bg)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>＋ 创建新账号</div>
                </div>
              </>
            )}

            </>)}
            {setOpen && (
              <section className="cardd" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button onClick={() => setLlmOpen((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                  <span className="h2d">{llmOpen ? '▾' : '▸'} 高级设置 · 模型端点（LLM Agent）</span>
                </button>
                {llmOpen && (<>
                <div className="tinyd">认知 C 层——给 myco 接入大模型。{providers.length > 0 && <span className="chipd gray" style={{ fontSize: 9, padding: '1px 6px', marginLeft: 4, cursor: 'pointer' }} onClick={() => setPForm({ id: '', name: '', baseUrl: '', model: '', authToken: '' })}>＋ 新增</span>}</div>
                {providers.map((p) => (
                  <div className="row" key={p.id} title={p.baseUrl}>
                    <span className={`dot ${p.authToken ? 'on' : ''}`} title={p.authToken ? '已配密钥' : '未配密钥'} />
                    <span className="name flex1 truncate">{p.name}{p.model ? <span className="muted small"> · {p.model}</span> : null}</span>
                    {p.id === defProvider && <span className="chip on" style={{ cursor: 'default' }}>默认</span>}
                    <span className="chip" style={{ cursor: 'pointer' }} title="测试连接" onClick={() => void testProvider(p.id)}>{testing === p.id ? '测试中…' : '测试'}</span>
                    {p.id !== defProvider && <span className="chip" onClick={() => void post('/api/provider_set_default', { id: p.id }).then(refreshSettings)} title="设为默认">设默认</span>}
                    <span className="chip" onClick={() => setPForm({ ...p, authToken: '' })} title="编辑">编辑</span>
                    <span className="chip" onClick={() => { if (confirm(`删除 Provider「${p.name}」?`)) void post('/api/provider_delete', { id: p.id }).then(refreshSettings) }} title="删除">删</span>
                  </div>
                ))}
                {pForm && (
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                    <div className="row"><input value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} placeholder="名称(如 zhipu)" /></div>
                    <div className="row"><input value={pForm.baseUrl} onChange={(e) => setPForm({ ...pForm, baseUrl: e.target.value })} placeholder="baseUrl" /></div>
                    <div className="row"><input value={pForm.model ?? ''} onChange={(e) => setPForm({ ...pForm, model: e.target.value })} placeholder="模型" /></div>
                    <div className="row"><input type="password" value={pForm.authToken ?? ''} onChange={(e) => setPForm({ ...pForm, authToken: e.target.value })} placeholder="密钥(留空=保留)" /></div>
                    <div className="row"><button onClick={() => void saveProvider()}>保存</button><span className="chip" onClick={() => setPForm(null)}>取消</span></div>
                  </div>
                )}
                </>)}
              </section>
            )}
          </section>
        )}
        {!accountView && !myResumeOpen && doneAcct && (
          <div className="centerd" style={{ marginTop: 36, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 46 }}>✅</div>
            <div className="h1d">已登录</div>
            <div className="subd">当前账号：<b>{accountShortLabel(doneAcct.name, doneAcct.tail)}</b></div>
            <div className="tinyd" style={{ textAlign: 'center' }}>本机现在可以：扫码确认网页登录 · 接任务干活<br />以后打开 myco 自动是它，无需重复登录</div>
            <button className="btnd" style={{ marginTop: 10 }} onClick={() => setDoneAcct(null)}>开始使用</button>
            <button className="btnd ghost" onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
              let url = PLATFORM_BASE + '/'
              try { url = (await m.invoke('auto_login_url', { pageUrl: PLATFORM_BASE + '/' })) as string } catch { /* 降级 */ }
              try { await m.invoke('open_external', { url }) } catch { window.open(url) }
            })}>🧭 去有灵探索一下 →</button>
          </div>
        )}
        {!accountView && !myResumeOpen && !doneAcct && (
        <>
        {/* ══ 第37轮：demo 整建制移植（ued/myco-multi-account-demo.html home 屏，DOM/类名/配色 1:1）═══
            滚动模型=demo 同款：.demo-scr 整页滚，卡片随内容长；数据接线=boardProjs/devices/accounts。 */}

        {youling?.rootDid && (<>
        {/* 探索卡（demo 323 方案A） */}
        <div className="cardd" style={{ cursor: 'pointer' }} onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
          let url = PLATFORM_BASE + '/'
          try { url = (await m.invoke('auto_login_url', { pageUrl: PLATFORM_BASE + '/' })) as string } catch { /* 降级 */ }
          try { await m.invoke('open_external', { url }) } catch { window.open(url) }
        })}>
          <div className="h2d" style={{ fontSize: 12.5 }}>🧭 去探索</div>
          <div className="tinyd">有灵 · 大千世界（打开有灵网页）</div>
        </div>

        {/* 升级卡（运维必要；demo 无此元素——仅发现新版时出现，样式融 demo） */}
        {updPer?.hasUpdate && (
          <div className="cardd" style={{ borderColor: '#6b7bff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>⬆ 新版 {updPer.serverVersion}</div>
                {/* 更新说明：点击展开/再点折叠（▾ 指示；hover title 亦有全文兜底） */}
                <div className="tinyd" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }} title={updPer.notes} onClick={() => setUpdNotesOpen((v) => !v)}>{updPer.notes}</div>
              </span>
              <span className="tinyd" style={{ flexShrink: 0, cursor: 'pointer', color: '#6b7bff', fontWeight: 700, alignSelf: 'flex-end', padding: '0 2px 2px 0' }} onClick={() => setUpdNotesOpen((v) => !v)}>{updNotesOpen ? '▴' : '▾'}</span>
              <button className="btnd small" disabled={updBusy} onClick={startUpdate}>{updBusy ? '更新中…' : '确认更新'}</button>
            </div>
            {updBusy && (
              <div style={{ marginTop: 6 }}>
                <div className="tinyd" style={{ color: 'var(--accent)' }}>{updMsg || '更新启动中…'}</div>
                {updProg?.phase === 'downloading' && updProg.total > 0 && (
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(107,123,255,.15)', marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, updProg.pct)}%`, borderRadius: 2, background: '#6b7bff', transition: 'width .3s' }} />
                  </div>
                )}
              </div>
            )}
            {updErr && (
              <div className="tinyd" style={{ marginTop: 6, color: '#e5534b', lineHeight: 1.5, userSelect: 'text' }}>{updErr}</div>
            )}
            {updNotesOpen && updPer.notes && (
              <div className="tinyd" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #d3dcf5', lineHeight: 1.7, wordBreak: 'break-word', userSelect: 'text' }}>{updPer.notes}</div>
            )}
          </div>
        )}
        </>)}

        {/* ── 欢迎首屏（未登录）：2026-10-06 整体重设计（设计定稿"太难看"）——
            层级 = 品牌/欢迎语 → 本机账号列表（主操作：一键登录）→ 登录其他账号 → 创建新账号。
            样式 .welcome* 在 demo.css（五主题 biolum 变量）；
            文案 2026-10-06 审校（对照表见会话报告）：主语明确化/去赘语/场景放宽。 ── */}
        {!youling?.rootDid && (
          <div className="welcome">
          <div className="welcome-hero">
            <div className="welcome-logo" aria-hidden>灵</div>
            <div className="h1d" style={{ fontSize: 19 }}>欢迎使用有灵</div>
            <div className="subd">有灵账号是你的永久身份——换手机、换电脑，都是同一个「我」。新设备出示识别码，主设备扫码确认即可登录。</div>
          </div>
          {accounts.length > 0 && (
            <div className="welcome-accounts">
            <div className="welcome-sec-title">本机保存的有灵账号 · 点一下即登录</div>
            {/* 凭据徽章=主设备/成员 chip（NAMING-RATIONALE 定稿图标 KeyRound/User，
                同账号页顶部卡语言）；长解释走 title 悬停，不再占欢迎屏教学行 */}
            {accounts.map((a) => {
              const role = (a as { role?: string }).role
              return (
                <div key={a.did} className="acct-row welcome-acct" onClick={() => void handleRelogin(a.did)}
                  title={`${accountDisplayName(a.name)} · ${normalizeAccountDid(a.did)}\n${credText(role)} · 最后登录 ${a.lastLogin?.slice(0, 10) ?? '未知'}`}>
                  <span className="av" style={{ background: avatarHue(a.name || a.did), color: '#fff' }}>{(a.name || '灵').slice(0, 1).toUpperCase()}</span>
                  <span className="meta">
                    <div className="nm"><span className="nm-t">{accountDisplayName(a.name)}</span> <span className="did">{accountTail(a.did)}</span></div>
                    {role === 'embodiment' ? (
                      <span className="chipd green" style={{ fontSize: 10.5, padding: '1px 7px', gap: 3, alignSelf: 'flex-start' }} title={credText(role)}><KeyRound size={11} />主设备</span>
                    ) : role === 'agent' ? (
                      <span className="chipd amber" style={{ fontSize: 10.5, padding: '1px 7px', gap: 3, alignSelf: 'flex-start' }} title={credText(role)}><User size={11} />成员</span>
                    ) : (
                      <span className="chipd gray" style={{ fontSize: 10.5, padding: '1px 7px', alignSelf: 'flex-start' }} title={credText(role)}>凭据已失</span>
                    )}
                  </span>
                  <span className="welcome-login-btn">登录</span>
                </div>
              )
            })}
            </div>
          )}
          <button className="btnd welcome-primary" onClick={() => { setAccountView(true); setPageView('method') }}>登录有灵账号</button>
          <div className="tinyd centerd">出示识别码扫码授权，或用恢复码导入</div>
          <div className="textlink"><span className="linkish" onClick={() => { setAccountView(true); setPageView('create') }}>第一次用有灵？创建新账号 →</span></div>
          {reloginMsg && <div className="tinyd" style={{ color: '#dc2626' }}>{reloginMsg}</div>}
          </div>
        )}

        {/* 内容区（demo 325-346：tasks/agents 同卡，devline 行）——已登录才显示 */}
        {youling?.rootDid && (<>
        {mainTab === 'tasks' && (
          <>
          {/* 第91轮：能力值紧凑卡（任务页顶）——当前 Beta 均值 / 目标门槛(SLA) / 95%CI；
              α+β<5 或无 ci95 → "样本不足"；点卡片开完整作业档案（原底部链接的入口职责收编于此） */}
          {myAbilities != null && (
            <div className="cardd" style={{ cursor: 'pointer' }} onClick={() => setMyResumeOpen(true)}
              title="点开完整作业档案（经验值/角色任务/积分）">
              <div className="h2d" style={{ fontSize: 12.5 }}>📊 我的能力档案
                {myAbility && <span className="tinyd" style={{ fontWeight: 400, marginLeft: 6 }}>{ROLE_LABEL[myAbility.role] ?? myAbility.role}</span>}
              </div>
              {myAbility ? (() => {
                const meanPct = myAbility.mean == null ? null : pctClamped(myAbility.mean)
                const targetPct = claimedThreshold == null ? null : pctClamped(claimedThreshold)
                const enough = myAbility.alpha + myAbility.beta >= 5 && myAbility.ci95 != null
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 3, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12 }}>当前 <b style={{ fontSize: 15, color: 'var(--ac, #4338ca)' }}>{meanPct == null ? '—' : `${Math.round(meanPct)}%`}</b></span>
                      <span className="tinyd">目标 {targetPct == null ? '—' : `${Math.round(targetPct)}%`}</span>
                      {enough && myAbility.ci95 ? (
                        <span className="tinyd">95% CI {fmtPct(myAbility.ci95[0])}~{fmtPct(myAbility.ci95[1])}</span>
                      ) : (
                        <span className="tinyd" style={{ opacity: 0.55 }}>样本不足</span>
                      )}
                    </div>
                    {/* 迷你条：mean 填充 + 目标刻度（目标缺失只画填充） */}
                    <div style={{ position: 'relative', height: 6, borderRadius: 999, background: 'rgba(107,123,255,.12)', marginTop: 7 }}>
                      {meanPct != null && (
                        <div style={{ width: `${Math.max(meanPct, 2)}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#6b7bff,#4d8dff)' }} />
                      )}
                      {targetPct != null && (
                        <div style={{ position: 'absolute', left: `calc(${Math.min(targetPct, 100)}% - 1px)`, top: -2, bottom: -2, width: 2, borderRadius: 1, background: '#e65100' }} />
                      )}
                    </div>
                  </>
                )
              })() : (
                <div className="tinyd" style={{ marginTop: 3 }}>还没有能力画像——领取任务开始答题后长出</div>
              )}
            </div>
          )}
          {/* 第89轮：统一任务列表——不分来源（youling 领的/好友分享的混排），空态给引导 */}
          <div className="cardd">
            <div className="h2d" style={{ fontSize: 12.5 }}>我的任务</div>
            {youlingTasks.length === 0 && peerTasks.length === 0 && (
              <div className="tinyd" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ flex: '1 1 auto' }}>
                  {youlingTasksErr ? '平台同步未开放或未领取' : '还没有领取中的任务——去有灵广场看看'}
                </span>
                {!youlingTasksErr && (
                  <span className="linkish" style={{ flexShrink: 0 }} onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
                    let url = PLATFORM_BASE + '/'
                    try { url = (await m.invoke('auto_login_url', { pageUrl: url })) as string } catch { /* 降级 */ }
                    try { await m.invoke('open_external', { url }) } catch { window.open(url) }
                  })}>去探索 →</span>
                )}
              </div>
            )}
            {youlingTasks.map((t) => (
              <div key={`${t.taskId}-${t.mode}`} className="devline" style={{ marginTop: 6, cursor: 'pointer', flexWrap: 'wrap', rowGap: 3 }} title={`${t.title}${t.slaText ? ' · ' + t.slaText : ''}——在 youling 网页继续做题`}
                onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
                  let url = t.entry || `${PLATFORM_BASE}/task/${t.taskId}`
                  try { url = (await m.invoke('auto_login_url', { pageUrl: url })) as string } catch { /* 降级用原 url */ }
                  try { await m.invoke('open_external', { url }) } catch { window.open(url) }
                })}>
                <span className="dot" style={{ background: '#1677ff' }} />
                <span style={{ flex: '1 1 55%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {t.title}{t.slaText ? <span className="tinyd" style={{ fontSize: 10, fontWeight: 400 }}> · {t.slaText}</span> : null}
                </span>
                <span className="endchip go">继续做题 →</span>
                <span style={{ flexBasis: '100%', paddingLeft: 14, display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                  {t.mode && <span className="chipd gray" style={{ fontSize: 9.5, padding: '1px 6px', flexShrink: 0 }}>{MODE_LABEL[t.mode] ?? t.mode}</span>}
                  <span className="tinyd" style={{ fontSize: 10 }}>待做 {t.pending} · 今日已答 {t.answeredToday}</span>
                </span>
              </div>
            ))}
            <PeerTasksCard tasks={peerTasks} onChanged={refreshPeerTasks} hideTitle />
          </div>
          {/* 新任务=独立功能入口（不属于任务列表） */}
          <div className="cardd">
            <div className="textlink"><span className="linkish" onClick={() => void import('@tauri-apps/api/core').then(async (m) => {
              let url = PLATFORM_BASE + '/'
              try { url = (await m.invoke('auto_login_url', { pageUrl: url })) as string } catch { /* 降级 */ }
              try { await m.invoke('open_external', { url }) } catch { window.open(url) }
            })}>＋ 新任务</span></div>
          </div>
          </>
        )}

        {mainTab === 'agents' && (
          <div className="cardd">
            <div className="h2d" style={{ fontSize: 12.5 }}>我的智能体</div>
            {/* 2026-10-13 P0：设备操作层（AgentDevices）——在线态三档醒目 + 放行/暂停放行/
                授权本机/除名（二次确认）/复制 DID；委任状剩余徽标按 pubkey 匹配（本机不显示）。
                名单复用 App 的名册（myco_list_devices，30s 轮询），组件自取放行态与委任状剩余。 */}
            <AgentDevices
              devices={devices}
              canManage={youling?.role === 'embodiment'}
              ownerRootDid={youling?.rootDid ?? null}
              onToast={pushTaskToast} />

          {/* 第81轮：好友/群/聊天（服务器中转+本地存储；任务卡分享）——好友分区挂在"我的智能体"卡下方 */}
          <FriendsZone boardProjs={boardProjs} onPeerTasks={onPeerTasks} peerTasks={peerTasks} onUnreadTotal={setUnreadChatN} />
          </div>
        )}
        </>)}
        </>
        )}
      </main>
      {/* 第83轮：任务卡事件 toast（fixed 不占布局——任意 Tab 下来卡/完成都有通知） */}
      {taskToasts.length > 0 && (
        <div style={{ position: 'fixed', top: 46, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          {taskToasts.map((t) => (
            <div key={t.id} style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(30,35,50,.92)', color: '#fff', fontSize: 12.5, boxShadow: '0 4px 14px rgba(0,0,0,.25)', maxWidth: 280 }}>{t.text}</div>
          ))}
        </div>
      )}
      {/* 底部 tab（demo：仅 home 屏有；登录流/账号页/done 屏无） */}
      {!!youling?.rootDid && !accountView && !myResumeOpen && !doneAcct && (
      <div className="tabbar">
        <button className={'tabbtn' + (mainTab === 'tasks' ? '' : ' ghost')} onClick={() => setMainTab('tasks')}>
          📋 任务
          {/* 第83轮：有待接受的分享任务 → 红点数字角标（不知道能点/有新卡 的醒目提示） */}
          {peerPendingN > 0 && (
            <span style={{ marginLeft: 5, minWidth: 16, height: 16, borderRadius: 8, background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', verticalAlign: 'middle' }}>{peerPendingN}</span>
          )}
        </button>
        <button className={'tabbtn' + (mainTab === 'agents' ? '' : ' ghost')} onClick={() => setMainTab('agents')}>
          🤖 智能体
          {/* 批三：聊天未读总数角标（免打扰会话不计入；与窗口标题同数据源） */}
          {unreadChatN > 0 && (
            <span style={{ marginLeft: 5, minWidth: 16, height: 16, borderRadius: 8, background: '#e5534b', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', verticalAlign: 'middle' }}>{unreadChatN > 99 ? '99+' : unreadChatN}</span>
          )}
        </button>
      </div>
      )}

      {/* ══ 账号格式停用：模态阻断（2026-10-09 与手机端对齐——设计定稿：不说"旧格式"，
          说"格式无效，不支持"；模态不可关闭，只有两个出口）══ */}
      {identityStore.accountFormatLegacy && youling?.rootDid && !regOpen && !legacyModalOff && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 20, maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>⚠️ {LEGACY_FORMAT_TITLE}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#3b475e', marginBottom: 14 }}>{LEGACY_FORMAT_BODY}</div>
            <button className="btnd" style={{ width: '100%', marginBottom: 8, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 9, padding: '10px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              onClick={async () => {
                setRegBusy(true); setRegErr(null)
                try {
                  await client.invoke('myco_unbind')
                  if (youling?.rootDid) localStorage.removeItem(`myco-pc.accountBackedUp:${youling.rootDid}`)
                  // 2026-10-13 修（用户实测"点了没反应"）：解绑成功后必须刷新身份态——
                  // identityStore 里 accountFormatLegacy/rootDid 不更新，模态显示条件
                  // 恒真 ⇒ 界面纹丝不动（与 IdentityPanel.doUnbind 的 loadYouling 对齐）。
                  await identityStore.loadYouling()
                  // 落点＝未关联欢迎屏（出示识别码加入他机 / 重新注册，都在那）
                  setLegacyModalOff(true); setAccountView(false)
                } catch (e) { setRegErr(String(e).replace(/^Error:\s*/, '')) }
                finally { setRegBusy(false) }
              }}
              disabled={regBusy}>
              {regBusy ? '处理中…' : '清除此账号（回未关联态）'}
            </button>
            {regErr && (
              <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6, lineHeight: 1.6 }}>{regErr}</div>
            )}
            <button className="btnd ghost" style={{ width: '100%', fontSize: 13, padding: '8px', cursor: 'pointer' }}
              onClick={() => {
                // 2026-10-13 修（用户实测"点了停留"）：放行模态让用户真能到账号页备份；
                // legacy 红标仍在账号页上，备份完可从那里回来继续清除/重注册。
                setLegacyModalOff(true); setAccountView(true); setPageView('page')
              }}>
              {LEGACY_FORMAT_ACTION_BACKUP}
            </button>
            <div style={{ fontSize: 11, color: '#6b7bff', marginTop: 10, lineHeight: 1.6 }}>
              清除后，你可以：<br />
              · 作为<b>成员设备</b>加入其他设备（出示识别码）<br />
              · 或重新注册新账号
            </div>
          </div>
        </div>
      )}

      {/* 重新注册确认（模态内嵌套——保留但默认不打开） */}
      {identityStore.accountFormatLegacy && youling?.rootDid && regOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 20, maxWidth: 380, width: '100%' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', marginBottom: 8 }}>确认重新注册</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: '#3b475e', marginBottom: 10 }}>
              将<b>删除本机账号钥</b>并创建新账号。<br />
              此操作<b>不可撤销</b>——若未备份恢复码，此账号将永久丢失。
            </div>
            <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="给新账号起个名字"
              style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border,#d7dfeb)', fontSize: 13, boxSizing: 'border-box' as const, marginBottom: 10 }} />
            {regErr && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{regErr}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btnd ghost" style={{ flex: 1, fontSize: 13, padding: '8px' }} onClick={() => { setRegOpen(false); setRegErr(null) }} disabled={regBusy}>返回</button>
              <button className="btnd" style={{ flex: 2, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '9px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                disabled={regBusy || !regName.trim()}
                onClick={async () => {
                  setRegBusy(true); setRegErr(null)
                  try {
                    await client.invoke('myco_unbind')
                    if (youling?.rootDid) localStorage.removeItem(`myco-pc.accountBackedUp:${youling.rootDid}`)
                    await identityStore.createYouling(regName.trim() || undefined)
                    setRegOpen(false); setRegName('')
                  } catch (e) {
                    setRegErr(String(e).replace(/^Error:\s*/, ''))
                  } finally { setRegBusy(false) }
                }}>
                {regBusy ? '处理中…' : '确认删除并重新注册'}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}