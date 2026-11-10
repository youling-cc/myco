/**
 * YoulingAuth — 有灵账号登录确认（myco://auth 深链接的接收端）。
 *
 * 链路：youling.cc 登录页生成 myco://auth?ticket=&callback=&svc= → 系统唤起本 exe
 * （冷启动 argv / 单实例回调）→ Rust 存 PENDING + emit `youling-auth-uri` →
 * 本组件弹确认 → youling_auth_callback 在 Rust 侧 POST 回 youling（免 CORS）。
 *
 * 身份前提：本机已有 myco DID 会话（identityStore.sessionToken）。没有 → 先
 * 一键创建（registerLogin 带 svc 基址，identity-svc 注册+登录一步完成）再确认。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useIdentityStore } from '@wsui/stores/identityStore'
import {
  describeAuthFailure, stripErrPrefix, ERR_DELEGATE_INCOMPLETE,
  type AuthFailureFacts, type AuthFailureView,
} from './youlingAuthError'

interface AuthReq {
  ticket: string
  callback: string
  svc: string
  callbackHost: string // 解析出的请求方域名（展示+防钓鱼）
  /** A1：浏览器临时会话钥公钥（base64）——存在则确认时顺带签「提交面会话委任状」 */
  sessionPubkey: string | null
  /**
   * 2026-10-10 任务1：静默续期标记（embed-server URI `&silent=1`）。
   * true = 本次是页面定时续期：**不渲染确认弹层**，直接重签；且调 Rust 侧
   * `session_delegation_sign(silent=true)` —— 那只允许续期**已授权过**的会话钥，
   * 新钥一律被拒（静默=无用户可见确认，不许静默"新授权"）。
   */
  silent: boolean
}

// identity-svc 默认端点（可配置，不硬编码）：
// 优先 localStorage `myco.exe.didBase` > 默认固定域名。
// 2026-09-28 第90轮：默认 https://myco.youling.cc/myco-id（443 反代 identity-svc:8321）。
export const DID_BASE_DEFAULT = 'https://myco.youling.cc/myco-id'
function resolveDidBase(): string {
  if (typeof localStorage !== 'undefined') {
    const user = localStorage.getItem('myco.exe.didBase')
    if (user !== null) return user
  }
  return DID_BASE_DEFAULT
}
const DEFAULT_SVC = resolveDidBase()

// 防钓鱼白名单（与 Rust 侧 get_allowed_hosts 保持一致，双道校验）。
// 从 DID_BASE 推导当前身份服务主机加入白名单（配置改了白名单跟着走）。
function allowedHosts(): string[] {
  const base = new Set([
    'youling.cc', 'www.youling.cc', 'myco.youling.cc',
    // 身份服务专属域（did 激活日 2026-09-30 A5）：二维码 svc=https://did.youling.cc
    'did.youling.cc',
    'localhost', '127.0.0.1',
    // 安全白名单双 IP（过渡期 vnext 活到 9/29，平台 callback 可能从任一 IP 来）
    'myco.youling.cc',
  ])
  try { base.add(new URL(DEFAULT_SVC).hostname) } catch { /* DEFAULT_SVC 非法时仅静态列表 */ }
  try { base.add(new URL(location.origin).hostname) } catch { /* file:// 等 */ }
  return [...base]
}
const ALLOWED_AUTH_HOSTS = allowedHosts()

// 泛域匹配（2026-10-02 第三次踩坑根修，与 Rust 侧 auth_host_allowed 同款）：
// youling.cc 本域或任意子域放行——DNS 泛解析+通配符证书体系下子域皆我方资产，
// 精确名单逐个加追不上域名扩张（myco.youling.cc→did.youling.cc→dev.youling.cc 三连踩）。
// 签名清单（B4）上线后由此接管。
function hostAllowed(h: string | null): boolean {
  if (!h) return false
  if (h === 'youling.cc' || (h.endsWith('.youling.cc') && h.length > '.youling.cc'.length)) return true
  return ALLOWED_AUTH_HOSTS.includes(h)
}

// 主机名口径与 Rust 侧 url::Url::host_str 对齐（不带端口）——callback 带
// 显式端口时（如 :8080）按裸主机比对，否则 host 含端口永远不命中名单。
function hostOf(u: string): string | null {
  try { return new URL(u).hostname } catch { return null }
}

/** 解析 `myco://auth?ticket=..&callback=..&svc=..&sk=..&silent=1`（sk/silent 可选）。
 *  导出供单测（静默标记是安全闸在 UI 侧的唯一开关，必须有回归钉）。 */
export function parseAuthUri(uri: string): AuthReq | null {
  try {
    const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : ''
    const p = new URLSearchParams(q)
    const ticket = p.get('ticket')
    const callback = p.get('callback')
    if (!ticket || !callback) return null
    const sv = p.get('silent')
    return {
      ticket, callback, svc: p.get('svc') || DEFAULT_SVC, callbackHost: hostOf(callback) || '未知来源',
      sessionPubkey: p.get('sk'),
      // 兼容 `silent=1`（embed-server 现行）与 `silent=true`（手写深链接）
      silent: sv === '1' || sv === 'true',
    }
  } catch {
    return null
  }
}

/**
 * 确认弹窗"将使用当前身份"的显示轴选择：确认走 wallet_sign=**账号钥**签名，
 * 必须显示账号轴 rootDid（did:youling:）；无账号身份（needAccount 兜底渲染）回落
 * 设备轴 did（identity_get 的 did:myco:），不留空白。修复：曾显示设备 did 而
 * 实际签名用账号 did——显示与用钥不一致，用户误以为用错身份登录。
 */
export function pickAuthDisplayDid(rootDid: string | null, deviceDid: string): string {
  return rootDid || deviceDid
}

export function YoulingAuth() {
  // 只订阅渲染真正用到的三个（status/did/rootDid）+ 两个 action；role/locked 只在
  // confirm 事件处理里按事实判定时读，一律走 getState() 新鲜读（复核 M3），故不再订阅
  // （订阅它们只多几次无意义重渲染）。
  const { status, did, rootDid, registerLogin, load } = useIdentityStore()
  const [req, setReq] = useState<AuthReq | null>(null)
  const [phase, setPhase] = useState<'confirm' | 'creating' | 'done' | 'error' | 'blocked'>('confirm')
  const [msg, setMsg] = useState('')
  /** 失败场景视图（标题/正文/可折叠详情）——由 youlingAuthError 纯模块按事实判定，
   *  见 2026-10-11 修「会话缺失，请重新创建账户」误导文案（仓根 TODO.md）。 */
  const [fail, setFail] = useState<AuthFailureView | null>(null)

  const allowed = req ? hostAllowed(req.callbackHost) : false

  /**
   * 静默续期（2026-10-10 任务1/F-2）。
   *
   * 由 embed-server 的 `silent=1` 唤起：窗口**不显示/不抢焦点**，这里也**不渲染确认弹层**，
   * 直接重签委任状并回调页面（页面定时器据此更新 sessionStorage 里的会话钥）。
   *
   * 安全闸：Rust `session_delegation_sign` 带 `silent: true` —— 只允许续期**已授权过**
   * 的会话钥（已在 session-key.json 记录里 = 用户在浏览器登录时确认过的那把），
   * 未授权的新钥一律 Err。
   *
   * **降级行为（被拒时）**：静默放弃——不弹层、不提示、**不调 youling_auth_callback_sig**
   * （ticket 保持未完成），只 console.warn。页面侧静默续期因此拿不到新委任状 →
   * 回退正常授权流程（F-3 唤起登录器，用户确认）。这样既不打扰用户，也绝不会静默
   * 签出新授权；白名单外/缺会话钥同样静默放弃。
   */
  const renewSilently = useCallback(async (r: AuthReq) => {
    if (!hostAllowed(r.callbackHost)) {
      console.warn('[silent-renew] 请求方不在可信名单，静默放弃:', r.callbackHost)
      return
    }
    if (!r.sessionPubkey) {
      console.warn('[silent-renew] 静默请求缺少会话钥（无可续期的钥），静默放弃')
      return
    }
    try {
      const d = await invoke<Record<string, unknown>>('session_delegation_sign', {
        sessionPubkeyB64: r.sessionPubkey, silent: true,
      })
      if (!d || typeof d !== 'object' || !d.sigB64) throw new Error('签发返回异常')
      const sj = await invoke('wallet_sign', { did: '', message: `myco-auth\n${r.ticket}` })
        .then((x) => ({ data: x as { did: string; sig: string } }))
      if (!sj?.data?.did || !sj?.data?.sig) throw new Error('wallet_sign 未返回签名')
      await invoke('youling_auth_callback_sig', {
        url: r.callback, ticket: r.ticket, did: sj.data.did, sig: sj.data.sig,
        sessionPubkey: r.sessionPubkey, sessionDelegation: JSON.stringify(d),
      })
    } catch (e) {
      // 未授权会话钥被 Rust 侧拒签（Err）/本机无账号钥/网络失败 → 静默放弃：
      // 页面侧会走正常授权流程（F-3），用户不会被"静默失败"打扰。
      console.warn('[silent-renew] 静默续期未完成（不打扰用户，页面侧回退正常授权）:', e)
    }
  }, [])

  const handleUri = useCallback((uri: string) => {
    const r = parseAuthUri(uri)
    if (!r) return
    // 静默续期：不弹层（窗口本就被静默唤起、可能根本没显示）——直接签+回调
    if (r.silent) { void renewSilently(r); return }
    setReq(r)
    setPhase('confirm')
    setMsg('')
    setFail(null)
  }, [renewSilently])

  useEffect(() => {
    // 冷启动（挂载时取走 PENDING）+ 热唤起（单实例 emit）
    invoke<string | null>('take_pending_auth_uri')
      .then((u) => { if (u) handleUri(u) })
      .catch(() => {})
    const un = listen<string>('youling-auth-uri', (e) => handleUri(e.payload))
    return () => { void un.then((f) => f()) }
  }, [handleUri])

  // 弹层渲染前确保身份状态已加载（修：冷启动时 status 尚为 loading 就被误判
  // "还没有有灵账户"——用户明明在本机建过账号，截图实测第18轮）
  useEffect(() => {
    if (req) void load()
  }, [req, load])

  // 第23轮:确认成功后 3 秒自动收起弹层(用户实测——网页已自动登录,弹层停在
  // "已确认登录"占着屏幕)。显式关(取消/我知道了)不受影响。
  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(() => setReq(null), 3000)
    return () => clearTimeout(t)
  }, [phase])

  // 钩子纪律(第21轮沙箱实测):必须在下方条件早退之前——曾放在早退后,弹窗一开
  // hooks 数量变化触发 React 崩溃=整窗白屏(热唤起必白屏的真凶)。
  // 第91轮复发修复:下方 done 态三层关闭 useEffect 曾又放在早退后(第79轮引入),
  // 深链接冷启动 req null→有值即 #310 白屏——所有 hooks 一律收拢到早退之前。
  const [seedB64, setSeedB64] = useState<string | null>(null)
  const [seedAck, seedAckSet] = useState(false)
  const setSeedAck = seedAckSet

  // 第79轮→80轮定稿：done 态三层关闭——①点窗口任意处（含后面的界面）立即关
  // ②1.5s 自动关兜底（用户注意力已回浏览器时）③不放按钮,杜绝"还要点一次"的错觉。
  // 这是支付终端/kiosk 成功页的标准模式（click-anywhere-to-continue）。
  useEffect(() => {
    if (phase !== 'done') return
    const close = () => setReq(null)
    const t = setTimeout(close, 1500)
    document.addEventListener('mousedown', close)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [phase])

  if (!req) return null

  // 已有账户的判定=账号钥存在（rootDid 非空），session 只是临时的——没有就静默续，
  // 不该把用户引去"一键创建"（账号已存在，再创建是幂等返回但文案误导）
  const needAccount = allowed && !rootDid
  // 第21轮:身份状态加载中(account 钥在 :3002 env,冷启动异步)——先显示检查中,
  // 避免 rootDid 未到时闪现"还没有有灵账户"误导已登录用户去点创建。
  const checking = allowed && status === 'loading' && !rootDid

  const createAccount = async () => {
    setPhase('creating')
    setFail(null)
    // 第21轮沙箱预演修正:旧实现只 registerLogin(设备身份)——全新用户走弹窗
    // 永远拿不到账号,confirm 落 token 模式=设备号裂号。补 myco_create 建真账号,
    // 然后弹种子备份(一次性展示+勾选确认,IdentityPanel 同款纪律)。
    const ok = await registerLogin(undefined, req.svc)
    if (!ok) { setPhase('error'); setMsg('创建有灵账户失败，请检查网络后重试'); return }
    try {
      // 第65轮：env 合并后 :3102 已死——改 invoke。force 版支持已有账号时建第二账号
      // （此弹窗出现=当前无可用账号，plain create 亦可，force 更稳）。
      const mc = await invoke<{ rootDid: string }>('myco_create_force', { name: '' })
      if (!mc?.rootDid) { setPhase('error'); setMsg('账号创建失败'); return }
      try {
        const seed = await invoke<string>('myco_export_seed')
        if (seed) setSeedB64(String(seed))
      } catch { /* 导出失败不阻断——身份面板可再导出 */ }
      await load()
      setPhase('confirm')
    } catch (e) {
      setPhase('error')
      setMsg('账号创建异常：' + String(e).replace(/^Error:\s*/, ''))
    }
  }

  const confirm = async () => {
    if (!allowed) return // 白名单外的请求方永不回调
    setPhase('creating')
    setFail(null)
    // 2026-10-11 修（仓根 TODO.md「"会话缺失，请重新创建账户"误导文案」）：三段回落链
    // 各自的失败原文都要留痕——①账号钥签名 ②分身签名（此前 catch 块空吞）
    // ③本机会话缺失。失败交 youlingAuthError 纯模块按**事实**判定场景（票据失效 /
    // 本机会话过期 / 委任状过期 / 账号锁定），文案与可折叠详情都在那边，组件只管抛与渲染。
    let sigErrText: string | null = null
    let delegatedErrText: string | null = null
    let callbackErrText: string | null = null
    let finalErrText: string | null = null
    // 账号钥签名是否已成功：为真则后续抛错=平台回调被拒（票据一次性/过期/验签失败），
    // 与"本机签名不可用"是两种病——不分开就会把票据问题误报成本机会话问题。
    let signedOk = false
    // 复核 M3（2026-10-11）：四个事实全部走 getState() 新鲜读，不再吃渲染闭包。
    // 理由：confirm 中途会 `registerLogin → load() → loadYouling()/refreshYoulingStatus()`
    // （见下方 token 轨自动续期），那些都会 set 新的 did/rootDid/role/locked/sessionToken；
    // 闭包里的旧值会把"续期后其实已解锁/已变成 agent/lost"的场景判错。sessionToken 原本
    // 就是 getState()，这里只是把余下四项对齐同一口径（store 是同一份，无行为风险）。
    const buildFacts = (): AuthFailureFacts => {
      const s = useIdentityStore.getState()
      return {
        rootDid: s.rootDid, deviceDid: s.did, role: s.role,
        sessionToken: s.sessionToken,
        locked: s.locked, sigErr: sigErrText, delegatedErr: delegatedErrText,
        callbackErr: callbackErrText, finalErr: finalErrText,
      }
    }
    /** 判定 + 落错误态（唯一出口：正文与详情同源，不会再各写一遍）。 */
    const failWith = (): void => {
      const view = describeAuthFailure(buildFacts())
      setFail(view)
      setMsg(view.message)
      setPhase('error')
    }
    try {
      // 第21轮定稿:签名模式——用**账号钥**签票(wallet_sign),登录的是用户的有灵账号
      // (如 cjfan),而非 token 模式注册的设备身份(平台侧裂成另一个账号+昵称回退的根因)。
      // 先 wallet_ensure_root 保证账号在票的 svc 上有名册(老账号注册在退役端点的迁移补登记)。
      // 第63轮 env 合并：wallet_sign 改 invoke 直调（原 fetch :3102 已死）
      try {
        const sj = await invoke('wallet_sign', {
          did: '', message: `myco-auth\n${req.ticket}`,
        }).then((r: { did: string; sig: string }) => ({ data: r }))
        if (sj?.data?.did && sj?.data?.sig) {
          // A1：请求带浏览器会话钥（sk）→ 顺带签「提交面会话委任状」（账号钥，
          // scope=submit-answer，12h），随回调提交平台注册。签发失败不阻断登录
          // （提交面落 ticket 低可信轨，老登录器行为）。
          let sessionDelegation: string | undefined
          if (req.sessionPubkey) {
            try {
              const d = await invoke<Record<string, unknown>>('session_delegation_sign', {
                sessionPubkeyB64: req.sessionPubkey,
              })
              if (d && typeof d === 'object' && d.sigB64) sessionDelegation = JSON.stringify(d)
            } catch (e) {
              console.warn('session_delegation_sign 失败（登录照常，提交走 ticket 轨）:', e)
            }
          }
          signedOk = true // 签名已产出：此后若抛错=回调被平台拒（见 catch 归因）
          await invoke('youling_auth_callback_sig', {
            url: req.callback, ticket: req.ticket, did: sj.data.did, sig: sj.data.sig,
            sessionPubkey: req.sessionPubkey ?? undefined, sessionDelegation,
          })
          setPhase('done')
          return
        }
        throw new Error('wallet_sign 未返回签名')
      } catch (sigErr) {
        // 归因二选一：签名已成功→原文进"平台回调"段；签名本身不可用→进"账号钥签名"段
        if (signedOk) callbackErrText = stripErrPrefix(sigErr)
        else sigErrText = stripErrPrefix(sigErr)
        // 根钥签名不可用 → 分身签名（第29轮 spec §7.2）：本机无根钥但持主设备签的
        // 委任状时，设备钥签票+委任状随行，平台验链落账 accountDid（PC 被手机授权的场景）。
        // 2026-10-11 修（**成员设备网页登录不了**根因）：原 fetch env 遗留 HTTP
        // `http://127.0.0.1:3102/api/wallet_sign_delegated`——第63轮 env 合并入 myco.exe
        // 后该路由已不存在（3102 只剩 /api/dshShare/*；`wallet_sign` 当轮已改 invoke，
        // **此处漏网**）⇒ 分身签名必然 404 ⇒ 三段回落全灭。改进程内 invoke（同款漏网点
        // 还有 auto_login_url，第63轮已单独修）。
        try {
          const dj = await invoke<{ did?: string; sig?: string; delegation?: unknown }>(
            'wallet_sign_delegated',
            { message: `myco-auth\n${req.ticket}` },
          )
          if (dj?.did && dj?.sig && dj?.delegation) {
            try {
              await invoke('youling_auth_callback_sig', { url: req.callback, ticket: req.ticket, did: dj.did, sig: dj.sig, delegation: JSON.stringify(dj.delegation) })
              setPhase('done')
              return
            } catch (delegCbErr) {
              // 分身签名成功但回调仍被拒——原文留痕后继续回落 token 模式（原实现被空吞）
              callbackErrText = stripErrPrefix(delegCbErr)
            }
          } else {
            delegatedErrText = ERR_DELEGATE_INCOMPLETE
          }
        } catch (delegErr) {
          // 非分身（无委任状/委任状过期）——原文留痕，继续回落 token 模式
          delegatedErrText = stripErrPrefix(delegErr)
        }
        console.warn('sig-mode fallback to token:', sigErr)
      }
      let token = useIdentityStore.getState().sessionToken
      if (!token) {
        // 旧文案「会话缺失，请重新创建账户」= 误导（诱导重建号=换一把账号钥，不可逆）。
        // 真实含义按事实分场景：票据失效 / 本机登录过期 / 本设备授权过期 / 账号锁定。
        failWith()
        return
      }
      try {
        await invoke('youling_auth_callback', { url: req.callback, ticket: req.ticket, token })
      } catch (first) {
        // token 侧失败统一自动续期：存量 token 可能由其他 identity-svc（本地/旧环境）签发，
        // 平台向 ticket.svc 校验必 401（业务错误如「identity token 校验失败」不含 401 字样）。
        // 对 req.svc 重新注册/挑战拿新 token 后重试一次——网络类失败重试也无害。
        callbackErrText = stripErrPrefix(first)
        setMsg(`首次回调被拒(${String(first).slice(0, 40)})，正在向 ${req.svc || '身份服务'} 重新验证…`)
        const ok = await useIdentityStore.getState().registerLogin(undefined, req.svc)
        if (!ok) throw new Error('自动续期失败，请到身份面板重新登录')
        token = useIdentityStore.getState().sessionToken
        if (!token) throw new Error('续期后仍无会话，请重试')
        await invoke('youling_auth_callback', { url: req.callback, ticket: req.ticket, token })
      }
      setPhase('done')
    } catch (e) {
      finalErrText = stripErrPrefix(e)
      failWith()
    }
  }

  // 显示=与实际用钥一致：签名走账号钥 → 账号轴 rootDid 优先，无账号回落设备 did
  const displayDid = pickAuthDisplayDid(rootDid, did)
  const shortDid = displayDid.slice(0, 20)
  const shortDeviceDid = did.slice(0, 20)

  return (
    /* 第41轮 K3 方案：五态统一 demo 白卡壳（遮罩轻压暗/白卡 12px 圆角/紫渐变主按钮），状态换芯 */
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 288, background: 'var(--card-bg, #fff)', borderRadius: 12, border: '1px solid var(--card-bd, #e4eaf2)', padding: 16, color: 'var(--tx, #1a2233)', boxShadow: '0 18px 60px rgba(20,30,60,.18)', display: 'flex', flexDirection: 'column', gap: 8 }}
        onClick={(e) => e.stopPropagation()}>
        {!allowed ? (
          /* blocked：已拦截 */
          <>
            <div style={{ fontSize: 40, textAlign: 'center' }}>⚠️</div>
            <div style={{ fontSize: 17, fontWeight: 800, textAlign: 'center' }}>已阻止</div>
            <div className="cardd warn-cardd">
              <div className="tinyd">请求方 <b style={{ fontFamily: 'monospace' }}>{req.callbackHost}</b> 不在可信名单内，为防止凭证被钓鱼网站窃取，已拒绝本次登录。</div>
            </div>
            <span className="chipd" style={{ alignSelf: 'center', background: '#fef3c7', color: '#92400e' }}>已拦截</span>
            <button className="btnd ghost" onClick={() => setReq(null)}>关闭</button>
          </>
        ) : phase === 'done' ? (
          /* done：点任意处立即关 / 1.5s 自动关——无按钮（不诱导点击） */
          <div onMouseDown={() => setReq(null)} style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <div style={{ fontSize: 46 }}>✅</div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>已登录</div>
            <div className="tinyd">请回到 {req.callbackHost}，正在自动登录…</div>
            <div className="tinyd" style={{ opacity: 0.55 }}>点击任意位置关闭</div>
          </div>
        ) : checking ? (
          /* creating/checking：spinner */
          <div style={{ textAlign: 'center', padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span className="spinnerd" style={{ width: 26, height: 26, borderWidth: 3 }} />
            <div style={{ fontSize: 14, fontWeight: 700 }}>正在检查本机有灵身份…</div>
          </div>
        ) : needAccount ? (
          /* 无账号：一键创建（含种子确认） */
          <>
            <div style={{ fontSize: 40, textAlign: 'center' }}>🌱</div>
            <div style={{ fontSize: 17, fontWeight: 800, textAlign: 'center' }}>创建有灵账户</div>
            <div className="subd" style={{ textAlign: 'center' }}>您还没有有灵账户。创建后将获得永久身份，做题攒的能力档案会有可信证明。</div>
            {seedB64 && !seedAck && (
              <div className="cardd warn-cardd">
                <div className="tinyd">⚠ 请保存账号种子（丢失=账号丢失，去中心化网络无运营方托管，无法找回）：</div>
                <div className="tinyd" style={{ fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', background: '#fff', padding: '6px 8px', borderRadius: 8, userSelect: 'all' }}>{seedB64}</div>
              </div>
            )}
            <button className="btnd" onClick={() => { if (seedB64 && !seedAck) setSeedAck(true); else createAccount() }} disabled={phase === 'creating'}>
              {phase === 'creating' ? '创建中…' : seedB64 && !seedAck ? '我已妥善保存，继续' : '✨ 一键创建有灵账户'}
            </button>
            <button className="btnd ghost" onClick={() => setReq(null)}>取消</button>
          </>
        ) : (
          /* confirm：确认登录 */
          <>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, alignSelf: 'center' }}>🌐</div>
            <div style={{ fontSize: 17, fontWeight: 800, textAlign: 'center' }}>确认登录</div>
            <div className="subd" style={{ textAlign: 'center' }}><b style={{ fontFamily: 'monospace' }}>{req.callbackHost}</b> 请求使用有灵账号登录</div>
            <div className="cardd info-cardd">
              <div className="tinyd">将使用当前身份：<b style={{ fontFamily: 'ui-monospace,monospace' }}>{shortDid}…</b></div>
              {rootDid && did && rootDid !== did && (
                <div className="tinyd" style={{ opacity: 0.65, marginTop: 2 }}>本机设备：<span style={{ fontFamily: 'ui-monospace,monospace' }}>{shortDeviceDid}…</span></div>
              )}
            </div>
            <span className="chipd green" style={{ alignSelf: 'center' }}>
              {req.sessionPubkey ? '验证身份 + 授权本会话提交答案签名（12 小时）' : '仅验证身份，不获取其他数据'}
            </span>
            {seedB64 && !seedAck && (
              <div className="cardd warn-cardd">
                <div className="tinyd">⚠ 请先保存账号种子（丢失=账号丢失）：</div>
                <div className="tinyd" style={{ fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all', background: '#fff', padding: '6px 8px', borderRadius: 8, userSelect: 'all' }}>{seedB64}</div>
              </div>
            )}
            <button className="btnd" onClick={confirm} disabled={phase === 'creating' || (!!seedB64 && !seedAck)}>{phase === 'creating' ? '确认中…' : '确认登录'}</button>
            <button className="btnd ghost" onClick={() => setReq(null)}>取消</button>
          </>
        )}

        {phase === 'error' && (
          /* 2026-10-11：标题+正文按场景分（youlingAuthError 纯模块判定），三段回落链
             的失败原文收进原生 <details>「详情」——288px 小卡不展开时只占一行，
             排障时展开即见（不引新依赖，不用自定义折叠件）。 */
          <div className="cardd warn-cardd">
            {fail?.title && (
              <div className="subd" style={{ fontWeight: 700, color: '#b91c1c' }}>{fail.title}</div>
            )}
            <div className="tinyd" style={{ color: '#b91c1c' }}>{msg || '网络异常，请重试'}</div>
            {fail?.detail && (
              <details style={{ marginTop: 4 }}>
                <summary className="tinyd" style={{ cursor: 'pointer', opacity: 0.7 }}>详情</summary>
                <div className="tinyd" style={{
                  marginTop: 4, fontFamily: 'ui-monospace,monospace', fontSize: 11,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.75,
                }}>{fail.detail}</div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
