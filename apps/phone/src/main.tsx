import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
// 第37轮：demo 整建制皮肤（与 exe home 同源，ued/myco-multi-account-demo.html 1:1）
import './demo.css'
// phone-chat.css 全局加载：theme-dot 等共享原语单一来源（ChatView/HistoryPanel 共用）。
import './styles/phone-chat.css'
// CLI 通道（三端一致机制）：window.MycoCli 挂载——APK EnvServer POST /api/cli 与
// 浏览器控制台共用（无 UI 全功能：identity/sign/device/delegation 词表同 myco-ubuntu）。
import { installMycoCli } from './cli'
import { chatPoll } from './chat-store'
installMycoCli()
// 分享任务卡「点卡就进」（2026-10-09）：挂 window.MycoDshShare + 安装原生桥回调表
// ——`window.__mycoTunnel` **必须早于**原生第一次回调（原生 onConn/onData 直接打它）。
// 未在 APK 里跑时是安全 no-op。
import { installTaskShare, wireChatRelayFallback, tunnelNetworkChanged } from './dsh-open-runtime'
import { bootVnetForwards, resetNetworkStreams } from './vnet-forward'
installTaskShare()
// 2026-10-22 手机端 vnet 固定端口转发（外网 RDP/SSH/DSH）：延迟 3s 启动，避免抢启动资源
setTimeout(() => {
  try {
    bootVnetForwards()
  } catch {
    /* 老壳/无桥：静默 */
  }
}, 3000)

// 聊天投递的云中继兜底（2026-10-12"直连优先、不通走中转"，与分享链路同构）：
// 手机异地（跨 v6 段）直推/对账全断时，经 8321 mux 的 WS 隧道投到对端 :9100。
wireChatRelayFallback()
// 2026-11-11：把本机设备身份尽早注入 libvnet。PC 侧启用 peer identity 后，
// 未认证的入站 vnet 流一律被拒——不注入的表现是"隧道能建、请求发出去没下文"，
// 排查成本极高（详见 vnet-identity.ts）。失败不阻塞启动，起隧道前还会再试一次。
void import('./vnet-identity').then((m) => m.ensureVnetIdentity()).catch(() => {})
// 2026-10-20 B1（AlarmManager 唤醒兜底）：原生 FreezeWakeReceiver 每 ~9min 注入本钩子，
// 强制一次 chatPoll（拉信箱 + 官方通知 pending，新消息会触发系统通知），并补一次隧道 tick。
// 冻结期 relay 入站字节被压制（delivery_suspended）时，靠它主动拉，而不是等 push。
;(window as unknown as Record<string, unknown>).__mycoAlarmWake = () => {
    try { (window as unknown as Record<string, unknown>).__mycoTick && ((window as any).__mycoTick as () => void)() } catch { /* best-effort */ }
    try { void chatPoll().catch(() => {}) } catch { /* best-effort */ }
    return 1
}

// 2026-10-30 外部 WiFi/移动网真案：系统网络回调不能只通知 ShareWebActivity。
// 主进程 KeepAliveService 注入这里——半开 open 隧道也强制重探、清远端地址缓存、
// RDP/DSH 原生流先回 relay-only，再异步补 direct 候选。
let networkResetTimer: ReturnType<typeof setTimeout> | null = null
function runNetworkReset(): string {
    let r: string = 'none'
    try { r = tunnelNetworkChanged() } catch { /* best-effort */ }
    try { resetNetworkStreams() } catch { /* best-effort */ }
    try {
      const shell = (window as unknown as { MycoShell?: { markJsTick?: () => void } }).MycoShell
      shell?.markJsTick?.()
    } catch { /* best-effort */ }
    return r
}
;(window as unknown as Record<string, unknown>).__mycoNetChanged = (delay?: unknown) => {
    // ShareWebActivity 旧协议传 1200ms（先重连隧道再刷新页面）；全局回调不传则立即。
    // 两条来源可能同拍到达，这里合并成一次，避免连续拆隧道。
    if (networkResetTimer !== null) return 'already-scheduled'
    const ms = Math.max(0, Number(delay) || 0)
    if (ms === 0) {
      try { return runNetworkReset() } catch { return 'error' }
    }
    networkResetTimer = setTimeout(() => {
      networkResetTimer = null
      try { runNetworkReset() } catch { /* best-effort */ }
    }, ms)
    return 'scheduled'
}

// 真机取证通道（与 MycoDshShare 同款传统）：EnvServer/adb eval 直接触发一次真实
// 的 p2pDeliver（含直推→中继兜底全梯子），验证跨网投递不靠 UI 打字。
import { p2pDeliver, buildEnvelope } from './p2p'
;(window as unknown as Record<string, unknown>).MycoChat = {
  deliver: (accountDid: string, text: string) =>
    p2pDeliver(accountDid, buildEnvelope(accountDid, 'text', { text }, `m${Date.now().toString(16)}-0`, Date.now())),
}

// 2026-10-12 手机当**中继 provider**（PC→手机方向兜底）：注册到云中继 + 常驻本地
// 隧道口（数据面 port=9100 的入站隧道分流到帧内 HTTP → ingestWireMsg）。
// RelayProvider 是 Java 常驻线程（REGISTER+30s 心跳+ACCEPT 接单泵到本地口）。
// 可重试：身份/本地口未就绪（首启竞态）时 5s 后再试，最多 12 次（1 分钟内）。
import { currentIdentity } from './identity'
import { startLocalListener, hasNativeProxy } from './native-proxy'
;(async () => {
  for (let i = 0; i < 12; i++) {
    try {
      if (!hasNativeProxy()) throw new Error('native bridge 未就绪')
      const did = currentIdentity()?.did
      if (!did) throw new Error('身份未就绪')
      const port = await startLocalListener()
      const shell = (window as unknown as { MycoShell?: { relayProviderStart?: (d: string, p: number) => string } }).MycoShell
      if (!shell?.relayProviderStart) throw new Error('MycoShell.relayProviderStart 不存在（旧 APK 壳）')
      const r = shell.relayProviderStart(did, port)
      console.log(`[relay-provider] 已装配（…${did.slice(-4)} → 本地 :${port}）${r}`)
      return
    } catch (e) {
      console.log(`[relay-provider] 装配第 ${i + 1} 次未成：${e instanceof Error ? e.message : String(e)}（5s 后重试）`)
      await new Promise((res) => setTimeout(res, 5000))
    }
  }
  console.log('[relay-provider] 装配重试耗尽——本进程不再试（重启 app 再来）')
})()

// 2026-10-22 V15：myco 自更新（手机端）。
// 启动 30s 后检查一次（24h 节流；仅 App 可见时）；有新版 → 经本地代理口让 Java
// DownloadManager 下载并自动弹安装。全程静默，失败不影响主流程。
// 取证入口：window.__mycoUpdateCheck(true)（adb / EnvServer eval）。
import { installUpdateBridge, checkForUpdate } from './update-check'
try { installUpdateBridge() } catch { /* ignore */ }
setTimeout(() => {
  void checkForUpdate()
    .then((r) => { try { console.log('[update]', JSON.stringify(r)) } catch { /* ignore */ } })
    .catch(() => undefined)
}, 30000)

// 吞掉 "ResizeObserver loop limit exceeded / loop completed with undelivered notifications"
// ——浏览器在 RO 回调引发同帧布局变化时的保护性日志，功能无害但会被 webview 当错误弹出来。
// 这是业界标准处理（AG Grid/Monaco 同款）；真正的修复（rAF 延迟）已在 ChatView 里。
window.addEventListener('error', (e) => {
  const m = e.message || ''
  if (m.includes('ResizeObserver loop')) {
    e.stopImmediatePropagation()
    e.preventDefault()
  }
}, true)

// 全局错误取证：未捕获异常/Promise 拒绝 → /tlog 回传服务器（journalctl 可查）。
// 用于抓"界面莫名状态"的现场（如 tab 按钮消失）——带 stack 前 260 字符。
const tlogErr = (kind: string, msg: string) => {
  try {
    fetch(`${location.origin}/tlog`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: `[ui-err] ${kind} ${msg}`.slice(0, 280) }),
    }).catch(() => {})
  } catch { /* 忽略 */ }
}
window.addEventListener('error', (e) => {
  const m = e.message || ''
  if (m.includes('ResizeObserver loop')) return
  tlogErr('error', `${m} @${e.filename}:${e.lineno} ${(e.error?.stack || '').slice(0, 160)}`)
})
window.addEventListener('unhandledrejection', (e) => {
  tlogErr('rejection', String(e.reason).slice(0, 200))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// ── E2E/dev 钩子（2026-10-20）：聊天发送（R1/R2/R6/R8 真机取数用）───────────────
// 放在 main.tsx 而不是 chat-store.ts：chat-store 可能被按需加载，钩子要"启动即可用"。
// 仅 localStorage.myco_eval === '1' 时存在；生产完全不可见。
void (async () => {
  try {
    if (!(typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('myco_eval') === '1')) return
    const { chatSendText, chatSendGroup, ensureDeviceGroup } = await import('./chat-store')
    const g = window as unknown as Record<string, unknown>
    const prev = (g.__mycoEval as Record<string, unknown> | undefined) ?? {}
    g.__mycoEval = {
      ...prev,
      /** 发一条文本到会话（to = convId：好友 did 或 grp-dev-* 群 id）。
       *  2026-10-20 修正：群消息必须走 `chatSendGroup`（它才带 members → targets 非空；
       *  用 chatSendText 发群会得到 targets=[]、消息永远出不去——真机 0/10 的根因）。 */
      sendText: (to: string, text: string) => {
        // 设备群：本地群档案可能还没建（App 重装/首次启动）→ 先 ensure，否则 chatSendGroup
        // 会抛"群不存在"，消息一条都发不出去（真机 0/10 的第二根因）。
        const conv = to.startsWith('grp-dev-') ? (ensureDeviceGroup() ?? to) : to
        return (conv.startsWith('grp-') ? chatSendGroup(conv, { text }) : chatSendText(conv, text))
          .then(() => 'ok').catch((e) => String(e))
      },
    }
  } catch { /* ignore */ }
})()
