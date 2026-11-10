// prepare-official-rotation.mjs — 用选定的候选 #1 生成轮换所需工件（本地，私钥不出本机除必要文件外）
// 产出 .tmp-shots/rotation/ 下：
//   hbl-seed.b64         ← 官方 root seed（32B raw, base64）→ 换到 hbl-myco config/accounts/*.seed
//   hbl-active.txt       ← 新官方 did（hbl-myco active.txt）
//   official.json        ← identity-svc 用（只含「小灵推送」设备钥；root 私钥不进 identity-svc）
//   official-push-device.pub.b64
//   rotate-guild-org.sql ← PolarDB guild_org 行 22 更新
//   meta.json            ← 轮换摘要（did/pubkey/时间）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8, importPrivateKey, exportPrivateKeyPkcs8 as expPkcs8, importPublicKey, verify, sign } from './identity/crypto.mjs'
import { canonicalMethodId, base58Encode } from './identity/did.mjs'

const b64 = (u8) => Buffer.from(u8).toString('base64')
const P = '../../.tmp-shots/official-candidates.json'
const list = JSON.parse(readFileSync(P, 'utf8'))
const chosen = list.find((c) => c.n === 1)
if (!chosen) throw new Error('找不到 #1')
const OUT = '../../.tmp-shots/rotation'
mkdirSync(OUT, { recursive: true })

// 1) 校验收到的候选密钥自洽：pkcs8 → pub 派生 == did 内嵌公钥
const privKey = await importPrivateKey(new Uint8Array(Buffer.from(chosen.privPkcs8B64, 'base64')))
const pubRaw = new Uint8Array(Buffer.from(chosen.pubkeyB64, 'base64'))
const didCheck = `did:youling:${canonicalMethodId(pubRaw)}`
if (didCheck !== chosen.did) throw new Error(`did 派生不符: ${didCheck} != ${chosen.did}`)
// 2) 从 pkcs8 提取 32B raw seed（Ed25519 PKCS8 DER = 16B 前缀 + 32B seed）
const der = Buffer.from(chosen.privPkcs8B64, 'base64')
if (der.length !== 48) throw new Error(`pkcs8 长度异常 ${der.length}`)
const seed = der.subarray(16, 48)
// 3) 自验：seed 签一段材料、pub 验签
const msg = new TextEncoder().encode('rotation-selfcheck')
const sig = await sign(privKey, msg)
const pubKey = await importPublicKey(pubRaw)
if (!(await verify(pubKey, msg, sig))) throw new Error('seed 自签自验失败')

// 4) 生成 identity-svc「小灵推送」设备钥（只此私钥进 identity-svc）
const dev = await generateKeyPair()
const devPub = await exportPublicKeyRaw(dev.publicKey)
const devPriv = await expPkcs8(dev.privateKey)
const devPubB58 = base58Encode(devPub)

const pubB58 = base58Encode(pubRaw)
const now = new Date().toISOString()
const meta = {
  did: chosen.did,
  pubkeyB64: b64(pubRaw),
  pubkeyB58: pubB58,
  name: '小灵',
  pushDevice: { name: '小灵推送（服务端）', pubkeyB64: b64(devPub), pubkeyB58: devPubB58 },
  rotatedFrom: 'did:youling:z6MknbmoBrHDpFN6uPBF27hkWntWXqMH73Xe6pRGk9SLc6sB',
  chosenAt: now,
}
const w = (name, data) => writeFileSync(`${OUT}/${name}`, data)

w('hbl-seed.b64', b64(seed))
w('hbl-active.txt', chosen.did + '\n')
w('hbl-identity.json', JSON.stringify({
  did: chosen.did,
  publicKeyBase58: pubB58,
  created: now,
}, null, 2) + '\n')
w('official.json', JSON.stringify({
  did: chosen.did,
  name: '小灵',
  rootPubkeyB64: b64(pubRaw),
  devicePubkeyB64: b64(devPub),
  devicePrivPkcs8B64: b64(devPriv),
  createdAt: Date.now(),
}, null, 2) + '\n')
w('official-push-device.pub.b64', b64(devPub) + '\n')
w('rotate-guild-org.sql', `-- 官方 DID 轮换（候选 #1，2026-10-20）：guild_org 行 22（client_id=hbl-vnext）
UPDATE guild_org
   SET owner_did = '${chosen.did}',
       public_key = '${pubB58}',
       version = version + 1,
       update_time = NOW()
 WHERE client_id = 'hbl-vnext';
`)
w('meta.json', JSON.stringify(meta, null, 2) + '\n')

// 5) 未选中候选的私钥从文件中清掉（只留公共信息；#1 私钥保留在本地 secret 文件）
const privKeep = { n: 1, did: chosen.did, privPkcs8B64: chosen.privPkcs8B64, pubkeyB64: chosen.pubkeyB64, pubkeyB58: pubB58 }
w('official-root-key.secret.json', JSON.stringify(privKeep, null, 2) + '\n')
const scrubbed = list.map((c) => ({ n: c.n, did: c.did, pubkeyB64: c.pubkeyB64, pubkeyB58: c.pubkeyB58, generatedAt: c.generatedAt, ...(c.n === 1 ? { chosen: true } : {}) }))
writeFileSync(P, JSON.stringify(scrubbed, null, 2))
console.log(JSON.stringify({ did: chosen.did, pubkeyB58: pubB58, pushDevice: meta.pushDevice, out: OUT }, null, 2))
