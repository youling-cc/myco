// identity-server.mjs — 独立 DID 身份服务（零依赖，Node 内置 http）。
// DID API（全部 POST，见 lib/identity/index.mjs）：
//   /identity/register | /identity/challenge | /identity/login
//   /identity/ciphertext | /identity/verify
// 通信簿 presence（在线登记/发现，in-memory，90s 无心跳判离线）：
//   /presence/register  {did,nodeId,name,token} → 登记/更新在线（token 须匹配 did）
//   /presence/heartbeat {did,token} → 保活
//   /presence/list      {token} → 列出在线节点（任何登录用户）
// WebRTC 信令（只转 SDP/ICE 元数据建联，数据 phone⇄PC 直连不经服务器）：
//   POST /signal/offer  {to, sdp}        → phone 发起 offer 到 PC
//   POST /signal/answer {to, sdp}        → PC 应答
//   POST /signal/ice    {to, candidate}  → 双向交换 ICE 候选
//   GET  /signal/poll                    → SSE 长连拉自己信箱（fetch-based，带 X-Myco-Auth）
// 好友聊天中转（第81轮，msg.mjs——拉走即删零存档；2026-10-07 好友去服务端化：
// friend-request/accept/remove 三 kind 回归白名单，只中转不裁决）：
//   POST /msg/send {fromAccountDid, fromName, toAccountDid, kind, payload, msgId, ts}
//   POST /msg/poll {accountDid} → 拉走即删
// （第86轮的 /friends/* 服务器权威表已随好友去服务端化删除——好友关系=双方本地
//  档案+签名握手，见端侧 chat_service.rs / chat-store.ts；/friends/* 现为 404。）
// 另：GET 非 API 路径 → 托管手机端 PWA 静态文件（web/），SPA 回退 index.html。
// 服务器只做：静态托管 + DID API + presence 登记 + WebRTC 信令中介；终端数据走 P2P 不经服务器。

import http from 'node:http'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIdentityApi, IdentityStore, IDENTITY_ROUTES, importPublicKey, verify, isCryptoDid, didFromPublicKey, normalizeDid } from './identity/index.mjs'
import { DELEGATION_ROUTES, handleDelegationPost, handleDelegationGet, addRevocationInternal } from './delegation.mjs'
import { MSG_ROUTES, handleMsgPost, depositInbox, setPollHook } from './msg.mjs'
import { createOfficialApi, OFFICIAL_GET_ROUTES, OFFICIAL_POST_ROUTES } from './official.mjs'
import { createRootApi } from './identity/root.mjs'
import { deposit, startPoll, drain } from './signal.mjs'
import { FeedbackStore } from './feedback.mjs'
import { AccessLogStore } from './access-log.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8321)
const DB_PATH = process.env.DB_PATH || resolve(__dirname, 'identity.db')
const HOST = process.env.HOST || '0.0.0.0'
const WEB_ROOT = resolve(__dirname, 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  // 发布下载包:zip/apk 必须显式(浏览器按 type 决定下载行为,apk 给 Android 触发安装弹窗)
  '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
}

const store = new IdentityStore({ path: DB_PATH })
// 2026-11-12 开源整改：反馈库/访问日志库支持环境变量覆盖，单测指临时目录，
// 运行时数据不再写仓内工作树。默认路径不变（生产行为零变化）。
const feedbackStore = new FeedbackStore({ path: process.env.FEEDBACK_DB_PATH || resolve(__dirname, 'feedback.db') })
const accessStore = new AccessLogStore({ path: process.env.ACCESS_DB_PATH || resolve(__dirname, 'access.db') })
// admin root：环境变量显式指定哪个 rootDid 是 super-admin；未设则回退到"最早注册的 root"。
// （生产库若混入测试数据导致最早 root 非真实 owner，用此变量锁定。）
const ADMIN_ROOT_DID = process.env.ADMIN_ROOT_DID || ''
const FILES_ROOT = resolve(__dirname, 'files')
fs.mkdirSync(FILES_ROOT, { recursive: true })
await store.open()
// 2026-10-16 吊销即时生效：/root/device/revoke 验签后同步写吊销注册表
// （onDeviceRevoked → delegation.addRevocationInternal）。真机实证安全洞：
// 此前只标名册，注册表恒空，平台登录回调按注册表拦截 → 被吊销设备持旧委任状仍可登录。
const rootApi = createRootApi({ dbPath: DB_PATH, onDeviceRevoked: (accDid, pub) => addRevocationInternal(accDid, [pub]) })
const api = createIdentityApi({ store })
// ── 官方通知通道（2026-10-20「小灵」：平台服务端 → 用户 did:youling 的结构化通知）──
// 官方账号/私钥/token/通知表都在本目录（official.json / official-token.txt / official-notices.json）。
// 未配置 official.json → /official/notify 返回 503（安全默认：不静默发不出、不伪造账号）。
const officialApi = createOfficialApi({ dir: __dirname, deposit: depositInbox })
setPollHook((accountDid, msgs) => officialApi.onPolled(accountDid, msgs))

// ── admin 判定：哪个 rootDid 是 super-admin ──
// 优先用环境变量 ADMIN_ROOT_DID 显式指定；未设则取 root_account 里 createdAt 最早的（首个注册的有灵账号）。
// 用独立的只读 DatabaseSync 句柄查 root_account/root_device（与 root.mjs 同库同表，避免改 IdentityStore）。
let _firstRootDidCache = { did: null, ts: 0 }
const FIRST_ROOT_TTL = 5 * 60 * 1000
const _rootDb = new DatabaseSync(DB_PATH)
// admin_tokens 表：浏览器后台用 session 换来的长效凭证（7 天），可吊销、审计到 DID。
_rootDb.exec(`
  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  )
`)
const ADMIN_TOKEN_TTL = 7 * 24 * 60 * 60 * 1000 // admin token 有效期 7 天

function firstRootDid() {
  // 显式指定优先（不走缓存——环境变量不会变，直接返回）
  if (ADMIN_ROOT_DID) return ADMIN_ROOT_DID
  const now = Date.now()
  if (_firstRootDidCache.did && now - _firstRootDidCache.ts < FIRST_ROOT_TTL) return _firstRootDidCache.did
  const row = _rootDb.prepare('SELECT rootDid FROM root_account ORDER BY createdAt ASC LIMIT 1').get()
  _firstRootDidCache = { did: row?.rootDid ?? null, ts: now }
  return _firstRootDidCache.did
}

/** 用 PC 端的 identity session 换一个长效 admin token（浏览器后台登录用）。 */
async function exchangeAdminToken(sessionToken) {
  // 1. 校验 session 拿到 did
  const { status, body } = await api.handle({ method: 'POST', pathname: '/identity/verify', body: { token: sessionToken } })
  if (status !== 200 || !body.did) return null
  // 2. 必须是 admin
  if (!(await isAdminDid(body.did))) return null
  // 3. 铸造 7 天 admin token
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  _rootDb.prepare('INSERT INTO admin_tokens (token, did, createdAt, expiresAt) VALUES (?,?,?,?)')
    .run(token, body.did, now, now + ADMIN_TOKEN_TTL)
  return { token, did: body.did, expiresAt: now + ADMIN_TOKEN_TTL }
}

/** 校验长效 admin token（Authorization: Bearer <token>）。返回 did 或 null。 */
function verifyAdminToken(token) {
  if (!token) return null
  const row = _rootDb.prepare('SELECT did, expiresAt, revoked FROM admin_tokens WHERE token=?').get(token)
  if (!row || row.revoked || row.expiresAt < Date.now()) return null
  return row.did
}

function revokeAdminToken(token) {
  _rootDb.prepare('UPDATE admin_tokens SET revoked=1 WHERE token=?').run(token)
}

/** 判定一个设备 DID 是否属于 admin（= 首个 root 的设备之一）。
 *  链路：did → publicKeyB64 → root_device.rootDid → 比对 firstRootDid。
 *  不依赖 attestSig（首设备无 attestSig，findDeviceRoot 会漏），直接查 root_device。 */
async function isAdminDid(did) {
  if (!did || !isCryptoDid(did)) return false
  const adminRoot = firstRootDid()
  if (!adminRoot) return false
  const id = await store.getIdentity(did).catch(() => null)
  if (!id) return false
  // 设备公钥直接反查所属 root（不管 attestSig）
  const row = _rootDb.prepare('SELECT rootDid FROM root_device WHERE pubkeyB64=? AND revoked=0 ORDER BY addedAt DESC LIMIT 1').get(id.publicKeyB64)
  if (row && row.rootDid === adminRoot) return true
  // 兜底：该 did 本身就是 root 的设备 DID（root 自己注册的 identity，公钥可能直接等于 rootPubkey）
  const acc = _rootDb.prepare('SELECT rootDid FROM root_account WHERE rootPubkeyB64=?').get(id.publicKeyB64)
  return !!acc && acc.rootDid === adminRoot
}

// ── 通信簿 presence ──
const presence = new Map() // did -> { nodeId, name, lastSeen }
const PRESENCE_TTL = 90_000
const SIG_WINDOW_MS = 60_000 // 签名时间戳重放窗口
const PRESENCE_ROUTES = new Set(['/presence/register', '/presence/heartbeat', '/presence/list', '/presence/by-root'])
const SIGNAL_POST_ROUTES = new Set(['/signal/offer', '/signal/answer', '/signal/ice', '/signal/deny', '/signal/pair'])

// ── DID 互换授权：无配对码。新设备出示 DID，主设备签 attestation 经 /root/device/add 上云；
//    新设备轮询 GET /device/<公钥> 反查发现自己被收编（见 root.mjs findDeviceRoot）。──

// 签名验证（sign-every-request，无 token/session）：
// 客户端发头 X-Myco-Auth: <did>.<ts>.<sigB64>，sig = ed25519.sign(`${did}\n${ts}\n${rawBody}`, seed)
// 服务器按 did 查公钥，验签 + 查 ts 在窗口内。验过返回 did，否则 null。
async function authedDid(rawBody, authHeader) {
  const parts = (authHeader || '').split('.')
  if (parts.length !== 3) return null
  const [did, tsStr, sigB64] = parts
  if (!isCryptoDid(did)) return null
  const ts = Number(tsStr)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_WINDOW_MS) return null
  const id = await store.getIdentity(did).catch(() => null)
  // did 未注册 → 客户端先 /identity/register（从公钥派生 canonical did 落库）。
  // 2026-10-08 设备面单形态后：legacy did（未升级老客户端）在单形态查找下恒 miss
  // → 这里返回 null（上层 403）——老客户端由此不可用、被迫升级；新客户端恒 canonical。
  if (!id) return null
  try {
    const pub = await importPublicKey(new Uint8Array(Buffer.from(id.publicKeyB64, 'base64')))
    // 签名材料用客户端原样 did 串（它签的就是自己持有的形态）；验签通过后返回
    // canonical 归一串——presence/信箱/msg/friends 等内存键统一到同一桶（spec v0.3 §3.3）。
    const data = new TextEncoder().encode(`${did}\n${ts}\n${rawBody}`)
    const ok = await verify(pub, data, new Uint8Array(Buffer.from(sigB64, 'base64')))
    return ok ? normalizeDid(did) : null
  } catch { return null }
}

async function handlePresence(pathname, rawBody, authHeader, body, send) {
  const did = await authedDid(rawBody, authHeader)
  if (!did) return send(403, { error: '签名无效或未注册' })
  if (pathname === '/presence/register') {
    if (!body.nodeId) return send(400, { error: '缺 nodeId' })
    const prev = presence.get(did)
    presence.set(did, {
      nodeId: body.nodeId,
      name: String(body.name || ''),
      // WebRTC DTLS 证书指纹（PC 发布，phone 连上后核对防中间人）；可选，兼容老客户端。
      certFp: body.certFp || prev?.certFp || null,
      addrs: body.addrs || prev?.addrs || null,
      // 归属有灵账号 + 角色 + 种类（自报，best-effort；非密码学证明。供按账号聚合在线视图）。
      rootDid: body.rootDid || prev?.rootDid || null,
      role: body.role || prev?.role || null, // 'embodiment' | 'appendage'
      kind: body.kind || prev?.kind || null, // 'pc' | 'phone' | ...
      // WebRTC 打洞能力（answerer 常驻）：phone 据此优先 WebRTC 直连，老 PC 无此字段则跳过空等。
      webrtc: body.webrtc ?? prev?.webrtc ?? null,
      // 第84轮：设备状态（active|typing|idle|locked——聊天灯的三态数据源）。
      // 2026-09-29 修：无 state 的重登记【保留】旧值（原 ?? undefined 直接擦除）——
      // 同设备 did 的老客户端/env 应用（presence.rs 不带 state）每次重登记都把
      // 灯状态抹掉（typing 4s TTL 几乎必被抹、locked/idle 周期性消失），UI 上看不到灯。
      state: body.state ?? prev?.state ?? null,
      lastSeen: Date.now(),
    })
    return send(200, { ok: true })
  }
  if (pathname === '/presence/heartbeat') {
    const p = presence.get(did)
    if (p) p.lastSeen = Date.now()
    return send(200, { ok: true })
  }
  if (pathname === '/presence/list') {
    const now = Date.now()
    const online = [...presence.entries()]
      .filter(([, p]) => now - p.lastSeen < PRESENCE_TTL)
      .map(([d, p]) => ({ did: d, nodeId: p.nodeId, name: p.name, certFp: p.certFp || null, addrs: p.addrs || null, rootDid: p.rootDid || null, role: p.role || null, kind: p.kind || null, webrtc: p.webrtc ?? null, state: p.state ?? null, lastSeen: p.lastSeen, self: d === did }))
    return send(200, { data: online })
  }
  // 按账号聚合：列该有灵账号名下全部设备（含吊销）+ 在线状态 + 具身标记。管理页用。
  //   POST /presence/by-root {rootDid} → {rootDid, name, devices:[{did,name,pubkeyB64,revoked,isEmbodiment,online,lastSeen,addrs}]}
  if (pathname === '/presence/by-root') {
    const rootDid = body.rootDid
    if (!rootDid) return send(400, { error: '缺 rootDid' })
    const acc = rootApi.getRoot(rootDid)
    if (!acc) return send(200, { data: { rootDid, name: '', devices: [] } })
    const now = Date.now()
    const devices = []
    for (const dv of acc.devices) {
      let did
      try { did = didFromPublicKey(new Uint8Array(Buffer.from(dv.pubkeyB64, 'base64'))) } catch { continue }
      const p = presence.get(did)
      devices.push({
        did, name: dv.name, pubkeyB64: dv.pubkeyB64,
        revoked: !!dv.revoked, isEmbodiment: !!dv.isEmbodiment,
        online: !!(p && now - p.lastSeen < PRESENCE_TTL),
        lastSeen: p?.lastSeen ?? null, addrs: p?.addrs ?? null,
        kind: p?.kind ?? null, role: p?.role ?? null,
      })
    }
    return send(200, { data: { rootDid, name: acc.name, backedUp: !!acc.backedUp, devices } })
  }
  return send(404, { error: 'not found' })
}

// ── WebRTC 信令（只转 SDP/ICE 元数据，按目标 did 路由到对方的 SSE 轮询）──
// POST 投递：{to: <目标did>, sdp?, candidate?}；GET /signal/poll 拉自己的信箱（SSE 长连）。
async function handleSignalPost(pathname, rawBody, authHeader, body, send) {
  const from = await authedDid(rawBody, authHeader)
  if (!from) return send(403, { error: '签名无效或未注册' })
  if (!body.to) return send(400, { error: '缺 to(目标 did)' })
  // 2026-10-10 canonical-only 收敛：legacy 裸 base58 的 to 一律拒（此前混在
  // 「缺 to」里误导）；统一文案「不支持的 did 格式」，与 msg/delegation/三端同口径。
  if (!isCryptoDid(body.to)) return send(400, { error: '不支持的 did 格式（to 须为 canonical：did:<method>:z…；legacy 裸 base58 已废止）' })
  const type = pathname === '/signal/offer' ? 'offer'
    : pathname === '/signal/answer' ? 'answer'
    : pathname === '/signal/deny' ? 'denied'
    : pathname === '/signal/pair' ? 'pair'
    : 'ice'
  const msg = { from, type }
  if (type === 'ice') msg.candidate = body.candidate
  else if (type === 'pair') { msg.name = String(body.name || '').slice(0, 64); msg.nonce = String(body.nonce || '').slice(0, 64); if (body.dev) msg.dev = String(body.dev).slice(0, 96) }
  else if (type !== 'denied') msg.sdp = body.sdp
  console.log("[signal] deposit type="+type+" from="+from+" to="+body.to); deposit(body.to, msg)
  return send(200, { ok: true })
}

// ── 静态托管（支持 gzip：大文件 wasm/js/css 客户端接受时压缩传输，wasm 19MB→~4MB）──
const gzipCache = new Map() // filePath -> Buffer（gzip 后）
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.map'])

function serveStatic(req, res, pathname) {
  // HEAD 与 GET 同头不同体(下载工具/链接检查器先 HEAD 探测;不支持会 404 假报)
  const isHead = req.method === 'HEAD'
  let p = pathname === '/' ? '/index.html' : pathname
  // 目录路径(尾 /)自动补 index.html(曾直接读目录失败→SPA 兜底盖住 /releases/ 等)
  if (p.endsWith('/')) p += 'index.html'
  let filePath
  try { filePath = resolve(WEB_ROOT, '.' + decodeURIComponent(p)) } catch { res.writeHead(400); return res.end('bad path') }
  if (!filePath.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end('forbidden') }
  const acceptGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // /releases/ 下载包缺文件必须真 404——SPA 兜底会 200 回 HTML,下载器把 HTML 存成 .zip(踩过)
      if (p.startsWith('/releases/')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
      fs.readFile(resolve(WEB_ROOT, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(isHead ? undefined : html)
      })
      return
    }
    const ext = extname(filePath).toLowerCase()
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' }
    if (p.startsWith('/assets/')) {
      // 哈希文件名（不可变）→ 强缓存一年
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    } else if (ext === '.html') {
      // index.html 每次都校验（部署新版后无需 ?v=2 强刷，浏览器自动拉新）
      headers['cache-control'] = 'no-cache, no-store, must-revalidate'
    }
    if (acceptGzip && COMPRESSIBLE.has(ext) && data.length > 1024) {
      // gzipCache 只缓存 /assets/ 下哈希不可变的资源；index.html 等随部署变化的文件必须每次新 gz，
      // 否则旧 index.html 卡在 gzipCache（引用被清掉的旧 JS）→ 模块加载失败、页面渲染失败。
      const cacheable = p.startsWith('/assets/')
      let gz = cacheable ? gzipCache.get(filePath) : null
      if (!gz) { gz = zlib.gzipSync(data, { level: 6 }); if (cacheable) gzipCache.set(filePath, gz) }
      headers['content-encoding'] = 'gzip'
      headers['content-length'] = gz.length
      headers['vary'] = 'Accept-Encoding'
      res.writeHead(200, headers)
      return res.end(isHead ? undefined : gz)
    }
    // 非压缩路径也带 Content-Length——39MB 的 zip 走 chunked 浏览器无进度条
    headers['content-length'] = data.length
    res.writeHead(200, headers)
    res.end(isHead ? undefined : data)
  })
}

// 2026-10-20：中继指标面用（relay 在下方 if/else 块内创建，故用模块级引用）
let relayRef = null

const server = http.createServer(async (req, res) => {
  // CORS（2026-10-10）：手机 WebView 从 file:// 发 fetch 到本服务被同源策略拦——
  // 放开全部 origin（身份面已有设备签名鉴权，CORS 只是允许浏览器到达这里）。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Myco-Auth, X-Myco-Attest, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://${req.headers.host}`)
  const _auth=req.headers["x-myco-auth"]||""; console.log("[req]",req.method,url.pathname,_auth?(_auth.split(".")[0]):"(noauth)")
  // 访问日志落库（跳过噪音：健康检查/图标/静态资源，避免刷屏；失败不影响请求）
  try {
    const _p = url.pathname
    const _ext = _p.slice(_p.lastIndexOf('.'))
    const _noisy = _p === '/health' || _p === '/favicon.ico' || _p === '/tlog'
      || _p.startsWith('/assets/') || _p.startsWith('/pc-direct/')
      || (_ext && /\.(js|mjs|css|png|jpg|jpeg|gif|ico|svg|woff2?|map|webmanifest|wasm)/.test(_ext))
    if (!_noisy) {
      accessStore.add({ ip: req.socket.remoteAddress, method: req.method, path: _p, ua: req.headers['user-agent'], authedDid: _auth ? _auth.split('.')[0] : null })
    }
  } catch { /* 访问日志失败不能影响请求处理 */ }
  const send = (status, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type, x-myco-auth',
    })
    res.end(body)
  }

  if (req.method === 'OPTIONS') return send(204, {})
  // /pc-direct/* → frp 隧道代理（手机 → identity-svc:8321 → localhost:9101 → frp → PC）
  // 同源（手机页面也在 :8321），无 CORS。透明转发 body + headers + SSE 流。
  if (url.pathname.startsWith('/pc-direct/')) {
    const targetPath = url.pathname.replace('/pc-direct', '') + url.search
    const proxyReq = http.request({
      hostname: '127.0.0.1', port: 9101, path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:9101' },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => send(502, { error: 'PC tunnel unreachable' }))
    req.pipe(proxyReq)
    return
  }


  // GET /identity/:did -> {publicKeyB64} (PC direct auth pubkey lookup)
  if (req.method === 'GET' && url.pathname.startsWith('/identity/')) {
    const did = decodeURIComponent(url.pathname.slice('/identity/'.length))
    if (!isCryptoDid(did)) return send(400, { error: 'bad did' })
    const id = await store.getIdentity(did)
    if (!id) return send(404, { error: 'not registered' })
    return send(200, { data: { did: id.did, publicKeyB64: id.publicKeyB64 } })
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(200, { ok: true, service: 'myco-identity', routes: [...IDENTITY_ROUTES, ...PRESENCE_ROUTES, ...SIGNAL_POST_ROUTES, ...MSG_ROUTES, ...OFFICIAL_GET_ROUTES, ...OFFICIAL_POST_ROUTES, '/signal/poll', '/device/:pubkeyB64'] })
  }

  // 官方通道（2026-10-20）：/official/info 公开；/official/status 需 X-Official-Token
  // 中继指标面（2026-10-20，给跨会话 relay 诊断用）：需 X-Official-Token（与官方通道同一份 600 文件）
if (req.method === 'GET' && url.pathname === '/relay/stats') {
  // 2026-11-07 修（生产 13 天监控盲区的根因）：token 文件自 2026-10-24 起是「每行一个 token」多 token
  // 契约（official.mjs readTokens：忽略空行 / # 注释）。本路由原先按整文件 trim() 当单 token 比，
  // 10-25 06:49 文件追加第二枚 token 后 got/want 长度永远不等（HTTP 头不可能带换行）⇒ 恒 403，
  // 中转会话/带宽指标自 10-25 06:49 起恒 no_data。改用官方通道同一份 tokenOk（任一 token 命中即过）。
  if (!officialApi.tokenOk(req.headers['x-official-token'])) return send(403, { error: 'forbidden' })
  try {
    return send(200, { ok: true, data: relayRef?.relayStats ? relayRef.relayStats() : null })
  } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
}

if (req.method === 'GET' && OFFICIAL_GET_ROUTES.has(url.pathname)) {
    try {
      return officialApi.handleGet(url.pathname, url.searchParams, req.headers, send)
    } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
  }

  // ── myco 账号模型:吊销注册表/续签收件箱(GET 面)──
  if (req.method === 'GET' && (url.pathname.startsWith('/revocation/') || url.pathname.startsWith('/delegation/'))) {
    return await handleDelegationGet(url.pathname, url, send)
  }

  // GET /signal/poll：SSE 长连拉自己信箱（fetch-based，带 X-Myco-Auth 头签空 body）
  if (req.method === 'GET' && url.pathname === '/signal/poll') {
    const did = await authedDid('', req.headers['x-myco-auth'])
    if (!did) return send(403, { error: '签名无效或未注册' })
    console.log("[signal] poll start did="+did)
    // SSE 活性=在线(2026-09-03 事件化):信令长连建立+每跳 keepalive 刷新 presence——
    // 挂长连的设备(PC/APK)零独立心跳;没挂长连的(手机 PWA 前台)仍走 register 自身。
    const touch = (d) => { const p = presence.get(d); if (p) p.lastSeen = Date.now() }
    return startPoll(did, res, touch)
  }

  // GET /signal/drain：一次性取走自己信箱全部积压（手机作主设备收 pair 申请——不挂长连的场景）
  if (req.method === 'GET' && url.pathname === '/signal/drain') {
    const did = await authedDid('', req.headers['x-myco-auth'])
    if (!did) return send(403, { error: '签名无效或未注册' })
    return send(200, { data: drain(did) })
  }

  // /root/* — 根账号（一身份多设备钥，个人 CA）。GET 读公开信息，POST 需根签。
  // /device/* — 设备公钥反查所属有灵账号（GET，公开读；DID 互换授权后新设备轮询发现自己）。
  if (url.pathname.startsWith('/root/') || url.pathname.startsWith('/device/')) {
    if (req.method === 'GET') {
      try {
        const { status, body: out } = await rootApi.handle('GET', url.pathname, {})
        return send(status, out)
      } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
    }
    let rawRoot = ''
    req.on('data', (c) => (rawRoot += c))
    req.on('end', async () => {
      let body = {}
      try { body = rawRoot ? JSON.parse(rawRoot) : {} } catch { return send(400, { error: 'body 必须是 JSON' }) }
      try {
        const { status, body: out } = await rootApi.handle(req.method, url.pathname, body)
        send(status, out)
      } catch (err) { send(500, { error: String(err?.message ?? err) }) }
    })
    return
  }

  // 测试日志回传（phone-sim E2E：浏览器把 window.LOG POST 到 /tlog → journalctl 可见；无状态免签名）
  // GET /tlog?line= 也收（图片像素式——受限 webview 里 fetch POST 可能被代理吞，<img> 总能发）
  if (url.pathname === '/tlog' && req.method === 'GET') {
    console.log('[tlog]', String(url.searchParams.get('line') || '').slice(0, 300))
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    return
  }
  if (url.pathname === '/tlog' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try { const b = JSON.parse(raw || '{}'); console.log('[tlog]', String(b.line || '').slice(0, 300)) } catch { /* 忽略 */ }
      send(200, { ok: true })
    })
    return
  }

  // DID API / presence / signal / msg / official POST（读 JSON body）
  if (IDENTITY_ROUTES.has(url.pathname) || PRESENCE_ROUTES.has(url.pathname) || SIGNAL_POST_ROUTES.has(url.pathname) || DELEGATION_ROUTES.has(url.pathname) || MSG_ROUTES.has(url.pathname) || OFFICIAL_POST_ROUTES.has(url.pathname)) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { return send(400, { error: 'body 必须是 JSON' }) }
      try {
        if (OFFICIAL_POST_ROUTES.has(url.pathname)) {
          // notify 走 X-Official-Token（服务端到服务端）；read 走设备签名（X-Myco-Auth）
          return await officialApi.handlePost(url.pathname, raw || '', req.headers['x-myco-auth'], body, send, { authedDid, rootApi, headers: req.headers })
        }
        if (PRESENCE_ROUTES.has(url.pathname)) {
          return await handlePresence(url.pathname, raw || '', req.headers['x-myco-auth'], body, send)
        }
        if (MSG_ROUTES.has(url.pathname)) {
          // 好友聊天信箱（第81轮）：注入 presence 同款验签（X-Myco-Auth 设备钥）
          // 第85轮：+rootApi（群管理 kind 的设备归属校验——防伪造 fromAccountDid 绕过群主闸）
          return await handleMsgPost(url.pathname, raw || '', req.headers['x-myco-auth'], body, send, { authedDid, rootApi })
        }
        if (SIGNAL_POST_ROUTES.has(url.pathname)) {
          return await handleSignalPost(url.pathname, raw || '', req.headers['x-myco-auth'], body, send)
        }
        if (DELEGATION_ROUTES.has(url.pathname)) {
          // 委任闭环上下文(2026-09-03):renew 入箱后通知本体处理——名册查该账号的
          // embodiment(主设备)→ 投其信令信箱 renew-notify(在线即推,离线暂存 5min)。
          const delegationCtx = {
            notifyAccount(accountDid) {
              try {
                const acc = rootApi.getRoot(accountDid)
                const emb = (acc?.devices ?? []).find((d) => d.isEmbodiment && !d.revoked)
                if (!emb) return
                const did = didFromPublicKey(Buffer.from(emb.pubkeyB64, 'base64'))
                deposit(did, { from: accountDid, type: 'renew-notify' })
              } catch { /* 名册缺/转换失败:分身 6h 重投兜底 */ }
            },
          }
          return await handleDelegationPost(url.pathname, body, send, delegationCtx)
        }
        const { status, body: out } = await api.handle({ method: req.method, pathname: url.pathname, body })
        send(status, out)
      } catch (err) {
        send(500, { error: String(err?.message ?? err) })
      }
    })
    return
  }

  // ── 文件托管（更新包/下载包，大文件 streaming）──
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const fileName = url.pathname.slice('/files/'.length)
    const filePath = resolve(FILES_ROOT, fileName)
    if (!filePath.startsWith(FILES_ROOT)) { res.writeHead(403); return res.end('forbidden') }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); return res.end('not found') }
      const ext = extname(filePath).toLowerCase()
      const stream = fs.createReadStream(filePath)
      stream.on('error', () => { res.writeHead(500); res.end('read error') })
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      })
      stream.pipe(res)
    })
    return
  }

  // ── 版本清单（canvas 自动更新检查）──
  if (req.method === 'GET' && url.pathname === '/api/update') {
    const manifestPath = resolve(FILES_ROOT, 'update-manifest.json')
    fs.readFile(manifestPath, 'utf8', (err, data) => {
      if (err) return send(200, { version: '0.0.0', url: '', releaseNotes: '' })
      try { return send(200, JSON.parse(data)) } catch { return send(200, { version: '0.0.0' }) }
    })
    return
  }

  // ── 用户反馈收集 ──
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}')
        feedbackStore.add({
          accountDid: body.accountDid, deviceDid: body.deviceDid, accountName: body.accountName,
          type: body.type, text: body.text, mycoVersion: body.mycoVersion,
          ipv6: body.ipv6, userAgent: req.headers['user-agent'], logs: body.logs,
        })
        return send(200, { ok: true })
      } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
    })
    return
  }

  // ── Admin 登录：用 PC 端 identity session 换长效 admin token（浏览器后台用，无需私钥进浏览器）──
  //   POST /api/admin/exchange { sessionToken } → { token, did, expiresAt }（sessionToken 来自 PC 端
  //   %APPDATA%/myco/myco-identity-session.json，由桌面端用有灵账号私钥走 challenge-login 换得）
  if (req.method === 'POST' && url.pathname === '/api/admin/exchange') {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}')
        const r = await exchangeAdminToken(body.sessionToken)
        if (!r) return send(403, { error: 'session 无效或非管理员' })
        return send(200, { data: r })
      } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
    })
    return
  }

  // ── Admin API ──（以下端点都需鉴权）
  // 鉴权（三选一，满足其一即放行）：
  //   1) 长效 admin token：Authorization: Bearer <token>（浏览器后台用，7 天有效，存 admin_tokens 表）。
  //   2) DID 签名：X-Myco-Auth 头，签名设备 DID 属于首个 root（super-admin）。无状态，适合程序化调用。
  //   3) 兼容老方式：环境变量 ADMIN_TOKEN + 仅 localhost（仅当 ADMIN_TOKEN 已设）。
  if (url.pathname.startsWith('/api/admin/')) {
    let adminOk = false
    let adminDid = null
    // 方式 1：长效 admin token
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    const tkDid = verifyAdminToken(bearer)
    if (tkDid) { adminOk = true; adminDid = tkDid }
    // 方式 2：DID 签名
    if (!adminOk) {
      const did = await authedDid('', req.headers['x-myco-auth']).catch(() => null)
      if (did && await isAdminDid(did)) { adminOk = true; adminDid = did }
    }
    // 方式 3：静态 token —— 2026-10-03 审计收口撤除（未激活死臂：生产 env 未设置
    // 恒关闭；静态对称密钥与"内容签名自证"原则相悖，did 签名/长效 token 两通道已够）。
    if (!adminOk) return send(403, { error: 'unauthorized' })
    const subPath = url.pathname.slice('/api/admin/'.length)

    // 注销当前 admin token（把 token 标 revoked）
    if (subPath === 'logout' && req.method === 'POST') {
      revokeAdminToken(bearer)
      return send(200, { ok: true })
    }

    if (subPath === 'feedback' && req.method === 'GET') {
      const status = url.searchParams.get('status') || undefined
      const limit = Number(url.searchParams.get('limit') || 50)
      const offset = Number(url.searchParams.get('offset') || 0)
      return send(200, { data: feedbackStore.list({ status, limit, offset }), total: feedbackStore.count({ status }) })
    }
    if (subPath.startsWith('feedback/') && req.method === 'PATCH') {
      let raw = ''
      req.on('data', c => raw += c)
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}')
          const id = Number(subPath.split('/')[1])
          feedbackStore.updateStatus(id, body.status)
          return send(200, { ok: true })
        } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
      })
      return
    }
    if (subPath === 'users' && req.method === 'GET') {
      // 从 root_account 表读用户列表（用 _rootDb 只读句柄，不依赖 IdentityStore.db）
      try {
        const users = _rootDb.prepare('SELECT rootDid, name, phone, email, createdAt FROM root_account ORDER BY createdAt DESC').all()
        return send(200, { data: users })
      } catch (err) { return send(500, { error: String(err?.message ?? err) }) }
    }
    if (subPath === 'stats' && req.method === 'GET') {
      const totalUsers = _rootDb.prepare('SELECT COUNT(*) as n FROM root_account').get().n
      const feedbackOpen = feedbackStore.count({ status: 'open' })
      const now = Date.now()
      const onlineDevices = [...presence.values()].filter(p => now - p.lastSeen < 90000).length
      return send(200, { data: { totalUsers, onlineDevices, feedbackOpen, totalFeedback: feedbackStore.count() } })
    }
    // 访问监控聚合：GET /api/admin/access?days=1（默认今日）
    if (subPath === 'access' && req.method === 'GET') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days') || 1), 1), 30)
      const since = Date.now() - days * 86400000
      return send(200, { data: { ...accessStore.stats({ since }), days, since } })
    }
    // ── 中继限流（QoS）：查 / 热改（2026-10-23，eval/relay/task.md M4）──
    // 鉴权与其它 /api/admin/* 一致（admin token 或 root DID 签名）；中继未就绪时 503。
    // 热改**不重启进程、不断现有会话**：只改令牌桶速率（relay.mjs applyQos）。
    if (subPath === 'relay/qos' && req.method === 'GET') {
      const st = relayRef?.relayStats ? relayRef.relayStats() : null
      return send(200, {
        ok: true,
        data: relayRef?.relayQos ? relayRef.relayQos() : null,
        stats: st ? { providers: st.providers, sessions: st.sessions, pairLatency: st.pairLatency, qos: st.qos } : null,
      })
    }
    if (subPath === 'relay/qos' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body
        try { body = JSON.parse(raw || '{}') } catch { return send(400, { error: 'bad-json' }) }
        if (!relayRef?.setRelayQos) return send(503, { error: 'relay-not-ready' })
        const cur = relayRef.relayQos ? relayRef.relayQos() : { globalMbps: 0, perSessionMbps: 0, burstMs: 100 }
        const next = {
          globalMbps: body.globalMbps !== undefined ? body.globalMbps : cur.globalMbps,
          perSessionMbps: body.perSessionMbps !== undefined ? body.perSessionMbps : cur.perSessionMbps,
          burstMs: body.burstMs !== undefined ? body.burstMs : cur.burstMs,
        }
        const applied = relayRef.setRelayQos(next)
        console.log(`[identity] admin 热改中继限流 by=${adminDid || 'admin-token'} →`, JSON.stringify(applied))
        return send(200, { ok: true, data: applied })
      })
      return
    }
    return send(404, { error: 'unknown admin endpoint' })
  }

  // ── /app 下载页（仅本地访问——公网不暴露，避免被外部爬到产品页/下载链）──
  if (req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
    const clientIp = req.socket.remoteAddress || ''
    if (!clientIp.includes('127.0.0.1') && !clientIp.includes('::1')) { res.writeHead(403); return res.end('forbidden') }
    const appDir = resolve(__dirname, 'web-app')
    let p = url.pathname === '/app' ? '/index.html' : url.pathname.slice('/app'.length)
    if (p === '/') p = '/index.html'
    const filePath = resolve(appDir, '.' + p)
    if (!filePath.startsWith(appDir)) { res.writeHead(403); return res.end('forbidden') }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found') }
      const ext = extname(filePath).toLowerCase()
      res.writeHead(200, { 'content-type': MIME[ext] || 'text/html; charset=utf-8' })
      res.end(data)
    })
    return
  }

  // ── /admin 管理后台页（页面壳本身公开可访问；数据靠 /api/admin/* 的 DID 鉴权保护）──
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) {
    const adminDir = resolve(__dirname, 'web-admin')
    let p = url.pathname === '/admin' ? '/index.html' : url.pathname.slice('/admin'.length)
    if (p === '/') p = '/index.html'
    const filePath = resolve(adminDir, '.' + p)
    if (!filePath.startsWith(adminDir)) { res.writeHead(403); return res.end('forbidden') }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found') }
      const ext = extname(filePath).toLowerCase()
      res.writeHead(200, { 'content-type': MIME[ext] || 'text/html; charset=utf-8' })
      res.end(data)
    })
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname)
  send(404, { error: 'not found' })
})

// 2026-10-07 测试挂起防线：Node ≥23 对 `node --test <目录>` 不再按文件名过滤——
// 本文件（含顶层 listen）会被当测试入口直接执行，服务器永不退出 → 整个
// 测试运行挂死（还占默认口 8321/写默认 identity.db）。测试 runner 执行测试文件时
// 会注入 NODE_TEST_CONTEXT；presence.test 起本服务总是显式带 PORT——据此区分：
// 被 runner 直接执行（无显式 PORT）则不监听、干净退出。
if (process.env.NODE_TEST_CONTEXT && !process.env.PORT) {
  console.log('[identity] 检测到测试 runner 直接执行（NODE_TEST_CONTEXT 且无 PORT）——跳过 listen')
} else {
  // 2026-10-11 云端中转兜底（④）：TCP relay 与 HTTP **同口复用**（首行嗅探分流，
  // 见 relay.mjs createPortMux）。为什么不另开 8322：阿里云安全组白名单未放行
  // 8322，而 8321 是 identity 正式端口——presence 能到的网络中继就能到。
  // relay 本体逻辑同一份（relay.mjs）；HTTP 走 server.emit('connection') 注入，
  // 行为零改动。8322 的独立监听仍可用 relay-standalone.mjs 单独起（安全组
  // 放行后即用，客户端 MYCO_RELAY_ADDR 指过去）。
  const { createRelay, createPortMux } = await import('./relay.mjs')
  // 2026-11-04 P0：传入签名验证能力——REGISTER <did> <ts> <sigB64> 的 Ed25519 验签
  // （防任意 REGISTER 劫持 provider；grace 期 RELAY_SIG_GRACE≠0 时无签名 WARN 放行）
  const relay = createRelay({
    port: 0, // 不自 listen——只作为 mux 的分流目标
    auth: {
      getIdentity: (did) => store.getIdentity(did),
      importPublicKey,
      verify,
    },
  })
  const mux = createPortMux({ httpServer: server, relay })
relayRef = relay
  mux.listen(PORT, HOST, () => {
    console.log(`[identity] listening on http://${HOST}:${PORT}, db=${DB_PATH}, web=${WEB_ROOT}, presence=on, signal=on, relay=mux(同口中继)`)
  })
}
