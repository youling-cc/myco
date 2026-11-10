/**
 * appendHistory 有序插入回归（2026-09-05 用户实测"气泡顺序错乱"根修）：
 * 打开任务的装配序 = 急拉 12 条（最新段）→ 完整页 N 条。append 语义曾无脑接尾，
 * 完整页去重剩下的更早消息排在最新段之后 → 数组 [最新段, 更早段]，
 * 渲染 reverse 后上半区完全倒序。钉住：append 分支必须按 timestamp 归位。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useBeliefStore } from './belief-store'
import type { ChatMessage } from './transport'

const msg = (i: number, role: 'user' | 'assistant' = 'user'): ChatMessage => ({
  role,
  text: `m${i}`,
  timestamp: new Date(Date.UTC(2026, 8, 5, 0, 0, i)).toISOString(),
  uuid: `u${i}`,
} as unknown as ChatMessage)

const sid = 'term-test'
const ensure = () => {
  useBeliefStore.setState((s) => ({
    beliefs: {
      ...s.beliefs,
      [sid]: {
        sessionId: sid, taskId: 't', messages: [], historyTotal: 0,
        historyLoadedFrom: 0, historyHasMore: false, pending: null, conn: 'online',
        interactive: false, agents: [], picker: null, todos: null,
        appState: null, fineState: null, appType: null, approval: null,
        hintAction: null, tokensUsed: null,
      },
    },
  }))
}

describe('appendHistory 有序插入', () => {
  beforeEach(ensure)

  it('急拉最新段后，完整页的更早消息按时间归位（乱序根修主场景）', () => {
    const st = useBeliefStore.getState()
    // 急拉：jsonl 尾部 12 条（m23..m34），时间正序
    st.appendHistory(sid, { messages: Array.from({ length: 12 }, (_, k) => msg(23 + k)), total: 34, count: 12 }, false)
    // 完整页：全量 34 条，uuid 去重后 fresh = m1..m22
    st.appendHistory(sid, { messages: Array.from({ length: 34 }, (_, k) => msg(1 + k)), total: 34, count: 34 }, false)
    const got = useBeliefStore.getState().beliefs[sid].messages
    expect(got.map((m) => m.text)).toEqual(Array.from({ length: 34 }, (_, k) => `m${k + 1}`))
  })

  it('实时增量（比已有都新）仍走尾部快路径', () => {
    const st = useBeliefStore.getState()
    st.appendHistory(sid, { messages: [msg(1), msg(2)], total: 2, count: 2 }, false)
    st.appendHistory(sid, { messages: [msg(3)], total: 3, count: 3 }, false)
    const got = useBeliefStore.getState().beliefs[sid].messages
    expect(got.map((m) => m.text)).toEqual(['m1', 'm2', 'm3'])
  })

  it('prepend（上滑加载更早）整段接头部不变', () => {
    const st = useBeliefStore.getState()
    st.appendHistory(sid, { messages: [msg(5), msg(6)], total: 8, count: 2 }, false)
    st.appendHistory(sid, { messages: [msg(3), msg(4)], total: 8, count: 2 }, true)
    const got = useBeliefStore.getState().beliefs[sid].messages
    expect(got.map((m) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6'])
  })

  it('无 timestamp 的消息保持尾部追加（实时语义兼容）', () => {
    const st = useBeliefStore.getState()
    st.appendHistory(sid, { messages: [msg(1), msg(2)], total: 2, count: 2 }, false)
    st.appendHistory(sid, { messages: [{ role: 'user', text: 'echo', uuid: 'e1' } as unknown as ChatMessage], total: 3, count: 1 }, false)
    const got = useBeliefStore.getState().beliefs[sid].messages
    expect(got.map((m) => m.text)).toEqual(['m1', 'm2', 'echo'])
  })
})
