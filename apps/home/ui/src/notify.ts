/* notify.ts — 系统通知封装（批三：tauri-plugin-notification）。
 * 语义（微信对齐）：窗口聚焦时静默；免打扰会话/全局开关关 → 不发；
 * 同一会话的新通知顶掉旧的（id=convId 散列）；点击 → 聚焦主窗 + 跳该会话。
 * 浏览器/embed 无 tauri 环境 → 全链路静默降级（动态 import + catch）。 */

import { chatNotifContent, type ConvRow, type ConvPref } from './chatOps'

const ENABLED_KEY = 'myco-notify-enabled'

/** 全局"新消息通知"开关（设置页持久化；默认开）。 */
export function notifEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) !== '0' } catch { return true }
}
export function setNotifEnabled(v: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, v ? '1' : '0') } catch { /* 容错 */ }
}

/** convId → 32-bit 通知 id（同会话新通知顶替旧的，不堆叠）。 */
function notifIdOf(convId: string): number {
  let h = 0
  for (let i = 0; i < convId.length; i++) h = (h * 31 + convId.charCodeAt(i)) >>> 0
  return (h & 0x7fffffff) || 1
}

type NotifApi = typeof import('@tauri-apps/plugin-notification')
let permCache: boolean | null = null

/** 权限确保（首次询问；拒绝/无环境 → false 静默降级）。 */
export async function ensureNotifPermission(): Promise<boolean> {
  if (permCache !== null) return permCache
  try {
    const m: NotifApi = await import('@tauri-apps/plugin-notification')
    let granted = await m.isPermissionGranted()
    if (!granted) {
      const p = await m.requestPermission()
      granted = p === 'granted'
    }
    permCache = granted
  } catch { permCache = false }
  return permCache
}

/** 窗口是否"用户正看着"（聚焦且可见）——微信语义：看着就静默。 */
function windowWatched(): boolean {
  try { return !document.hidden && document.hasFocus() } catch { return false }
}

/** 聊天消息通知主入口：前置闸（全局开关/会话免打扰/窗口聚焦）→ 系统通知。
 *  返回是否真发出（测试/调试可观测）。 */
export async function sendChatNotif(conv: ConvRow, prefs: Record<string, ConvPref>, fromName?: string): Promise<boolean> {
  if (!notifEnabled()) return false
  if (prefs[conv.id]?.mute) return false
  if (windowWatched()) return false
  if (!(await ensureNotifPermission())) return false
  try {
    const m: NotifApi = await import('@tauri-apps/plugin-notification')
    const { title, body } = chatNotifContent(conv, fromName)
    m.sendNotification({
      id: notifIdOf(conv.id),
      title,
      body,
      autoCancel: true,
      extra: { convId: conv.id },
    })
    return true
  } catch { return false }
}

/** 通知点击 → 聚焦主窗 + 回调 convId（调用方跳会话）。幂等注册（重复调用只挂一次）。 */
let actionBound = false
export async function bindNotifAction(onOpenConv: (convId: string) => void): Promise<void> {
  if (actionBound) return
  actionBound = true
  try {
    const m: NotifApi = await import('@tauri-apps/plugin-notification')
    await m.onAction((n) => {
      const convId = (n.extra as { convId?: unknown } | undefined)?.convId
      // 聚焦主窗（无边框窗也在任务栏可达；set-focus 权限已配）
      void import('@tauri-apps/api/window')
        .then((w) => w.getCurrentWindow().setFocus())
        .catch(() => {})
      if (typeof convId === 'string' && convId) onOpenConv(convId)
    })
  } catch { actionBound = false }
}

/** 通知 id 散列暴露（会话已读时清掉其待发通知用）。 */
export async function cancelConvNotif(convId: string): Promise<void> {
  try {
    const m: NotifApi = await import('@tauri-apps/plugin-notification')
    await m.cancel([notifIdOf(convId)])
  } catch { /* 静默 */ }
}
