// register-official-account.mjs — 把选定官方 did 注册进 myco 身份服务（本地用 root 私钥签名，不把 root 私钥送上服务器）
// 幂等：已存在（409 did_conflict）时核对 /root/<did> 公钥一致即视为成功。
import { readFileSync } from 'node:fs'
import { importPrivateKey, sign } from './identity/crypto.mjs'

const BASE = (process.argv[2] || 'http://myco.youling.cc:8321').replace(/\/+$/, '')
const dir = '../../.tmp-shots/rotation'
const secret = JSON.parse(readFileSync(`${dir}/official-root-key.secret.json`, 'utf8'))
const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'))
const b64 = (u8) => Buffer.from(u8).toString('base64')

const priv = await importPrivateKey(new Uint8Array(Buffer.from(secret.privPkcs8B64, 'base64')))
const enc = new TextEncoder()
const rootSig = b64(await sign(priv, enc.encode(`create\n${meta.did}\n${meta.pubkeyB64}`)))
const body = {
  rootDid: meta.did,
  rootPubkeyB64: meta.pubkeyB64,
  devicePubkeyB64: meta.pushDevice.pubkeyB64,
  name: meta.name,
  deviceName: meta.pushDevice.name,
  rootSig,
}
async function post(path, b) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  let j = null; try { j = await r.json() } catch { /* */ }
  return { status: r.status, body: j }
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`)
  let j = null; try { j = await r.json() } catch { /* */ }
  return { status: r.status, body: j }
}

const reg = await post('/root/create', body)
console.log('create:', reg.status, JSON.stringify(reg.body).slice(0, 220))
const chk = await get(`/root/${encodeURIComponent(meta.did)}`)
console.log('verify root:', chk.status, JSON.stringify(chk.body).slice(0, 300))
const ok = chk.status === 200 && chk.body?.data?.rootPubkeyB64 === meta.pubkeyB64
console.log(ok ? 'REGISTER_OK' : 'REGISTER_FAILED')
process.exit(ok ? 0 : 1)
