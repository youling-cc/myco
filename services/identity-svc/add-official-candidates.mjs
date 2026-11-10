// add-official-candidates.mjs — 追加 6 个候选官方 did（用户对 #1 "还行"，保留待选）
import { readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8 } from './identity/crypto.mjs'
import { canonicalMethodId, base58Encode } from './identity/did.mjs'

const b64 = (u8) => Buffer.from(u8).toString('base64')
const P = '../../.tmp-shots/official-candidates.json'
const list = JSON.parse(readFileSync(P, 'utf8'))
list[0].liked = true // #1 用户标记"还行"
const start = list.length
for (let i = 0; i < 6; i++) {
  const kp = await generateKeyPair()
  const pub = await exportPublicKeyRaw(kp.publicKey)
  const priv = await exportPrivateKeyPkcs8(kp.privateKey)
  const did = `did:youling:${canonicalMethodId(pub)}`
  list.push({
    n: start + i + 1,
    did, tail: did.slice('did:youling:'.length),
    pubkeyB64: b64(pub), pubkeyB58: base58Encode(pub),
    privPkcs8B64: b64(priv),
    generatedAt: new Date().toISOString(),
  })
}
writeFileSync(P, JSON.stringify(list, null, 2))
for (const c of list.slice(start)) console.log(`#${c.n}  ${c.did}`)
console.log('\n已追加，共', list.length, '个候选；#1 标记 liked=true')
