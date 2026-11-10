/**
 * share-entry.test.ts — 「取票」环节：wire 形状、回包路由、两条 provider 的择优。
 *
 * 这里锁的是**与 PC 端 `dsh_share.rs` 的字节级契约**：
 *   · request  payload 的四个字段名与顺序语义；
 *   · grant    payload 的 ok/mt/expiresAt/gwPort/error；
 *   · 入口 URL `http://127.0.0.1:<port>/gw/<id>/?mt=…`。
 * 谁改了字段名，PC 那边就静默不认——所以这几条必须是红的起点。
 */
import { describe, it, expect } from 'vitest'
import {
  EntryError,
  _resetEntryInboxForTest,
  actionShareCoords,
  awaitGrant,
  buildLocalEntryUrl,
  cancelGrantWait,
  deliverShareEntryGrant,
  entryControlEnvelope,
  newRequestId,
  parseEntryUrl,
  parseGrant,
  requestShareEntry,
  shareCardOf,
  shareEntryRequestPayload,
  shareEntryRequestWire,
  syncReplyMatches,
  type ShareCard,
} from './share-entry'

const CARD: ShareCard = {
  shareId: 'sh-abc123',
  sourceDevice: 'did:myco:zPcDevice',
  sourceDeviceName: '办公室的电脑',
  sourceAccount: 'did:youling:zAcct',
  title: '重构分享网关',
}

describe('任务卡识别（shareCardOf）', () => {
  it('有 shareId + sourceDevice + 账号 → 成卡', () => {
    const c = shareCardOf({
      shareId: 'sh-1',
      sourceDevice: 'did:myco:zPc',
      sourceAccount: 'did:youling:zA',
      sourceDeviceName: '我的电脑',
      title: 'T',
    })
    expect(c).toEqual({
      shareId: 'sh-1',
      sourceDevice: 'did:myco:zPc',
      sourceAccount: 'did:youling:zA',
      sourceDeviceName: '我的电脑',
      title: 'T',
    })
  })

  it('普通好友任务卡（无 shareId/sourceDevice）→ null（走原详情页，不误判）', () => {
    expect(shareCardOf({ taskId: 't1', title: 'x', from: 'did:youling:zB' })).toBeNull()
    expect(shareCardOf({ shareId: 'sh-1' })).toBeNull()
    expect(shareCardOf(null)).toBeNull()
  })

  it('设备群广播形状（卡片嵌在 payload.card + members[0] 是账号 did）→ 也认', () => {
    const c = shareCardOf({
      groupId: 'grp-dev-x',
      groupName: '我的设备',
      members: ['did:youling:zAcct'],
      status: 'todo',
      fromName: '我的电脑',
      card: {
        shareId: 'sh-nested',
        sourceDevice: 'did:myco:zPc',
        sourceDeviceName: '办公室的电脑',
        title: '嵌套卡',
      },
    })
    expect(c).toEqual({
      shareId: 'sh-nested',
      sourceDevice: 'did:myco:zPc',
      sourceAccount: 'did:youling:zAcct',
      sourceDeviceName: '办公室的电脑',
      title: '嵌套卡',
    })
  })

  it('账号缺 sourceAccount 时退化用 from（PC 端 card 记录的兜底字段）', () => {
    const c = shareCardOf({ shareId: 'sh-1', sourceDevice: 'did:myco:zPc', from: 'did:youling:zA' })
    expect(c?.sourceAccount).toBe('did:youling:zA')
  })

  // ═══ 2026-10-10 真机事故：真实广播/同步链的卡顶层缺 sourceDevice（只有
  // sourceDeviceName），但 action.url 带着同样坐标 —— 顶层缺失从 URL 兜底，老卡兼容 ═══

  it('顶层三坐标全缺、只有 action.url（remoteOpen 全坐标）→ 也从 URL 抠齐成卡', () => {
    const c = shareCardOf({
      taskId: 'peer-task-share-sh-x1',
      title: '只有 URL 的卡',
      sourceDeviceName: 'DESKTOP-X',
      action: {
        kind: 'open-url',
        url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-x1&device=did:myco:zPc&account=did:youling:zA',
      },
    })
    expect(c).toEqual({
      shareId: 'sh-x1',
      sourceDevice: 'did:myco:zPc',
      sourceAccount: 'did:youling:zA',
      sourceDeviceName: 'DESKTOP-X',
      title: '只有 URL 的卡',
    })
  })

  it('顶层有 shareId 但缺 sourceDevice → 从 action.url 的 device= 补上', () => {
    const c = shareCardOf({
      shareId: 'sh-x2',
      sourceDeviceName: 'DESKTOP-X',
      from: 'did:youling:zA',
      action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-x2&device=did:myco:zPc&account=did:youling:zA' },
    })
    expect(c?.sourceDevice).toBe('did:myco:zPc')
    expect(c?.sourceAccount).toBe('did:youling:zA')
  })

  it('嵌套卡（payload.card）顶层缺 sourceDevice → 同样从 card.action.url 兜底', () => {
    const c = shareCardOf({
      groupId: 'grp-dev-x',
      members: ['did:youling:zAcct'],
      status: 'todo',
      fromName: '办公室的电脑',
      card: {
        shareId: 'sh-x3',
        sourceDeviceName: '办公室的电脑',
        title: '嵌套缺设备卡',
        action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-x3&device=did:myco:zPc&account=did:youling:zAcct' },
      },
    })
    expect(c?.sourceDevice).toBe('did:myco:zPc')
    expect(c?.sourceAccount).toBe('did:youling:zAcct')
  })

  it('URL 里 percent 编码的值会解码；顶层字段优先于 URL（不覆盖）', () => {
    const c = shareCardOf({
      shareId: 'sh-top',
      sourceDevice: 'did:myco:zTop',
      sourceAccount: 'did:youling:zTop',
      action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-x4&device=did%3Amyco%3AzPc&account=did%3Ayouling%3AzA' },
    })
    expect(c?.shareId).toBe('sh-top')
    expect(c?.sourceDevice).toBe('did:myco:zTop')
    expect(c?.sourceAccount).toBe('did:youling:zTop')
  })

  it('顶层缺字段但 URL 也不带坐标（源设备 /open 只有 shareId）→ 仍 null，不给假入口', () => {
    // 手机里存的源设备原版卡：action.url=/open?shareId=…（无 device/account）——
    // 顶层有 sourceDevice/sourceAccount 才成卡（回归：真机现卡就是这个形状）
    expect(
      shareCardOf({
        shareId: 'sh-x5',
        action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-x5' },
      }),
    ).toBeNull()
    const ok = shareCardOf({
      shareId: 'sh-x5',
      sourceDevice: 'did:myco:zPc',
      sourceAccount: 'did:youling:zA',
      action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-x5' },
    })
    expect(ok?.sourceDevice).toBe('did:myco:zPc')
  })

  it('actionShareCoords：fragment 先切、空值跳过、无 action 得空', () => {
    expect(
      actionShareCoords({
        action: { kind: 'open-url', url: 'http://h/x?shareId=&device=did:myco:zPc&account=did:youling:zA#frag' },
      }),
    ).toEqual({ shareId: '', device: 'did:myco:zPc', account: 'did:youling:zA' })
    expect(actionShareCoords({ action: { kind: 'remote' } })).toEqual({ shareId: '', device: '', account: '' })
    expect(actionShareCoords({})).toEqual({ shareId: '', device: '', account: '' })
    expect(actionShareCoords(null)).toEqual({ shareId: '', device: '', account: '' })
  })
})

describe('request 的 wire 形状（逐字对齐 dsh_share.rs:8088）', () => {
  it('四个字段，名字不能改', () => {
    const p = shareEntryRequestPayload(CARD, 'ser-deadbeef', 'did:myco:zPhone', 'did:youling:zAcct')
    expect(Object.keys(p)).toEqual(['shareId', 'requestId', 'requesterDevice', 'requesterAccount'])
    expect(p).toEqual({
      shareId: 'sh-abc123',
      requestId: 'ser-deadbeef',
      requesterDevice: 'did:myco:zPhone',
      requesterAccount: 'did:youling:zAcct',
    })
  })

  it('requestId 形状 ser-<24hex>（与 PC rand_hex(24) 同形）', () => {
    const id = newRequestId()
    expect(id).toMatch(/^ser-[0-9a-f]{24}$/)
    expect(id).not.toBe(newRequestId())
  })
})

describe('grant 解析（逐字对齐 dsh_share.rs:8128-8143）', () => {
  const now = 1_700_000_000_000

  it('ok:true → mt/expiresAt/gwPort 齐活', () => {
    const e = parseGrant(
      { shareId: 'sh-abc123', requestId: 'ser-1', ok: true, mt: 'MT', expiresAt: now + 180_000, gwPort: 13911 },
      'sh-abc123',
      now,
    )
    expect(e.mt).toBe('MT')
    expect(e.gwPort).toBe(13911)
    expect(e.via).toBe('control-message')
  })

  it('缺 gwPort → 回落 PC 默认网关端口 13911', () => {
    const e = parseGrant({ ok: true, mt: 'MT', expiresAt: now + 1000 }, 'sh-abc123', now)
    expect(e.gwPort).toBe(13911)
  })

  it('ok:false → 把源设备给的人话原样透出（那是给用户看的）', () => {
    let err: unknown
    try {
      parseGrant({ ok: false, error: '你不在这个任务的授权名单里' }, 'sh-abc123', now)
    } catch (e) {
      err = e
    }
    expect((err as EntryError).message).toBe('你不在这个任务的授权名单里')
    expect((err as EntryError).reason).toBe('denied')
  })

  it('ok:false 且没说理由 → 有兜底人话（不吐内部术语）', () => {
    let err: unknown
    try {
      parseGrant({ ok: false }, 'sh-abc123', now)
    } catch (e) {
      err = e
    }
    expect((err as EntryError).message).toContain('拒绝了')
    expect((err as EntryError).message.toLowerCase()).not.toContain('tunnel')
  })

  it('shareId 对不上 → 拒绝（张冠李戴闸）', () => {
    expect(() => parseGrant({ shareId: 'sh-other', ok: true, mt: 'M' }, 'sh-abc123', now)).toThrowError(/对不上/)
  })

  it('已过期 → expired（不乱用）', () => {
    let err: unknown
    try {
      parseGrant({ ok: true, mt: 'M', expiresAt: now - 1 }, 'sh-abc123', now)
    } catch (e) {
      err = e
    }
    expect((err as EntryError).reason).toBe('expired')
  })

  it('ok:true 但没 mt → no-entry', () => {
    expect(() => parseGrant({ ok: true, expiresAt: now + 1000 }, 'sh-abc123', now)).toThrowError(/入口凭证/)
  })

  it('离线类理由归类为 offline（UI 据此决定"稍后重试"）', () => {
    let err: unknown
    try {
      parseGrant({ ok: false, error: '源设备不在线' }, 'sh-abc123', now)
    } catch (e) {
      err = e
    }
    expect((err as EntryError).reason).toBe('offline')
  })
})

describe('入口 URL（remoteOpen 的 302 Location）', () => {
  it('抠出 mt 与网关端口，并校验 shareId 命中', () => {
    const e = parseEntryUrl('http://127.0.0.1:13911/gw/sh-abc123/?mt=Zm9v', 'sh-abc123')
    expect(e.mt).toBe('Zm9v')
    expect(e.gwPort).toBe(13911)
    expect(e.via).toBe('broker')
  })

  it('别的 share 的地址 → 拒绝', () => {
    expect(() => parseEntryUrl('http://127.0.0.1:13911/gw/sh-other/?mt=x', 'sh-abc123')).toThrowError(/对不上/)
  })

  it('没 mt → 拒绝', () => {
    expect(() => parseEntryUrl('http://127.0.0.1:13911/gw/sh-abc123/', 'sh-abc123')).toThrowError(/凭证/)
  })

  it('本机地址带本地端口拼得对（手机真正打开的那一串）', () => {
    const u = buildLocalEntryUrl(52341, CARD, 'a+b/c=')
    expect(u).toBe('http://127.0.0.1:52341/gw/sh-abc123/?mt=a%2Bb%2Fc%3D')
  })
})

describe('回包收件箱（deliverShareEntryGrant 的归属闸）', () => {
  it('唤醒在等的请求并解析票', async () => {
    _resetEntryInboxForTest()
    const p = awaitGrant('ser-1', 'sh-abc123', 'did:youling:zAcct', { timeoutMs: 5000 })
    const ok = deliverShareEntryGrant({
      from: 'did:youling:zAcct',
      payload: { shareId: 'sh-abc123', requestId: 'ser-1', ok: true, mt: 'MT', expiresAt: Date.now() + 60_000, gwPort: 13911 },
    })
    expect(ok).toBe(true)
    const e = await p
    expect(e.mt).toBe('MT')
  })

  it('requestId 不是本机在等的 → 静默丢弃（不给探测者当放大器）', () => {
    _resetEntryInboxForTest()
    expect(deliverShareEntryGrant({ from: 'x', payload: { requestId: 'nobody', ok: true, mt: 'M' } })).toBe(true)
  })

  it('shareId 对不上 → 唤醒但以"对不上"拒绝', async () => {
    _resetEntryInboxForTest()
    const p = awaitGrant('ser-2', 'sh-abc123', 'did:youling:zAcct', { timeoutMs: 5000 })
    deliverShareEntryGrant({
      from: 'did:youling:zAcct',
      payload: { shareId: 'sh-OTHER', requestId: 'ser-2', ok: true, mt: 'M' },
    })
    await expect(p).rejects.toThrowError(/对不上/)
  })

  it('来源账号对不上 → 同样拒绝（防他机代答）', async () => {
    _resetEntryInboxForTest()
    const p = awaitGrant('ser-3', 'sh-abc123', 'did:youling:zAcct', { timeoutMs: 5000 })
    deliverShareEntryGrant({
      from: 'did:youling:zStranger',
      payload: { shareId: 'sh-abc123', requestId: 'ser-3', ok: true, mt: 'M' },
    })
    await expect(p).rejects.toThrowError(/对不上/)
  })

  it('等不到 → 人话超时（不吐术语）', async () => {
    _resetEntryInboxForTest()
    const p = awaitGrant('ser-4', 'sh-abc123', 'did:youling:zAcct', { timeoutMs: 20 })
    await expect(p).rejects.toThrowError(/没有回应/)
    cancelGrantWait('ser-4')
    _resetEntryInboxForTest()
  })
})

describe('两条 provider 的择优（requestShareEntry）', () => {
  const base = { card: CARD, myAccount: 'did:youling:zAcct', myDevice: 'did:myco:zPhone' }

  it('★ 同步回程：回包在 HTTP 响应体里 → 一次往返拿票（不等回推、不转兜底）', async () => {
    _resetEntryInboxForTest()
    const sent: { kind: string; payload: Record<string, unknown>; requestId: string }[] = []
    let brokerCalled = false
    const entry = await requestShareEntry({
      ...base,
      controlWaitMs: 5000,
      sendControl: async (kind, payload, requestId) => {
        sent.push({ kind, payload, requestId })
        // 源设备把回包挂进 POST /p2p/msg 的响应体（与 PC 端 msg_ok_body 同形）
        return {
          delivered: true,
          reply: {
            shareId: CARD.shareId,
            requestId,
            ok: true,
            mt: 'MT-SYNC',
            expiresAt: Date.now() + 180_000,
            gwPort: 13911,
          },
        }
      },
      broker: async () => {
        brokerCalled = true
        throw new Error('不该走到兜底')
      },
    })
    expect(entry.mt).toBe('MT-SYNC')
    expect(entry.via).toBe('control-sync')
    expect(entry.gwPort).toBe(13911)
    expect(brokerCalled).toBe(false)
    // 请求 wire：spec 四字段 + syncReply 开关（字段名一个字不改）
    expect(sent[0].kind).toBe('share-entry-request')
    expect(Object.keys(sent[0].payload)).toEqual([
      'shareId',
      'requestId',
      'requesterDevice',
      'requesterAccount',
      'syncReply',
    ])
    expect(sent[0].payload.syncReply).toBe(true)
    expect(sent[0].payload.requesterDevice).toBe('did:myco:zPhone')
    _resetEntryInboxForTest()
  })

  it('同步回包里 requestId 对不上 → 不认这张票（张冠李戴），转兜底', async () => {
    _resetEntryInboxForTest()
    const entry = await requestShareEntry({
      ...base,
      controlWaitMs: 30,
      sendControl: async () => ({
        delivered: true,
        reply: { shareId: CARD.shareId, requestId: 'ser-别人的', ok: true, mt: 'MT-STOLEN', expiresAt: Date.now() + 60_000 },
      }),
      broker: async () => ({ mt: 'MT-B', expiresAt: 0, gwPort: 13911, via: 'broker' }),
    })
    expect(entry.mt).toBe('MT-B')
    _resetEntryInboxForTest()
  })

  it('同步回包是人话拒绝 → 透出那句人话（不误当票）', async () => {
    _resetEntryInboxForTest()
    let err: unknown
    try {
      await requestShareEntry({
        ...base,
        controlWaitMs: 30,
        randId: () => 'ser-rej',
        sendControl: async () => ({
          delivered: true,
          reply: { shareId: CARD.shareId, requestId: 'ser-rej', ok: false, error: '你不在这个任务的授权名单里' },
        }),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EntryError)
    expect((err as EntryError).message).toBe('你不在这个任务的授权名单里')
  })

  it('A 送达但响应体里没有回包（老桌面端）→ 回落 P2P 回推等待，再转兜底', async () => {
    _resetEntryInboxForTest()
    const logs: string[] = []
    const entry = await requestShareEntry({
      ...base,
      controlWaitMs: 30,
      onLog: (l) => logs.push(l),
      // 老写法：裸 boolean（没有同步回包）
      sendControl: async () => true,
      broker: async () => ({ mt: 'MT-B', expiresAt: 0, gwPort: 13912, via: 'broker' }),
    })
    expect(entry.mt).toBe('MT-B')
    expect(entry.via).toBe('broker')
    expect(entry.gwPort).toBe(13912)
    expect(logs.join('\n')).toContain('兜底')
  })

  it('A 送达且老桌面端把回包推回来了 → 仍然用 A（回推路径不被改坏）', async () => {
    _resetEntryInboxForTest()
    const entry = await requestShareEntry({
      ...base,
      controlWaitMs: 2000,
      sendControl: async (kind, payload, requestId) => {
        queueMicrotask(() =>
          deliverShareEntryGrant({
            from: CARD.sourceAccount,
            payload: { shareId: CARD.shareId, requestId, ok: true, mt: 'MT-PUSH', expiresAt: Date.now() + 60_000, gwPort: 13911 },
          }),
        )
        void kind
        void payload
        return true
      },
      broker: async () => {
        throw new Error('不该走到兜底')
      },
    })
    expect(entry.mt).toBe('MT-PUSH')
    expect(entry.via).toBe('control-message')
    _resetEntryInboxForTest()
  })

  it('A 根本发不出去（对方无可直连地址）→ 立刻转兜底，不白等', async () => {
    _resetEntryInboxForTest()
    const t0 = Date.now()
    const entry = await requestShareEntry({
      ...base,
      controlWaitMs: 5000,
      sendControl: async () => false,
      broker: async () => ({ mt: 'MT-B', expiresAt: 0, gwPort: 13911, via: 'broker' }),
    })
    expect(entry.mt).toBe('MT-B')
    expect(Date.now() - t0).toBeLessThan(500) // 没等满 5s
  })

  it('两条都失败 → 抛 EntryError，且优先给"最具体"的那句人话', async () => {
    _resetEntryInboxForTest()
    let err: unknown
    try {
      await requestShareEntry({
        ...base,
        controlWaitMs: 20,
        sendControl: async () => true,
        broker: async () => {
          throw new EntryError('denied', '你不在这个任务的授权名单里')
        },
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EntryError)
    expect((err as EntryError).message).toBe('你不在这个任务的授权名单里')
    const m = (err as EntryError).message
    for (const bad of ['tunnel', 'p2p', 'mt', '端口']) expect(m.toLowerCase()).not.toContain(bad.toLowerCase())
  })

  it('没有 sendControl（不在 P2P 可达面）时直接走兜底', async () => {
    const entry = await requestShareEntry({
      ...base,
      broker: async () => ({ mt: 'MT-B', expiresAt: 0, gwPort: 13911, via: 'broker' }),
    })
    expect(entry.mt).toBe('MT-B')
  })
})

describe('同步回程的 wire 契约（phone ↔ PC 两侧字段名锁死）', () => {
  it('shareEntryRequestWire = spec 四字段 + syncReply（字段名一个字不改）', () => {
    const w = shareEntryRequestWire(CARD, 'ser-1', 'did:myco:zPhone', 'did:youling:zAcct')
    expect(Object.keys(w)).toEqual(['shareId', 'requestId', 'requesterDevice', 'requesterAccount', 'syncReply'])
    expect(w.syncReply).toBe(true)
  })

  it('信封形状与手机既有 buildEnvelope 同键（PC 适配层按这些键取值）', () => {
    const env = entryControlEnvelope(
      { account: 'did:youling:zA', device: 'did:myco:zP', name: '我', deviceName: 'myco-phone' },
      'did:youling:zA',
      'share-entry-request',
      { shareId: 'sh-1' },
      'se-1',
      123,
    )
    expect(Object.keys(env)).toEqual(['msgId', 'from', 'fromName', 'fromDevice', 'fromDeviceName', 'to', 'kind', 'payload', 'ts'])
    expect(env.fromDevice).toBe('did:myco:zP')
    expect(env.kind).toBe('share-entry-request')
  })

  it('syncReplyMatches：空 = 宽容（老端没回填），不一致 = 拒', () => {
    expect(syncReplyMatches({ requestId: 'ser-1' }, 'ser-1')).toBe(true)
    expect(syncReplyMatches({}, 'ser-1')).toBe(true)
    expect(syncReplyMatches({ requestId: 'ser-2' }, 'ser-1')).toBe(false)
  })
})
