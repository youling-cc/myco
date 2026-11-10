/**
 * cli.test.ts — MycoCli 单测（node 环境跑，不碰网络；wire 兼容用 A6 同款方法：
 * TS 侧按 Rust serde 字段名手造 wire 验证互操作）。
 *
 * 覆盖：词法/参数解析、identity birth/did、sign、device token/verify-token
 * （含篡改拒绝）、delegation issue/verify 往返、myco-ubuntu mycoDid 字段 wire 兼容。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { lex, parseArgs, exec } from './cli'
import { didFromPubkey } from './didUtil'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512.js'
import bs58 from 'bs58'

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))

// node 下无 localStorage —— 内存版 mock（identity.ts/cli.ts 均已容错，mock 后行为更可控）
beforeEach(() => {
  const store = new Map<string, string>()
  // @ts-expect-error 测试桩
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
})

const run = async (cmd: string): Promise<any> => JSON.parse(await exec(cmd))
const TE = new TextEncoder()
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8))
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const wireEncode = (s: string) => btoa(unescape(encodeURIComponent(s)))
const wireDecode = (s: string) => decodeURIComponent(escape(atob(s)))

// identity.ts 的 _rootSeedB64 是内存缓存（单会话 vault 恒定的既有语义）——跨用例
// 换 root 必须用**文件级恒定**凭据，否则缓存种子与 vault did 不配对（签验必败）。
const ROOT_SEED = ed.utils.randomPrivateKey()
// canonical-only（2026-10-10）：账号/设备 did 一律 canonical `z` multibase 形态
const ROOT_DID = didFromPubkey(ed.getPublicKey(ROOT_SEED), 'youling')
const ROOT_SEED_B64 = b64(ROOT_SEED)
let DEVICE_KEY_B64: string | null = null

/** 把当前 vault 升级为持根账号（文件级恒定 root；vault 未落盘时自造）。 */
function grantRoot(): void {
  const raw = localStorage.getItem('youling.vault')
  const vk = raw ? JSON.parse(raw) : { mode: 'plain', keyB64: DEVICE_KEY_B64 ?? b64(ed.utils.randomPrivateKey()) }
  localStorage.setItem('youling.vault', JSON.stringify({ ...vk, rootSeedB64: ROOT_SEED_B64, rootDid: ROOT_DID }))
}

describe('词法与参数解析', () => {
  it('引号词/转义/--k=v 与 cli.rs parse_args 同规则', () => {
    expect(lex('identity did')).toEqual(['identity', 'did'])
    expect(lex('delegation verify "a b"')).toEqual(['delegation', 'verify', 'a b'])
    expect(lex("sign --as 'root device' x==")).toEqual(['sign', '--as', 'root device', 'x=='])
    expect(lex('a "" b')).toEqual(['a', '', 'b'])
    const p = parseArgs(['issue', '--did', 'D', '--scopes', 'a,b', '--ttl-ms=100', '--deliver'])
    expect(p.positional).toEqual(['issue'])
    expect(p.flags.did).toBe('D')
    expect(p.flags.scopes).toBe('a,b')
    expect(p.flags['ttl-ms']).toBe('100')
    expect(p.flags.deliver).toBe('true')
  })
})

describe('identity birth / did', () => {
  it('首跑 born=true，重跑幂等 born=false，did 可解码回公钥', async () => {
    const r1 = await run('identity birth')
    expect(r1.ok).toBe(true)
    expect(r1.data.born).toBe(true)
    DEVICE_KEY_B64 ??= JSON.parse(localStorage.getItem('youling.vault')!).keyB64
    expect(r1.data.did).toMatch(/^did:myco:z/)
    // spec v0.3 canonical 不变量：z 尾段 base58 解码 = 34B（0xed 0x01 + 32B 公钥）
    const pk = bs58.decode(r1.data.did.replace('did:myco:z', ''))
    expect(pk.length).toBe(34)
    expect(pk[0]).toBe(0xed)
    expect(pk[1]).toBe(0x01)
    const r2 = await run('identity birth')
    expect(r2.data.born).toBe(false)
    expect(r2.data.did).toBe(r1.data.did)
  })

  it('identity did 输出 DID Document（myco-ubuntu identity.rs document() 同构）', async () => {
    await run('identity birth')
    const r = await run('identity did')
    expect(r.ok).toBe(true)
    expect(r.data.id).toMatch(/^did:myco:/)
    expect(r.data.verificationMethod[0].type).toBe('Ed25519VerificationKey2020')
    expect(r.data.verificationMethod[0].publicKeyBase58).toBe(r.data.id.replace('did:myco:', ''))
    expect(typeof r.data.created).toBe('string')
  })
})

describe('sign', () => {
  it('无根钥回退设备钥并在 signer 标注（auto）', async () => {
    await run('identity birth')
    const payload = b64(TE.encode('hbl-payload'))
    const r = await run(`sign ${payload}`)
    expect(r.ok).toBe(true)
    expect(r.data.algo).toBe('ed25519')
    expect(r.data.signer).toBe('device')
    // 验签：did 解公钥（spec v0.3 双收——canonical z multibase 剥 ed01 头）→ ed.verify
    const pub = bs58.decode(r.data.did.replace('did:myco:z', '')).slice(2)
    expect(ed.verify(fromB64(r.data.signature), TE.encode('hbl-payload'), pub)).toBe(true)
  })
  it('--as root 无根钥时报错', async () => {
    await run('identity birth')
    const r = await run(`sign ${b64(TE.encode('x'))} --as root`)
    expect(r.ok).toBe(false)
    expect(r.err).toContain('根钥')
  })
})

describe('device token（补齐能力，与 myco-ubuntu device.rs 同构）', () => {
  it('签发→离线验签往返；篡改 scopes 提权被拒', async () => {
    await run('identity birth')
    grantRoot()
    // 目标设备 did（canonical）
    const devSeed = ed.utils.randomPrivateKey()
    const devDid = didFromPubkey(ed.getPublicKey(devSeed), 'myco')
    const r = await run(`device token --did ${devDid} --scopes task.pull --ttl-secs 3600`)
    expect(r.ok).toBe(true)
    // 验证方离线验（device verify-token）
    const v = await run(`device verify-token ${r.data.token}`)
    expect(v.data.valid).toBe(true)
    expect(v.data.claims.orgDid).toBe(ROOT_DID)
    expect(v.data.claims.scopes).toEqual(['task.pull'])
    // 篡改：scopes 换 admin（复用真签名）→ 验签必败
    const raw = JSON.parse(wireDecode(r.data.token))
    raw.scopes = ['admin']
    const bad = await run(`device verify-token ${wireEncode(JSON.stringify(raw))}`)
    expect(bad.data.valid).toBe(false)
    expect(bad.data.reason).toContain('签名验证失败')
    // 过期 token 被拒
    const expired = { ...JSON.parse(wireDecode(r.data.token)), expiresAt: Date.now() - 1000 }
    const e2 = await run(`device verify-token ${wireEncode(JSON.stringify(expired))}`)
    expect(e2.data.valid).toBe(false)
  })

  // 2026-10-10 canonical-only 反向守卫：legacy（裸 base58 尾段）orgDid 已废止——即便签名是真的也拒
  it('legacy orgDid（裸 base58）→ 拒（不支持的 did 格式），即使签名有效', async () => {
    await run('identity birth')
    grantRoot()
    const orgSeed = ed.utils.randomPrivateKey()
    const legacyOrgDid = `did:youling:${bs58.encode(ed.getPublicKey(orgSeed))}`
    const devDid = didFromPubkey(ed.getPublicKey(ed.utils.randomPrivateKey()), 'myco')
    const claims = { orgDid: legacyOrgDid, deviceDid: devDid, scopes: ['task.pull'], issuedAt: 1, expiresAt: Date.now() + 3600_000 }
    const msg = `device-grant\n${claims.orgDid}\n${claims.deviceDid}\n${claims.scopes.join(',')}\n${claims.expiresAt}`
    const token = wireEncode(JSON.stringify({ ...claims, sigB64: b64(ed.sign(TE.encode(msg), orgSeed)) }))
    const v = await run(`device verify-token ${token}`)
    expect(v.data.valid).toBe(false)
    expect(v.data.reason).toContain('不支持的 did 格式')
  })
})

describe('delegation issue / verify', () => {
  it('签发→verify 往返（同字段名 accountDid）', async () => {
    await run('identity birth')
    grantRoot()
    const devPub = ed.getPublicKey(ed.utils.randomPrivateKey())
    const devDid = didFromPubkey(devPub, 'myco')
    const r = await run(`delegation issue --did ${devDid} --name n1 --scopes task.pull --ttl-ms 86400000`)
    expect(r.ok).toBe(true)
    expect(r.data.delegation.accountDid).toBe(ROOT_DID)
    const v = await run(`delegation verify ${r.data.wire}`)
    expect(v.data.valid).toBe(true)
    expect(v.data.remainingMs).toBeGreaterThan(0)
    // 篡改被拒
    const bad = JSON.parse(wireDecode(r.data.wire))
    bad.scopes = 'admin'
    const v2 = await run(`delegation verify ${wireEncode(JSON.stringify(bad))}`)
    expect(v2.data.valid).toBe(false)
  })

  it('myco-ubuntu wire 兼容：mycoDid 字段名的委任状按同一签名消息验证通过', async () => {
    // A6 方法：TS 侧模拟 Rust serde（camelCase: mycoDid/devicePubkeyB64/...）手造 wire
    const orgSeed = ed.utils.randomPrivateKey()
    const orgDid = didFromPubkey(ed.getPublicKey(orgSeed), 'youling')
    const devPubB64 = b64(ed.getPublicKey(ed.utils.randomPrivateKey()))
    const now = Date.now()
    const body = { mycoDid: orgDid, devicePubkeyB64: devPubB64, deviceName: 'rust-node', scopes: '*', issuedAt: now, exp: now + 86400000, nonce: `d${now}`, sigB64: '' }
    const msg = `delegation\n${body.mycoDid}\n${body.devicePubkeyB64}\n${body.deviceName}\n${body.scopes}\n${body.issuedAt}\n${body.exp}\n${body.nonce}`
    body.sigB64 = b64(ed.sign(TE.encode(msg), orgSeed))
    const wire = wireEncode(JSON.stringify(body))
    const v = await run(`delegation verify ${wire}`)
    expect(v.data.valid).toBe(true)
    expect(v.data.delegation.crossWire).toContain('myco-ubuntu')
  })
})

describe('错误面', () => {
  it('未知命令/缺参数返回 err+usage 标记', async () => {
    const r1 = await run('foo')
    expect(r1.ok).toBe(false)
    expect(r1.usage).toBe(true)
    const r2 = await run('delegation verify')
    expect(r2.ok).toBe(false)
    const r3 = await run('')
    expect(r3.ok).toBe(true) // 空命令=usage
  })
})
