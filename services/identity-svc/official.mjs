// official.mjs — 官方通知通道（2026-10-20 申诉陈词 24h 触达的前置：
// 「小灵」官方智能体 + 平台服务端主动推结构化通知）。
//
// 定位：**服务端直连的官方↔用户单向通知**，不是聊天正文通道。
//   · 官方账号 = 全局唯一 `did:youling`（昵称「小灵」，根钥存 official.json，服务端签每条通知，
//     客户端可用官方账号公钥验签 → 客户端不能被他人伪造 official-notice）；
//   · 平台侧调 `POST /official/notify`（X-Official-Token 鉴权，服务端到服务端）；
//     入队后复用 msg.mjs 的信箱（`/msg/poll`）投递到用户账号，**离线可达**
//     （信箱持久化 30 天；官方通知自身 TTL 默认 7 天，可 per-notice 指定）；
//   · 状态机 `queued → delivered(poll 拉走) → read(端侧打开会话回执) / expired`；
//     `GET /official/status` 供平台查「未投递/未读」名单（申诉管理面板第③层数据源）；
//   · 群发：一次 ≤200 个 did，各自独立 noticeId/未读/状态；失败逐条进 `rejected`，
//     不影响其他人。限流：单 token 20 req/s（可配）。
//
// 契约（与申诉管理会话对齐，2026-10-20）：
//   POST /official/notify  Header: X-Official-Token
//     {to:[did,...], title, body, action:{label,url}, category?, dedupeKey?, expiresInMs?,
//      meta?{caseId,itemId,...}}
//     → {ok, data:{batchId, notices:[{did,noticeId,state:"queued",dedupe}], rejected:[{did,reason}]}}
//   GET  /official/status?noticeIds=a,b | ?dids=d1,d2&unread=1&category=…&olderThanMs=…&limit=…
//     → {ok, data:{notices:[{noticeId,did,title,category,state,createdAt,deliveredAt,readAt,expiresAt}], count}}
//   POST /official/read  （设备签名 X-Myco-Auth；body {accountDid, noticeIds:[...]}）
//     → {ok, data:{marked:n}}   —— 服务端校验该设备属于 accountDid（同群管理 kind 口径）
//   GET  /official/info（公开）→ {ok, data:{did,name,pubkeyB64,online:true}}
//
// 签名材料（客户端验签用；ed25519）：
//   `official-notice\n<userAccountDid>\n<noticeId>\n<createdAt>\n<sha256hex(title\nbody\nlabel\nurl)>`
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { importPrivateKey, sign } from './identity/crypto.mjs'
import { parseCryptoDid, didFromPublicKey } from './identity/did.mjs'

// ── 常量（与契约文档保持一致；改这里要同步 docs/todo/2026-10-20-小灵官方智能体与服务端推送-设计与R.md）──
export const TITLE_MAX = 60          // 字（code point 计）
export const BODY_MAX = 500
export const ACTION_LABEL_MAX = 20
export const CATEGORY_MAX = 40
export const META_MAX_BYTES = 2048
export const DEDUPE_MAX = 120
export const BATCH_MAX = 200
export const STATUS_IDS_MAX = 500
export const READ_IDS_MAX = 200
export const PENDING_MAX = 100   // /official/pending 单次返回上限（客户端自愈同步）
export const STATUS_LIMIT_MAX = 1000
export const TTL_DEFAULT_MS = 7 * 24 * 3600_000
export const TTL_MIN_MS = 60_000
export const TTL_MAX_MS = 30 * 24 * 3600_000
export const NOTICE_CAP = 50_000     // 单机通知表上限（超限先清过期，再丢最老）
export const NOTICE_KIND = 'official-notice'
export const DEFAULT_URL_HOSTS = ['dev.youling.cc', 'www.youling.cc', 'youling.cc', 'tool.youling.cc', 'myco.youling.cc']
export const DEFAULT_RATE_PER_SEC = 20

export const OFFICIAL_GET_ROUTES = new Set(['/official/info', '/official/status'])
export const OFFICIAL_POST_ROUTES = new Set(['/official/notify', '/official/read', '/official/pending'])

/** 字（code point）计长——emoji 不按 UTF-16 双位算。 */
function cpLen(s) { return [...String(s)].length }
/** 控制字符闸（换行在 body 里允许，标题/label 不允许）。 */
function hasCtl(s, allowNewline = false) {
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    if (c === 0x0a || c === 0x0d) { if (!allowNewline) return true; continue }
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}
function sha256hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex') }

/** 客户端验签用的规范材料（PC Rust / 手机 chip 端同口径）。导出供测试与文档引用。 */
export function noticeSignMaterial(did, noticeId, createdAt, { title, body, action }) {
  const inner = sha256hex(`${title}\n${body}\n${action.label}\n${action.url}`)
  return `${NOTICE_KIND}\n${did}\n${noticeId}\n${createdAt}\n${inner}`
}

/** 读官方账号（identity-svc 目录下的 official.json；缺失=通道未配置）。 */
/** 归一化官方账号对象（注入或文件读入都用它）：返回 {did,name,rootPubkeyB64,devices,signer}。 */
export function normalizeOfficialAccount(o) {
  if (!o?.did) return null
  // 已归一化（loadOfficialAccount 的返回值）→ 幂等直接返回（防双重归一化变 null）
  if ('signer' in o && 'devices' in o) return o
  const name = o.name || '小灵'
  if (o.devicePrivPkcs8B64 && o.devicePubkeyB64) {
    const signer = { name, pubkeyB64: o.devicePubkeyB64, privPkcs8B64: o.devicePrivPkcs8B64 }
    return { did: o.did, name, rootPubkeyB64: o.rootPubkeyB64 || o.pubkeyB64, devices: [{ name, pubkeyB64: o.devicePubkeyB64 }], signer }
  }
  if (o.privPkcs8B64) {
    const rootPub = o.rootPubkeyB64 || o.pubkeyB64
    return { did: o.did, name, rootPubkeyB64: rootPub, devices: [], signer: { name, pubkeyB64: rootPub, privPkcs8B64: o.privPkcs8B64 } }
  }
  if (o.rootPubkeyB64 && o.devicePubkeyB64) {  // 只有公钥（只读巡检场景）
    return { did: o.did, name, rootPubkeyB64: o.rootPubkeyB64, devices: [{ name, pubkeyB64: o.devicePubkeyB64 }], signer: null }
  }
  return null
}

export function loadOfficialAccount(dir) {
  const p = join(dir, 'official.json')
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j?.did || !j?.rootPubkeyB64) return null
    // 新格式（2026-10-20 DID 轮换后）：identity-svc 只持「小灵推送」设备钥（root 私钥不进本服务）。
    // 兼容旧格式（root 私钥直签）：{pubkeyB64, privPkcs8B64}。
    const devices = []
    let signer
    if (j.devicePrivPkcs8B64 && j.devicePubkeyB64) {
      signer = { name: j.name || '小灵', pubkeyB64: j.devicePubkeyB64, privPkcs8B64: j.devicePrivPkcs8B64 }
      devices.push({ name: signer.name, pubkeyB64: signer.pubkeyB64 })
    } else if (j.privPkcs8B64) {
      signer = { name: j.name || '小灵', pubkeyB64: j.rootPubkeyB64, privPkcs8B64: j.privPkcs8B64 }
    } else {
      return null
    }
    return { did: j.did, name: j.name || '小灵', rootPubkeyB64: j.rootPubkeyB64, devices, signer }
  } catch { return null }
}

/**
 * @param {object} opts
 * @param {string} opts.dir           identity-svc 数据目录（official.json / official-notices.json 所在）
 * @param {string} [opts.token]       平台服务端 token（缺省读 env MYCO_OFFICIAL_TOKEN 或 dir/official-token.txt）
 * @param {(accountDid:string, env:object)=>void} opts.deposit  信箱入队函数（msg.mjs 提供）
 * @param {object} [opts.official]    官方账号（测试注入；缺省从 dir/official.json 读）
 * @param {string[]} [opts.urlHosts]  action.url 允许域名
 * @param {number} [opts.ratePerSec]  单 token 每秒请求上限
 * @param {()=>number} [opts.now]     时钟（测试注入）
 */
export function createOfficialApi(opts) {
  const dir = opts.dir
  const storePath = join(dir, 'official-notices.json')
  const now = opts.now || (() => Date.now())
  const deposit = opts.deposit
  const urlHosts = opts.urlHosts || DEFAULT_URL_HOSTS
  const ratePerSec = opts.ratePerSec || DEFAULT_RATE_PER_SEC
  const tokens = opts.token !== undefined ? [opts.token] : readTokens()
  let official = normalizeOfficialAccount(opts.official !== undefined ? opts.official : loadOfficialAccount(dir))
  let signKey = null       // Promise<CryptoKey>
  /** noticeId -> notice */
  const notices = new Map()
  /** dedupe key -> noticeId */
  const dedupe = new Map()
  /** accountDid -> {cardAt, cap, version, legacyAt}（客户端能力证据：新版 pending 心跳 vs 旧版信箱拉取） */
  const clients = new Map()
  let seq = 0
  let rate = { sec: 0, count: 0 }

  // 2026-10-24 多 token（TD 联调）：env 单值向后兼容；official-token.txt 每行一个（# 注释/空行忽略）。
  // 各 token 同限流桶（按请求计，不按 token 分桶——契约口径「同限流桶 20 req/s」）。
  function readTokens() {
    const out = []
    if (process.env.MYCO_OFFICIAL_TOKEN) out.push(process.env.MYCO_OFFICIAL_TOKEN.trim())
    try {
      for (const line of readFileSync(join(dir, 'official-token.txt'), 'utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (t && !t.startsWith('#')) out.push(t)
      }
    } catch { /* 无 token 文件 */ }
    return [...new Set(out)]
  }

  function load() {
    try {
      if (!existsSync(storePath)) return
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      for (const n of raw.notices || []) {
        notices.set(n.noticeId, n)
        if (n.dedupeKey) dedupe.set(`${n.did}|${n.dedupeKey}`, n.noticeId)
      }
      for (const [acc, c] of Object.entries(raw.clients || {})) {
        if (acc && c && typeof c === 'object') clients.set(acc, c)
      }
    } catch { /* 坏文件按空表起（通知可重推） */ }
    sweep()
  }
  function save() {
    try {
      mkdirSync(dirname(storePath), { recursive: true })
      writeFileSync(storePath, JSON.stringify({
        notices: [...notices.values()],
        clients: Object.fromEntries(clients),
      }))
    } catch { /* 落盘失败不挡内存态 */ }
  }
  function sweep() {
    const t = now()
    let dirty = false
    for (const [id, n] of notices) {
      if (n.state !== 'read' && t > n.expiresAt) { n.state = 'expired'; dirty = true }
      if (t - n.expiresAt > 30 * 24 * 3600_000) { notices.delete(id); dirty = true } // 过期 30 天后清行
    }
    if (notices.size > NOTICE_CAP) {
      const arr = [...notices.values()].sort((a, b) => a.createdAt - b.createdAt)
      for (const n of arr.slice(0, arr.length - NOTICE_CAP)) { notices.delete(n.noticeId); dirty = true }
    }
    if (dirty) save()
  }
  function checkRate() {
    const sec = Math.floor(now() / 1000)
    if (sec !== rate.sec) rate = { sec, count: 0 }
    rate.count++
    return rate.count <= ratePerSec
  }
  async function getSignKey() {
    if (!official?.signer) return null
    if (!signKey) signKey = importPrivateKey(new Uint8Array(Buffer.from(official.signer.privPkcs8B64, 'base64')))
    return signKey
  }
  function tokenOk(header) {
    if (!tokens.length) return false
    const got = String(header || '')
    // 任一 token 匹配即过（每个候选常数时间比较，防时序侧信道；服务端到服务端密钥）
    for (const tk of tokens) {
      if (got.length !== tk.length) continue
      let diff = 0
      for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ tk.charCodeAt(i)
      if (diff === 0) return true
    }
    return false
  }
  function validActionUrl(u) {
    try {
      const x = new URL(String(u))
      if (x.protocol !== 'https:' && x.protocol !== 'http:') return false
      return urlHosts.includes(x.hostname)
    } catch { return false }
  }

  /** 校验单条 notice 请求体；返回 {ok, err} 或归一化字段。 */
  function validateOne(src) {
    const title = String(src?.title ?? '')
    const body = String(src?.body ?? '')
    const action = src?.action && typeof src.action === 'object' ? src.action : null
    if (!cpLen(title) || cpLen(title) > TITLE_MAX) return { ok: false, err: `title 必须 1..${TITLE_MAX} 字` }
    if (hasCtl(title)) return { ok: false, err: 'title 含控制字符' }
    if (!cpLen(body) || cpLen(body) > BODY_MAX) return { ok: false, err: `body 必须 1..${BODY_MAX} 字` }
    if (hasCtl(body, true)) return { ok: false, err: 'body 含控制字符' }
    if (!action || !cpLen(action.label) || cpLen(action.label) > ACTION_LABEL_MAX) return { ok: false, err: `action.label 必须 1..${ACTION_LABEL_MAX} 字` }
    if (!validActionUrl(action.url)) return { ok: false, err: `action.url 不在允许域名（${urlHosts.join('/')}）或不是 http(s)`, reason: 'url_not_allowlisted' }
    const category = src?.category == null ? '' : String(src.category)
    if (category && (cpLen(category) > CATEGORY_MAX || hasCtl(category))) return { ok: false, err: `category ≤${CATEGORY_MAX} 字且无控制字符` }
    const meta = src?.meta ?? null
    if (meta != null) {
      const s = JSON.stringify(meta)
      if (s.length > META_MAX_BYTES) return { ok: false, err: `meta ≤${META_MAX_BYTES}B` }
    }
    const dedupeKey = src?.dedupeKey == null ? '' : String(src.dedupeKey)
    if (dedupeKey && (cpLen(dedupeKey) > DEDUPE_MAX || hasCtl(dedupeKey))) return { ok: false, err: `dedupeKey ≤${DEDUPE_MAX} 字` }
    let ttl = Number(src?.expiresInMs ?? TTL_DEFAULT_MS)
    if (!Number.isFinite(ttl)) ttl = TTL_DEFAULT_MS
    ttl = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Math.floor(ttl)))
    return { ok: true, v: { title, body, action: { label: String(action.label), url: String(action.url) }, category, meta, dedupeKey, ttl } }
  }

  async function handleNotify(body, headers, send) {
    if (!tokenOk(headers?.['x-official-token'])) return send(401, { error: 'X-Official-Token 缺失或错误' })
    if (!official) return send(503, { error: '官方通道未配置（缺 official.json）' })
    if (!checkRate()) return send(429, { error: `限流：单 token ${ratePerSec} req/s` })
    const to = Array.isArray(body?.to) ? body.to : []
    if (!to.length) return send(400, { error: 'to 必须是非空 did 数组' })
    if (to.length > BATCH_MAX) return send(400, { error: `to 单批上限 ${BATCH_MAX}` })
    const v = validateOne(body)
    if (!v.ok) return send(400, { error: v.err, ...(v.reason ? { code: v.reason, reason: v.reason } : {}) })
    const key = await getSignKey()
    if (!key) return send(503, { error: '官方私钥不可用' })
    const batchId = `batch-${randomUUID()}`
    const noticesOut = []
    const rejected = []
    const t = now()
    for (const raw of to) {
      const did = String(raw || '')
      if (!parseCryptoDid(did)) { rejected.push({ did, reason: '不支持的 did 格式（须 canonical did:<method>:z…）' }); continue }
      const dk = v.v.dedupeKey ? `${did}|${v.v.dedupeKey}` : ''
      if (dk && dedupe.has(dk)) {
        const ex = notices.get(dedupe.get(dk))
        if (ex && ex.state !== 'expired') {
          noticesOut.push({ did, noticeId: ex.noticeId, state: ex.state, dedupe: true })
          continue
        }
      }
      const noticeId = `ntc-${randomUUID()}`
      const createdAt = t
      const expiresAt = t + v.v.ttl
      const material = noticeSignMaterial(did, noticeId, createdAt, v.v)
      const sigB64 = Buffer.from(await sign(key, new TextEncoder().encode(material))).toString('base64')
      const notice = {
        noticeId, did, batchId, title: v.v.title, body: v.v.body, action: v.v.action,
        category: v.v.category, meta: v.v.meta, dedupeKey: v.v.dedupeKey,
        createdAt, expiresAt, state: 'queued', deliveredAt: null, readAt: null,
      }
      notices.set(noticeId, notice)
      if (dk) dedupe.set(dk, noticeId)
      seq++
      const env = {
        seq,
        id: noticeId,
        from: official.did,
        fromName: official.name,
        fromDevice: '',
        kind: NOTICE_KIND,
        payload: {
          noticeId, title: v.v.title, body: v.v.body, action: v.v.action,
          category: v.v.category, meta: v.v.meta,
          createdAt, expiresAt, sigB64, sigAlg: 'ed25519',
          // 验签公钥：客户端优先用 signer.pubkeyB64；并应核对它 ∈ /root/<officialDid>.devices
          signer: { name: official.signer.name, pubkeyB64: official.signer.pubkeyB64 },
          officialDid: official.did, officialName: official.name,
        },
        ts: createdAt,
      }
      deposit(did, env)
      noticesOut.push({ did, noticeId, state: 'queued', dedupe: false })
    }
    save()
    return send(200, { ok: true, data: { batchId, notices: noticesOut, rejected, nextPollHintMs: 5000 } })
  }

  function parseList(v, max) {
    if (v == null || v === '') return []
    const arr = String(v).split(',').map((s) => s.trim()).filter(Boolean)
    return arr.slice(0, max)
  }

  function handleStatus(query, headers, send) {
    if (!tokenOk(headers?.['x-official-token'])) return send(401, { error: 'X-Official-Token 缺失或错误' })
    sweep()
    const ids = parseList(query.get('noticeIds'), STATUS_IDS_MAX)
    const dids = parseList(query.get('dids'), BATCH_MAX)
    const category = (query.get('category') || '').trim()
    const state = (query.get('state') || '').trim()
    const unreadOnly = query.get('unread') === '1'
    const olderThanMs = Number(query.get('olderThan') || query.get('olderThanMs') || 0) // 契约: olderThan（毫秒），兼容 olderThanMs
    const sinceMs = Number(query.get('sinceMs') || 0)
    let limit = Number(query.get('limit') || 200)
    if (!Number.isFinite(limit) || limit <= 0) limit = 200
    limit = Math.min(STATUS_LIMIT_MAX, limit)
    const t = now()
    const out = []
    for (const n of notices.values()) {
      if (ids.length && !ids.includes(n.noticeId)) continue
      if (dids.length && !dids.includes(n.did)) continue
      if (category && n.category !== category) continue
      if (state && n.state !== state) continue
      if (unreadOnly && n.state === 'read') continue
      if (sinceMs && n.createdAt < sinceMs) continue
      if (olderThanMs && t - n.createdAt < olderThanMs) continue
      out.push({
        noticeId: n.noticeId, did: n.did, batchId: n.batchId, title: n.title, category: n.category,
        state: n.state, createdAt: n.createdAt, deliveredAt: n.deliveredAt, readAt: n.readAt, expiresAt: n.expiresAt,
        clientCapability: capabilityOf(n.did), clientLastSeenAt: lastSeenOf(n.did),
        meta: n.meta,
      })
    }
    // 2026-10-20 修：先前是「边收集边 break」再排序——截断的是最老 N 条（顺序错误）。
    // 平台轮询要的是最新状态：先全量排序（新→旧）再截断 limit。
    out.sort((a, b) => b.createdAt - a.createdAt)
    const sliced = out.slice(0, limit)
    return send(200, { ok: true, data: { notices: sliced, count: sliced.length } })
  }

  /** 该账号最近一次出现的客户端能力：card-v1（新版客户端 /official/pending 心跳或 read）、
   *  legacy（只有旧版信箱拉取证据）、null（没见过任何客户端）。 */
  function capabilityOf(did) {
    const c = clients.get(did)
    if (!c) return null
    if (c.cardAt || c.cap === 'card-v1') return 'card-v1'
    if (c.legacyAt) return 'legacy'
    return null
  }
  function lastSeenOf(did) {
    const c = clients.get(did)
    return c?.cardAt || c?.legacyAt || null
  }

  /** msg.mjs `/msg/poll` 出队后回调（2026-10-20 语义调整）：
   *  **出队 ≠ 已触达**——旧版客户端也会把 official-notice 拉走并当未知 kind 丢弃。
   *  这里只记「该账号出现过 legacy 客户端」证据，通知状态保持 queued；
   *  真正的 delivered 由 /official/pending（新版客户端 3s 心跳）标记。 */
  function onPolled(accountDid, msgs) {
    const sawOfficial = (msgs || []).some((m) => m?.kind === NOTICE_KIND)
    if (!sawOfficial) return
    const c = clients.get(accountDid) || {}
    c.legacyAt = now()
    clients.set(accountDid, c)
    save()
  }

  /** 设备签名 + 设备归属校验（read/pending 共用；失败已 send 错误并返回 null）。 */
  async function verifySignedAccount(rawBody, authHeader, body, send, ctx) {
    if (typeof ctx?.authedDid !== 'function') { send(500, { error: '官方通道缺 authedDid 注入' }); return null }
    const deviceDid = await ctx.authedDid(rawBody, authHeader)
    if (!deviceDid) { send(403, { error: '签名无效或未注册' }); return null }
    const accountDid = String(body?.accountDid || '')
    if (!parseCryptoDid(accountDid)) { send(400, { error: 'accountDid 须为 canonical did' }); return null }
    let belongs = false
    try {
      const acc = ctx.rootApi?.getRoot(accountDid)
      belongs = !!acc && acc.devices.some((dv) => {
        if (dv.revoked) return false
        try { return didFromPublicKey(new Uint8Array(Buffer.from(dv.pubkeyB64, 'base64'))) === deviceDid } catch { return false }
      })
    } catch { belongs = false }
    if (!belongs) { send(403, { error: '签名设备不属于该账号' }); return null }
    return accountDid
  }

  /** 通知行 → 投递信封（现签；与 inbox 里的信封同形，客户端按 msgId=noticeId 幂等）。 */
  async function buildNoticeEnvelope(n, key) {
    const material = noticeSignMaterial(n.did, n.noticeId, n.createdAt,
      { title: n.title, body: n.body, action: n.action })
    const sigB64 = Buffer.from(await sign(key, new TextEncoder().encode(material))).toString('base64')
    seq++
    return {
      seq, id: n.noticeId, from: official.did, fromName: official.name, fromDevice: '',
      kind: NOTICE_KIND,
      payload: {
        noticeId: n.noticeId, title: n.title, body: n.body, action: n.action,
        category: n.category, meta: n.meta, createdAt: n.createdAt, expiresAt: n.expiresAt,
        sigB64, sigAlg: 'ed25519',
        signer: { name: official.signer?.name || official.name, pubkeyB64: official.signer?.pubkeyB64 || '' },
        officialDid: official.did, officialName: official.name,
      },
      ts: n.createdAt,
    }
  }

  /** 客户端自愈同步：返回「已投递但未读」的通知。
   *  动机：/msg/poll 是「拉走即删」ACK 语义——若响应在网络上丢失，通知会永久丢。
   *  客户端定时（或启动）调本端点，把 delivered 且未 read 的通知补投一次（幂等）。 */
  async function handlePending(rawBody, authHeader, body, send, ctx) {
    const accountDid = await verifySignedAccount(rawBody, authHeader, body, send, ctx)
    if (!accountDid) return
    sweep()
    const key = await getSignKey()
    if (!key) return send(503, { error: '官方私钥不可用' })
    const sinceMs = Number(body?.sinceMs || 0)
    const t = now()
    // 能调用 /official/pending 的只可能是新版客户端（旧版没有该行为）→ 这是「触达」证据
    const ci = body?.client && typeof body.client === 'object' ? body.client : null
    const caps = Array.isArray(ci?.caps) ? ci.caps.map(String) : []
    const acct = clients.get(accountDid) || {}
    acct.cardAt = t
    if (caps.includes('official-card-v1')) acct.cap = 'card-v1'
    if (ci?.version) acct.version = String(ci.version).slice(0, 40)
    clients.set(accountDid, acct)

    const rows = [...notices.values()]
      // 新版客户端会主动拉 delivered/queued 的未读通知；queued 也可在此转为 delivered
      //（旧版客户端只拉信箱、不会拉这里 → 不会误标触达）
      .filter((n) => n.did === accountDid && (n.state === 'queued' || n.state === 'delivered')
        && n.expiresAt > t && (!sinceMs || n.createdAt >= sinceMs))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, PENDING_MAX)
    const msgs = []
    for (const n of rows) {
      if (n.state === 'queued') { n.state = 'delivered'; n.deliveredAt = t }
      msgs.push(await buildNoticeEnvelope(n, key))
    }
    save()
    return send(200, { ok: true, data: { msgs, count: msgs.length } })
  }

  // 2026-10-24 平台代读（TD-021~025，契约 v1.3 §9.1）：X-Official-Token 头存在即走 token 模式
  // （token 无效直接 401，绝不回落签名模式——防降级绕过）；无 token 头 = 既有设备签名模式（行为不变）。
  function handleReadByToken(body, tokHeader, send) {
    if (!tokenOk(tokHeader)) return send(401, { error: 'X-Official-Token 缺失或错误' })
    if (!checkRate()) return send(429, { error: `限流：单 token ${ratePerSec} req/s` })
    const did = String(body?.did || '')
    const dedupeKey = String(body?.dedupeKey || '')
    if (!did.startsWith('did:') || !dedupeKey) return send(400, { error: '缺 did 或 dedupeKey' })
    const t = now()
    const noticeId = dedupe.get(`${did}|${dedupeKey}`)
    const n = noticeId ? notices.get(noticeId) : null
    if (!n) return send(200, { ok: true, data: { matched: 0 } })
    if (n.state === 'read') return send(200, { ok: true, data: { matched: 1, noticeId, state: 'read', already: true } })
    if (n.state === 'expired' || t > n.expiresAt) return send(200, { ok: true, data: { matched: 1, noticeId, state: 'expired', note: '已过期不可置读' } })
    const prevState = n.state // 'queued' | 'delivered'（TD-024：两者均可直置 read）
    n.state = 'read'
    n.readAt = t
    if (!n.deliveredAt) n.deliveredAt = t
    save()
    return send(200, { ok: true, data: { matched: 1, noticeId, prevState, state: 'read' } })
  }

  async function handleRead(rawBody, authHeader, body, send, ctx) {
    const tokHeader = ctx?.headers?.['x-official-token']
    if (tokHeader !== undefined) return handleReadByToken(body, tokHeader, send)
    const accountDid = await verifySignedAccount(rawBody, authHeader, body, send, ctx)
    if (!accountDid) return
    const ids = Array.isArray(body?.noticeIds) ? body.noticeIds.map(String) : []
    if (!ids.length) return send(400, { error: 'noticeIds 必须是非空数组' })
    if (ids.length > READ_IDS_MAX) return send(400, { error: `noticeIds 单次上限 ${READ_IDS_MAX}` })
    const t = now()
    let marked = 0
    for (const id of ids) {
      const n = notices.get(id)
      if (!n || n.did !== accountDid) continue    // 只动自己的——别人的 id 静默跳过（不探测存在性）
      if (n.state === 'read' || n.state === 'expired') continue
      n.state = 'read'
      n.readAt = t
      if (!n.deliveredAt) n.deliveredAt = t
      marked++
    }
    if (marked) save()
    return send(200, { ok: true, data: { marked } })
  }

  function handleInfo(headers, send) {
    if (!official) return send(503, { error: '官方通道未配置' })
    return send(200, {
      ok: true,
      data: {
        did: official.did, name: official.name,
        pubkeyB64: official.rootPubkeyB64, // 账号根公钥（客户端可验 root 签名）
        devices: official.devices,        // 通知签名钥（客户端验 notice 用；应与 /root/<did>.devices 一致）
        online: true,
      },
    })
  }

  /** 测试/运维：当前通知数（不对外暴露接口）。 */
  function stats() { return { notices: notices.size, dedupe: dedupe.size, configured: !!official, tokenConfigured: tokens.length > 0 } }

  load()
  // 懒签名键不预热（启动快）；首次 notify 时 import。

  return {
    handleGet(pathname, query, headers, send) {
      if (pathname === '/official/info') return handleInfo(headers, send)
      if (pathname === '/official/status') return handleStatus(query, headers, send)
      return send(404, { error: 'unknown official route' })
    },
    async handlePost(pathname, rawBody, authHeader, body, send, ctx) {
      if (pathname === '/official/notify') return handleNotify(body, ctx?.headers, send)
      if (pathname === '/official/read') return handleRead(rawBody, authHeader, body, send, ctx)
      if (pathname === '/official/pending') return handlePending(rawBody, authHeader, body, send, ctx)
      return send(404, { error: 'unknown official route' })
    },
    // 2026-11-07：/relay/stats 等内部路由复用同一份 token 校验（多 token 契约见 readTokens）
    tokenOk,
    onPolled,
    stats,
    __test: { notices, dedupe, sweep, save, load, noticeSignMaterial },
  }
}
