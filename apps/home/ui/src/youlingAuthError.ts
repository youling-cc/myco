/**
 * YoulingAuth 登录失败的「判定 + 文案 + 诊断串」纯模块（2026-10-11）。
 *
 * 修的是仓根 TODO.md「"会话缺失，请重新创建账户"误导文案」：确认弹窗三段式
 * 回落链（①wallet_sign 账号钥签名 ②wallet_sign_delegated 分身签名 ③token 模式）
 * 全部走不通时，原实现只抛一句 `会话缺失，请重新创建账户`——真实含义却是
 * "网页发的登录票据（平台 TTL 300s）已失效，回网页重发即可"，有诱导用户重复建号
 * 的风险（建号不可逆：新账号 = 另一把账号钥）。
 *
 * 本模块把判定与措辞从组件里抽出来，供 vitest 纯函数单测钉死（与
 * youlingAuthSilent.test.ts / youlingAuthDisplay.test.ts 同款：不渲染 DOM）。
 * 判定一律按**可判定的事实**走，不硬编码"必须三分支"——locked 是第四个事实分支。
 */

/** 失败场景（决定给用户看哪句文案）。 */
export type AuthFailureScene =
  /** 本机账号被加密锁住（账号钥取不出）→ 解锁，不是票据问题 */
  | 'locked'
  /** 成员设备：本机无账号钥、委任状过期/缺失 → 去主设备重新授权 */
  | 'delegation'
  /** 本机无有效会话（sessionToken 为空）→ 账号面板重新登录 */
  | 'session'
  /**
   * 到有灵平台的请求根本没走通（传输失败/超时/DNS 失败/响应不可解析）→ 稍后重试。
   * 与 ticket 的关键区别：ticket 是"平台收到了、明确拒了"，本档是"压根没握上手"——
   * 此时叫用户"回网页重新发起登录"同样会失败（网页侧走的是同一条网络），等于换个
   * 说法的误导。（2026-10-11 复核 M1）
   */
  | 'network'
  /** 默认（最常见）：票据失效 / 回调被拒 / 回落链全失败 → 回网页重发，别重建号 */
  | 'ticket'

/** 判定所需事实（全部来自 identityStore / 本次 confirm 的中间结果）。 */
export interface AuthFailureFacts {
  /** 账号轴（identityStore.rootDid）：非空 = 本机有一个活动账号 */
  rootDid: string | null
  /** 设备轴（identityStore.did）：identity_get 的 did:myco: 本机设备身份 */
  deviceDid: string
  /**
   * 本机在该账号下的角色（myco_get.role，运行时值域含 'lost'）：
   * embodiment=持账号钥 / agent=持有效委任状 / lost=两者皆无（委任状过期即被
   * Delegations::load 丢弃，故 lost 即"委任状过期或缺失"）/ unlinked=无活动账号。
   */
  role: string
  /** identityStore.sessionToken：null = 本机无有效会话 */
  sessionToken: string | null
  /** identityStore.locked：账号已加密且未解锁（wallet_sign 必失败） */
  locked?: boolean
  /** ①账号钥签名失败原文（null = 没失败到这步） */
  sigErr?: string | null
  /** ②分身签名失败原文（原实现 catch 块空吞，现捕获） */
  delegatedErr?: string | null
  /** ③本机签名已成功、但平台回调被拒的原文（票据一次性/过期，或签名校验失败） */
  callbackErr?: string | null
  /** 最终抛出的错误原文（token 模式续期失败等） */
  finalErr?: string | null
}

/** 组件要渲染的三件套。 */
export interface AuthFailureView {
  scene: AuthFailureScene
  /** 场景短标题（加粗那行） */
  title: string
  /** 该干什么（正文那行） */
  message: string
  /** 可折叠「详情」里的排障串（多行） */
  detail: string
}

/** 与组件原口径一致的错误文本归一（剥 `Error: ` 前缀）。 */
export function stripErrPrefix(e: unknown): string {
  return String(e).replace(/^Error:\s*/, '')
}

/** 分身签名返回 200 但缺 did/sig/delegation 时的诊断原文（组件共用同一常量）。 */
export const ERR_DELEGATE_INCOMPLETE = '分身签名未返回可用签名（did/sig/delegation 缺项）'

/**
 * 「到平台的请求没走通」的**可核实**文本特征表（全部小写比对）。
 *
 * 只收能溯源到真实产串处的标识，不猜：
 *  - 本仓 Rust 侧：`apps/home/src-tauri/src/lib.rs:648` / `:698` 传输失败包一层
 *    `format!("回调失败: {e}")`，:650 / :700 读了响应但解不开时 `format!("响应解析失败: {e}")`；
 *    :629 / :669 回调地址不是 http(s)；:632 / :672 非白名单 host（两者都在发请求之前，
 *    故也可归"没走通"）。
 *  - `e` = ureq 2.12.1 `Transport` 的 Display（crate 源 `src/error.rs:227`）：依次是
 *    `<url>: <kind>`、`msg`、`source`。kind 串见同文件 `impl Display for ErrorKind`
 *    （`Connection Failed` / `Dns Failed` / `Network Error` / `Bad Status` / `Bad Header` /
 *    `Too Many Redirects` / `Malformed proxy`…）；msg/source 串见 `src/stream.rs:426`
 *    `"Connect error"`、`:367` `resolve dns name '<host>'`、`:139/98` `timed out reading response`、
 *    `src/ntls.rs:21` `native_tls handshake timed out`，以及 std io error 原文
 *    （`os error 10060` = WSAETIMEDOUT、`forcibly closed by the remote host`、
 *    `No connection could be made because the target machine actively refused it`…）。
 *  - 前端本地 fetch 失败：`Failed to fetch` / `NetworkError` / `AbortError`（超时）。
 *  - 历史中文串：`请求失败` / `网络错误`。
 *
 * 判定口径**故意保守**：命中即归 network（引导"稍后重试"），不认识的一律不归——
 * 落 ticket 兜底。故票据失效/验签失败/会话无效这些平台业务错误串（HTTP 200 或 4xx
 * 带 `{"error": …}` 体）不会被误吞进本档。
 */
export const NETWORK_ERR_PATTERNS: readonly string[] = [
  // Rust 侧统一前缀（lib.rs:648/650/698/700）+ 发请求前的两道本地门（:629/632/669/672）
  '回调失败',
  '响应解析失败',
  '仅支持 http(s) 回调地址',
  '拒绝非白名单回调地址',
  // ureq 2.12.1 ErrorKind / msg / source
  'connection failed',
  'connect error',
  'dns failed',
  'resolve dns name',
  'no ip address for',
  'network error',
  'timed out',
  'timeout',
  'native_tls handshake',
  // std io error 原文
  'os error',
  'actively refused',
  'forcibly closed',
  // 浏览器 fetch 层
  'failed to fetch',
  'networkerror',
  'aborterror',
  'load failed',
  // 历史中文串
  '请求失败',
  '网络错误',
  '网络不可达',
  '连接超时',
]

/**
 * 这段错误原文是否指向**传输层**（到平台没走通），而非平台业务拒绝。
 * 只做字面包含比对；空串/null 一律 false。
 */
export function isTransportError(err?: string | null): boolean {
  if (!err) return false
  const s = String(err).toLowerCase()
  return NETWORK_ERR_PATTERNS.some((p) => s.includes(p))
}

/**
 * 是否存在"平台确实收到了这次回调"的证据（HTTP 非 2xx 且带业务 error 体 = lib.rs:646/696，
 * 或 200 但 `ok:false` = :654/:704）。有证据 → 票据失效可断言；无证据 → 走保守文案。
 */
export function hasPlatformCallbackEvidence(f: Pick<AuthFailureFacts, 'callbackErr'>): boolean {
  return !!f.callbackErr && !isTransportError(f.callbackErr)
}

/**
 * 由事实判定场景。判定序 = "谁最能解释这次失败"，先**已确认的本机事实**，再
 * **可核实的文本证据**，最后才是**启发式推断**：
 *
 * 1. locked：账号钥根本取不出（wallet_sign 的原话"本机未持有账号钥（或已锁定）"），
 *    处置是解锁，与票据/网络都无关——必须最先判。且它在本机可自证（本地加密态），
 *    比任何文本推断都硬。
 * 2. delegation：role=lost 且账号轴在 = 本机有设备身份、无账号钥、委任状已过期/缺失
 *    （成员设备的典型态）。同样是本机可自证的事实；处置在主设备，重试网络无意义，
 *    故排在 network 之前。
 *    ⚠️ role=agent（委任状仍有效）**不**归此类：授权没过期，叫用户重新授权是另一种误导；
 *    该类设备走 token 轨，无会话时落 'session'。
 * 3. network（2026-10-11 复核 M1 新增）：错误原文命中传输层特征（见
 *    NETWORK_ERR_PATTERNS 的溯源注释）= 到平台压根没握上手。此时"回网页重新发起登录"
 *    会同样失败，必须换成"稍后重试"——故优先于 ticket 兜底。
 *    不覆盖 locked/delegation：那两类是已确认的本机事实，本档只是文本启发。
 * 4. callbackErr：本机签名已成功、平台仍拒 → 票据/回调问题（ticket 一次性，Redis
 *    TTL 300s）。"平台确实收到并拒了"是比文本推断更直接的证据，故优先于网络启发。
 * 5. session：本机压根没有可用会话（sessionToken 为空）→ 去账号面板重新登录。
 * 6. 其余（回落链全失败、续期失败、无任何可核实证据）→ 保守口径的 ticket。
 */
export function classifyAuthFailure(f: AuthFailureFacts): AuthFailureScene {
  if (f.locked) return 'locked'
  if (f.role === 'lost') return 'delegation'
  if (hasPlatformCallbackEvidence(f)) return 'ticket'
  if (
    isTransportError(f.sigErr) ||
    isTransportError(f.delegatedErr) ||
    isTransportError(f.callbackErr) ||
    isTransportError(f.finalErr)
  ) {
    return 'network'
  }
  if (!f.sessionToken) return 'session'
  return 'ticket'
}

/**
 * 场景短标题（288px 卡片第一行，加粗）。
 * 明确不再出现「请重新创建账户」——重建号=换一把账号钥，是不可逆的误导。
 */
export function authFailureTitle(scene: AuthFailureScene): string {
  switch (scene) {
    case 'locked':
      return '本机账号已锁定'
    case 'delegation':
      return '本设备授权已过期'
    case 'session':
      return '本机登录已过期'
    case 'network':
      return '平台暂时联系不上'
    case 'ticket':
    default:
      return '登录票据已失效'
  }
}

/** 从事实里挑出第一条能说明"没走通"的原文（诊断口径，缺项返回 null）。 */
export function pickTransportError(f: AuthFailureFacts): string | null {
  const cands = [f.callbackErr, f.sigErr, f.delegatedErr, f.finalErr]
  for (const c of cands) if (isTransportError(c)) return stripErrPrefix(String(c))
  return null
}

/** 场景正文（第二行）：一律点明"下一步去哪"，不吓人、不诱导重建号。 */
export function authFailureMessage(scene: AuthFailureScene, f?: AuthFailureFacts): string {
  switch (scene) {
    case 'locked':
      return '账号已加密，请先在 myco 账号面板解锁后重试。'
    case 'delegation':
      return '请在主设备上重新授权本设备后重试。'
    case 'session':
      return '请先在 myco 账号面板重新登录后重试。'
    case 'network':
      // 不引导"回网页重发"（网页侧同一条网络，同样会失败），也不要重建号。
      return '请检查本机网络后稍后重试；如反复失败请稍后再发起登录。'
    case 'ticket':
    default:
      // 复核 M1 保守口径：只有拿到"平台确实收到了这次回调"的证据（HTTP 非 2xx 带
      // 业务 error 体 / 200 但 ok:false），才敢断言"票据已失效"。没有证据时
      // （回落链全失败、续期失败、文本无法归因）不断言病因，只说"本次没完成 +
      // 稍后重试"，把"回网页"降级为"反复失败后的备选"，避免又一种误导。
      return f && hasPlatformCallbackEvidence(f)
        ? '票据有效期 5 分钟，请回到网页重新发起登录；不要重新创建账户。'
        : '本次登录未能完成，请稍后重试；如反复失败请回到网页重新发起登录。不要重新创建账户。'
  }
}

/** 可分派的一行诊断（值缺失时给固定占位，别留空行）。 */
function seg(label: string, value: string | null | undefined, missing: string): string {
  return `${label}：${value ? stripErrPrefix(value) : missing}`
}

/**
 * 诊断串：①账号钥签名 ②分身签名 ③本机会话 三段（TODO 要求的"三路失败原因串起来
 * 供排障"）+ 可选 ④平台回调 ⑤最终错误 + 一行本机状态（只报轴的有无，不落 DID 原文
 * ——弹窗可能被截图）。
 */
export function buildAuthDiagnostic(f: AuthFailureFacts): string {
  const lines = [
    seg('①账号钥签名', f.sigErr, '未失败'),
    seg('②分身签名', f.delegatedErr, '未失败'),
    // 会话只报有无——sessionToken 原文不进文案（弹窗会被截图/上报）
    `③本机会话：${f.sessionToken ? '有（已取得 sessionToken）' : '无（sessionToken 为空）'}`,
  ]
  if (f.callbackErr) lines.push(seg('④平台回调', f.callbackErr, '未失败'))
  if (f.finalErr) lines.push(seg('⑤最终错误', f.finalErr, '无'))
  lines.push(
    `本机状态：role=${f.role || '未知'} rootDid=${f.rootDid ? '有' : '无'}` +
    ` 设备did=${f.deviceDid ? '有' : '无'} 账号锁=${f.locked ? '是' : '否'}`,
  )
  // 归因行（2026-10-11 复核 M1）：显式告诉排障者"平台是否收到过这次回调"——
  // 收到=票据/验签侧问题，没收到=传输侧问题，两条路的处置完全不同。
  const transportErr = pickTransportError(f)
  lines.push(
    transportErr
      ? `归因：到平台的请求未走通（传输层，非票据问题）—— ${transportErr}`
      : hasPlatformCallbackEvidence(f)
        ? '归因：平台已收到回调并拒绝（票据/验签侧，非传输问题）'
        : '归因：无传输层证据，按票据兜底口径展示（保守文案）',
  )
  return lines.join('\n')
}

/** 组件唯一入口：事实 → { 场景, 标题, 正文, 诊断串 }。 */
export function describeAuthFailure(f: AuthFailureFacts): AuthFailureView {
  const scene = classifyAuthFailure(f)
  return {
    scene,
    title: authFailureTitle(scene),
    message: authFailureMessage(scene, f),
    detail: buildAuthDiagnostic(f),
  }
}
