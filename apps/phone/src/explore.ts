/**
 * explore.ts — 「去探索」免登（手机版，对齐 PC `auto_login_url` lib.rs:797）。
 *
 * 事故（2026-10-15 用户报）：手机点「探索有灵」打开的网页**没有登录**——PC 的探索
 * 按钮早已走 出票→签名→callback→`?autologin=<ticket>` 免登链（2026-10-12 还支持了
 * 分身），手机端一直是裸 `<a href>` 直开。
 *
 * 链路（与 PC 完全同协议）：
 *   ① POST {PLATFORM}/api/v1/auth/qr-tickets {provider:"myco"} → data.ticketId
 *   ② 签名两态（与 YoulingLogin 扫码确认同一套）：
 *      主设备（持根钥）→ 根钥签 "myco-auth\n{ticket}" → POST {ticket, did:rootDid, sig}
 *      分身（持委任状）→ 设备钥签 + 委任状随行
 *        → POST {ticket, did:deviceDid, sig, delegation:JSON(委任状)}——平台验链落账 accountDid
 *   ③ 拼 URL：{page}?autologin={ticket}（page 已含 ? 则 &）——平台前端轮询到
 *      ticket=confirmed 直接落会话，浏览器免扫码免点击。
 *
 * 互踢防线（PC 第92轮教训，内测 18:05-18:23 被循环踢 9 次的根因）：每次完整走一遍
 * DID 登录舞步=平台同 did 重登=踢掉浏览器旧会话。票按身份缓存 10 分钟，窗口内重复
 * 点击直接复用旧票，不再出票不再 callback。
 *
 * 零损失兜底：任一步失败（未建号/无委任/网络不通/平台拒绝）→ 原样返回 pageUrl
 * （平台落扫码页，用户还能手动登，不会更糟）。
 */
import { getRootIdentity, getRootSeed, signWithRoot, currentIdentity } from './identity'
import { loadDelegation, pollDelegation, signWithDeviceKey, devicePubkeyB64 } from './delegation'
import { NETWORK_URL } from './config'

/** 平台页基址（从 config.ts 取，可通过 VITE_NETWORK_URL 覆盖；2026-11-03 开源配置化）。 */
const PLATFORM = NETWORK_URL
/** 票复用窗口：同身份 10 分钟内不出新票（防互踢，同 PC AUTO_LOGIN_TICKET）。 */
export const TICKET_WINDOW_MS = 10 * 60_000

/** 单测注入面：网络与时间都可替身。 */
export interface ExploreDeps {
  now?: () => number
  postJson?: (url: string, body: unknown) => Promise<{ ok: boolean; status: number; json: any }>
}

interface CachedTicket { did: string; at: number; ticket: string }
let cached: CachedTicket | null = null

/** 仅测试用：清票缓存（单测隔离）。 */
export function __resetExploreCacheForTest(): void { cached = null }

/** 拼目标 URL：page 已含 ? 用 &（同 PC with_ticket）。 */
export function withTicket(pageUrl: string, ticket: string): string {
  const sep = pageUrl.includes('?') ? '&' : '?'
  return `${pageUrl}${sep}autologin=${ticket}`
}

/** 缓存判定抽出为纯函数（单测锚点）：同身份且在窗口内才复用。 */
export function cacheUsable(c: CachedTicket | null, did: string, now: number): c is CachedTicket {
  return !!c && c.did === did && now - c.at < TICKET_WINDOW_MS
}

/**
 * 生成免登后的探索 URL。pageUrl 通常传 EXPLORE_URL；返回值可能就是原样 pageUrl（降级）。
 */
export async function exploreAutologinUrl(pageUrl: string, deps: ExploreDeps = {}): Promise<string> {
  const now = deps.now ?? Date.now
  const postJson = deps.postJson ?? shellAwarePost

  // 身份判定（与 YoulingLogin.confirm 同口径）：
  // ① 主设备=真持根钥（vault 有 rootDid 但无 seed 的分身槽不算，走 ②）
  const rootDid = getRootIdentity()
  const rootMode = !!(rootDid && getRootSeed())
  // ② 分身=委任状绑定本机当前设备钥。
  //    2026-10-15 真机事故（用户报「点探索打开的网页没登录」）：手机 localStorage 里的委任状
  //    丢了（重装/清缓存），而**云端信箱里躺着一张新鲜有效的**——原实现只在"本地有状但过期"
  //    时探信箱，本地**完全无状**就直接降级裸链接，于是永远取不回来。
  //    修：本地无状或状过期，都先探一次信箱（pollDelegation 内部会把取到的状落盘）。
  const dlg0 = loadDelegation()
  const deviceDid = currentIdentity()?.did ?? null
  const pk = devicePubkeyB64()
  let cred = dlg0 && deviceDid && pk && dlg0.devicePubkeyB64 === pk ? dlg0 : null
  if (!rootMode && !!deviceDid && (!cred || cred.exp <= now())) {
    const fresh = await pollDelegation()
    if (fresh && fresh.devicePubkeyB64 === pk && fresh.exp > now()) cred = fresh
  }
  const dlgUsable = !rootMode && !!cred && !!deviceDid && cred.exp > now()
  // 无任何可用身份 → 直接裸链接（平台落扫码页），零网络请求
  const cacheKey = rootMode ? rootDid! : (dlgUsable ? deviceDid! : null)
  if (!rootMode && !dlgUsable) {
    console.warn('[explore] 无可用身份，降级裸链接:', deviceDid ? (cred ? 'cred-expired' : 'no-cred-mailbox-empty') : 'no-device-identity')
    return pageUrl
  }

  // 窗口内同身份 → 复用旧票（不出票不签名不 callback，防互踢）
  if (cacheKey && cacheUsable(cached, cacheKey, now())) return withTicket(pageUrl, cached.ticket)

  try {
    // ① 出票
    const t = await postJson(`${PLATFORM}/api/v1/auth/qr-tickets`, { provider: 'myco' })
    if (!t.ok) throw new Error(`qr-tickets HTTP ${t.status}`)
    const ticket = t.json?.data?.ticketId
    if (!ticket || typeof ticket !== 'string') throw new Error('no ticketId')

    // ② 签名两态 + 回调确认
    let cbBody: Record<string, unknown>
    if (rootMode) {
      const sig = signWithRoot(`myco-auth\n${ticket}`)
      if (!sig) throw new Error('根身份锁定或缺失')
      cbBody = { ticket, did: rootDid, sig }
    } else {
      const sig = await signWithDeviceKey(`myco-auth\n${ticket}`)
      if (!sig) throw new Error('设备身份未就绪')
      cbBody = { ticket, did: deviceDid, sig, delegation: JSON.stringify(cred!) }
    }
    const cb = await postJson(`${PLATFORM}/api/v1/auth/myco/callback`, cbBody)
    if (!cb.ok || cb.json?.ok === false) throw new Error(cb.json?.error ? String(cb.json.error) : `callback HTTP ${cb.status}`)

    // ③ 成功 → 记缓存（下次 10 分钟内直接复用）
    if (cacheKey) cached = { did: cacheKey, at: now(), ticket }
    return withTicket(pageUrl, ticket)
  } catch (e) {
    // 零损失降级：同身份旧票优先（平台侧票死则落扫码页）→ 无则原样返回
    console.warn('[explore] 免登失败，降级裸链接:', String(e).slice(0, 140))
    if (cacheKey && cached?.did === cacheKey) return withTicket(pageUrl, cached.ticket)
    return pageUrl
  }
}

/**
 * 签名一张已有的 ticket 并提交平台确认（2026-10-28 深链接登录 DL-Auth 用）。
 * 与 exploreAutologinUrl 内部逻辑完全同构——只是 ticket 来自外部（深链接）而非自出票。
 * 返回 {ok:true} = 平台已确认；{ok:false,error} = 失败原因。
 */
export async function signAutologinTicket(ticket: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const rootDid = getRootIdentity()
    const rootSeed = getRootSeed()
    const rootMode = !!rootSeed
    const deviceDid = currentIdentity()?.did ?? null
    const postJson = shellAwarePost

    let cbBody: Record<string, unknown>
    if (rootMode && rootDid) {
      const sig = signWithRoot(`myco-auth\n${ticket}`)
      if (!sig) return { ok: false, error: '根身份锁定或缺失' }
      cbBody = { ticket, did: rootDid, sig }
    } else {
      // 分身模式：先尝试取委任状
      const pk = devicePubkeyB64()
      const dlg0 = loadDelegation()
      let cred = dlg0 && deviceDid && pk && dlg0.devicePubkeyB64 === pk ? dlg0 : null
      if (!cred || cred.exp <= Date.now()) {
        const fresh = await pollDelegation()
        if (fresh && fresh.devicePubkeyB64 === pk && fresh.exp > Date.now()) cred = fresh
      }
      if (!deviceDid || !cred || cred.exp <= Date.now()) {
        return { ok: false, error: '设备身份/委任状未就绪（请先在 PC 端确认设备授权）' }
      }
      const sig = await signWithDeviceKey(`myco-auth\n${ticket}`)
      if (!sig) return { ok: false, error: '设备钥签名失败' }
      cbBody = { ticket, did: deviceDid, sig, delegation: JSON.stringify(cred) }
    }

    const cb = await postJson(`${PLATFORM}/api/v1/auth/myco/callback`, cbBody)
    if (!cb.ok || cb.json?.ok === false) {
      return { ok: false, error: cb.json?.error ? String(cb.json.error) : `callback HTTP ${cb.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 100) }
  }
}

async function defaultPostJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, json }
}

/**
 * 壳内 POST —— **必须走原生代理，不能裸 fetch**（2026-10-15 真机实证）。
 *
 * 手机 UI 是 `file:///android_asset/www/` 源，跨源 fetch 的预检（Origin: null）
 * 被平台 403 拒（`/api/v1/auth/qr-tickets` 与 `/myco/callback` 实测均无 ACAO 头）
 * → 免登链死在第一步 → 用户看到"网页打开了但没登录"。
 * 壳提供 `MycoShell.proxyPostAsync(cb, url, ct, authHeader, body)`：Java 侧
 * HttpURLConnection 直发（无浏览器同源策略），完成后回 `window.<cb>({status, body})`。
 * 浏览器/PWA 环境无壳 → 退回普通 fetch（那边由平台 CORS 策略决定）。
 */
function shellAwarePost(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const shell = (window as unknown as { MycoShell?: { proxyPostAsync?: (cb: string, u: string, ct: string, ah: string, b: string) => void } }).MycoShell
  if (!shell?.proxyPostAsync) return defaultPostJson(url, body)
  const post = shell.proxyPostAsync.bind(shell)
  return new Promise((resolve) => {
    const w = window as unknown as Record<string, unknown>
    const cbName = '__explorePost' + Math.random().toString(36).slice(2)
    const done = (v: { ok: boolean; status: number; json: any }) => { clearTimeout(timer); delete w[cbName]; resolve(v) }
    const timer = setTimeout(() => done({ ok: false, status: 0, json: {} }), 15_000)
    w[cbName] = (r: { status?: number; body?: string }) => {
      const status = Number(r?.status ?? 0)
      let json: any = {}
      try { json = JSON.parse(String(r?.body ?? '')) } catch { /* 非 JSON（错误页等）→ 空对象 */ }
      done({ ok: status >= 200 && status < 300, status, json })
    }
    try { post(`window.${cbName}`, url, 'application/json', '', JSON.stringify(body)) }
    catch { done({ ok: false, status: 0, json: {} }) }
  })
}

/**
 * 入口用：算 URL 并开浏览器。
 *
 * APK 壳里 window.open() **静默无效**（WebView 未开 setSupportMultipleWindows/
 * onCreateWindow，2026-10-15 真机实测：点探索屏幕无反应）——必须走壳的
 * MycoShell.openInBrowser 桥（系统浏览器 ACTION_VIEW，只放行 http(s)，
 * 同 2026-10-12 任务卡「在浏览器中打开」通道）。浏览器/PWA 环境退回 window.open。
 */
/**
 * 外开 URL（2026-10-16 从 openExplore 抽出，供任务行/任务卡等复用）。
 * APK 壳里 window.open() **静默无效**（WebView 未开 setSupportMultipleWindows/
 * onCreateWindow）——必须走壳的 MycoShell.openInBrowser 桥（系统浏览器
 * ACTION_VIEW，只放行 http(s)）；浏览器/PWA 环境退回 window.open。
 */
export function openExternal(url: string): void {
  const shell = (window as unknown as { MycoShell?: { openInBrowser?: (u: string) => string } }).MycoShell
  if (shell?.openInBrowser) {
    const r = shell.openInBrowser(url)
    if (typeof r === 'string' && r.startsWith('ERR:')) {
      console.warn('[openExternal] openInBrowser 被拒:', r)
      window.open(url, '_blank')
    }
    return
  }
  window.open(url, '_blank')
}

export async function openExplore(pageUrl: string): Promise<void> {
  let url = pageUrl
  try {
    url = await exploreAutologinUrl(pageUrl)
  } catch (e) {
    console.warn('[explore] 免登流程异常:', String(e).slice(0, 140))
  }
  openExternal(url)
}
