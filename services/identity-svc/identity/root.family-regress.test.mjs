// identity/root.family-regress.test.mjs — 2026-10-07 群体评审 P0-1 回归锁
// 场景：同公钥、异 did 的残留行（清档前窗口的旧形态生产存量）撞 pubkey 复用检测
// → 必须 409 pubkey_conflict，绝不允许 500（原 9e0d635 删 family 声明漏用法的残留 bug）。
// 独立文件原因：root.mjs 的 _db 是模块级单例——本文件必须是它的首个使用者，
// 传文件路径才能让测试侧 DatabaseSync 打开同一文件直插残留行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { createRootApi } from './root.mjs'
import { generateKeyPair, exportPublicKeyRaw, sign } from './crypto.mjs'
import { didFromPublicKey, base58Encode } from './did.mjs'

const enc = () => new TextEncoder()
const b64 = (u8) => Buffer.from(u8).toString('base64')
async function newKey() {
  const { publicKey, privateKey } = await generateKeyPair()
  const raw = await exportPublicKeyRaw(publicKey)
  return { raw, privateKey, pubB64: b64(raw) }
}
async function createRoot(api, rootDid, key, devicePubkeyB64) {
  const msg = enc().encode(`create\n${rootDid}\n${key.pubB64}`)
  const sig = await sign(key.privateKey, msg)
  return api.handle('POST', '/root/create', {
    rootDid, rootPubkeyB64: key.pubB64, devicePubkeyB64, name: 't', rootSig: b64(sig),
  })
}

test('root: 同公钥异 did 残留行 → 409 pubkey_conflict 而非 500（family 残留回归锁）', async () => {
  const dbPath = join(tmpdir(), `family-regress-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const api = createRootApi({ dbPath })
  const key = await newKey()
  const dev = await newKey()
  const canonical = didFromPublicKey(key.raw).replace('did:myco:', 'did:youling:')
  // 先成功注册（建表+canonical 行）
  assert.equal((await createRoot(api, canonical, key, dev.pubB64)).status, 201)
  // 测试侧直插同公钥、异 did 残留行（旧形态），并删掉 canonical 行
  // （模拟清档前窗口：库里只有旧形态行，canonical 自愈来 create）
  const legacyDid = 'did:myco:' + base58Encode(key.raw) // 2026-10-10 收敛：legacy 串手搓
  const side = new DatabaseSync(dbPath)
  side.prepare('INSERT INTO root_account (rootDid, rootPubkeyB64, name, createdAt) VALUES (?,?,?,?)').run(legacyDid, key.pubB64, 'residue', 1)
  side.prepare('DELETE FROM root_account WHERE rootDid=?').run(canonical)
  side.close()
  // canonical create：did 精确查重不中 → pkHit 命中残留行（同公钥）→ 修复前 ReferenceError→500 / 修复后 409
  const r = await createRoot(api, canonical, key, dev.pubB64)
  assert.notEqual(r.status, 500, `绝不允许 500（family 残留回归）：${JSON.stringify(r.body)}`)
  assert.equal(r.status, 409, `应 409 pubkey_conflict（pkHit 命中残留行），得到 ${JSON.stringify(r.body)}`)
  assert.equal(r.body.code, 'pubkey_conflict')
  // 临时文件清理容忍失败（root.mjs 的 _db 单例持句柄未释放是 Windows 已知行为；%TEMP% 系统自清）
  try { rmSync(dbPath, { force: true }) } catch { /* EPERM: 句柄占用，留给系统临时目录清理 */ }
})
