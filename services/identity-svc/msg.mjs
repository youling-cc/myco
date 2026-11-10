// msg.mjs — 低频控制消息中转信箱（第81轮：登录器好友+聊天；第86轮好友曾改走 /friends/*；
// 2026-10-07 好友去服务端化——握手三 kind 回归信箱作离线兜底）。
// 定位与 delegation.mjs 同族：服务器只做中转不留档——
//   /msg/send {fromAccountDid, fromName, toAccountDid, kind, payload, msgId, ts}
//     投进收件人（账号 did）信箱；群消息（payload.members[]）逐成员投递（发送者除外）。
//   /msg/poll {accountDid} → {data:{msgs, cursor}}  拉走即删（ACK 语义，服务器零存档）。
// 鉴权与 presence 同链：X-Myco-Auth 设备钥签名（authedDid 由 identity-server 注入）。
//   简化（设计定稿）：只验设备签名，不查名册归属——消息按 toAccountDid 明文路由。
//   （群管理 kind 例外：GROUP_ADMIN_KINDS 查设备归属，第85轮。好友握手 kind 的
//   防冒充校验（payload.sig/名册归属/公钥判等）在接收端做，见端侧实现。）
// 信箱约束：每账号 500 条 / 30 天 TTL，超限丢最老（中转件不是档案）。
// 落盘 msg-inbox.json 防重启丢失（照 revocations.json 持久化写法）；但单条 payload
//   >64KB 的大媒体只留内存态——重启即丢可接受（端侧重发），避免落盘信箱膨胀成 GB 级。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCryptoDid, didFromPublicKey } from './identity/did.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INBOX_STORE = join(HERE, 'msg-inbox.json')

/** kind 白名单（2026-10-07 好友去服务端化：好友握手三 kind 加回信箱——
 *  好友关系=双方本地档案+签名握手，服务器只中转不再裁决（friends.mjs 已删，
 *  /friends/* 404）。握手消息 P2P 直推优先，信箱是对端离线时的兜底（30 天 TTL）；
 *  防冒充（payload.sig 验签+名册归属+公钥判等）全部在**接收端**做，服务器保持哑中转。
 *  群建卡/群管理元数据（group-create/invite/rename/leave/kick/mute，第85轮群主治理
 *  操作；b597d04 的白名单漏了这六项导致群管理消息被 400 拒，msg.test.mjs 抓出后修复）。
 *  批二（2026-09-28）：+group-disband——群主退群=解散。
 *  聊天正文（text/image/file/group-msg）与任务卡（task-*）走 P2P IPv6 直连
 *  （第84轮）——消息本体不占服务器。 */
const MSG_KINDS = new Set([
  'friend-request', 'friend-accept', 'friend-remove',
  'group-create', 'group-invite', 'group-rename', 'group-leave', 'group-kick', 'group-mute',
  'group-disband',
])
/** 第85轮：群管理 kind（元数据操作）——设备归属校验（fromDevice 必须真的属于
 *  fromAccountDid 名下，防伪称 owner 的 group-kick/invite）。 */
const GROUP_ADMIN_KINDS = new Set(['group-invite', 'group-rename', 'group-leave', 'group-kick', 'group-mute', 'group-disband'])
export const MSG_ROUTES = new Set(['/msg/send', '/msg/poll'])

const MAX_PAYLOAD = 3 * 1024 * 1024   // payload 超 3MB → 413（端侧发送前自限 2MB，这是服务端硬闸）
const PERSIST_MAX = 64 * 1024         // 落盘单条 payload 上限；大媒体内存态（见文件头注释）
const INBOX_CAP = 500                 // 每账号暂存上限，超限丢最老
const INBOX_TTL_MS = 30 * 24 * 3600_000 // 30 天 TTL

/** accountDid → [{seq, id, from, fromName, fromDevice, kind, payload, ts}] */
const inbox = new Map()
let seqCounter = 0

/** did 形态校验：did:myco:/did:youling: × canonical z multibase（spec v0.3 §3.1）。
 *  账号 did 是 did:youling:，设备 did 是 did:myco:——信箱路由键两种前缀均合法。
 *  2026-10-10 canonical-only 收敛：legacy 裸 base58（32B）不再双收——parseCryptoDid
 *  拒 ⇒ 这里拒（统一文案「不支持的 did 格式」，与三端/平台 40115 同口径）。 */
function msgDidOk(did) {
  return !!parseCryptoDid(did)
}

function sweep(now = Date.now()) {
  // TTL 清理：过期条目整体丢（中转件不是档案，过期即无意义）
  for (const [acc, arr] of inbox) {
    const kept = arr.filter((m) => now - m.ts < INBOX_TTL_MS)
    if (kept.length !== arr.length) kept.length ? inbox.set(acc, kept) : inbox.delete(acc)
  }
}

function loadInbox() {
  try {
    if (!existsSync(INBOX_STORE)) return
    const raw = JSON.parse(readFileSync(INBOX_STORE, 'utf8'))
    for (const [acc, arr] of Object.entries(raw)) {
      if (Array.isArray(arr)) inbox.set(acc, arr)
      for (const m of arr) if (typeof m.seq === 'number' && m.seq > seqCounter) seqCounter = m.seq
    }
    sweep()
  } catch { /* 坏文件按空信箱起——中转件丢了可重发 */ }
}

function saveInbox() {
  try {
    // 只落盘可持久化的小消息（文本/握手/任务卡）；大媒体内存态
    const out = {}
    for (const [acc, arr] of inbox) {
      const small = arr.filter((m) => (m.payload ? JSON.stringify(m.payload).length : 0) <= PERSIST_MAX)
      if (small.length) out[acc] = small
    }
    writeFileSync(INBOX_STORE, JSON.stringify(out))
  } catch { /* 落盘失败不挡内存态 */ }
}
loadInbox()

/** 入箱统一口：cap 截断 + 落盘。 */
function deposit(accountDid, env) {
  const arr = inbox.get(accountDid) ?? []
  arr.push(env)
  if (arr.length > INBOX_CAP) arr.splice(0, arr.length - INBOX_CAP) // 丢最老
  inbox.set(accountDid, arr)
}

/** 跨模块入箱（2026-10-20 官方通知 official.mjs 用：服务端直连入队，不经 /msg/send）。 */
export function depositInbox(accountDid, env) {
  deposit(accountDid, env)
  saveInbox()
}

/** `/msg/poll` 出队钩子（官方通知置 delivered 用；出队即 ACK，钩子拿到即将删除的批量）。 */
let pollHook = null
export function setPollHook(fn) {
  pollHook = typeof fn === 'function' ? fn : null
}

/**
 * POST 路由处理（body 已 JSON 解析；rawBody 用于验签）。
 * ctx.authedDid(rawBody, authHeader) —— identity-server 注入的签名验证函数，返回设备 did 或 null。
 */
export async function handleMsgPost(pathname, rawBody, authHeader, body, send, ctx) {
  const authedDid = ctx?.authedDid
  if (typeof authedDid !== 'function') return send(500, { error: 'msg 路由缺 authedDid 注入' })
  const fromDevice = await authedDid(rawBody, authHeader)
  if (!fromDevice) return send(403, { error: '签名无效或未注册' })

  if (pathname === '/msg/send') {
    const { fromAccountDid = '', fromName = '', toAccountDid, kind, payload, msgId, ts } = body ?? {}
    if (!MSG_KINDS.has(kind)) return send(400, { error: `未知 kind: ${kind}（聊天正文请走 P2P 直连——第84轮服务器只收控制消息）` })
    if (!msgId || typeof msgId !== 'string') return send(400, { error: '缺 msgId' })
    // 第85轮：群管理操作验设备归属——签名设备（fromDevice）必须真的在 fromAccountDid
    // 名下（未吊销），否则任何人可伪称 owner 发 group-kick/invite（签名只证明持钥，
    // fromAccountDid 是自报字段）。名册缺失（老部署/极端时序）→ 拒绝（fail-closed）。
    if (GROUP_ADMIN_KINDS.has(kind) && ctx?.rootApi) {
      const acc = ctx.rootApi.getRoot(fromAccountDid)
      const belongs = acc && acc.devices.some((dv) => {
        if (dv.revoked) return false
        try { return didFromPublicKey(new Uint8Array(Buffer.from(dv.pubkeyB64, 'base64'))) === fromDevice } catch { return false }
      })
      if (!belongs) return send(403, { error: '群管理消息的签名设备不属于声称的发起账号' })
    }
    // 群 kind 的 toAccountDid 是名义目标（groupId，扇出真名单在 payload.members[]）——
    // 不做 did 校验（E2E 抓过：groupId 被 did 校验拒掉，群消息 400）。
    const isGroupKind = (kind === 'group-create' || kind === 'group-msg') && Array.isArray(payload?.members)
    if (!toAccountDid || typeof toAccountDid !== 'string') return send(400, { error: '缺 toAccountDid' })
    if (!isGroupKind && !msgDidOk(toAccountDid)) return send(400, { error: '不支持的 did 格式（toAccountDid 须为 canonical：did:<method>:z…；legacy 裸 base58 已废止）' })
    if (fromAccountDid && !msgDidOk(fromAccountDid)) return send(400, { error: '不支持的 did 格式（fromAccountDid 须为 canonical：did:<method>:z…）' })
    const size = payload == null ? 0 : JSON.stringify(payload).length
    if (size > MAX_PAYLOAD) return send(413, { error: `payload 超 3MB 上限（${size}B）` })
    const env = {
      seq: ++seqCounter,
      id: String(msgId).slice(0, 64),
      from: fromAccountDid || fromDevice, // 好友锚=账号 did；匿名兜底设备 did（老客户端）
      fromName: String(fromName || '').slice(0, 64),
      fromDevice,
      kind,
      payload: payload ?? {},
      ts: Number(ts) || Date.now(),
    }
    // 群消息扇出：payload.members[]（群建卡/群聊），发送者自己不投
    let recipients = [toAccountDid]
    if ((kind === 'group-create' || kind === 'group-msg') && Array.isArray(payload?.members)) {
      recipients = payload.members.filter((m) => msgDidOk(m) && m !== env.from)
    }
    for (const acc of recipients) deposit(acc, env)
    saveInbox()
    return send(200, { ok: true, data: { delivered: recipients.length, seq: env.seq } })
  }

  if (pathname === '/msg/poll') {
    const { accountDid } = body ?? {}
    if (!accountDid || !msgDidOk(accountDid)) return send(400, { error: '不支持的 did 格式（accountDid 须为 canonical：did:<method>:z…）' })
    const msgs = inbox.get(accountDid) ?? []
    if (msgs.length && pollHook) {
      // 2026-10-20：官方通知投递回执（official.mjs 据此把 notice 置 delivered）。
      // 钩子异常不得影响出队语义（中转件优先，钩子只是状态旁路）。
      try { pollHook(accountDid, msgs) } catch { /* 状态更新失败→下次查询仍显示 queued，可接受 */ }
    }
    inbox.delete(accountDid) // 拉走即删（ACK 语义）
    if (msgs.length) saveInbox()
    return send(200, { ok: true, data: { msgs, cursor: seqCounter } })
  }

  return send(404, { error: 'unknown msg route' })
}

// ── 测试钩子（node --test 专用，生产不调）──
export const __test = { inbox, sweep, INBOX_CAP, MSG_KINDS, msgDidOk, loadInbox, INBOX_STORE }
