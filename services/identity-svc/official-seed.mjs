// official-seed.mjs — 「小灵」官方账号一次性签发（identity-svc 内运行；幂等）
//
// 用法（在 identity-svc 目录）：
//   node official-seed.mjs [baseUrl] [name]
//     baseUrl 默认 http://127.0.0.1:8321（容器内自调）；name 默认「小灵」
//   OFFICIAL_DIR 可指定产出目录（默认脚本所在目录 = identity-svc 数据目录）
//
// 产出（mode 600）：
//   official.json          {did,name,rootPubkeyB64,rootPrivPkcs8B64,devicePubkeyB64,devicePrivPkcs8B64,createdAt}
//   official-token.txt     平台服务端调用 /official/notify 用的 X-Official-Token（缺失才生成，已有不覆盖）
//
// 幂等：official.json 已存在 → 只打印摘要退出（不会重签、不会换钥）。
// 注册：POST /root/create（rootSig=`create\n<rootDid>\n<rootPubkeyB64>`）；
//   已存在同 did（409 did_conflict）时用 GET /root/<did> 核对公钥一致才继续。
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { generateKeyPair, exportPublicKeyRaw, exportPrivateKeyPkcs8, sign } from './identity/crypto.mjs'
import { canonicalMethodId } from './identity/did.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = (process.argv[2] || 'http://127.0.0.1:8321').replace(/\/+$/, '')
const NAME = process.argv[3] || '小灵'
const DIR = process.env.OFFICIAL_DIR || HERE
const ACCOUNT_FILE = join(DIR, 'official.json')
const TOKEN_FILE = join(DIR, 'official-token.txt')

const b64 = (u8) => Buffer.from(u8).toString('base64')

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  let j = null; try { j = await r.json() } catch { /* 空 body */ }
  return { status: r.status, body: j }
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`)
  let j = null; try { j = await r.json() } catch { /* */ }
  return { status: r.status, body: j }
}

function summary(st) {
  console.log(JSON.stringify({
    ok: true,
    did: st.did,
    name: st.name,
    rootPubkeyB64: st.rootPubkeyB64,
    tokenFile: TOKEN_FILE,
    accountFile: ACCOUNT_FILE,
    already: !!st.already,
  }, null, 2))
}

if (existsSync(ACCOUNT_FILE)) {
  const st = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'))
  summary({ ...st, already: true })
  process.exit(0)
}

// ① 生成根钥 + 设备钥（设备钥仅满足 /root/create 的入册要求，服务端不跑客户端）
const root = await generateKeyPair()
const dev = await generateKeyPair()
const rootPub = await exportPublicKeyRaw(root.publicKey)
const devPub = await exportPublicKeyRaw(dev.publicKey)
const did = `did:youling:${canonicalMethodId(rootPub)}`
const rootPubB64 = b64(rootPub)
const devPubB64 = b64(devPub)
const rootSig = b64(await sign(root.privateKey, new TextEncoder().encode(`create\n${did}\n${rootPubB64}`)))

// ② 注册（幂等：409 时核对已存在账号公钥与本次一致）
const reg = await post('/root/create', {
  rootDid: did, rootPubkeyB64: rootPubB64, devicePubkeyB64: devPubB64,
  name: NAME, deviceName: '小灵服务端', rootSig,
})
if (reg.status !== 201) {
  const exists = reg.status === 409 && reg.body?.code === 'did_conflict'
  if (!exists) {
    console.error('[official-seed] /root/create 失败:', reg.status, JSON.stringify(reg.body))
    process.exit(2)
  }
  const chk = await get(`/root/${encodeURIComponent(did)}`)
  if (chk.status !== 200 || chk.body?.data?.rootPubkeyB64 !== rootPubB64) {
    console.error('[official-seed] did 已被另一把钥占用（不能接管）:', chk.status, JSON.stringify(chk.body))
    process.exit(3)
  }
  console.log('[official-seed] 账号已存在且公钥一致 → 复用')
}

// ③ 落盘（600）+ token（已有则不覆盖）
const rootPrivPkcs8B64 = b64(await exportPrivateKeyPkcs8(root.privateKey))
const devPrivPkcs8B64 = b64(await exportPrivateKeyPkcs8(dev.privateKey))
const st = {
  did, name: NAME, rootPubkeyB64: rootPubB64, rootPrivPkcs8B64,
  devicePubkeyB64: devPubB64, devicePrivPkcs8B64: devPrivPkcs8B64,
  createdAt: Date.now(),
}
writeFileSync(ACCOUNT_FILE, JSON.stringify(st, null, 2), { mode: 0o600 })
try { chmodSync(ACCOUNT_FILE, 0o600) } catch { /* */ }
if (!existsSync(TOKEN_FILE)) {
  writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  try { chmodSync(TOKEN_FILE, 0o600) } catch { /* */ }
  console.log('[official-seed] 已生成 official-token.txt（平台服务端 X-Official-Token）')
}
summary(st)
