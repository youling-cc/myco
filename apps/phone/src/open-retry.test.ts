/**
 * open-retry.test.ts — 取票重试策略 + 人话文案（2026-10-12 实测反馈那一轮的锁）。
 *
 * 锁四件事：
 *   ① 只有瞬时原因（offline / 未知）自动重试；拒绝·过期·入口坏了**不重试**；
 *   ② 重试间隔是递增退避（不是死循环猛敲）；
 *   ③ 最终文案按场景分口径（中继没看到 / 中继不可达 / 设备连不上 / 名单外）；
 *   ④ 如实报告重试次数，且设备名缺失时有兜底。
 */
import { describe, it, expect } from 'vitest'
import {
  OPEN_RETRY_DELAYS_MS,
  isTransientOpenFailure,
  classifyOpenFailure,
  retryNote,
  finalOpenNote,
  retryTransient,
  pickHealTargets,
  withSourceDevice,
  waitUntil,
} from './open-retry'

describe('等就绪（身份/隧道；2026-10-16 冷启动真案）', () => {
  it('已经就绪 → 零等待、不 sleep', async () => {
    let slept = 0
    const r = await waitUntil(() => true, { timeoutMs: 1000, sleep: async () => { slept++ } })
    expect(r).toBe(0)
    expect(slept).toBe(0)
  })

  it('等一会儿才就绪 → 返回等了多久', async () => {
    let ready = false
    let n = 0
    const r = await waitUntil(() => ready, {
      timeoutMs: 1000,
      pollMs: 100,
      now: () => n * 100,
      sleep: async () => { n++; if (n >= 3) ready = true },
    })
    expect(r).toBe(300)
  })

  it('一直不就绪 → null（调用方据此说人话，不无限等）', async () => {
    let n = 0
    const r = await waitUntil(() => false, {
      timeoutMs: 300,
      pollMs: 100,
      now: () => n * 100,
      sleep: async () => { n++ },
    })
    expect(r).toBeNull()
  })
})

describe('重试策略', () => {
  it('退避递增、有上限（不是死循环猛敲）', () => {
    expect(OPEN_RETRY_DELAYS_MS.length).toBe(3)
    for (let i = 1; i < OPEN_RETRY_DELAYS_MS.length; i++) {
      expect(OPEN_RETRY_DELAYS_MS[i]).toBeGreaterThan(OPEN_RETRY_DELAYS_MS[i - 1])
    }
    // 合计（不含尝试本身耗时）够设备重启/中继重注册缓过来，又短到用户愿意等
    const sum = OPEN_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThanOrEqual(4000)
    expect(sum).toBeLessThanOrEqual(10000)
  })

  it('只有瞬时原因重试；拒绝/过期/入口坏了不重试', () => {
    expect(isTransientOpenFailure('offline')).toBe(true)
    expect(isTransientOpenFailure(undefined)).toBe(true)
    expect(isTransientOpenFailure('denied')).toBe(false)
    expect(isTransientOpenFailure('expired')).toBe(false)
    expect(isTransientOpenFailure('no-entry')).toBe(false)
    expect(isTransientOpenFailure('unsupported')).toBe(false)
  })
})

describe('重试循环（retryTransient，注入 sleep → 零等待直测）', () => {
  const ok = { ok: true as const }
  const bad = (reason: string) => ({ ok: false as const, reason })

  it('一趟就成：不睡眠、不报进度', async () => {
    const slept: number[] = []
    const notes: string[] = []
    const r = await retryTransient(async () => ok, {
      delays: OPEN_RETRY_DELAYS_MS,
      isTransient: (v) => !v.ok,
      onRetry: (n) => notes.push(String(n)),
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(r.value).toEqual(ok)
    expect(r.attempts).toBe(1)
    expect(slept).toEqual([])
    expect(notes).toEqual([])
  })

  it('前两趟瞬时失败、第三趟成功：按退避等两次、进度报 2/4→3/4', async () => {
    const slept: number[] = []
    const notes: string[] = []
    let n = 0
    const r = await retryTransient(async () => (++n < 3 ? bad('offline') : ok), {
      delays: OPEN_RETRY_DELAYS_MS,
      isTransient: (v) => !v.ok,
      onRetry: (next, total) => notes.push(`${next}/${total}`),
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(r.value).toEqual(ok)
    expect(r.attempts).toBe(3)
    expect(slept).toEqual([OPEN_RETRY_DELAYS_MS[0], OPEN_RETRY_DELAYS_MS[1]])
    expect(notes).toEqual(['2/4', '3/4'])
  })

  it('一直瞬时失败：跑满 4 趟（3 次退避）后收摊，不无限重试', async () => {
    const slept: number[] = []
    let calls = 0
    const r = await retryTransient(async () => { calls++; return bad('offline') }, {
      delays: OPEN_RETRY_DELAYS_MS,
      isTransient: (v) => !v.ok,
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(calls).toBe(4)
    expect(r.attempts).toBe(4)
    expect(slept).toEqual([...OPEN_RETRY_DELAYS_MS])
    expect(r.value).toEqual(bad('offline'))
  })

  it('非瞬时失败（被判无权限）：第一趟就收摊——不让用户白等 6 秒', async () => {
    const slept: number[] = []
    let calls = 0
    const r = await retryTransient(async () => { calls++; return bad('denied') }, {
      delays: OPEN_RETRY_DELAYS_MS,
      isTransient: (v) => v.reason === 'offline',
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(calls).toBe(1)
    expect(r.attempts).toBe(1)
    expect(slept).toEqual([])
  })
})

describe('失败口径归类', () => {
  it('中继里没这台设备 → relay-missing（"等一下就好"）', () => {
    expect(classifyOpenFailure('对方设备不在线（云端中转无此设备）')).toBe('relay-missing')
    expect(classifyOpenFailure('NOT_FOUND')).toBe('relay-missing')
  })

  it('中继本身连不上 → relay-unreachable（"看看手机网络"）', () => {
    expect(classifyOpenFailure('云端中转服务器不可达（myco.youling.cc:8321）：connect timeout')).toBe('relay-unreachable')
    expect(classifyOpenFailure('连不上云端中转——先看看手机网络再点一次')).toBe('relay-unreachable')
  })

  it('中继卡槽满 / 通道没接上 / 本机签名没过 —— 三种各归各的（别再塌成"不在线"）', () => {
    expect(classifyOpenFailure('对方设备的云端通道忙，稍后再试')).toBe('relay-busy')
    expect(classifyOpenFailure('BUSY')).toBe('relay-busy')
    expect(classifyOpenFailure('云端中转忙（源设备的并发通道已满），过几秒再点一次')).toBe('relay-busy')
    expect(classifyOpenFailure('对方设备没接上云端通道，稍后再试')).toBe('relay-unavailable')
    expect(classifyOpenFailure('UNAVAILABLE')).toBe('relay-unavailable')
    expect(classifyOpenFailure('本机身份还没就绪，签名没通过——重启一次 myco 再点')).toBe('auth')
    expect(classifyOpenFailure('身份未就绪')).toBe('auth')
  })

  it('设备连不上（手机/PC 两套措辞都认）→ device-unreachable', () => {
    expect(classifyOpenFailure('DESKTOP-KJS1H2L暂时连不上，稍后再试')).toBe('device-unreachable')
    expect(classifyOpenFailure('源设备不在线（或那台设备没有可直连的地址），稍后再试')).toBe('device-unreachable')
    expect(classifyOpenFailure('笔记本不在线（没有可连接的地址），稍后再试')).toBe('device-unreachable')
  })

  it('名单外/被拒 → denied（文案原样透出，不改写）', () => {
    expect(classifyOpenFailure('你不在这个任务的授权名单里')).toBe('denied')
  })
})

describe('文案', () => {
  it('重试进度带次数与设备名', () => {
    expect(retryNote('DESKTOP-KJS1H2L', 2, 4)).toBe('「DESKTOP-KJS1H2L」暂时连不上，正在重试…（第 2/4 次）')
    expect(retryNote('', 3, 4)).toContain('对方设备')
  })

  it('最终文案：中继没看到那台设备 —— 不冤枉设备、给下一步', () => {
    const s = finalOpenNote({ deviceName: 'DESKTOP-KJS1H2L', message: '对方设备不在线（云端中转无此设备）', reason: 'offline', attempts: 4 })
    expect(s).toContain('云端中转里暂时没看到「DESKTOP-KJS1H2L」')
    expect(s).toContain('已自动重试 3 次')
    expect(s).toContain('再点一次')
    expect(s).not.toContain('不在线（或那台设备没有可直连的地址）') // 不再甩那句冤枉话
  })

  it('最终文案：中继不可达 —— 指向手机网络', () => {
    const s = finalOpenNote({ deviceName: 'PC', message: '云端中转服务器不可达（myco.youling.cc:8321）：timeout', reason: 'offline', attempts: 2 })
    expect(s).toContain('连不上云端中转')
    expect(s).toContain('手机网络')
  })

  it('最终文案：设备连不上 —— 说"可能刚重启/在切网"', () => {
    const s = finalOpenNote({ deviceName: '', message: '源设备不在线（或那台设备没有可直连的地址），稍后再试', reason: 'offline', attempts: 4 })
    expect(s).toContain('「对方设备」暂时连不上')
    expect(s).toContain('刚重启')
  })

  it('最终文案：中继卡槽满 —— 说"过几秒再点"，不甩设备不在线', () => {
    const s = finalOpenNote({
      deviceName: 'OFFICE-PC',
      message: '云端中转忙（源设备的并发通道已满），过几秒再点一次',
      reason: 'offline',
      attempts: 4,
    })
    expect(s).toContain('云端中转忙')
    expect(s).toContain('「OFFICE-PC」')
    expect(s).toContain('已自动重试 3 次')
    expect(s).not.toContain('不在线')
  })

  it('最终文案：本机身份没就绪 —— 指到"重启一次 myco"（真案：解冻后第一次点卡）', () => {
    const s = finalOpenNote({
      deviceName: 'OFFICE-PC',
      message: '本机身份还没就绪，签名没通过——重启一次 myco 再点',
      reason: 'offline',
      attempts: 1,
    })
    expect(s).toContain('身份还没就绪')
    expect(s).toContain('myco')
  })

  it('非瞬时失败：文案一字不改（拒绝理由必须原样到达用户）', () => {
    const raw = '你不在这个任务的授权名单里，找发起人要一次授权'
    expect(finalOpenNote({ deviceName: 'PC', message: raw, reason: 'denied', attempts: 1 })).toBe(raw)
    expect(finalOpenNote({ deviceName: 'PC', message: raw, reason: 'expired', attempts: 1 })).toBe(raw)
  })

  it('名册三态（2026-10-12 二版）：不信口开河，各给各的下一步', () => {
    const msg = 'OFFICE-PC暂时连不上，稍后再试'
    // 不在名册 = 记录已失效（真机那张旧卡的形状：来源 OFFICE-PC 早换过绑定）→ 让对方重发
    const gone = finalOpenNote({ deviceName: 'OFFICE-PC', message: msg, reason: 'offline', attempts: 4, source: 'gone' })
    expect(gone).toContain('已经不在你的设备名册里了')
    expect(gone).toContain('让对方重新分享一次')
    expect(gone).not.toContain('刚重启') // 别再给"等一下就好"的错误暗示
    // 离线 → 等它开机
    expect(finalOpenNote({ deviceName: 'PC', message: msg, reason: 'offline', attempts: 4, source: 'offline' }))
      .toContain('当前离线')
    // 在线却连不上 → 网络/瞬时（用户那句"设备明明在线"就是这个）
    expect(finalOpenNote({ deviceName: 'PC', message: msg, reason: 'offline', attempts: 4, source: 'online' }))
      .toContain('在线但连不上')
    // 查不到名册（好友的卡）→ 不乱下结论
    expect(finalOpenNote({ deviceName: 'PC', message: msg, reason: 'offline', attempts: 4, source: 'unknown' }))
      .toContain('暂时连不上')
  })

  it('只跑一趟就成（attempts=1）时不提重试次数', () => {
    const s = finalOpenNote({ deviceName: 'PC', message: 'PC 暂时连不上，稍后再试', reason: 'offline', attempts: 1 })
    expect(s).not.toContain('重试')
  })
})

describe('旧卡自愈（2026-10-12 三版）', () => {
  const src = 'did:myco:OFFICEPC'
  const me = 'did:myco:PHONE'
  const roster = [
    { did: src, name: 'OFFICE-PC', online: false, revoked: false }, // 卡上的死记录（连名册都没有它才是 gone）
    { did: me, name: 'phone', online: true, revoked: false }, // 本机：不该问自己
    { did: 'did:myco:DESKTOP', name: 'DESKTOP-KJS1H2L', online: true, revoked: false },
    { did: 'did:myco:OFFLINE', name: '笔记本', online: false, revoked: false }, // 离线：问了白等
    { did: 'did:myco:REVOKED', name: '旧设备', online: true, revoked: true }, // 已吊销：不算成员
    { did: 'did:myco:LAPTOP', name: 'laptop-cjfan', online: true, revoked: false },
    { did: 'did:myco:EXTRA', name: '第四台', online: true, revoked: false },
  ]

  it('只挑在册+在线+非本机+非原设备，且默认上限 3 台', () => {
    const got = pickHealTargets(roster, src, me)
    expect(got.map((t) => t.did)).toEqual(['did:myco:DESKTOP', 'did:myco:LAPTOP', 'did:myco:EXTRA'])
    expect(got[0].name).toBe('DESKTOP-KJS1H2L')
  })

  it('一台在线的都没有 → 空（不去问离线设备白等超时）', () => {
    expect(pickHealTargets([{ did: 'x', online: false }, { did: me, online: true }], src, me)).toEqual([])
  })

  it('换了来源设备：只动 sourceDevice/sourceDeviceName，别的字段一字不改', () => {
    const flat = withSourceDevice({ shareId: 'sh-1', sourceDevice: src, sourceDeviceName: 'OFFICE-PC', title: 'T' }, 'did:myco:D', 'DESKTOP')
    expect(flat).toEqual({ shareId: 'sh-1', sourceDevice: 'did:myco:D', sourceDeviceName: 'DESKTOP', title: 'T' })
    const nested = withSourceDevice({ payload: { a: 1 }, card: { shareId: 'sh-1', sourceDevice: src, title: 'T' } }, 'did:myco:D', 'DESKTOP')
    expect(nested.card).toEqual({ shareId: 'sh-1', sourceDevice: 'did:myco:D', title: 'T', sourceDeviceName: 'DESKTOP' })
    expect((nested as { payload: unknown }).payload).toEqual({ a: 1 })
    // 名字缺省时保留原名字（别把卡上的显示名抹成 undefined）
    const keep = withSourceDevice({ shareId: 'sh-1', sourceDevice: src, sourceDeviceName: 'OFFICE-PC' }, 'did:myco:D')
    expect((keep as { sourceDeviceName?: string }).sourceDeviceName).toBe('OFFICE-PC')
  })

  it('原对象不被就地改写（React 状态里的卡不能被动过）', () => {
    const raw = { shareId: 'sh-1', sourceDevice: src }
    const out = withSourceDevice(raw, 'did:myco:D', 'X')
    expect((raw as { sourceDevice: string }).sourceDevice).toBe(src)
    expect(out).not.toBe(raw)
  })
})

// ═══ 2026-10-20 R11：僵尸任务卡（分享已停止）═══
describe('R11 僵尸任务卡：分享已停止不可重试', () => {
  it('isTransientOpenFailure("gone") === false（重试不会变好）', () => {
    expect(isTransientOpenFailure('gone')).toBe(false)
  })
  it('classifyOpenFailure 识别"已不在/已停止分享"', () => {
    expect(classifyOpenFailure('这个任务在那台设备上已经不在了（可能已停止分享）')).toBe('share-gone')
    expect(classifyOpenFailure('分享已停止')).toBe('share-gone')
  })
  it('finalOpenNote 对 gone 原样透出人话（不加"已自动重试"）', () => {
    const note = finalOpenNote({ message: '这个分享已经停止（卡片已自动清理），不用再试', reason: 'gone', attempts: 1 })
    expect(note).toContain('卡片已自动清理')
    expect(note).not.toContain('已自动重试')
  })
})
