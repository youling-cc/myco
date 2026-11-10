// root.mjs — 根账号（一身份多设备钥，个人 CA 的数据层）。
//
// 模型(ADR-005 封版,2026-09-07)：人=灵(youling),机=体(myco 菌丝体),双 method 单规则。
//   新账号 rootDid = did:youling:<base58(rootPubkey)>(裸公钥——解码即公钥,乐观验证);
//   旧格式 did:soul:<base58(sha256(pub))> 与 did:myco:<base58(pub)> 兼容识别(不再新生成)。
//   /root/create 三重防冲突:①服务器重算派生(防篡改冒用) ②did 唯一 ③公钥复用检测
//   (did 不冲突但钥匙撞他人出生/控制/设备钥→409 pubkey_conflict)。
//   409 语义(裸公钥终形):did 被占 ⟺ 同一把钥注册过(rootSig 已自证持钥,他人抢注不可能)——
//   是"同一身份重复注册"而非碰撞,客户端幂等/引导恢复即可,不要静默重新随机(换人格丢画像)。
//   root_device 表存授权设备公钥（每台设备一把；可吊销）。
//   设备日常用自己的私钥签名；加/删设备钥才需要根私钥签（master，少动）。
//
// 端点（挂在 identity-server /root/*）：
//   POST /root/create        {rootPubkeyB64, devicePubkeyB64, name, rootSig}
//   POST /root/device/add    {rootDid, pubkeyB64, name, rootSig}
//   POST /root/device/revoke {rootDid, pubkeyB64, rootSig}
//   GET  /root/:did          → {rootDid, rootPubkeyB64, devices:[...]}（公开读，供验签方查钥）
//   GET  /device/:pubkeyB64  → {rootDid, accountName, addedAt, attestSigB64}（反查：新设备发现自己被谁收编）
//
// rootSig = ed25519.sign( `${action}\n${rootDid}\n${pubkeyB64}`, rootPrivKey )（base64）。
// create 时 action="create"、pubkeyB64=rootPubkeyB64（自证持根私钥）。
import { DatabaseSync } from 'node:sqlite'
import { importPublicKey, verify } from './index.mjs'

// base58(Bitcoin 字母表)——服务器端重算 did 派生关系用(ADR-003 派生校验)
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) { out = B58A[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }  // 前导零
  return out || '1'
}
/** 有灵账号 did(ADR-005 终形)。2026-10-07 清档定稿：**仅 canonical**——
 *  'did:youling:z'+b58(0xed 0x01+pub)(与 did:key 同构)。三种旧格式派生函数已随
 *  格式闸门删除（create 只收 canonical，异形态一律 400 unsupported_did_format）。 */
const didYouling = (pubB64) => 'did:youling:z' + b58PrefixedEd25519(Buffer.from(pubB64, 'base64'))

/** b58(0xed 0x01 + 32B 公钥)——multibase 载荷（spec v0.3 §3.1 精确字节序）。 */
function b58PrefixedEd25519(pub) {
  const payload = Buffer.concat([Buffer.from([0xed, 0x01]), pub])
  return b58(payload)
}

/** did 查找键（2026-10-06 删号窗口清理：三形态归一查找已删，直连单形态精确查询）。
 *  旧的三形态兜底（canonical/legacy/did:myco: 逐个试）服务于"存量名册行不迁移、
 *  查询侧归一"的过渡期——删号窗口定稿后删号=清库+客户端重新注册，名册行与
 *  客户端出示同为注册时的单一形态，精确匹配即可。did:soul: 同样原样精确匹配。 */

let _db = null
function db(path) {
  if (!_db) {
    _db = new DatabaseSync(path)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS root_account (
        rootDid TEXT PRIMARY KEY,
        rootPubkeyB64 TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS root_device (
        rootDid TEXT NOT NULL,
        pubkeyB64 TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        addedAt INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (rootDid, pubkeyB64)
      );
    `)
    // attestSigB64 列（归属凭证签名，设备随后拉取本地携带）。已有表补列，缺列才加。
    try { _db.exec(`ALTER TABLE root_device ADD COLUMN attestSigB64 TEXT NOT NULL DEFAULT ''`) } catch { /* 已有列 */ }
    // isEmbodiment 列（具身自报：该设备自报持有 账号钥；与 revoked 正交。best-effort，非密码学证明）。
    try { _db.exec(`ALTER TABLE root_device ADD COLUMN isEmbodiment INTEGER NOT NULL DEFAULT 0`) } catch { /* 已有列 */ }
    try { _db.exec(`ALTER TABLE root_device ADD COLUMN embodimentReportedAt INTEGER NOT NULL DEFAULT 0`) } catch { /* 已有列 */ }
    // backedUp 列（"已导出备份"云端标记，per-账号；非密，一处备份、处处不唠叨）。
    try { _db.exec(`ALTER TABLE root_account ADD COLUMN backedUp INTEGER NOT NULL DEFAULT 0`) } catch { /* 已有列 */ }
    // phone/email 列（用户联系方式，用于身份找回和未来通信）
    try { _db.exec(`ALTER TABLE root_account ADD COLUMN phone TEXT NOT NULL DEFAULT ''`) } catch { /* 已有列 */ }
    try { _db.exec(`ALTER TABLE root_account ADD COLUMN email TEXT NOT NULL DEFAULT ''`) } catch { /* 已有列 */ }
  }
  return _db
}

const now = () => Date.now()

async function verifyRootSig(rootPubkeyB64, action, rootDid, pubkeyB64, sigB64) {
  try {
    const pk = await importPublicKey(new Uint8Array(Buffer.from(rootPubkeyB64, 'base64')))
    const msg = new TextEncoder().encode(`${action}\n${rootDid}\n${pubkeyB64}`)
    const sig = new Uint8Array(Buffer.from(sigB64, 'base64'))
    return await verify(pk, msg, sig)
  } catch { return false }
}

/** 验 attestation 签名：`attest\nrootDid\npubkeyB64\nissuedAt`。 */
async function verifyAttestSig(rootPubkeyB64, rootDid, pubkeyB64, issuedAt, sigB64) {
  try {
    const pk = await importPublicKey(new Uint8Array(Buffer.from(rootPubkeyB64, 'base64')))
    const msg = new TextEncoder().encode(`attest\n${rootDid}\n${pubkeyB64}\n${issuedAt}`)
    const sig = new Uint8Array(Buffer.from(sigB64, 'base64'))
    return await verify(pk, msg, sig)
  } catch { return false }
}

/** 验具身自报签名：`embodiment\nrootDid\npubkeyB64\nissuedAt`（rootPriv 签）。
 *  比 attest 更强：attest 只证明"被有灵账号收编"，embodiment 证明"该设备持有 账号钥"。
 *  仅持 账号钥的设备（具身）能产出此签名 → 用于 best-effort 的具身标记。 */
async function verifyEmbodimentSig(rootPubkeyB64, rootDid, pubkeyB64, issuedAt, sigB64) {
  try {
    const pk = await importPublicKey(new Uint8Array(Buffer.from(rootPubkeyB64, 'base64')))
    const msg = new TextEncoder().encode(`embodiment\n${rootDid}\n${pubkeyB64}\n${issuedAt}`)
    const sig = new Uint8Array(Buffer.from(sigB64, 'base64'))
    return await verify(pk, msg, sig)
  } catch { return false }
}

// 2026-10-16 吊销即时生效（真机实证安全洞修复）：opts.onDeviceRevoked(accountDid, pubkeyB64)
// —— /root/device/revoke 验根钥签名后，除标名册外同步写吊销注册表。此前只标名册 →
// 注册表恒空 → 平台登录回调查注册表放行（被吊销设备持旧委任状仍登录成功，钥匙代理
// 多设备真机测试实证）。identity-server 装配 delegation.addRevocationInternal 注入，
// 模块解耦；注册表写失败不挡名册吊销（名册仍是权威源）。
export function createRootApi({ dbPath, onDeviceRevoked }) {
  const get = () => db(dbPath)

  return {
    /** did → 根账号（含设备钥列表），供验签方/客户端读。
     *  2026-10-06 删号窗口清理：单形态精确查询（三形态归一查找已删——删号=清库+
     *  客户端重新注册，行键与出示形态天然一致）。 */
    getRoot(rootDid) {
      const acc = get().prepare('SELECT rootDid, rootPubkeyB64, name, createdAt, backedUp FROM root_account WHERE rootDid=?').get(rootDid)
      if (!acc) return null
      const devices = get().prepare('SELECT pubkeyB64, name, addedAt, revoked, attestSigB64, isEmbodiment, embodimentReportedAt FROM root_device WHERE rootDid=? ORDER BY addedAt').all(acc.rootDid)
      return { ...acc, devices }
    },

    /** 根账号下当前有效（未吊销）设备公钥列表——验签方据此验设备签名。 */
    activeDeviceKeys(rootDid) {
      const acc = this.getRoot(rootDid)
      if (!acc) return []
      return get().prepare('SELECT pubkeyB64 FROM root_device WHERE rootDid=? AND revoked=0').all(acc.rootDid).map(r => r.pubkeyB64)
    },

    /** 设备公钥 → 它最新加入的有灵账号（反查。新设备不知自己被谁收编，轮询这个发现）。
     *  只取未吊销的最近一次加入；附 账号名。都没有则 null。 */
    findDeviceRoot(pubkeyB64) {
      const d = get()
      const row = d.prepare('SELECT rootDid, name, addedAt, attestSigB64 FROM root_device WHERE pubkeyB64=? AND revoked=0 ORDER BY addedAt DESC LIMIT 1').get(pubkeyB64)
      if (!row || !row.attestSigB64) return null
      const acc = d.prepare('SELECT name FROM root_account WHERE rootDid=?').get(row.rootDid)
      return { rootDid: row.rootDid, accountName: acc?.name ?? '', deviceName: row.name ?? '', addedAt: row.addedAt, attestSigB64: row.attestSigB64 }
    },

    async handle(method, path, body) {
      // GET /root/:did
      if (method === 'GET' && path.startsWith('/root/')) {
        const rootDid = decodeURIComponent(path.slice('/root/'.length))
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        return { status: 200, body: { data: acc } }
      }
      // GET /device/:pubkeyB64 — 反查设备所属有灵账号（DID 互换授权后，新设备轮询发现自己被收编）
      if (method === 'GET' && path.startsWith('/device/')) {
        const pubkeyB64 = decodeURIComponent(path.slice('/device/'.length))
        const found = this.findDeviceRoot(pubkeyB64)
        if (!found) return { status: 404, body: { error: 'device not found' } }
        return { status: 200, body: { data: found } }
      }
      if (method !== 'POST') return null

      if (path === '/root/create') {
        const { rootPubkeyB64, devicePubkeyB64, name = '', deviceName, rootSig, phone = '', email = '' } = body ?? {}
        if (!rootPubkeyB64 || !devicePubkeyB64 || !rootSig) return { status: 400, body: { error: '缺字段 rootPubkeyB64/devicePubkeyB64/rootSig' } }
        const rootDid = body.rootDid
        if (!rootDid) return { status: 400, body: { error: '缺字段 rootDid' } }
        // ① 派生校验(ADR-005)+格式闸门(2026-10-07 清档定稿)，两步判断：
        //    a.形态闸：rootDid 非 canonical 构造（z+base58 multibase）→ 旧格式账号一律
        //      400 拒绝并引导解绑——清档后客户端自愈拿旧格式来 create 在此闸住不回填；
        //    b.派生闸：形态对但与 rootPubkeyB64 派生不符 → derivation_mismatch（冒用他人 did）。
        const expectCanonical = didYouling(rootPubkeyB64)
        if (rootDid !== expectCanonical) {
          const isCanonicalShape = /^did:youling:z[1-9A-HJ-NP-Za-km-z]+$/.test(rootDid)
          if (!isCanonicalShape) {
            return { status: 400, body: { error: 'unsupported_did_format: 服务端仅支持 canonical 账号（did:youling:z<base58(0xed01+pub)>）。检测到旧格式账号——请在 myco 中解绑该账号（或注销设备）后重新注册', code: 'unsupported_did_format' } }
          }
          return { status: 400, body: { error: 'derivation_mismatch: rootDid 与 rootPubkeyB64 派生关系不符(应为 did:youling:z<base58(0xed01+pub)>)' } }
        }
        const ok = await verifyRootSig(rootPubkeyB64, 'create', rootDid, rootPubkeyB64, rootSig)
        if (!ok) return { status: 403, body: { error: 'rootSig 验签失败' } }
        const d = get()
        // ② did 唯一(机制兜底)。裸公钥终形下 409=同一把钥重复注册(rootSig 已证持钥)——
        //    客户端幂等容忍/引导恢复,不是"名字被占要换随机"(那样换人格丢画像)。
        //    2026-10-07 清档定稿：格式闸门后 rootDid 必为 canonical，family 四形态查重
        //    缩为精确查重（库里只有 canonical 行，异形态项永远空转）。
        if (d.prepare('SELECT rootDid FROM root_account WHERE rootDid=?').get(rootDid)) return { status: 409, body: { error: 'did_conflict: 此 did 已存在(裸公钥下=同一身份重复注册,应幂等容忍或走恢复)', code: 'did_conflict' } }
        // ③ 公钥复用检测(ADR-003 §7):did 不冲突但钥匙撞他人——撞他人出生/当前控制钥,或撞他人
        //   未吊销设备钥。撞自家(同 did)不拦(用户自己的钥卫生/未来开灵升格路径)。
        const pkHit = d.prepare('SELECT rootDid FROM root_account WHERE rootPubkeyB64=?').get(rootPubkeyB64)
        // 2026-10-07 群体评审 P0-1 修复：原 `!family.has(...)` 引用了已删的 family 集合
        // （9e0d635 删声明漏用法→ReferenceError→500）。闸门后 rootDid 必 canonical，
        // "撞他人"判定=命中行 did ≠ 本次 rootDid（同 did 已被 ② 精确查重截走）。
        if (pkHit && pkHit.rootDid !== rootDid) return { status: 409, body: { error: 'pubkey_conflict: 此公钥已是另一账号(' + pkHit.rootDid.slice(0, 24) + '…)的钥(概率~2^-256 的钥匙碰撞,应重新生成)', code: 'pubkey_conflict' } }
        const devHit = d.prepare('SELECT rootDid FROM root_device WHERE pubkeyB64=? AND revoked=0').get(rootPubkeyB64)
        if (devHit && devHit.rootDid !== rootDid) return { status: 409, body: { error: 'pubkey_conflict: 此公钥已是另一账号的设备钥(钥匙碰撞,应重新生成)', code: 'pubkey_conflict' } }
        try {
          d.prepare('INSERT INTO root_account (rootDid, rootPubkeyB64, name, createdAt, phone, email) VALUES (?,?,?,?,?,?)').run(rootDid, rootPubkeyB64, name || '有灵账号', now(), phone, email)
        } catch (e) {
          // 并发 race 由 rootDid 主键约束兜底
          if (String(e).includes('UNIQUE')) return { status: 409, body: { error: 'did_conflict: 并发注册冲突,应重试', code: 'did_conflict' } }
          throw e
        }
        // 第一个设备用 deviceName（机型/计算机名），与 账号名解耦；缺省回退 账号名
        const devName = deviceName || name || '未命名设备'
        d.prepare('INSERT INTO root_device (rootDid, pubkeyB64, name, addedAt, revoked) VALUES (?,?,?,?,0)').run(rootDid, devicePubkeyB64, devName, now())
        // did:youling 主体验签注册（2026-09-10 账户级任务授权）：identity 表是信令/
        // sign-every-request 的验签面（按 did 查公钥）——账号身份（root 钥签 offer 等）
        // 曾从未进此表=did:youling 一律「签名无效或未注册」。建号即注册（同库 upsert）。
        try {
          d.prepare(`INSERT INTO identity (did, publicKeyB64, ciphertextB64, saltB64, ivB64, iters, didDocument, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(did) DO UPDATE SET publicKeyB64=excluded.publicKeyB64, didDocument=excluded.didDocument, updatedAt=excluded.updatedAt`)
            .run(rootDid, rootPubkeyB64, '', '', '', 0, JSON.stringify({ id: rootDid, alsoKnownAs: ['youling-root'] }), now(), now())
        } catch { /* identity 表未建（极早期启动）——下次注册兜底 */ }
        return { status: 201, body: { data: { rootDid } } }
      }

      if (path === '/root/device/add') {
        const { rootDid, pubkeyB64, name = '', issuedAt, attestSigB64 } = body ?? {}
        if (!rootDid || !pubkeyB64 || !attestSigB64 || issuedAt == null) return { status: 400, body: { error: '缺字段 rootDid/pubkeyB64/issuedAt/attestSigB64' } }
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        // 验 attestation 签名（attest\nrootDid\npubkeyB64\nissuedAt），即归属凭证。
        // 签名材料用客户端原样 did 串；落库键用 acc.rootDid（单形态精确查询下两者一致，
        // 保留 acc.rootDid 写法作行键权威源）。
        const ok = await verifyAttestSig(acc.rootPubkeyB64, rootDid, pubkeyB64, issuedAt, attestSigB64)
        if (!ok) return { status: 403, body: { error: 'attestSig 验签失败' } }
        get().prepare('INSERT INTO root_device (rootDid, pubkeyB64, name, addedAt, revoked, attestSigB64) VALUES (?,?,?,?,0,?) ON CONFLICT(rootDid,pubkeyB64) DO UPDATE SET revoked=0, name=excluded.name, attestSigB64=excluded.attestSigB64, addedAt=excluded.addedAt').run(acc.rootDid, pubkeyB64, name, issuedAt, attestSigB64)
        return { status: 200, body: { data: { rootDid: acc.rootDid, added: pubkeyB64 } } }
      }

      if (path === '/root/device/revoke') {
        const { rootDid, pubkeyB64, rootSig } = body ?? {}
        if (!rootDid || !pubkeyB64 || !rootSig) return { status: 400, body: { error: '缺字段 rootDid/pubkeyB64/rootSig' } }
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        const ok = await verifyRootSig(acc.rootPubkeyB64, 'revoke', rootDid, pubkeyB64, rootSig)
        if (!ok) return { status: 403, body: { error: 'rootSig 验签失败' } }
        get().prepare('UPDATE root_device SET revoked=1 WHERE rootDid=? AND pubkeyB64=?').run(acc.rootDid, pubkeyB64)
        // 2026-10-16：同步写吊销注册表（平台登录回调/委任状收发按注册表拦截——
        // 只标名册不够，见 createRootApi 头注释）。失败不挡：名册已吊销，注册表可由
        // 客户端 /revocation/push 补推（老客户端路径仍在）。
        try { onDeviceRevoked?.(acc.rootDid, pubkeyB64) } catch (e) { console.warn('[root] 吊销注册表写入失败（名册已吊销）:', e?.message ?? e) }
        return { status: 200, body: { data: { rootDid: acc.rootDid, revoked: pubkeyB64 } } }
      }

      // 具身自报：持 账号钥的设备给自己（或名下某设备）标记"持有 账号钥"。
      //   POST /root/device/embodiment {rootDid, pubkeyB64, issuedAt, embodimentSigB64}
      //   embodimentSigB64 = ed25519.sign(`embodiment\nrootDid\npubkeyB64\nissuedAt`, rootPriv)。
      //   需该设备先 /root/device/add 入册；UPDATE 命中 0 行 = 未入册 → 404。
      if (path === '/root/device/embodiment') {
        const { rootDid, pubkeyB64, issuedAt, embodimentSigB64 } = body ?? {}
        if (!rootDid || !pubkeyB64 || !embodimentSigB64 || issuedAt == null) return { status: 400, body: { error: '缺字段 rootDid/pubkeyB64/issuedAt/embodimentSigB64' } }
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        const ok = await verifyEmbodimentSig(acc.rootPubkeyB64, rootDid, pubkeyB64, issuedAt, embodimentSigB64)
        if (!ok) return { status: 403, body: { error: 'embodimentSig 验签失败' } }
        const r = get().prepare('UPDATE root_device SET isEmbodiment=1, embodimentReportedAt=? WHERE rootDid=? AND pubkeyB64=?').run(Number(issuedAt), acc.rootDid, pubkeyB64)
        if (r.changes === 0) return { status: 404, body: { error: '该设备未在此 账号名下（先 /root/device/add）' } }
        return { status: 200, body: { data: { rootDid: acc.rootDid, embodiment: pubkeyB64 } } }
      }

      // 改 账号名（持 账号钥签 `rename\nrootDid\nname` 验签后 UPDATE）。
      // UPDATE 键用 acc.rootDid（名册行键权威源；单形态精确查询下与客户端串一致）。
      if (path === '/root/rename') {
        const { rootDid, name, sigB64 } = body ?? {}
        if (!rootDid || name == null || !sigB64) return { status: 400, body: { error: '缺字段 rootDid/name/sigB64' } }
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        const ok = await verifyRootSig(acc.rootPubkeyB64, 'rename', rootDid, String(name), sigB64)
        if (!ok) return { status: 403, body: { error: 'sig 验签失败' } }
        const safeName = String(name).replace(/[\r\n\t\x00-\x1f]/g, '').trim().slice(0, 32)
        get().prepare('UPDATE root_account SET name=? WHERE rootDid=?').run(safeName || 'myco 账号', acc.rootDid)
        return { status: 200, body: { data: { rootDid: acc.rootDid, name: safeName || 'myco 账号' } } }
      }

      // 置"已导出备份"云端标记（per-账号）。持 账号钥的具身签 `backup\nrootDid\ndevicePubkey` 验签后置位。
      //   POST /root/backup-flag {rootDid, devicePubkeyB64, sigB64}。非密标记，一处备份、所有设备不再唠叨。
      if (path === '/root/backup-flag') {
        const { rootDid, devicePubkeyB64, sigB64 } = body ?? {}
        if (!rootDid || !devicePubkeyB64 || !sigB64) return { status: 400, body: { error: '缺字段 rootDid/devicePubkeyB64/sigB64' } }
        const acc = this.getRoot(rootDid)
        if (!acc) return { status: 404, body: { error: 'root not found' } }
        const ok = await verifyRootSig(acc.rootPubkeyB64, 'backup', rootDid, devicePubkeyB64, sigB64)
        if (!ok) return { status: 403, body: { error: 'sig 验签失败' } }
        get().prepare('UPDATE root_account SET backedUp=1 WHERE rootDid=?').run(acc.rootDid)
        return { status: 200, body: { data: { rootDid: acc.rootDid, backedUp: true } } }
      }

      return null
    },
  }
}
