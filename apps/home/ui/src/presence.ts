/* presence.ts — 在线状态灯纯函数（第84轮三态灯；2026-09-29 灯恢复抽出可测）。
 *
 * 三态灯映射（两端一致，手机端 apps/phone/src/presence.ts 同构）：
 *   offline        → 灰（off）
 *   active         → 绿常亮
 *   typing         → 绿呼吸（CSS animation 1.2s）
 *   idle | locked  → 烛光橘
 * 数据源：chat_presence（服务器 /presence/list 聚合）+ p2p-typing 瞬时信号。
 */

/** 好友在线状态（chat_presence 聚合结果）。 */
export interface FriendPresence { online: boolean; state: string; deviceName: string; devices: number }

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

/** typing 上报节流器（3s 内多次输入只放行一次——"输入框有内容变化即上报，节流 3s"）。
 *  返回的函数给出当前时刻（ms），放行=true。 */
export function makeThrottle(gapMs: number): (now: number) => boolean {
  let last = -Infinity
  return (now: number) => {
    if (now - last < gapMs) return false
    last = now
    return true
  }
}

/** 群内任一成员 typing → 其账号 did（"多人会话：任一 typing 显示 X 正在输入…"）。
 *  members 含自己——调用方传 myDid 排除；presence 键=账号 did。 */
export function firstTypingMember(
  members: readonly string[],
  presence: Record<string, FriendPresence>,
  myDid?: string,
): string | null {
  for (const m of members) {
    if (m === myDid) continue
    if (presence[m]?.online && presence[m]?.state === 'typing') return m
  }
  return null
}
