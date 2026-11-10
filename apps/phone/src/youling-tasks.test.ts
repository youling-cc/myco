/**
 * youling-tasks.test.ts — ENV 感知面解析与降级单测（第88轮）。
 *
 * 覆盖三层：
 *   ① parse 层多字段名兜底（API 部署前字段名未定，snake/camel 双形态都吃得下）；
 *   ② accuracy 归一（0-1 小数 → 百分比）；
 *   ③ fetch 降级路径：无账号锚 → no-account；SPA fallback（200+text/html）→ not-ready；
 *      正常 JSON → 解析（node 环境 stub localStorage 注入假 vault 提供账号锚）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseYoulingTasks,
  parseMyResume,
  fetchYoulingTasks,
  youlingTaskUrl,
  YOULING_BASE,
} from './youling-tasks'

// ── parseYoulingTasks：多形态/多字段名 ──

describe('parseYoulingTasks', () => {
  it('裸数组 + snake_case 字段兜底（task_id/title/sla/pending_count/answered_today）', () => {
    const out = parseYoulingTasks([
      { task_id: 't1', title: '图片标注', sla: '2h', pending_count: 12, answered_today: 34 },
    ])
    expect(out).toEqual([{
      taskId: 't1', title: '图片标注', slaText: '2h',
      pendingCount: 12, answeredToday: 34, url: `${YOULING_BASE}/task/t1`,
    }])
  })

  it('data 包裹 + tasks 键 + camelCase 字段 + 服务端自带 url', () => {
    const out = parseYoulingTasks({ code: 0, data: { tasks: [{ taskId: 't2', name: '语音转写', url: 'http://x/t2' }] } })
    expect(out).toHaveLength(1)
    expect(out[0].taskId).toBe('t2')
    expect(out[0].title).toBe('语音转写')
    expect(out[0].url).toBe('http://x/t2')
  })

  it('无 id 的行丢弃；字符串数字转数值；第91轮 title 兜底=task_id（不再"未命名任务"）', () => {
    const out = parseYoulingTasks([
      { title: '没有 id' },
      { id: 't3', pendingCount: '7' },
    ])
    expect(out).toEqual([{
      taskId: 't3', title: 't3', slaText: undefined,
      pendingCount: 7, answeredToday: undefined, url: `${YOULING_BASE}/task/t3`,
    }])
  })

  it('空对象/非数组输入 → 空列表（不抛）', () => {
    expect(parseYoulingTasks(null)).toEqual([])
    expect(parseYoulingTasks({ data: null })).toEqual([])
    expect(parseYoulingTasks({ foo: 1 })).toEqual([])
  })
})

// ── 第91轮：三态卡形态（真实 API /env/worker/{did}/tasks）——已领取过滤 ──

describe('parseYoulingTasks 三态卡（modes 投影）', () => {
  /** 未领取的三态卡（真实 47 条题池的典型形态：my_claim=null/my_assigned=0/my_answered=0） */
  const unclaimed = {
    task_id: 'POOL-1', task_type_id: 'tt-1',
    modes: {
      practice: { available: true, pool_size: 100, my_answered: 0, claim: 'open_to_all' },
      exam: { available: true, pool_size: 3198, my_answered: 0, claim: 'open_to_all_round_dedup' },
      production: { available: true, pool_size: 208455, open_items: 5, my_assigned: 0, my_claim: null, claim: 'match_dispatched' },
    },
  }

  it('未领取条目全部过滤（47 条题池只剩已领取——第91轮产品定稿）', () => {
    expect(parseYoulingTasks({ topic: 'x', did: 'd', tasks: [unclaimed], mode_matrix: {}, notes: [] })).toEqual([])
  })

  it('my_claim 登记 → 进列表；name 缺失回退 task_id；role 从 my_claim 提取；threshold 宽容解析', () => {
    const out = parseYoulingTasks({ tasks: [{
      task_id: 'COLONY-1',
      modes: { production: { available: true, open_items: 5, my_assigned: 3, my_claim: { capacity_per_day: 10, role: 'verifier' }, claim: 'match_dispatched' } },
      profile_filter: { gateThreshold: 0.8 },
    }] })
    expect(out).toEqual([{
      taskId: 'COLONY-1', title: 'COLONY-1', slaText: undefined,
      pendingCount: 3, answeredToday: undefined,
      url: `${YOULING_BASE}/task/COLONY-1`,
      mode: 'production', threshold: 0.8, role: 'verifier',
    }])
  })

  it('exam my_answered>0 视为参与进列表（practice 恒 0 不误纳）；服务端 name 优先', () => {
    const out = parseYoulingTasks({ tasks: [{
      task_id: 'EX-1', name: '货柜巡检',
      modes: {
        practice: { available: true, pool_size: 100, my_answered: 0 },
        exam: { available: true, pool_size: 10, my_answered: 4 },
        production: { available: false, open_items: 0, my_assigned: 0, my_claim: null },
      },
      task_threshold: 75,
    }] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ taskId: 'EX-1', title: '货柜巡检', mode: 'exam', answeredToday: 4, threshold: 75 })
  })
})

// ── parseMyResume：键名兜底 + accuracy 归一 + 第91轮 abilities ──

describe('parseMyResume', () => {
  it('data 包裹 + resume 键兜底 + skill/skillName 键', () => {
    const r = parseMyResume({ data: { resume: [{ skill: '标注', alpha: 8, beta: 2 }], total_answered: 40, task_count: 5 } })
    expect(r?.skills).toEqual([{ name: '标注', alpha: 8, beta: 2, score: undefined }])
    expect(r?.totalAnswered).toBe(40)
    expect(r?.taskCount).toBe(5)
  })

  it('accuracy 0-1 小数归一为百分比；已是百分比原样保留', () => {
    expect(parseMyResume({ accuracy: 0.87 })?.accuracy).toBe(87)
    expect(parseMyResume({ accuracy: 87 })?.accuracy).toBe(87)
    expect(parseMyResume({ accuracy: 1 })?.accuracy).toBe(100)
  })

  it('非对象输入 → null；缺 α/β 记 0', () => {
    expect(parseMyResume(null)).toBeNull()
    expect(parseMyResume('x')).toBeNull()
    expect(parseMyResume({ skills: [{}] })?.skills[0]).toEqual({ name: '技能', alpha: 0, beta: 0, score: undefined })
  })

  it('第91轮：真实 resume 信封内 abilities（role/mean/α/β/ci95 数组形态）+ 全局门槛', () => {
    const r = parseMyResume({ topic: 'x', did: 'd', resume: {
      derived: { by_role: { executor: { tasks: 3 } }, kappa: 12 },
      abilities: [{ role: 'executor', mean: 0.72, alpha: 8, beta: 2, ci95: [0.65, 0.78] }],
      gate_threshold: 0.8,
    } })
    expect(r?.abilities).toEqual([{ role: 'executor', mean: 0.72, alpha: 8, beta: 2, ci95: [0.65, 0.78] }])
    expect(r?.gateThreshold).toBe(0.8)
    // abilities 兜底成 skills 行（既有 MyResume 视图零改动可用）
    expect(r?.skills).toEqual([{ name: 'executor', alpha: 8, beta: 2 }])
  })

  it('第91轮：ci95 对象形态 {lower,upper}；abilities 在 derived 内也吃', () => {
    const r = parseMyResume({ resume: { derived: { abilities: [{ role: 'verifier', mean: 0.5, alpha: 1, beta: 1, ci95: { lower: 0.2, upper: 0.9 } }] } } })
    expect(r?.abilities[0].ci95).toEqual([0.2, 0.9])
  })

  it('第91轮：无 abilities → 空数组（能力卡走空态文案）', () => {
    expect(parseMyResume({ resume: { derived: { kappa: 0 } } })?.abilities).toEqual([])
  })
})

// ── fetch 路径：降级分类（stub localStorage 注入假账号锚）──

/** Map 型 localStorage stub（identity.lsGet 运行时取全局 localStorage，可动态注入 vault）。 */
function stubLs(items: Record<string, string> = {}): void {
  const m = new Map(Object.entries(items))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  })
}

const FAKE_VAULT = JSON.stringify({ mode: 'plain', rootDid: 'did:youling:testaaa' })

describe('fetchYoulingTasks 降级', () => {
  beforeEach(() => { stubLs({ 'youling.vault': FAKE_VAULT }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('SPA fallback（200 + text/html）→ not-ready（ENV 未部署的实测形态）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    })))
    await expect(fetchYoulingTasks()).rejects.toMatchObject({ kind: 'not-ready' })
  })

  it('正常 JSON → 解析出任务', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 0, data: { tasks: [{ taskId: 't9', title: '验收', slaText: '4h' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const ts = await fetchYoulingTasks()
    expect(ts).toHaveLength(1)
    expect(ts[0].title).toBe('验收')
    // 打到的 URL 带 did 路径段（did 的 ":" 经 encodeURIComponent → %3A，路径段安全）
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain(`/env/worker/${encodeURIComponent('did:youling:testaaa')}/tasks`)
  })

  it('网络异常 → network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(fetchYoulingTasks()).rejects.toMatchObject({ kind: 'network' })
  })

  it('无账号锚（vault 空）→ no-account，且不发请求', async () => {
    stubLs() // 空 localStorage = 未关联有灵账号
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(fetchYoulingTasks()).rejects.toMatchObject({ kind: 'no-account' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('youlingTaskUrl', () => {
  it('按 /task/{id} 约定拼落地页（与 TaskLinkCard 链接格式一致）', () => {
    expect(youlingTaskUrl('abc-1')).toBe(`${YOULING_BASE}/task/abc-1`)
  })
})
