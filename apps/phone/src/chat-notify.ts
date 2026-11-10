/**
 * chat-notify.ts — 批四：新消息通知调度（手机侧）。
 *
 * 数据源：chat-store 的 onMessageIngested（内容类消息真实入库且去重后触发）。
 * 语义（微信同款）：
 *  - 前台且正在聊该会话 → 不通知（屏内消息自己看得见）
 *  - 免打扰会话 → 不通知（convprefs.muted；App 级未读徽章同规则不计数）
 *  - APK 壳：MycoShell.notifyChat(title, body) → 系统通知（渠道 myco_chat，壳侧注册）
 *  - PWA 降级：页面标题闪烁「【新消息】名字: 摘要」4s 还原（无壳环境的弱提醒）
 *
 * openConv 由 ChatScreen 挂载/卸载时登记——判定"正在聊"的唯一权威。
 */
import { onMessageIngested, convPref, convPreview } from './chat-store'

/** 当前打开的会话 id（null=会话列表/别的屏）。ChatScreen mount/unmount 维护。 */
let openConv: string | null = null
export function setOpenConv(convId: string | null): void { openConv = convId }

interface MycoShellNotify { notifyChat?: (title: string, body: string) => void }

const baseTitle = typeof document !== 'undefined' ? document.title : ''
let flashTimer: ReturnType<typeof setTimeout> | null = null

/** PWA 降级：标题闪烁 4s（后台标签页/浏览器内可见性提醒；还原回原标题）。 */
function flashTitle(text: string): void {
  if (typeof document === 'undefined') return
  document.title = text
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { document.title = baseTitle }, 4000)
}

/** 是否应静默（纯函数，单测覆盖）：免打扰 / 前台正在聊该会话。 */
export function shouldSilence(convId: string, muted: boolean, openConvId: string | null, visible: boolean): boolean {
  if (muted) return true
  return visible && openConvId === convId
}

let started = false
/** 进程级单例（App 根身份就绪后调用一次；重复调用幂等）。 */
export function ensureChatNotify(): void {
  if (started) return
  started = true
  onMessageIngested((convId, m) => {
    try {
      const muted = !!convPref(convId).muted
      const visible = typeof document === 'undefined' ? true : document.visibilityState === 'visible'
      if (shouldSilence(convId, muted, openConv, visible)) return
      const name = (m.fromName || '').trim() || `…${(m.from || '').slice(-4)}`
      const body = convPreview(m).slice(0, 60) || '新消息'
      const shell = (window as unknown as { MycoShell?: MycoShellNotify }).MycoShell
      if (shell?.notifyChat) {
        // APK 壳：系统通知（渠道注册/权限兜底都在壳侧）
        shell.notifyChat(name, body)
        return
      }
      // PWA 降级：标题闪烁
      flashTitle(`【新消息】${name}: ${body.slice(0, 20)}`)
    } catch { /* 通知失败不殃及入库 */ }
  })
}
