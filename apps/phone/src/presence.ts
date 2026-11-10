/* presence.ts — 在线状态灯纯函数（第84轮三态灯；2026-09-29 灯恢复抽出可测）。
 *
 * 三态灯映射（两端一致，PC 端 apps/home/ui/src/presence.ts 同构）：
 *   offline        → 灰（off）
 *   active         → 绿常亮
 *   typing         → 绿呼吸（CSS animation 1.2s）
 *   idle | locked  → 烛光橘
 * 数据源：listPresence（服务器 /presence/list，15s 轮询）聚合到好友账号粒度。
 */

/** 好友在线状态（presence 聚合：任一设备在线即 online；state 取最新交互设备）。 */
export interface FriendPresence { online: boolean; state: string; deviceName: string }

// 2026-10-07：presence 表键 = 服务器上报的账号 did 形态，查询键 = 名册/会话 did 形态，
// 两者可以是同一把钥匙的不同历史形态——查表一律走**公钥级**等价查找（否则灯/typing 恒灭）。
import { accountDidAliases, accountDidEq, convKey } from './didUtil'

/** 别名感知查表：直查命中优先，再按等价形态逐个查（含 did_safe 下划线形态还原；
 *  软 did/群 id 只有自己一个）。 */
export function presenceOf(map: Record<string, FriendPresence>, did: string): FriendPresence | undefined {
  const direct = map[did]
  if (direct) return direct
  const k = convKey(did)
  const canon = map[k]
  if (canon) return canon
  for (const a of accountDidAliases(k)) {
    const hit = map[a]
    if (hit) return hit
  }
  return undefined
}

export type PresenceDotClass = 'off' | 'active' | 'typing' | 'idle' | 'locked'

/** 状态 → 灯样式类名（三态映射的唯一权威）。 */
export function presenceDotClass(p?: FriendPresence | null): PresenceDotClass {
  if (!p?.online) return 'off'
  if (p.state === 'typing') return 'typing'
  if (p.state === 'active') return 'active'
  if (p.state === 'idle' || p.state === 'locked') return p.state
  return 'active' // 老版本无 state 字段：在线即绿灯
}

/** 灯 hover 文案。 */
export function presenceDotTitle(p?: FriendPresence | null): string {
  if (!p?.online) return '离线'
  if (p.state === 'typing') return '正在输入…'
  if (p.state === 'active') return '在线'
  if (p.state === 'locked') return '已锁屏（灯还亮着）'
  return '在，但没在动（灯还亮着）'
}

/** typing 上报节流器（3s 内多次输入只放行一次——"输入框有内容变化即上报，节流 3s"）。 */
export function makeThrottle(gapMs: number): (now: number) => boolean {
  let last = -Infinity
  return (now: number) => {
    if (now - last < gapMs) return false
    last = now
    return true
  }
}

/** 群内任一成员 typing → 其账号 did（"多人会话：任一 typing 显示 X 正在输入…"）。 */
export function firstTypingMember(
  members: readonly string[],
  presence: Record<string, FriendPresence>,
  myDid?: string,
): string | null {
  for (const m of members) {
    if (accountDidEq(m, myDid)) continue
    const p = presenceOf(presence, m)
    if (p?.online && p.state === 'typing') return m
  }
  return null
}

/** 无输入判 idle 阈值（设计定稿 5min；PC 端 presence.rs IDLE_THRESHOLD_MS 同值）。 */
export const IDLE_THRESHOLD_MS = 300_000

/** 本机设备状态决策（presence 上报的 state 字段）：typing TTL > 后台 > 5min 无交互 > active。
 *  手机不能可靠检测锁屏，息屏/切后台按 idle 报（visibilitychange 驱动即时重报）。 */
export function computePhoneState(args: {
  now: number
  typingUntil: number
  visible: boolean
  lastInteractionAt: number
}): 'active' | 'typing' | 'idle' {
  if (args.now < args.typingUntil) return 'typing'
  if (!args.visible) return 'idle'
  if (args.now - args.lastInteractionAt > IDLE_THRESHOLD_MS) return 'idle'
  return 'active'
}
