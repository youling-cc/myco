/**
 * task-open.ts — **任务卡的「打开」路由**（PC，2026-10-23）。
 *
 * 为什么需要这一层（真机 bug）：
 *   任务列表行的左键一直是「照着 `action.kind === 'open-url'` 打开 URL」。
 *   分享卡改成带 `env[]` 之后，卡的真实入口是**环境**（RDP/DSH/…），但列表行仍拿着
 *   旧的 `open-url`（跨设备投递时还被改写成 remoteOpen）→ 浏览器落到分享入口
 *   `/gw/<id>/app/` → 页面报 `no valid share cookie (open the share entry first)`
 *   （cookie 只在入口 `/gw/<id>/` 的 302 里种；`/app/` 是反代面，直接开必报）。
 *
 * 路由规则（入口只来自卡，R28）：
 *   ① 卡上有**显式** `env[]`（或动作 `kind === 'open-env'` 且带 env）→ `vnet_env_open`：
 *      后端按 env 建 `127.0.0.1:<固定口>` 链路并起客户端（RDP→mstsc / DSH→浏览器）。
 *      **绝不调 open_external、绝不回落分享入口**（离线/无服务/无权限时就地给人话）。
 *   ② 没有 env 的老卡 → 原样 `open-url`（scheme 白名单不变，行为与改造前一致）。
 *   ③ 其它/未知 kind → `none`（UI 不显示动作，纪律同 §3.10）。
 *
 * 注意：这里只认**显式** env（`Array.isArray(card.env) && length > 0`），
 * 不用 `envsOfCard` 的「老卡按 sourceDevice 派生 rdp」——那条派生只用于气泡里的
 * env 行渲染；拿它改列表行行为会把所有老分享卡都从分享页改成 RDP 直连，属于行为漂移。
 */
import {
  capsGate,
  capsOfCard,
  envsOfCard,
  KIND_LABEL,
  openArgs,
  resultNote,
  rowStateOf,
  stateText,
  type EnvOpenResult,
  type EnvRowState,
  type TaskEnv,
} from './task-env'

/** 任务卡动作（与 Rust `share_card_record` 的 `action` 同形状；未知字段忽略）。 */
export interface TaskCardAction {
  kind?: string
  url?: string
  label?: string
  target?: string
  /** `open-env`：卡声明的全部 env（接收方按 env 建链） */
  env?: unknown[]
  /** `open-env`：卡身份（审计/幂等用） */
  shareId?: string
}

/** action.url 的 scheme 白名单：任务卡可由他人下发，只允许 http/https/myco://，
 *  拒 file://、javascript: 等本机执行面（协议 §3.10 纪律 2）。 */
export function safeActionUrl(u?: string): string | null {
  if (!u) return null
  if (u.startsWith('myco://')) return u
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * 卡上**显式声明**的 env（动作里的 env 优先于卡面 env——跨设备投递时动作是权威副本）。
 *
 * 与 `envsOfCard` 的区别：这里**不做**老卡的 `sourceDevice → rdp` 派生。
 * 返回 `[]` = 这张卡没有 env 入口（调用方保持 open-url）。
 */
export function declaredEnvsOfCard(
  card: Record<string, unknown> | null | undefined,
  action?: TaskCardAction | null,
): TaskEnv[] {
  const c = card || {}
  if (Array.isArray(c.env) && c.env.length > 0) {
    const fromCard = envsOfCard(c)
    if (fromCard.length) return fromCard
  }
  if (Array.isArray(action?.env) && action.env.length > 0) {
    return envsOfCard({ env: action.env })
  }
  return []
}

/** 主 env：`rdp → dsh → 声明顺序第一条`（与 Rust `primary_env` / 手机端同序）。 */
export function primaryEnvOf(envs: TaskEnv[]): TaskEnv | null {
  if (!envs.length) return null
  return envs.find((e) => e.kind === 'rdp') || envs.find((e) => e.kind === 'dsh') || envs[0]
}

/** `open-env` 的按钮文案（"打开远程桌面" / "打开 DSH Web"）。 */
export function envOpenLabel(env: TaskEnv): string {
  // DSH web 是英文名：读作"打开 DSH Web"（与 Rust `env_action_label` 逐字一致）
  if (env.kind === 'dsh') return '打开 DSH Web'
  return `打开${KIND_LABEL[env.kind] || '环境'}`
}

/** 动作文案：卡给的 label 优先，其次按主 env 推导（后端新卡两者一致）。 */
export function actionLabelOf(
  action: TaskCardAction | null | undefined,
  envs: TaskEnv[],
): string {
  const l = (action?.label || '').trim()
  if (l) return l
  const env = primaryEnvOf(envs)
  return env ? envOpenLabel(env) : '打开'
}

/** 打开动作的依赖注入点（单测据此断言"到底调了哪条路"）。 */
export interface TaskOpenDeps {
  /** Tauri IPC（`vnet_env_open`）；缺失 = 浏览器调试页，给一句人话而不是假装成功。 */
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /** `open_external`（老卡的 open-url 路径）。 */
  openExternalUrl?: (url: string) => Promise<unknown> | unknown
}

export interface TaskOpenOutcome {
  /** env=按环境建链 / url=打开链接 / none=没有可执行动作 */
  via: 'env' | 'url' | 'none'
  ok: boolean
  /** env 路径的终态（ready/building/offline/no-service/denied/idle） */
  state?: EnvRowState
  /** 给人看的一句话（env 路径必有；url 路径为空） */
  note: string
  env?: TaskEnv
  /** 行内按钮文案（"打开远程桌面"） */
  label: string
}

/**
 * 执行一次「打开」。**纯路由**：不读 React、不读设备名册，只按卡与动作决定调哪条路。
 *
 * 关键不变量（单测锁死）：
 *   · 有 env → 只调 `vnet_env_open`，**绝不**调 `open_external`；
 *   · 无 env + open-url → 只调 `open_external`；
 *   · env-open 返回 offline/no-service/denied → 不补开浏览器（不把失败伪装成"打开了"）。
 */
export async function runTaskOpen(
  card: Record<string, unknown> | null | undefined,
  action: TaskCardAction | null | undefined,
  deps: TaskOpenDeps,
): Promise<TaskOpenOutcome> {
  const envs = declaredEnvsOfCard(card, action)
  const label = actionLabelOf(action, envs)
  if (envs.length) {
    const env = primaryEnvOf(envs) as TaskEnv
    // 卡身份/caps 一起带给执行器（`openArgs` 的契约）：动作里的 env 可能比卡面更新，
    // 这里把生效的 env 回填进卡副本，避免"动作有 env、卡面没有"时执行器看不到声明。
    const cardForArgs: Record<string, unknown> = { ...(card || {}) }
    if (!(Array.isArray(cardForArgs.env) && cardForArgs.env.length > 0)) {
      cardForArgs.env = Array.isArray(action?.env) ? action.env : envs
    }
    if (!env.device) {
      return {
        via: 'env',
        ok: false,
        state: 'denied',
        note: '卡上缺少目标设备信息，请让对方重新分享',
        env,
        label,
      }
    }
    if (capsGate(capsOfCard(cardForArgs)) === 'denied') {
      // 客户端预检（后端同样会 denied）：立即给红字，不必往返一次
      return { via: 'env', ok: false, state: 'denied', note: stateText('denied', env.kind), env, label }
    }
    const invoke = deps.invoke
    if (!invoke) {
      return { via: 'env', ok: false, state: 'idle', note: '当前环境不支持（没有本机 IPC）', env, label }
    }
    try {
      const res = (await invoke('vnet_env_open', {
        args: openArgs(cardForArgs, env),
      })) as EnvOpenResult | null
      const state = rowStateOf(res)
      const note = resultNote(res) || stateText(state, env.kind)
      return { via: 'env', ok: state === 'ready' || !!res?.ok, state, note, env, label }
    } catch (e) {
      // IPC 层失败（旧 exe 没这条命令/参数错）：不当成功，也不谎报离线
      const msg = e instanceof Error ? e.message : String(e)
      return { via: 'env', ok: false, state: 'idle', note: `调用失败：${msg}`, env, label }
    }
  }
  if (action?.kind === 'open-url') {
    const url = safeActionUrl(action.url)
    if (url) {
      await deps.openExternalUrl?.(url)
      return { via: 'url', ok: true, note: '', label }
    }
  }
  return { via: 'none', ok: false, note: '', label }
}
