/**
 * explore.test.ts — 「去探索」免登（手机版）单测。
 *
 * 事故背景（2026-10-15 用户报）：手机点探索打开的网页没登录——手机端一直裸链接，
 * PC 早有 auto_login_url 免登链。本模块对齐 PC 协议（lib.rs:797）。
 *
 * 断言锚点：两态签名回调体（与 YoulingLogin 同构）、10 分钟票缓存防互踢（PC 第92轮
 * 内测被循环踢 9 次的教训）、零损失降级（失败返回裸 URL）、串号防护（不同身份不共用票）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./identity', () => ({
  getRootIdentity: vi.fn(() => null as string | null),
  getRootSeed: vi.fn(() => null as string | null),
  signWithRoot: vi.fn(() => null as string | null),
  currentIdentity: vi.fn(() => null as { did: string } | null),
}))
vi.mock('./delegation', () => ({
  loadDelegation: vi.fn(() => null as any),
  devicePubkeyB64: vi.fn(() => null as string | null),
  pollDelegation: vi.fn(async () => null as any),
  signWithDeviceKey: vi.fn(async () => null as string | null),
}))

import { getRootIdentity, getRootSeed, signWithRoot, currentIdentity } from './identity'
import { loadDelegation, devicePubkeyB64, pollDelegation, signWithDeviceKey } from './delegation'
import {
  exploreAutologinUrl, withTicket, cacheUsable, TICKET_WINDOW_MS,
  __resetExploreCacheForTest,
} from './explore'

const PAGE = 'https://www.youling.cc/'
const now = vi.fn(() => 1_000_000)

interface Call { url: string; body: any }
function makePost(opts?: { ticketFail?: boolean; callbackFail?: boolean; ticketId?: string }) {
  const calls: Call[] = []
  const postJson = async (url: string, body: unknown) => {
    calls.push({ url, body })
    if (url.endsWith('/auth/qr-tickets')) {
      if (opts?.ticketFail) return { ok: false, status: 500, json: {} }
      return { ok: true, status: 200, json: { data: { ticketId: opts?.ticketId ?? 'TICKET-1' } } }
    }
    if (url.endsWith('/auth/myco/callback')) {
      if (opts?.callbackFail) return { ok: true, status: 200, json: { ok: false, error: 'rejected' } }
      return { ok: true, status: 200, json: { ok: true } }
    }
    return { ok: false, status: 404, json: {} }
  }
  return { postJson, calls }
}

function asRoot() {
  ;(getRootIdentity as any).mockReturnValue('did:youling:zROOT')
  ;(getRootSeed as any).mockReturnValue('seed-b64')
  ;(signWithRoot as any).mockReturnValue('SIG-ROOT')
}

function asDelegated(exp: number, poll?: any) {
  ;(currentIdentity as any).mockReturnValue({ did: 'did:myco:zDEV' })
  ;(devicePubkeyB64 as any).mockReturnValue('DEV-PK')
  ;(loadDelegation as any).mockReturnValue({
    accountDid: 'did:youling:zROOT', devicePubkeyB64: 'DEV-PK', deviceName: '手机',
    scopes: '*', issuedAt: 1, exp, nonce: 'n', sigB64: 's',
  })
  ;(signWithDeviceKey as any).mockResolvedValue('SIG-DEV')
  if (poll !== undefined) (pollDelegation as any).mockResolvedValue(poll)
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetExploreCacheForTest()
  now.mockReturnValue(1_000_000)
  ;(getRootIdentity as any).mockReturnValue(null)
  ;(getRootSeed as any).mockReturnValue(null)
  ;(signWithRoot as any).mockReturnValue(null)
  ;(currentIdentity as any).mockReturnValue(null)
  ;(loadDelegation as any).mockReturnValue(null)
  ;(devicePubkeyB64 as any).mockReturnValue(null)
  ;(pollDelegation as any).mockResolvedValue(null)
  ;(signWithDeviceKey as any).mockResolvedValue(null)
})

describe('纯函数', () => {
  it('withTicket：无 ? 用 ?，有 ? 用 &', () => {
    expect(withTicket('https://a.b/', 'T')).toBe('https://a.b/?autologin=T')
    expect(withTicket('https://a.b/?x=1', 'T')).toBe('https://a.b/?x=1&autologin=T')
  })
  it('cacheUsable：同身份且窗口内才复用', () => {
    const c = { did: 'D', at: 1_000_000, ticket: 'T' }
    expect(cacheUsable(c, 'D', 1_000_000 + TICKET_WINDOW_MS - 1)).toBe(true)
    expect(cacheUsable(c, 'D', 1_000_000 + TICKET_WINDOW_MS)).toBe(false)
    expect(cacheUsable(c, 'OTHER', 1_000_000 + 1)).toBe(false)
    expect(cacheUsable(null, 'D', 0)).toBe(false)
  })
})

describe('主设备（根钥）模式', () => {
  it('出票→根钥签→callback {ticket,did,sig}→拼 ?autologin=', async () => {
    asRoot()
    const { postJson, calls } = makePost()
    const url = await exploreAutologinUrl(PAGE, { now, postJson })
    expect(url).toBe('https://www.youling.cc/?autologin=TICKET-1')
    expect(calls[0].url).toBe('https://www.youling.cc/api/v1/auth/qr-tickets')
    expect(calls[0].body).toEqual({ provider: 'myco' })
    expect(calls[1].body).toEqual({ ticket: 'TICKET-1', did: 'did:youling:zROOT', sig: 'SIG-ROOT' })
    expect(signWithRoot).toHaveBeenCalledWith('myco-auth\nTICKET-1')
  })
})

describe('分身（委任状）模式', () => {
  it('设备钥签 + delegation 随行', async () => {
    asDelegated(2_000_000)
    const { postJson, calls } = makePost()
    const url = await exploreAutologinUrl(PAGE, { now, postJson })
    expect(url).toBe('https://www.youling.cc/?autologin=TICKET-1')
    const cb = calls[1].body
    expect(cb.ticket).toBe('TICKET-1')
    expect(cb.did).toBe('did:myco:zDEV')
    expect(cb.sig).toBe('SIG-DEV')
    expect(typeof cb.delegation).toBe('string')
    expect(JSON.parse(cb.delegation).devicePubkeyB64).toBe('DEV-PK')
  })
  it('委任过期 → 探信箱拿到续签 → 照常走通', async () => {
    asDelegated(900_000, { accountDid: 'did:youling:zROOT', devicePubkeyB64: 'DEV-PK', deviceName: '手机', scopes: '*', issuedAt: 1, exp: 5_000_000, nonce: 'n2', sigB64: 's2' })
    const { postJson, calls } = makePost()
    const url = await exploreAutologinUrl(PAGE, { now, postJson })
    expect(url).toContain('autologin=TICKET-1')
    expect(pollDelegation).toHaveBeenCalled()
    expect(JSON.parse(calls[1].body.delegation).exp).toBe(5_000_000)
  })
  it('委任过期且续不上 → 零损失降级裸 URL（不出票不回调）', async () => {
    asDelegated(900_000, null)
    const { postJson, calls } = makePost()
    const url = await exploreAutologinUrl(PAGE, { now, postJson })
    expect(url).toBe(PAGE)
    expect(calls.length).toBe(0)
  })
  it('委任状不是本机设备钥的 → 视为无身份 → 裸 URL', async () => {
    asDelegated(2_000_000)
    ;(devicePubkeyB64 as any).mockReturnValue('OTHER-PK')
    const { postJson, calls } = makePost()
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
    expect(calls.length).toBe(0)
  })
  it('本地无委任状 → 探信箱取到云端已投递的状 → 走通免登（2026-10-15 真机事故回归）', async () => {
    // 真机现场：手机 localStorage 里的状丢了（重装/清缓存），但云端信箱躺着一张新鲜的
    // （账号 koGc / 设备 phone），原实现本地无状就直接降级 → 用户看到"网页打开了但没登录"。
    ;(currentIdentity as any).mockReturnValue({ did: 'did:myco:zDEV' })
    ;(devicePubkeyB64 as any).mockReturnValue('DEV-PK')
    ;(loadDelegation as any).mockReturnValue(null) // ← 关键：本地完全没状
    ;(signWithDeviceKey as any).mockResolvedValue('SIG-DEV')
    ;(pollDelegation as any).mockResolvedValue({
      accountDid: 'did:youling:zROOT', devicePubkeyB64: 'DEV-PK', deviceName: 'phone',
      scopes: '*', issuedAt: 1, exp: 5_000_000, nonce: 'n', sigB64: 's',
    })
    const { postJson, calls } = makePost()
    const url = await exploreAutologinUrl(PAGE, { now, postJson })
    expect(url).toBe('https://www.youling.cc/?autologin=TICKET-1')
    expect(pollDelegation).toHaveBeenCalled()
    expect(calls.length).toBe(2)
    expect(JSON.parse(calls[1].body.delegation).deviceName).toBe('phone')
  })
  it('本地无状且信箱也空 → 零损失降级裸 URL', async () => {
    ;(currentIdentity as any).mockReturnValue({ did: 'did:myco:zDEV' })
    ;(devicePubkeyB64 as any).mockReturnValue('DEV-PK')
    ;(loadDelegation as any).mockReturnValue(null)
    ;(pollDelegation as any).mockResolvedValue(null)
    const { postJson, calls } = makePost()
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
    expect(calls.length).toBe(0)
  })
})

describe('票缓存（防互踢，PC 第92轮教训）', () => {
  it('窗口内第二次调用复用旧票：零网络请求', async () => {
    asRoot()
    const { postJson, calls } = makePost()
    await exploreAutologinUrl(PAGE, { now, postJson })
    await exploreAutologinUrl(PAGE, { now, postJson })
    expect(calls.length).toBe(2) // 只有第一次的出票+回调
    expect(calls[0].body).toEqual({ provider: 'myco' })
  })
  it('过窗后重新出票', async () => {
    asRoot()
    const { postJson } = makePost({ ticketId: 'T1' })
    await exploreAutologinUrl(PAGE, { now, postJson })
    now.mockReturnValue(1_000_000 + TICKET_WINDOW_MS + 1)
    const { postJson: p2, calls: c2 } = makePost({ ticketId: 'T2' })
    const url = await exploreAutologinUrl(PAGE, { now, postJson: p2 })
    expect(url).toContain('autologin=T2')
    expect(c2.length).toBe(2)
  })
  it('串号防护：换身份不复用他人票（含降级路径也不用）', async () => {
    asRoot()
    const a = makePost({ ticketId: 'T-ROOT' })
    await exploreAutologinUrl(PAGE, { now, postJson: a.postJson })
    // 切到分身身份
    ;(getRootIdentity as any).mockReturnValue(null); (getRootSeed as any).mockReturnValue(null)
    asDelegated(2_000_000)
    const b = makePost({ ticketFail: true }) // 出票失败 → 只能降级
    const url = await exploreAutologinUrl(PAGE, { now, postJson: b.postJson })
    expect(url).toBe(PAGE) // 不拿 ROOT 的旧票垫
  })
})

describe('零损失降级', () => {
  it('出票失败 → 裸 URL', async () => {
    asRoot()
    const { postJson } = makePost({ ticketFail: true })
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
  })
  it('平台回调拒绝 → 裸 URL 且不写缓存', async () => {
    asRoot()
    const { postJson } = makePost({ callbackFail: true })
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
    // 紧接着再试（这次成功）应全新出票，而不是复用失败票
    const ok = makePost({ ticketId: 'T-NEW' })
    const url = await exploreAutologinUrl(PAGE, { now, postJson: ok.postJson })
    expect(url).toContain('autologin=T-NEW')
  })
  it('根钥被锁（signWithRoot 返回 null）→ 裸 URL', async () => {
    asRoot()
    ;(signWithRoot as any).mockReturnValue(null)
    const { postJson } = makePost()
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
  })
  it('降级时同身份旧票可用（平台侧票死则落扫码页，零损失）', async () => {
    asRoot()
    const a = makePost({ ticketId: 'T-OLD' })
    await exploreAutologinUrl(PAGE, { now, postJson: a.postJson })
    now.mockReturnValue(1_000_000 + TICKET_WINDOW_MS * 5) // 旧票早过窗
    const b = makePost({ ticketFail: true })
    const url = await exploreAutologinUrl(PAGE, { now, postJson: b.postJson })
    expect(url).toContain('autologin=T-OLD')
  })
  it('无任何身份 → 裸 URL，零网络请求', async () => {
    const { postJson, calls } = makePost()
    expect(await exploreAutologinUrl(PAGE, { now, postJson })).toBe(PAGE)
    expect(calls.length).toBe(0)
  })
})
