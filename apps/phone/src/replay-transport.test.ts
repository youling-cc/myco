import { describe, expect, it } from 'vitest'
import { parseSensorCorpus, ReplayTransport } from './transport'

const CORPUS = [
  { kind: 'header', v: 2, session: 's1', cwd: 'D:/x', harness: 'claude-code', createdAt: '2026-08-17T00:00:00Z' },
  { kind: 'sensor', source: 'terminal', at: '2026-08-17T00:00:01Z', payload: { cursorX: 1, cursorY: 2, lines: ['a', 'b'] } },
  { kind: 'sensor', source: 'user_input', at: '2026-08-17T00:00:02Z', payload: { text: 'hi' } },
  { kind: 'sensor', source: 'event_out', at: '2026-08-17T00:00:02Z', payload: { kind: 'input_echo', sessionId: 's1', text: 'hi', atMs: 2 } },
  { kind: 'sensor', source: 'event_out', at: '2026-08-17T00:00:03Z', payload: { kind: 'message', sessionId: 's1', message: { role: 'user', text: 'hi' }, atMs: 3 } },
  'corrupt line {',
  { kind: 'sensor', source: 'terminal', at: '2026-08-17T00:00:04Z', payload: { cursorX: 5, cursorY: 6, lines: ['a', 'b', 'c'] } },
  { kind: 'sensor', source: 'event_out', at: '2026-08-17T00:00:05Z', payload: { kind: 'state', sessionId: 's1', appState: 'working', fineState: 'generating', atMs: 5 } },
].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')

describe('parseSensorCorpus', () => {
  it('解析 header/事件/帧,容忍坏行', () => {
    const c = parseSensorCorpus(CORPUS)
    expect(c.header.session).toBe('s1')
    expect(c.header.harness).toBe('claude-code')
    expect(c.events.map((e) => e.kind)).toEqual(['input_echo', 'message', 'state'])
    expect(c.frames).toHaveLength(2)
    expect(c.frames[1].lines).toEqual(['a', 'b', 'c'])
    expect(c.inputs).toBe(1)
  })
})

describe('ReplayTransport', () => {
  it('screen 取时刻前的最近帧', () => {
    const t = new ReplayTransport(parseSensorCorpus(CORPUS))
    const s = t.screen(Date.parse('2026-08-17T00:00:03Z'))
    expect(s.lines).toEqual(['a', 'b'])
    expect(t.screen().lines).toEqual(['a', 'b', 'c'])
    expect(t.session().sessionId).toBe('s1')
  })

  it('pump 全量喂入且不丢', async () => {
    const got: string[] = []
    const t = new ReplayTransport(parseSensorCorpus(CORPUS), { speed: 1000 })
    const n = await t.pump((e) => { got.push(String(e.kind)) })
    expect(n).toBe(3)
    expect(got).toEqual(['input_echo', 'message', 'state'])
  })
})

describe('parseSensorCorpus 管道语料归一（2026-09-09 回放渲染修复）', () => {
  const PIPE_CORPUS = [
    JSON.stringify({ kind: 'header', v: 2, session: 'proj-x', cwd: 'D:/x', harness: 'claude-pipe', createdAt: '2026-09-09T00:00:00Z' }),
    JSON.stringify({ kind: 'sensor', source: 'event_out', at: '2026-09-09T00:00:01Z', payload: { type: 'system', subtype: 'init', session_id: 'abc' } }),
    JSON.stringify({ kind: 'sensor', source: 'event_out', at: '2026-09-09T00:00:02Z', payload: { type: 'user', message: { role: 'user', content: '你好任务' } } }),
    JSON.stringify({ kind: 'sensor', source: 'event_out', at: '2026-09-09T00:00:03Z', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收到，' }, { type: 'text', text: '开始工作' }] } } }),
    JSON.stringify({ kind: 'sensor', source: 'event_out', at: '2026-09-09T00:00:04Z', payload: { type: 'result', subtype: 'success' } }),
  ].join('\n')

  it('claude 协议事件归一为可渲染 message/state（kind 存在）', () => {
    const c = parseSensorCorpus(PIPE_CORPUS)
    expect(c.events).toHaveLength(4)
    expect(c.events.every((e) => typeof (e as Record<string, unknown>).kind === 'string')).toBe(true)
    const msgs = c.events.filter((e) => (e as Record<string, unknown>).kind === 'message') as Array<{ message?: { role?: string; text?: string } }>
    expect(msgs).toHaveLength(3) // user + assistant + result
    expect(msgs[0].message?.text).toBe('你好任务')
    expect(msgs[1].message?.text).toBe('收到，开始工作') // content 数组拼接
    expect(msgs[2].message?.text).toContain('回合完成')
  })

  it('已是 ObservationEvent 的事件不被改写', () => {
    const corpus = [
      JSON.stringify({ kind: 'header', v: 2 }),
      JSON.stringify({ kind: 'sensor', source: 'event_out', at: '2026-09-09T00:00:01Z', payload: { kind: 'message', message: { role: 'user', text: '原生' } } }),
    ].join('\n')
    const c = parseSensorCorpus(corpus)
    expect((c.events[0] as Record<string, unknown>).kind).toBe('message')
  })
})
