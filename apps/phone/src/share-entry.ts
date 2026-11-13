/**
 * share-entry.ts — **分享卡形状与坐标**（「点卡就进」的卡片侧纯函数）。
 *
 * ── 2026-11-12 取票链整链删除（用户立法：取票已彻底收进插件，不留回落） ──────
 * 本文件历史上的「取票」环节（share-entry-request 控制消息 / mt 窄票 /
 * 本地监听数据面 / 同步回程 / 自动重试 / P2P 回推等待）**全部删除**。
 * 手机点 DSH 卡的唯一路径现在是（见 `dsh-open-runtime.ts`）：
 *   ① `MycoShell.reuseSharePage` 复用仍活着的分享页（返回再开，<1s）；
 *   ② 设备隧道 VNETP 直入：`ensureShareEntryForwardFor(源设备)`（本机→对端 15200，
 *      VNETP/1 DID 认证口，免票免客户端断言）→ 开
 *      `http://<deviceAlias>.localhost:<localPort>/<shareAlias>/`
 *      （`*.localhost` 解析回环，Host 随 URL 进隧道；网关按 Host+别名表归位）。
 * 拿不到隧道口 / 卡上没坐标 → 如实说「连不上源设备」或「卡片缺少源设备坐标」。
 *
 * 本文件保留的只有：
 *   · `ShareCard` / `shareCardOf` / `actionShareCoords` —— 卡片归一到分享坐标；
 *   · `DEFAULT_GW_PORT` —— 网关端口默认值（卡上没写时用）；
 *   · `entryControlEnvelope` / `newControlMsgId` —— 卡片管理类控制消息信封
 *     （转授/改名等，`share-admin.ts` 用；不是取票）。
 */

// ══════════════════ 卡片形状 ══════════════════

/**
 * DSH 分享任务卡（跨设备同步过来的那条；字段名对齐 PC 端 `chat_service.rs`
 * `device_group_task_payload` 的 `card` 记录）。
 */
export interface ShareCard {
  /** 分享实例 id（`sh-…`）——没它就没有可打开的入口。 */
  shareId: string
  /** **源设备** did（隧道目标）。别和 `requesterDevice` 混。 */
  sourceDevice: string
  /** 源设备展示名（"来自 X"）。 */
  sourceDeviceName?: string
  /** 源账号 did（grant 名单按它比对；同账号时 == 本机账号）。 */
  sourceAccount: string
  /** 卡片标题（给 WebView 的标题栏/日志用）。 */
  title?: string
}

/**
 * 从卡的 `action.url` 里抠分享坐标（**纯函数**）。
 *
 * 为什么需要它（2026-10-10 真机事故）：真实广播/同步链里有的卡**顶层缺
 * `shareId`/`sourceDevice`**（只有 `sourceDeviceName`），但它的 `action.url`
 * （`/api/dshShare/remoteOpen?shareId=…&device=…&account=…`，或源设备那份
 * `/open?shareId=…`）里带着同样的坐标——URL 是源设备建卡时写死的，与顶层字段同源。
 * 顶层字段缺失时从 URL 兜底，**老卡也兼容**（不要求对方重发）。
 *
 * 解析手写不引 `URL`：`did:` 值里的 `:` 合法，值本身可能带未编码残留，按
 * `?` 后 `k=v&` 切分最稳；`#` 起是 fragment 先切掉。值做一次 decodeURIComponent
 * （PC 侧 `qenc` 只编码必要字符，解码是幂等的）。
 */
export function actionShareCoords(p: Record<string, unknown> | null | undefined): {
  shareId: string
  device: string
  account: string
} {
  const out = { shareId: '', device: '', account: '' }
  if (!p) return out
  const act = p.action && typeof p.action === 'object' ? (p.action as Record<string, unknown>) : null
  let url = str(act?.url).trim()
  if (!url) return out
  const hash = url.indexOf('#')
  if (hash >= 0) url = url.slice(0, hash)
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  if (!q) return out
  for (const part of q.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    let v = part.slice(eq + 1).trim()
    if (!v) continue
    try {
      v = decodeURIComponent(v).trim()
    } catch {
      /* 值有裸 % 也照用 */
    }
    if (!v) continue
    if (k === 'shareId' && !out.shareId) out.shareId = v
    else if (k === 'device' && !out.device) out.device = v
    else if (k === 'account' && !out.account) out.account = v
  }
  return out
}

/**
 * 从一条 task-share 消息里抽出分享卡（纯函数；不是分享卡 → null）。
 *
 * **两层形状都要认**（真机踩过）：
 *   · 设备群广播（`chat_service.rs` 的 `device_group_task_payload`）把卡片**嵌在
 *     `payload.card`** 里，外层是 `{groupId, groupName, members, card, status, fromName}`；
 *   · 好友直推的分享卡则把字段**平铺在 payload 顶层**。
 * 只认一层就会漏掉一半来源。账号 did 也做多级兜底：`sourceAccount → account → from
 * → 外层 members[0]`（设备群的 members 就是账号 did，是最可靠的那个）。
 *
 * **坐标最后一道兜底**（2026-10-10）：`shareId` / `sourceDevice` / `sourceAccount`
 * 顶层缺失时从 `action.url` 的 query 抠（[`actionShareCoords`]）——顶层与 URL 同源，
 * 谁缺谁补，不因某个同步链丢了字段就把一张本来能开的卡判死。
 */
export function shareCardOf(payload: Record<string, unknown> | null | undefined): ShareCard | null {
  if (!payload) return null
  const nested =
    payload.card && typeof payload.card === 'object' ? (payload.card as Record<string, unknown>) : null
  const p = nested ?? payload
  const urlQ = actionShareCoords(p)
  const shareId = str(p.shareId).trim() || urlQ.shareId
  const sourceDevice = str(p.sourceDevice).trim() || urlQ.device
  if (!shareId || !sourceDevice) return null
  const members = Array.isArray(payload.members) ? payload.members : []
  const sourceAccount =
    str(p.sourceAccount).trim() ||
    str(p.account).trim() ||
    str(p.from).trim() ||
    str(members[0]).trim() ||
    str(payload.from).trim() ||
    urlQ.account
  if (!sourceAccount) return null
  return {
    shareId,
    sourceDevice,
    sourceAccount,
    sourceDeviceName: str(p.sourceDeviceName) || undefined,
    title: str(p.title) || undefined,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** PC 端默认网关端口（`dsh_share.rs:GW_BIND_PORT`）。 */
export const DEFAULT_GW_PORT = 13911

/**
 * 控制消息信封（与手机既有 `p2p.ts:buildEnvelope` **同形**：PC 端
 * `chat_service::ingest_p2p_inner` 适配层按这些键取值）。
 *
 * 用途：卡片管理类控制消息（转授申请/答复、改名等，`share-admin.ts`）。
 * **不是取票**——取票链已于 2026-11-12 整链删除。
 */
export function entryControlEnvelope(
  me: { account: string; device: string; name?: string; deviceName?: string },
  to: string,
  kind: string,
  payload: Record<string, unknown>,
  msgId: string,
  ts: number,
): Record<string, unknown> {
  return {
    msgId,
    from: me.account,
    fromName: me.name ?? '我',
    fromDevice: me.device,
    fromDeviceName: me.deviceName ?? 'myco-phone',
    to,
    kind,
    payload,
    ts,
  }
}

/** 控制消息 msgId（手机上不落会话，只需唯一；与 `p2p.ts` 的 se- 前缀同风格）。 */
export function newControlMsgId(now: number, rand: () => number = Math.random): string {
  return `se-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`
}
