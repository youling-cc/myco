/**
 * open-retry.ts — 「点卡就进」取票失败的**自动重试策略 + 人话文案**（2026-10-12）。
 *
 * 背景（用户真机实测问题，见 §协调板 2026-10-12）：
 *   手机上点任务卡，转几秒后卡下面冒出「源设备不在线（或那台设备没有可直连的地址），
 *   稍后再试」，可设备行明明亮着「● 在线 / ☁ 中转」；重启一次 myco 又好了。
 *   真因不是设备离线，而是**一次瞬时失败就收摊**：
 *     · 设备行那两枚徽标是**预测**（云端在场 TTL ~45s + 每 15s 轮询；中转 = 直连
 *       探测不通后的路由判断），都不是"这条路当下通不通"的实测；
 *     · 真建连要过 LAN/IPv6 直连 → P2P 隧道 → 云端中继（要求中继里**当下**有那台
 *       设备的注册，注册是 PC 进程内长连接 + 30s 心跳，进程一重启就断几秒）；
 *     · 而取票只跑一趟（Provider A 控制消息等 1.5s，A/B/C 三条腿共 ~3s 预算），
 *       全败即把话说死——设备重启、换网、中继重注册这几秒全被算成"设备不在线"。
 *
 * 这一版把"几秒的抖动"挡在用户看不见的地方：
 *   ① **offline 类失败自动退避重试**（本文件 `OPEN_RETRY_DELAYS_MS`，共 4 趟 ≈ 6s）；
 *   ② 重试期间 UI 显示进度（`retryNote`），不是干等；
 *   ③ 真失败时**按场景说人话**（`finalOpenNote`：中继里没看到 / 中继不可达 / 设备
 *      连不上 / 你不在名单），并如实报告重试次数。
 *
 * 不可重试的失败一律原样透出（`isTransientOpenFailure`）：拒绝/不在名单/已过期/
 * 入口数据坏了——这些重试一百次也不会变好，只会让用户多等 6 秒。
 */

/** 重试间隔（毫秒）：第 1 次失败后等 700ms，再 1.8s，再 3.5s；合计约 6s + 4 趟尝试耗时。 */
export const OPEN_RETRY_DELAYS_MS: readonly number[] = [700, 1800, 3500]

/** 取票失败原因（与 dsh-open.ts 的 `EntryError.reason` 同词表）。 */
export type OpenFailReason = 'offline' | 'denied' | 'gone' | 'no-entry' | 'expired' | 'unsupported' | 'internal'

/** 能不能靠"再试一次"变好。只有**连不上/拿不到**这类瞬时原因算数。 */
export function isTransientOpenFailure(reason: string | undefined): boolean {
  if (reason === 'gone') return false // 分享已停止：重试一百次也不会回来
  return reason === 'offline' || reason === undefined || reason === ''
}

/** 最近一次失败像什么（决定最终文案的口径）。纯函数，单测直击。 */
export type OpenFailKind =
  | 'relay-missing'
  | 'relay-busy'
  | 'relay-unavailable'
  | 'relay-unreachable'
  | 'auth'
  | 'denied'
  | 'share-gone'
  | 'device-unreachable'
  | 'other'

/**
 * 按**最近一次**的错误文本归类。
 *
 * 为什么按文本而不是按 reason：同一个 `offline` 底下混着几种物理原因（中继里没这台
 * 设备 / 中继卡槽满 / 中继本身连不上 / 设备确实连不上 / 本机身份没就绪），它们给用户
 * 的下一步动作完全不同——"等一下就好"、"看看手机网络"、"重启一次 myco"、"让对方开机"。
 *
 * 顺序要紧：**具体原因排在泛化的「不在线/连不上」前面**（2026-10-16 真案四种原因原来
 * 全塌成最后那句「在线但连不上」，用户看不出该做什么）。
 */
export function classifyOpenFailure(message: string): OpenFailKind {
  if (/已经不在了|已停止分享|分享已停止|分享不存在/.test(message)) { return 'share-gone' }
  const m = message || ''
  if (/并发通道已满|云端通道忙|BUSY/.test(m)) return 'relay-busy'
  if (/云端通道没接上|没接上云端通道|UNAVAILABLE/.test(m)) return 'relay-unavailable'
  if (/签名没通过|身份还没就绪|身份未就绪/.test(m)) return 'auth'
  if (/云端中转无此设备|NOT_FOUND|不在中继|没看到那台设备|中转里没看到/.test(m)) return 'relay-missing'
  if (/云端中转服务器不可达|中转服务器响应异常|中转服务器.*不可达|连不上云端中转/.test(m)) return 'relay-unreachable'
  if (/名单|没有权限|未授权|已被拒绝|被拒|denied/.test(m)) return 'denied'
  if (/不在线|连不上|没有可连接的地址|没有可直连的地址|暂时打不开/.test(m)) return 'device-unreachable'
  return 'other'
}

/** 设备名兜底（空/全空白的名字一律"对方设备"）。 */
function nameOf(deviceName: string | undefined): string {
  const n = (deviceName || '').trim()
  return n || '对方设备'
}

/**
 * 「瞬时失败就再试一趟」的通用外壳（纯逻辑、可注入 sleep → 单测直击）。
 *
 * 语义（dsh-open-runtime 的取票重试就是它）：
 *   · 最多跑 `delays.length + 1` 趟；
 *   · 每趟之间按 `delays` 依次等待（递增退避），等之前先 `onRetry(下一趟序号, 总趟数)`
 *     ——UI 用它把"正在重试…（2/4）"摆出来；
 *   · `isTransient(结果)` 为假 → **立刻**返回（拒绝/过期这类重试没意义）；
 *   · 返回值带 `attempts`（实际跑了几趟），文案据此如实报次数。
 */
export async function retryTransient<T>(
  run: (attempt: number) => Promise<T>,
  opts: {
    delays: readonly number[]
    isTransient: (v: T) => boolean
    onRetry?: (nextAttempt: number, totalAttempts: number) => void
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const total = opts.delays.length + 1
  let value!: T
  let attempts = 0
  for (let i = 0; i < total; i++) {
    attempts = i + 1
    value = await run(attempts)
    if (!opts.isTransient(value)) break
    if (attempts >= total) break
    opts.onRetry?.(attempts + 1, total)
    await sleep(opts.delays[i])
  }
  return { value, attempts }
}

/**
 * 等到 `ready()` 为真，或超时（纯逻辑、可注入 sleep/now → 单测直击）。
 *
 * 返回**等了多久毫秒**（已经就绪 = 0）；超时返回 `null`。
 *
 * 为什么需要它（2026-10-16 真机真案）：手机 app 从"后台冻结"被唤醒时，WebView 的 JS
 * 恢复了但**身份还没加载完**（日志实证 `[relay-provider] 装配第 1 次未成：身份未就绪`）。
 * 那一刻点卡会立刻发取票请求，而签名材料还没就绪 → 源设备那道签名闸直接把请求挡在
 * 签票逻辑之前（PC 侧审计里连一条记录都没有）→ 用户看到"在线但连不上"，重试四趟
 * 白等 40 多秒，重启 app 立刻就好。取票前先等一下，比失败后重试便宜得多。
 */
export async function waitUntil(
  ready: () => boolean,
  opts: {
    timeoutMs: number
    pollMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<number | null> {
  const pollMs = opts.pollMs ?? 150
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const t0 = now()
  if (ready()) return 0
  while (now() - t0 < opts.timeoutMs) {
    await sleep(pollMs)
    if (ready()) return now() - t0
  }
  return null
}

/** 名册设备行（自愈挑选用；字段名与 identity.PresenceByRootDevice 对齐）。 */
export interface RosterRowLike {
  did: string
  name?: string
  online?: boolean
  revoked?: boolean
}

/**
 * **旧卡自愈**的候选：源设备记录已失效时，从名册里挑几台**在线**的同伴设备去问一遍。
 *
 * 为什么这么挑（2026-10-12 真机取证）：设备群里那张旧卡写着来源 `OFFICE-PC`，可这台
 * 设备早不在名册（换过绑定/改名），而分享其实活在同一账号的另一台设备上。取票请求
 * `share-entry-request` 本身**不含目标字段**（按传输层寻址），所以把同一张票的请求换个
 * 设备发出去：托管的设备会应答、不托管的会回"已经不在了"——谁托管谁应答。
 *
 * 三条护栏：① 只在**源设备不在名册**时才走这条（正常路径一个字不改）；② 只挑在册且在
 * 线的（问离线设备纯白等）；③ 上限 cap 台（默认 3），逐台问、拿到第一张有效票就收工。
 */
export function pickHealTargets(
  roster: RosterRowLike[],
  sourceDid: string,
  myDeviceDid: string,
  cap = 3,
): { did: string; name?: string }[] {
  const src = (sourceDid || '').trim()
  const mine = (myDeviceDid || '').trim()
  return roster
    .filter((r) => r && r.online === true && r.revoked !== true)
    .filter((r) => !!r.did && r.did !== src && r.did !== mine)
    .slice(0, Math.max(0, cap))
    .map((r) => ({ did: r.did, name: r.name }))
}

/**
 * 把卡上的**来源设备**换成另一台（自愈用）：只改 `sourceDevice` / `sourceDeviceName`，
 * 其余字段一字不动（shareId / 来源账号 / 标题 / 可见范围都不能碰）。
 * 卡可能是摊平的、也可能嵌在 `payload.card` 里 → 两处都认。
 */
export function withSourceDevice(
  raw: Record<string, unknown>,
  did: string,
  name?: string,
): Record<string, unknown> {
  const nested = raw.card && typeof raw.card === 'object' ? (raw.card as Record<string, unknown>) : null
  if (nested) {
    return {
      ...raw,
      card: { ...nested, sourceDevice: did, sourceDeviceName: name ?? nested.sourceDeviceName },
    }
  }
  return { ...raw, sourceDevice: did, sourceDeviceName: name ?? raw.sourceDeviceName }
}

/** 重试期间的进度文案（卡片下面那行字）。 */
export function retryNote(deviceName: string | undefined, nextAttempt: number, totalAttempts: number): string {
  return `「${nameOf(deviceName)}」暂时连不上，正在重试…（第 ${nextAttempt}/${totalAttempts} 次）`
}

/** 源设备在名册里的状态（决定最终文案的口径；`unknown` = 名册查不到，别乱猜）。 */
export type SourceDeviceState = 'online' | 'offline' | 'gone' | 'unknown'

/**
 * 收摊时的最终文案：
 *   · 非瞬时原因（拒绝/过期/入口坏了）→ **原样透出**（那是准确的、可行动的信息）；
 *   · 瞬时原因 → 按场景给口径 + 如实报告已重试几次 + 一句下一步。
 *
 * 2026-10-12 二版（用户问「重试 4 趟仍失败的那张卡怎么回事」）：把「来源设备记录
 * 本身失效」单独分出来。真机实测：设备群里的旧卡写着来源 `OFFICE-PC`，而该设备早
 * 不在名册（换过绑定/改过名），四趟重试全打在同一个死地址上，用户只看到"暂时连不上"，
 * 白等 6 秒还看不懂该找谁。名册三态（在线 / 离线 / 不在册）各有各的下一步。
 */
export function finalOpenNote(input: {
  deviceName?: string
  message: string
  reason?: string
  attempts: number
  source?: SourceDeviceState
}): string {
  const { message, reason, attempts, source = 'unknown' } = input
  if (!isTransientOpenFailure(reason)) return message || '打不开这个任务，稍后再试'
  const name = nameOf(input.deviceName)
  const tried = attempts > 1 ? `（已自动重试 ${attempts - 1} 次）` : ''
  switch (classifyOpenFailure(message)) {
    case 'relay-busy':
      return `云端中转忙（「${name}」的并发通道满了）${tried}——过几秒再点一次`
    case 'relay-unavailable':
      return `「${name}」的云端通道没接上（收到了但没应答）${tried}——过几秒再点一次`
    case 'auth':
      return `本机身份还没就绪（签名没通过）${tried}——把 myco 切到前台等它连上，或重启一次再点`
    case 'relay-missing':
      return `云端中转里暂时没看到「${name}」${tried}——它可能刚重启，过十几秒再点一次`
    case 'relay-unreachable':
      return `连不上云端中转${tried}——先看看手机网络，再点一次`
    case 'denied':
      return message
    case 'device-unreachable':
      if (source === 'gone') {
        return `这张卡的来源设备「${name}」已经不在你的设备名册里了（换过绑定或已移除）${tried}——让对方重新分享一次`
      }
      if (source === 'offline') {
        return `「${name}」当前离线${tried}——等它开机（或连上网）后再点一次`
      }
      if (source === 'online') {
        return `「${name}」在线但连不上${tried}——可能刚重启或正在切网，稍后再点一次`
      }
      return `「${name}」暂时连不上${tried}——可能刚重启或正在切网，稍后再点一次`
    default:
      return `${message}${tried}`
  }
}
