/**
 * share-entry.test.ts — 分享卡形状与坐标提取（纯函数）。
 *
 * 2026-11-13：取票链整链删除后，本文件只锁**还活着的**契约：
 *   · `shareCardOf` 对平铺/嵌套/老卡（URL 兜底）三种形状的识别；
 *   · `actionShareCoords` 的 URL 解析边界。
 * 信封/票/回包收件箱/两条 provider 的测试随取票链一并删除（行为已不存在）。
 */
import { describe, it, expect } from 'vitest'
import { actionShareCoords, shareCardOf } from './share-entry'

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

