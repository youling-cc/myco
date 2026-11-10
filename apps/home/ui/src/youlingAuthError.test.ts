import { describe, it, expect } from 'vitest'
import {
  classifyAuthFailure, authFailureMessage, authFailureTitle, describeAuthFailure, buildAuthDiagnostic,
  stripErrPrefix, isTransportError, hasPlatformCallbackEvidence, pickTransportError, NETWORK_ERR_PATTERNS,
  ERR_DELEGATE_INCOMPLETE, type AuthFailureFacts,
} from './youlingAuthError'

/* 2026-10-11 回归（仓根 TODO.md「"会话缺失，请重新创建账户"误导文案」）：
 * confirm() 三段回落链（①wallet_sign 账号钥签名 ②wallet_sign_delegated 分身签名
 * ③token 模式）全失败时，旧实现抛 `会话缺失，请重新创建账户`——真实含义是"网页票据
 * 已失效（平台 TTL 300s），回网页重发即可"，诱导用户重复建号（=换一把账号钥，不可逆）。
 *
 * 本组用例钉死三件事：
 *  1) 场景判定（locked / delegation / session / ticket 的事实分支与优先级）；
 *  2) 每个场景的文案原文（含"不要重新创建账户"+ 5 分钟）；
 *  3) 诊断串（①账号钥 ②分身 ③会话 三段 + 状态行；不泄露 sessionToken 原文）。 */

const ACC = 'did:youling:z6MkmQ7vHsT9wBnE4uLpXyZa1cDfGh'
const DEV = 'did:myco:z6MkeJKomRTkqP3vNsW8xHb2aYd4fE8'

const base: AuthFailureFacts = {
  rootDid: ACC, deviceDid: DEV, role: 'embodiment', sessionToken: null,
  locked: false, sigErr: null, delegatedErr: null, callbackErr: null, finalErr: null,
}

describe('YoulingAuth 失败场景判定（classifyAuthFailure）', () => {
  it('票据失效 + 回调被拒（最常见）：回调已发出仍被拒 → ticket', () => {
    const scene = classifyAuthFailure({
      ...base,
      sigErr: null,
      delegatedErr: 'Failed to fetch',
      callbackErr: 'Error: { "ok": false, "error": "ticket 不存在或已使用" }',
    })
    expect(scene).toBe('ticket')
  })

  it('回落链全失败（签名成功但无会话/续期失败）→ ticket（默认口径，仍回网页）', () => {
    expect(classifyAuthFailure({
      ...base, sessionToken: 'tok-stale', finalErr: '自动续期失败，请到身份面板重新登录',
    })).toBe('ticket')
  })

  it('本机无有效会话（sessionToken 为空、无回调被拒、账号未锁）→ session', () => {
    expect(classifyAuthFailure({
      ...base, sigErr: '本机未持有账号钥（或已锁定）', delegatedErr: ERR_DELEGATE_INCOMPLETE,
    })).toBe('session')
  })

  it('成员设备委任状过期/缺失（role=lost，账号轴仍在）→ delegation', () => {
    expect(classifyAuthFailure({ ...base, role: 'lost', sessionToken: null })).toBe('delegation')
    expect(classifyAuthFailure({ ...base, role: 'lost', sessionToken: 'tok-stale' })).toBe('delegation')
  })

  it('role=agent（委任状仍有效，不在"已过期"之列）不误判成 delegation → 按会话事实落 session', () => {
    expect(classifyAuthFailure({ ...base, role: 'agent', sessionToken: null })).toBe('session')
  })

  it('账号被加密锁定（locked）优先于一切——解锁才管用，回网页重发也没用', () => {
    expect(classifyAuthFailure({
      ...base, locked: true, role: 'lost', sessionToken: null, callbackErr: 'ticket 不存在或已使用',
    })).toBe('locked')
  })

  it('委任状过期优先于"无会话"：成员设备该去主设备重新授权，而非在本机找登录', () => {
    expect(classifyAuthFailure({ ...base, role: 'lost', sessionToken: null })).toBe('delegation')
  })

  it('回调被平台拒优先于"无会话"：本机签名已成功，锅在服务端票据侧', () => {
    expect(classifyAuthFailure({
      ...base, sessionToken: null, callbackErr: 'did 签名校验失败',
    })).toBe('ticket')
  })
})

describe('YoulingAuth 失败文案（authFailureTitle/Message，逐字钉）', () => {
  it('ticket（有平台拒绝证据）：标题点明票据失效，正文给 5 分钟 + 回网页重发 + 明确不要重新创建账户', () => {
    expect(authFailureTitle('ticket')).toBe('登录票据已失效')
    const facts = { ...base, callbackErr: 'ticket 不存在或已使用' }
    const msg = authFailureMessage('ticket', facts)
    expect(msg).toBe('票据有效期 5 分钟，请回到网页重新发起登录；不要重新创建账户。')
    expect(msg).toContain('票据有效期 5 分钟')
    expect(msg).toContain('回到网页重新发起登录')
    expect(msg).toContain('不要重新创建账户')
  })

  /* 2026-10-11 复核 M1 的保守口径：ticket 是兜底桶，没有"平台确实收到了这次回调"的
   * 证据时（回落链全失败 / 续期失败 / 文本无法归因）不得断言"票据已失效"——那只在
   * 平台明确拒绝时才成立（见上方用例）。此时既不说病因，也不把"回网页"当首选动作，
   * 只要求稍后重试，把"回网页"降级为反复失败后的备选。 */
  it('ticket（无证据=兜底桶）：不断言票据失效、不引导回网页优先，只要求稍后重试（逐字钉）', () => {
    const cautious = '本次登录未能完成，请稍后重试；如反复失败请回到网页重新发起登录。不要重新创建账户。'
    // 完全不带 facts 的旧调用口径也必须落到保守文案（不是断言票据失效）
    expect(authFailureMessage('ticket')).toBe(cautious)
    // 回落链全失败 + 续期失败（恰是复核点名的那条路径）：无任何平台回调证据
    expect(authFailureMessage('ticket', {
      ...base, sessionToken: 'tok-stale', finalErr: '自动续期失败，请到身份面板重新登录',
    })).toBe(cautious)
    // 保守文案的三项硬约束
    expect(cautious).toContain('稍后重试')
    expect(cautious).toContain('不要重新创建账户')
    expect(cautious).not.toContain('票据有效期 5 分钟')
    expect(cautious.startsWith('票据')).toBe(false)
    // 有证据才允许出现 5 分钟断言——两句话必须可区分
    expect(authFailureMessage('ticket', { ...base, callbackErr: 'did 签名校验失败' })).not.toBe(cautious)
  })

  it('network：平台/网络不可达，明确要求稍后重试（不引导回网页重发、不引导重建号）', () => {
    expect(authFailureTitle('network')).toBe('平台暂时联系不上')
    const msg = authFailureMessage('network')
    expect(msg).toBe('请检查本机网络后稍后重试；如反复失败请稍后再发起登录。')
    expect(msg).toContain('稍后重试')
    expect(msg).not.toContain('回到网页')
    expect(msg).not.toContain('票据')
    expect(msg).not.toContain('重新创建账户')
  })

  it('session：本机登录已过期，先在账号面板重新登录', () => {
    expect(authFailureTitle('session')).toBe('本机登录已过期')
    expect(authFailureMessage('session')).toBe('请先在 myco 账号面板重新登录后重试。')
  })

  it('delegation：本设备授权已过期，在主设备上重新授权本设备', () => {
    expect(authFailureTitle('delegation')).toBe('本设备授权已过期')
    expect(authFailureMessage('delegation')).toBe('请在主设备上重新授权本设备后重试。')
  })

  it('locked：本机账号已锁定，先去账号面板解锁', () => {
    expect(authFailureTitle('locked')).toBe('本机账号已锁定')
    expect(authFailureMessage('locked')).toBe('账号已加密，请先在 myco 账号面板解锁后重试。')
  })

  it('五个场景一律不再出现旧的"会话缺失/请重新创建账户"祈使句', () => {
    for (const s of ['ticket', 'session', 'delegation', 'locked', 'network'] as const) {
      const msg = authFailureMessage(s)
      const title = authFailureTitle(s)
      expect(msg).not.toContain('会话缺失')
      expect(title).not.toContain('会话缺失')
      expect(msg).not.toContain('请重新创建账户')
      // "重新创建账户"只允许以劝阻（"不要…"）形态出现在 ticket 场景
      expect(msg.includes('重新创建账户')).toBe(s === 'ticket')
    }
  })

  it('五档标题都在 4-8 字、且同场景标题唯一', () => {
    const scenes = ['ticket', 'session', 'delegation', 'locked', 'network'] as const
    const titles = scenes.map((s) => authFailureTitle(s))
    for (const t of titles) {
      expect(t.length).toBeGreaterThanOrEqual(4)
      expect(t.length).toBeLessThanOrEqual(8)
    }
    expect(new Set(titles).size).toBe(scenes.length)
  })
})

describe('YoulingAuth 场景判定·网络/传输档（2026-10-11 复核 M1 新增档）', () => {
  /* 判据一律用**真实可能出现的原文**（见 youlingAuthError.ts 的 NETWORK_ERR_PATTERNS
   * 溯源注释：Rust lib.rs:648/698 包 "回调失败: {e}"、:650/700 的 "响应解析失败: {e}"、
   * :632/:672 白名单拒答；e = ureq 2.12.1 Transport 的 "…: <kind>: <msg>: <source>"）。 */

  it('Rust 侧传输失败透传原文（回调失败: <ureq 错误>）→ network，不再落 ticket 兜底', () => {
    // ureq 2.12.1 stream.rs:426 "Connect error" 套 std io 原文（WSAETIMEDOUT）
    expect(classifyAuthFailure({
      ...base, callbackErr: '回调失败: https://did.youling.cc/auth: Connection Failed: Connect error: 由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。 (os error 10060)',
    })).toBe('network')
    // DNS 失败：error.rs:406 "Dns Failed" + stream.rs:367 "resolve dns name '<host>'"
    expect(classifyAuthFailure({
      ...base, callbackErr: "回调失败: https://did.youling.cc/auth: Dns Failed: resolve dns name 'did.youling.cc:443': failed to lookup address information",
    })).toBe('network')
    // IO/超时：error.rs:414 "Network Error" + stream.rs:139 "timed out reading response"
    expect(classifyAuthFailure({
      ...base, callbackErr: '回调失败: https://dev.youling.cc/auth: Network Error: timed out reading response',
    })).toBe('network')
    // 2026-10-02 非白名单根修前的真实拒答形态（lib.rs:632/672，发请求之前）
    expect(classifyAuthFailure({
      ...base, callbackErr: '拒绝非白名单回调地址: https://foo.example/auth',
    })).toBe('network')
    // 响应到手但解不开（lib.rs:650/700）——同样是"这次没走通"，重试即可
    expect(classifyAuthFailure({
      ...base, callbackErr: '响应解析失败: expected value at line 1 column 1',
    })).toBe('network')
  })

  it('四处错误原文任一命中传输特征都算 network（sigErr/delegatedErr/finalErr 同样参判）', () => {
    expect(classifyAuthFailure({ ...base, sessionToken: 'tok', sigErr: '回调失败: Network Error: timed out' })).toBe('network')
    expect(classifyAuthFailure({ ...base, sessionToken: 'tok', delegatedErr: 'TypeError: Failed to fetch' })).toBe('network')
    expect(classifyAuthFailure({ ...base, sessionToken: 'tok', finalErr: 'Error: 回调失败: Connection Failed: Connect error: 由于目标计算机积极拒绝，无法连接。 (os error 10061)' })).toBe('network')
    expect(classifyAuthFailure({ ...base, sessionToken: 'tok', delegatedErr: 'AbortError: The operation was aborted' })).toBe('network')
    expect(classifyAuthFailure({ ...base, sessionToken: 'tok', finalErr: '网络错误：连接超时' })).toBe('network')
  })

  it('平台业务错误串**不**误判成 network（那些是平台收到了并明确拒绝）', () => {
    // lib.rs:644/694 把 4xx body 里的 error 字段原文透传
    for (const e of [
      '会话无效或已过期',
      'ticket 不存在或已使用',
      'did 签名校验失败',
      'identity token 校验失败',
      'HTTP 502',
    ]) {
      expect(isTransportError(e)).toBe(false)
      expect(classifyAuthFailure({ ...base, callbackErr: e })).toBe('ticket')
    }
  })

  it('优先级：network 优先于 ticket 兜底，但**不**覆盖 locked / delegation 两类已确认事实', () => {
    const netFacts = { ...base, sessionToken: null, callbackErr: '回调失败: Network Error: timed out reading response' }
    // 基准：同样的事实无网络特征时落 ticket 兜底
    expect(classifyAuthFailure({ ...base, sessionToken: null, callbackErr: 'ticket 不存在或已使用' })).toBe('ticket')
    expect(classifyAuthFailure(netFacts)).toBe('network')
    // locked 压过 network（本机可自证的锁定态是根因）
    expect(classifyAuthFailure({ ...netFacts, locked: true })).toBe('locked')
    // delegation 压过 network（委任状过期本机可自证，重试网络无意义）
    expect(classifyAuthFailure({ ...netFacts, role: 'lost' })).toBe('delegation')
  })

  it('优先级：平台已明确拒绝（callbackErr 有业务证据）优先于网络启发推断', () => {
    // callbackErr 带业务 error 体=平台确实收到并拒了；此时 sigErr 里的网络串是回落链
    // 途中产生的噪音，不该把结论改成"稍后重试"（票据才是真病因）。
    expect(classifyAuthFailure({
      ...base, sessionToken: null,
      sigErr: '回调失败: Network Error: timed out',
      callbackErr: 'ticket 不存在或已使用',
    })).toBe('ticket')
  })

  it('network 整条视图与诊断归因行（标题/正文/归因串自洽）', () => {
    const view = describeAuthFailure({
      ...base, sessionToken: 'tok-stale',
      finalErr: '回调失败: https://did.youling.cc/auth: Connection Failed: Connect error: (os error 10060)',
    })
    expect(view.scene).toBe('network')
    expect(view.title).toBe('平台暂时联系不上')
    expect(view.message).toBe('请检查本机网络后稍后重试；如反复失败请稍后再发起登录。')
    expect(view.detail).toContain('归因：到平台的请求未走通（传输层，非票据问题）')
    expect(view.detail).toContain('os error 10060')
    // 归因行不能把"票据/验签"写成病因
    expect(view.detail).not.toContain('归因：平台已收到回调并拒绝')
  })

  it('判定/归因辅助函数口径（isTransportError / hasPlatformCallbackEvidence / pickTransportError）', () => {
    expect(isTransportError(null)).toBe(false)
    expect(isTransportError(undefined)).toBe(false)
    expect(isTransportError('')).toBe(false)
    expect(isTransportError('   ')).toBe(false)
    expect(isTransportError('TIMED OUT')).toBe(true) // 大小写不敏感

    expect(hasPlatformCallbackEvidence({ callbackErr: null })).toBe(false)
    expect(hasPlatformCallbackEvidence({ callbackErr: 'ticket 不存在或已使用' })).toBe(true)
    expect(hasPlatformCallbackEvidence({ callbackErr: '回调失败: Network Error: timed out' })).toBe(false)

    // 诊断串给的是**首条命中**的传输错误原文（剥 Error: 前缀，便于截图排障）
    expect(pickTransportError({
      ...base, callbackErr: 'Error: 回调失败: Network Error: timed out',
      sigErr: '回调失败: Connection Failed',
    })).toBe('回调失败: Network Error: timed out')
    expect(pickTransportError({ ...base, sigErr: '本机未持有账号钥（或已锁定）' })).toBeNull()

    // 特征表本身：非空、一律小写（比对是 lowercase，混入大写会静默失效）
    expect(NETWORK_ERR_PATTERNS.length).toBeGreaterThan(0)
    for (const p of NETWORK_ERR_PATTERNS) expect(p).toBe(p.toLowerCase())
  })
})

describe('YoulingAuth 诊断串（buildAuthDiagnostic：三路原因串起来供排障）', () => {
  it('三段齐全 + 可选四/五段 + 状态行（逐行原文）', () => {
    const detail = buildAuthDiagnostic({
      ...base,
      sigErr: 'Error: 本机未持有账号钥（或已锁定）',
      delegatedErr: ERR_DELEGATE_INCOMPLETE,
      callbackErr: 'ticket 不存在或已使用',
      finalErr: 'Error: 自动续期失败，请到身份面板重新登录',
    })
    expect(detail.split('\n')).toEqual([
      '①账号钥签名：本机未持有账号钥（或已锁定）',
      '②分身签名：分身签名未返回可用签名（did/sig/delegation 缺项）',
      '③本机会话：无（sessionToken 为空）',
      '④平台回调：ticket 不存在或已使用',
      '⑤最终错误：自动续期失败，请到身份面板重新登录',
      '本机状态：role=embodiment rootDid=有 设备did=有 账号锁=否',
      '归因：平台已收到回调并拒绝（票据/验签侧，非传输问题）',
    ])
  })

  it('未失败/未走到的那几段给固定占位，不留空段', () => {
    const detail = buildAuthDiagnostic({ ...base, sessionToken: 'tok' })
    expect(detail.split('\n')).toEqual([
      '①账号钥签名：未失败',
      '②分身签名：未失败',
      '③本机会话：有（已取得 sessionToken）',
      '本机状态：role=embodiment rootDid=有 设备did=有 账号锁=否',
      '归因：无传输层证据，按票据兜底口径展示（保守文案）',
    ])
  })

  it('两轴皆无 + role 未知 + 已锁定 → 状态行如实报"无/未知/是"', () => {
    const detail = buildAuthDiagnostic({
      rootDid: null, deviceDid: '', role: '', sessionToken: null, locked: true,
    })
    expect(detail).toContain('本机状态：role=未知 rootDid=无 设备did=无 账号锁=是')
  })

  it('诊断串不泄露 sessionToken 原文（弹窗会被截图）', () => {
    const detail = buildAuthDiagnostic({ ...base, sessionToken: 'SECRET-TOKEN-VALUE' })
    expect(detail).not.toContain('SECRET-TOKEN-VALUE')
    expect(detail).toContain('已取得 sessionToken')
  })

  it('stripErrPrefix 与原组件同款口径（只剥行首 Error: ）', () => {
    expect(stripErrPrefix(new Error('x 失败'))).toBe('x 失败')
    expect(stripErrPrefix('Error: y')).toBe('y')
    expect(stripErrPrefix('网络 Error: z')).toBe('网络 Error: z')
  })
})

describe('YoulingAuth 失败视图（describeAuthFailure 组件唯一入口）', () => {
  it('场景/标题/正文/详情自洽：与单函数恒等，detail 非空', () => {
    const facts: AuthFailureFacts[] = [
      { ...base, role: 'lost', sessionToken: null },
      { ...base, sessionToken: null },
      { ...base, sessionToken: 'tok-stale' },
      { ...base, locked: true },
      // 网络档也走同一入口：message 必须与 authFailureMessage(scene) 恒等（network 文案
      // 与 facts 无关，这正是"同场景文案唯一"的护栏）
      { ...base, sessionToken: null, callbackErr: '回调失败: Network Error: timed out' },
    ]
    for (const f of facts) {
      const view = describeAuthFailure(f)
      expect(view.title).toBe(authFailureTitle(view.scene))
      expect(view.message).toBe(authFailureMessage(view.scene))
      expect(view.detail.length).toBeGreaterThan(0)
    }
  })

  it('member 设备（role=lost）整条视图：标题正文指主设备，详情含三段诊断', () => {
    const view = describeAuthFailure({
      ...base, role: 'lost', sessionToken: null,
      sigErr: '本机未持有账号钥（或已锁定）', delegatedErr: 'TypeError: Failed to fetch',
    })
    expect(view.scene).toBe('delegation')
    expect(view.title).toBe('本设备授权已过期')
    expect(view.message).toBe('请在主设备上重新授权本设备后重试。')
    expect(view.detail).toContain('①账号钥签名：本机未持有账号钥（或已锁定）')
    expect(view.detail).toContain('②分身签名：TypeError: Failed to fetch')
    expect(view.detail).toContain('③本机会话：无（sessionToken 为空）')
    expect(view.detail).toContain('role=lost')
  })
})
