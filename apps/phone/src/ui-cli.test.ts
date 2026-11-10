// MD-002（2026-10-21）：ui 词表 —— agent 的 UI 感知+执行面（window.__mycoUi）
// 语义：ui state（感知）/ ui tab（切 tab）/ ui open-conv（打开会话）/ ui click-text（DOM 点击兜底）
// node 环境跑（与 cli.test.ts 同款）：手动挂 globalThis.window —— dispatch 执行期才读 window，
// beforeEach 里安装/卸载 mock 即可，不需要 jsdom。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { exec } from './cli'

type Rec = Record<string, unknown>

function installMockUi(overrides: Partial<Rec> = {}) {
  const impl = {
    chat: null as { id: string; title: string } | null,
    convRows: [
      { id: 'did:youling:z6MkOFFICIAL', title: '小灵', isGroup: false, unreadN: 1 },
      { id: 'grp-dev-x', title: '设备群', isGroup: true, unreadN: 0 },
    ],
    setChat: (_c: unknown) => {},
  }
  const g = globalThis as unknown as Rec
  g.window = {
    __mycoUi: {
      _view: 'agents',
      _impl: impl,
      state: () => ({ view: 'agents', convs: impl.convRows }),
      tab: (n: string) => (n === 'tasks' || n === 'agents' ? 'OK:' + n : 'ERR:bad-tab'),
      openConv: (q: string) => {
        const row = impl.convRows.find((r) => r.title === q || r.id === q)
        return row ? 'OK:' + row.id : 'ERR:no-conv:' + q
      },
      clickText: (t: string) => (t === '去补充说明' ? 'OK:clicked:' + t : 'ERR:no-element:' + t),
      ...overrides,
    },
  }
}

beforeEach(() => { installMockUi() })
afterEach(() => { delete (globalThis as unknown as Rec).window })

describe('MD-002 ui 词表（agent 双界面：感知+执行）', () => {
  it('ACC-UI-001 感知：ui state 返回 view/convs', async () => {
    const r = JSON.parse(await exec('ui state')) as { ok: boolean; data: { view: string } }
    expect(r.ok).toBe(true)
    expect(r.data.view).toBe('agents')
  })

  it('ACC-UI-002 执行：ui tab agents 切换成功', async () => {
    const r = JSON.parse(await exec('ui tab agents')) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    expect(r.data).toBe('OK:agents')
  })

  it('ACC-UI-003 执行：ui open-conv 按名字打开小灵会话', async () => {
    const r = JSON.parse(await exec('ui open-conv 小灵')) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    expect(r.data).toBe('OK:did:youling:z6MkOFFICIAL')
  })

  it('ACC-UI-004 执行：ui open-conv 按 convId 打开', async () => {
    const r = JSON.parse(await exec('ui open-conv did:youling:z6MkOFFICIAL')) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    expect(r.data).toBe('OK:did:youling:z6MkOFFICIAL')
  })

  it('ACC-UI-005 执行：ui click-text 点按钮', async () => {
    const r = JSON.parse(await exec('ui click-text 去补充说明')) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    expect(r.data).toBe('OK:clicked:去补充说明')
  })

  it('ACC-UI-006 错误面：无 __mycoUi / 未知子命令 / 不存在的会话都给 ERR', async () => {
    delete (globalThis as unknown as Rec).window // 先卸掉 mock：无 window → err
    const r1 = JSON.parse(await exec('ui state')) as { ok: boolean; err: string }
    expect(r1.ok).toBe(false)
    installMockUi()
    const r2 = JSON.parse(await exec('ui jump')) as { ok: boolean; err: string }
    expect(r2.ok).toBe(false)
    const r3 = JSON.parse(await exec('ui open-conv 不存在')) as { ok: boolean; err: string }
    expect(r3.ok).toBe(false)
    expect(r3.err).toContain('no-conv')
  })
})
