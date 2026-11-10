// gen-official-candidates.mjs — 生成 6 个候选「有灵官方」did:youling 账号（离线，不写服务端）
// 输出：.tmp-shots/official-candidates.json（含私钥 pkcs8，临时保留到选定后清理）
import { writeFileSync } from 'node:fs'
import { generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8 } from './identity/crypto.mjs'
import { canonicalMethodId, base58Encode } from './identity/did.mjs'

const b64 = (u8) => Buffer.from(u8).toString('base64')
const out = []
for (let i = 1; i <= 6; i++) {
  const kp = await generateKeyPair()
  const pub = await exportPublicKeyRaw(kp.publicKey)
  const priv = await exportPrivateKeyPkcs8(kp.privateKey)
  const did = `did:youling:${canonicalMethodId(pub)}`
  const tail = did.slice('did:youling:'.length)
  out.push({
    n: i,
    did,
    tail,
    pubkeyB64: b64(pub),
    pubkeyB58: base58Encode(pub),
    // 私钥 pkcs8（ed25519）——选定后进 official.json / 注册用；未选中的之后删除
    privPkcs8B64: b64(priv),
    generatedAt: new Date().toISOString(),
  })
}
writeFileSync('../../.tmp-shots/official-candidates.json', JSON.stringify(out, null, 2))
for (const c of out) console.log(`#${c.n}  ${c.did}`)
console.log('\n候选已存: .tmp-shots/official-candidates.json（6 个，含私钥，选定后清理其余）')
