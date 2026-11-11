/**
 * shareVisibility 单测——§3.22 schema 驱动最容易翻车的四件事：
 * 值类型（数字/数组/缺 label）、联动隐藏（dependsOn 四种写法）、
 * 只读项回写（selectable:false 不许被带偏）、手填会话（分隔/去重）。
 * 全部纯函数，无 DOM、无 Tauri——vitest 在 node 环境下直接跑。
 */
import { describe, it, expect } from 'vitest'
import {
  buildVisibility, buildVisibilityPayload, depOk, splitSessionIds, visApplySessionCwds, visAsList,
  visCeilingLabel, visCeilings, visDisplayItems, visDraftFrom, visEq, visFilterSessionsByProjects,
  visGrantDirty, visGrantPayload, visGrantStart, visItemVisible, visNotNarrowed, visPathKey,
  visPathParent, visPathTail, visPathUnder, visProjectsOf, visSamePath, visScopeLabel,
  visSessionCwdsOf, visSessionCwdOf, visSessionInProjects, visShortId, visTouched, visValueOf,
  visWindowValue, VIS_PROJECT_TIER_LABEL, VIS_WIDE,
  type VisItem, type VisOption, type Visibility,
} from './shareVisibility'

/** 后端实际会给的 schema（§3.22.2 样例的忠实复刻 + 会话多选 + 时长单选）。 */
const ITEMS: VisItem[] = [
  {
    id: 'space', label: '可见范围', kind: 'enum', default: 'machine', selectable: true,
    options: [
      { value: 'machine', label: '我的全部（整机）' },
      { value: 'project', label: '只这一个项目' },
      { value: 'session', label: '只指定会话' },
    ],
  },
  {
    id: 'sessions', label: '可见哪些会话', kind: 'multi', default: [], selectable: true,
    source: 'sessions', dependsOn: { id: 'space', equals: 'session' },
  },
  {
    id: 'windowMs', label: '能看到多久以前的内容', kind: 'enum', default: 21600000, selectable: true,
    options: [
      { value: 3600000, label: '最近 1 小时' },
      { value: 21600000, label: '最近 6 小时' },
      { value: null, label: '不限（全部历史）' },
    ],
  },
]

const CUR: Visibility = { space: 'machine', sessions: ['s-1'], windowMs: 21600000 }

describe('visEq / visAsList · 值归一', () => {
  it('数字与字符串同型比较（schema 的 value 未必是字符串）', () => {
    expect(visEq(3600000, '3600000')).toBe(true)
    expect(visEq(null, '')).toBe(true)
    expect(visEq('machine', 'session')).toBe(false)
  })
  it('多选值归一：数组去空 / 单值当一元 / 空值空表', () => {
    expect(visAsList(['a', '', 'b'])).toEqual(['a', 'b'])
    expect(visAsList('a')).toEqual(['a'])
    expect(visAsList(null)).toEqual([])
  })
})

describe('visValueOf · 草稿 → 当前值 → 默认值', () => {
  it('三层优先级', () => {
    expect(visValueOf(ITEMS[0], CUR, { space: 'session' })).toBe('session') // 草稿优先
    expect(visValueOf(ITEMS[0], CUR, {})).toBe('machine')                   // 当前值
    expect(visValueOf(ITEMS[2], { sessions: [] }, {})).toBe(21600000)       // 当前缺 → 默认
  })
})

describe('depOk · dependsOn 四种写法', () => {
  const val = (id: string) => (id === 'space' ? 'session' : undefined)
  it('{id, equals}', () => {
    expect(depOk({ id: 'space', equals: 'session' }, val)).toBe(true)
    expect(depOk({ id: 'space', equals: 'machine' }, val)).toBe(false)
  })
  it('{item, in:[…]} 与 {field, value}', () => {
    expect(depOk({ item: 'space', in: ['project', 'session'] }, val)).toBe(true)
    expect(depOk({ item: 'space', in: ['machine'] }, val)).toBe(false)
    expect(depOk({ field: 'space', value: 'session' }, val)).toBe(true)
  })
  it('{id, not} 反条件', () => {
    expect(depOk({ id: 'space', not: 'machine' }, val)).toBe(true)
    expect(depOk({ id: 'space', not: 'session' }, val)).toBe(false)
  })
  it('直接映射 {space:"session"} + 数组=全满足', () => {
    expect(depOk({ space: 'session' }, val)).toBe(true)
    expect(depOk({ space: 'machine' }, val)).toBe(false)
    expect(depOk([{ space: 'session' }, { space: 'session' }], val)).toBe(true)
    expect(depOk([{ space: 'session' }, { space: 'machine' }], val)).toBe(false)
  })
  it('解析不出形状 → 视为满足（宁可多显示一项，不可藏起用户配置）', () => {
    expect(depOk(undefined, val)).toBe(true)
    expect(depOk('session', val)).toBe(true)
    expect(depOk({}, val)).toBe(true)
  })
})

describe('visItemVisible · 联动隐藏（space≠session 时"可见哪些会话"不显示）', () => {
  it('space=session → 显示；space=machine/project → 不显示', () => {
    const v = (space: string) => (id: string) => (id === 'space' ? space : undefined)
    expect(visItemVisible(ITEMS[1], v('session'))).toBe(true)
    expect(visItemVisible(ITEMS[1], v('machine'))).toBe(false)
    expect(visItemVisible(ITEMS[1], v('project'))).toBe(false)
  })
  it('没有 dependsOn 的项恒显示', () => {
    expect(visItemVisible(ITEMS[0], () => undefined)).toBe(true)
  })
})

describe('visDraftFrom / visTouched · 草稿与脏标记', () => {
  it('当前值优先、缺项回默认', () => {
    expect(visDraftFrom(CUR, ITEMS)).toEqual({ space: 'machine', sessions: ['s-1'], windowMs: 21600000 })
    expect(visDraftFrom({}, ITEMS)).toEqual({ space: 'machine', sessions: [], windowMs: 21600000 })
    expect(visDraftFrom(null, null)).toEqual({})
  })
  it('改动才置脏', () => {
    const base = visDraftFrom(CUR, ITEMS)
    expect(visTouched(base, { ...base })).toBe(false)
    expect(visTouched(base, { ...base, space: 'project' })).toBe(true)
  })
})

describe('buildVisibility · 回写体（默认项不许被带偏）', () => {
  it('按草稿覆盖，同时保住 current 的形状', () => {
    const draft = { ...visDraftFrom(CUR, ITEMS), space: 'session', sessions: ['s-1', 's-2'] }
    expect(buildVisibility(CUR, ITEMS, draft)).toEqual({ space: 'session', sessions: ['s-1', 's-2'], windowMs: 21600000 })
  })
  it('selectable:false 的项回默认值（用户改不动，篡改草稿也带不偏）', () => {
    const locked: VisItem[] = [{ ...ITEMS[0], selectable: false }]
    const d = { space: 'session' }
    expect(buildVisibility({ ...CUR, space: 'machine' }, locked, d).space).toBe('machine')
    expect(buildVisibility({}, locked, d).space).toBe('machine') // current 缺 → 用 default
  })
  it('多选归一成字符串数组（后端少给一层/给单值都不炸）', () => {
    const draft = { ...visDraftFrom(CUR, ITEMS), space: 'session', sessions: 's-9' }
    expect(buildVisibility(CUR, ITEMS, draft).sessions).toEqual(['s-9'])
  })
  it('时长不合法 → null（后端语义：不限），合法数字原样', () => {
    const draft = { ...visDraftFrom(CUR, ITEMS), windowMs: 'soon' }
    expect(buildVisibility(CUR, ITEMS, draft).windowMs).toBeNull()
    expect(buildVisibility(CUR, ITEMS, { ...draft, windowMs: 3600000 }).windowMs).toBe(3600000)
  })
  it('草稿里没有的项 → 不动原值', () => {
    expect(buildVisibility(CUR, ITEMS, {})).toEqual(CUR)
  })
})

describe('splitSessionIds / visShortId · 手填退化路径', () => {
  it('逗号/顿号/分号/空白都算分隔，去空去重保序', () => {
    expect(splitSessionIds(' a , b\n c、d；a ')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitSessionIds('   ')).toEqual([])
  })
  it('短标签只给尾巴（全文另附 title）', () => {
    expect(visShortId('sess_0123456789abcdef')).toBe('…89abcdef')
    expect(visShortId('short')).toBe('short')
  })
})

/** §3.20 逐人：跟着主设备/账号走——同一份值铺到他所有设备行，界面按账号一行配。 */
describe('visNotNarrowed · 继承与全宽都算"没有额外限制"', () => {
  it('没配（null/undefined）→ 没有额外限制', () => {
    expect(visNotNarrowed(null)).toBe(true)
    expect(visNotNarrowed(undefined)).toBe(true)
  })
  it('全宽的一份（= 后端默认）→ 没有额外限制（逐人只能收紧 ⇒ 效果 ≡ 继承）', () => {
    expect(visNotNarrowed(VIS_WIDE)).toBe(true)
    expect(visNotNarrowed({ space: 'machine', sessions: ['s-1'], windowMs: null })).toBe(true) // 非会话态下白名单不生效
    expect(visNotNarrowed({ space: 'project', sessions: [], windowMs: null })).toBe(true)
  })
  it('真收窄了才算：会话白名单（space=session 且非空）或时间窗', () => {
    expect(visNotNarrowed({ space: 'session', sessions: ['s-1'], windowMs: null })).toBe(false)
    expect(visNotNarrowed({ space: 'session', sessions: [], windowMs: null })).toBe(true) // 空白名单 = 不额外限制
    expect(visNotNarrowed({ space: 'machine', sessions: [], windowMs: 3600000 })).toBe(false)
    expect(visNotNarrowed({ space: 'machine', sessions: [], windowMs: 'x' })).toBe(true) // 坏值不当限制
  })
})

describe('visScopeLabel · 人话摘要（只出 schema 的 label，不吐内部值）', () => {
  it('继承了/全宽了 → 「跟随整体范围」；没给这句 → 主项默认 label', () => {
    expect(visScopeLabel(null, ITEMS, '跟随整体范围')).toBe('跟随整体范围')
    expect(visScopeLabel(VIS_WIDE, ITEMS, '跟随整体范围')).toBe('跟随整体范围')
    expect(visScopeLabel(VIS_WIDE, ITEMS)).toBe('我的全部（整机） · 不限（全部历史）') // 这份 fixture 的默认是 6 小时
  })
  it('收窄到会话 → 主项 label + 选了几个；再窄的时间另说', () => {
    expect(visScopeLabel({ space: 'session', sessions: ['s-1', 's-2'], windowMs: 21600000 }, ITEMS))
      .toBe('只指定会话（2）')
    expect(visScopeLabel({ space: 'session', sessions: ['s-1'], windowMs: 3600000 }, ITEMS))
      .toBe('只指定会话（1） · 最近 1 小时')
    expect(visScopeLabel({ space: 'session', sessions: ['s-1'], windowMs: null }, ITEMS))
      .toBe('只指定会话（1） · 不限（全部历史）') // 也偏离了这份 schema 的默认（6 小时）
  })
  it('时间项等于自身默认值时不啰嗦；非默认才追加', () => {
    expect(visScopeLabel({ space: 'session', sessions: ['s-1'], windowMs: 21600000 }, ITEMS))
      .toBe('只指定会话（1）') // windowMs 默认就是这个值
  })
  it('schema 认不出 → 只给项名/兜底，绝不回落到原始值', () => {
    const raw: Visibility = { space: 'session', sessions: ['s-9'], windowMs: 60000 }
    for (const s of [visScopeLabel(raw, null), visScopeLabel(raw, []), visScopeLabel(null, null)]) {
      expect(s).not.toMatch(/space|session|windowMs|s-9|60000/)
      expect(s.length).toBeGreaterThan(0)
    }
    expect(visScopeLabel(raw, [{ id: 'space', label: '可见范围', kind: 'enum' }])).toBe('可见范围（1）')
  })
})

/** `sessions` 带候选清单的那一版 schema（后端把本机会话读进 options；清单读不到时没有 options）。 */
const OPTS: VisItem[] = ITEMS.map((it) => it.id !== 'sessions' ? it : {
  ...it,
  options: [
    { value: 's-1', label: '登录器好友列表' },
    { value: 's-2', label: '画布项目' },
    { value: 's-3', label: '发版脚本' },
  ],
})

/** 天花板表 → 「点不动的可选项取值」集合（单测只关心"哪些被挡"，不锁顺序）。 */
const blocked = (ceil: Record<string, { disabled: { value: unknown }[] }>, id: string): unknown[] =>
  (ceil[id]?.disabled ?? []).map((d) => d.value)

describe('visWindowValue · 时间窗取值（null 是合法值，不是"没给"）', () => {
  it('数字/ null / 认不出', () => {
    expect(visWindowValue(21600000)).toBe(21600000)
    expect(visWindowValue(null)).toBeNull()
    expect(visWindowValue('soon')).toBeUndefined()
    expect(visWindowValue(undefined)).toBeUndefined()
  })
})

describe('visCeilings · 逐人编辑器的整体天花板（能选的 = 整体 ∩ 这一层）', () => {
  const val = (v: unknown) => () => v
  it('① 整体=只指定会话 → 只有「只指定会话」可点，整机/项目被灰', () => {
    const ceil = visCeilings({ space: 'session', sessions: ['s-1', 's-2', 's-3'], windowMs: null }, val('session'), ITEMS)
    expect(blocked(ceil, 'space')).toEqual(['machine', 'project'])
    expect(ceil.windowMs.disabled).toEqual([]) // 整体不限历史 ⇒ 时间上没天花板
    expect(ceil.sessions.disabled).toEqual([]) // 没有候选项清单 ⇒ 不逐值挡（值本身会被判整块）
    expect(visCeilings({ space: 'session', sessions: ['s-1', 's-2', 's-3'], windowMs: null }, val('session'), OPTS)
      .sessions.disabled).toEqual([]) // 整体给的 3 个会话都在白名单里 ⇒ 都可勾
  })
  it('② 整体=整机 + 6 小时 → 只有 ≤6 小时的可点（6 小时本身可点），1 天/7 天/全部历史被灰', () => {
    const ceil = visCeilings({ space: 'machine', sessions: [], windowMs: 21600000 }, val('machine'), ITEMS)
    expect(blocked(ceil, 'windowMs')).toEqual([null])            // fixture 里比 6 小时宽的只有"不限（全部历史）"
    expect(blocked(ceil, 'windowMs')).not.toContain(21600000)     // 等于天花板的那一档可点
    expect(ceil.space.disabled).toEqual([])                       // 整机最宽 ⇒ 空间上没天花板
    // 用户口径那张表里的三档都摆上：6 小时是天花板本身可点，1 天/7 天/全部历史不可点。
    const W: VisItem = {
      id: 'windowMs', label: '能看到多久以前的内容', kind: 'enum', default: 21600000,
      options: [
        { value: 3600000, label: '最近 1 小时' }, { value: 21600000, label: '最近 6 小时' },
        { value: 86400000, label: '最近 1 天' }, { value: 604800000, label: '最近 7 天' },
        { value: null, label: '不限（全部历史）' },
      ],
    }
    const c2 = visCeilings({ space: 'machine', sessions: [], windowMs: 21600000 }, val(21600000), [W])
    expect(blocked(c2, 'windowMs')).toEqual([86400000, 604800000, null])
    expect(c2.windowMs.disabled.map((d) => d.title)).toEqual([
      '整体只看到「最近 6 小时」以内，这里不能放宽',
      '整体只看到「最近 6 小时」以内，这里不能放宽',
      '整体只看到「最近 6 小时」以内，这里不能放宽',
    ])
  })
  it('③ 整体=某个项目 → 整机被灰，「只这一个项目」与「只指定会话」都可点（同级不算放宽）', () => {
    const ceil = visCeilings({ space: 'project', sessions: [], windowMs: null }, val('project'), ITEMS)
    expect(blocked(ceil, 'space')).toEqual(['machine'])
    expect(ceil.windowMs.disabled).toEqual([])
  })
  it('④ 整体=整机 + 不限历史（allVisible，没有天花板）→ 全部可选，现状不变', () => {
    const ceil = visCeilings(VIS_WIDE, val('machine'), OPTS)
    expect(blocked(ceil, 'space')).toEqual([])
    expect(blocked(ceil, 'windowMs')).toEqual([])
    expect(blocked(ceil, 'sessions')).toEqual([])
    expect(visCeilings(null, val(undefined), OPTS)).toEqual({ space: { disabled: [], locked: false, lockedTitle: '' }, sessions: { disabled: [], locked: false, lockedTitle: '' }, windowMs: { disabled: [], locked: false, lockedTitle: '' } })
  })
  it('⑤ 整体会话白名单 = 上限：白名单外的候选项被灰，白名单内的可勾可取消', () => {
    const ceil = visCeilings({ space: 'session', sessions: ['s-1', 's-2'], windowMs: null }, val('session'), OPTS)
    expect(blocked(ceil, 'sessions')).toEqual(['s-3'])
    expect(ceil.sessions.disabled[0].title).toBe('整体没开放这个，这里不能放宽')
    // 白名单为空 = 不额外限制（后端 restricts_sessions 同口径）⇒ 候选项全可选
    const none = visCeilings({ space: 'session', sessions: [], windowMs: null }, val('session'), OPTS)
    expect(blocked(none, 'sessions')).toEqual([])
    // 清单读不到（没有 options）且整体限定了会话 → items 为空，界面按建表结果退化只读 + 不渲染（见下）
    expect(visCeilings({ space: 'session', sessions: ['s-1'], windowMs: null }, val('s-1'), ITEMS).sessions.disabled).toEqual([])
  })
  it('⑥ 清单读不到的退化项：整体限定了会话 → 连"直接填会话编号"也收；整体没限 → 照旧手填', () => {
    const narrow = visCeilings({ space: 'session', sessions: ['s-1'], windowMs: null }, val(''), ITEMS)
    expect(narrow.sessions.locked).toBe(true)
    expect(narrow.sessions.lockedTitle).toBe('整体没开放这个，这里不能放宽')
    const wide = visCeilings({ space: 'session', sessions: [], windowMs: null }, val(''), ITEMS)
    expect(wide.sessions.locked).toBe(false)
  })
  it('⑦ 灰项说明是人话：不吐 space/windowMs/machine/session 这类内部词', () => {
    const cases: Visibility[] = [
      { space: 'session', sessions: ['s-1'], windowMs: null },
      { space: 'machine', sessions: [], windowMs: 21600000 },
      { space: 'project', sessions: [], windowMs: 3600000 },
    ]
    for (const c of cases) {
      const ceil = visCeilings(c, val(undefined), OPTS)
      const texts = Object.values(ceil).flatMap((x) => x.disabled.map((d) => d.title))
      for (const t of texts) {
        expect(t).not.toMatch(/space|windowMs|machine|session|s-1|21600000/)
        expect(t.length).toBeGreaterThan(0)
      }
    }
  })
  it('⑧ 只挡认识的三个维度；别的项（schema 以后加）不猜语义、不误伤', () => {
    const extra: VisItem[] = [...ITEMS, { id: 'caps', label: '能力', kind: 'enum', options: [{ value: 'all', label: '全给' }] }]
    const ceil = visCeilings({ space: 'session', sessions: ['s-1'], windowMs: 3600000 }, val('all'), extra)
    expect(ceil.caps).toBeUndefined()
    // 整体值认不出（不是能证明更宽的数值）→ 不挡（宁可漏挡，不可误挡）
    expect(visCeilings({ space: 'machine', sessions: [], windowMs: 'soon' }, val(21600000), ITEMS).windowMs.disabled).toEqual([])
    // 整体值缺失（未配置的分享）→ 空间侧按最宽算：没有比"整机"更宽的东西可挡
    expect(visCeilings({}, val('machine'), ITEMS).space.disabled).toEqual([])
  })
})

describe('visCeilingLabel · 整体基线那一行的人话', () => {
  it('会话个数写成「N 个」，其余项取 label，拼成一句话', () => {
    expect(visCeilingLabel({ space: 'session', sessions: ['s-1'], windowMs: 21600000 }, ITEMS))
      .toBe('只指定会话（1 个） · 最近 6 小时')
    expect(visCeilingLabel({ space: 'session', sessions: ['s-1', 's-2', 's-3'], windowMs: null }, ITEMS))
      .toBe('只指定会话（3 个） · 不限（全部历史）')
    expect(visCeilingLabel(VIS_WIDE, ITEMS)).toBe('我的全部（整机） · 不限（全部历史）')
    expect(visCeilingLabel({ space: 'project', sessions: [], windowMs: 21600000 }, ITEMS))
      .toBe('只这一个项目 · 最近 6 小时')
  })
  it('认不出的项跳过；一整项都认不出 → 沿用摘要的人话兜底，绝不落到原始值', () => {
    expect(visCeilingLabel({ space: 'machine', sessions: [], windowMs: 12345 }, ITEMS)).toBe('我的全部（整机）')
    expect(visCeilingLabel(null, ITEMS)).not.toMatch(/space|windowMs|machine|session/)
    expect(visCeilingLabel({ space: 'session', sessions: ['s-9'], windowMs: 60000 }, null).length).toBeGreaterThan(0)
    for (const s of [visCeilingLabel(null, ITEMS), visCeilingLabel({ space: 'session', sessions: ['s-9'], windowMs: 60000 }, null)]) {
      expect(s).not.toMatch(/space|windowMs|machine|session|s-9|60000/)
    }
  })
})

describe('visGrantPayload / visGrantStart · 逐人回写体与起手值', () => {
  it('did 随 payload 走（后端从 payload 读 did = 写该人，铺到他所有设备行）', () => {
    const p = visGrantPayload({ space: 'session', sessions: ['s-1'], windowMs: null }, ' did:myco:d1 ')
    expect(p).toEqual({ space: 'session', sessions: ['s-1'], windowMs: null, did: 'did:myco:d1' })
  })
  it('空 did 不塞键（免得写成一个空人）', () => {
    const p = visGrantPayload(VIS_WIDE, '  ')
    expect(p !== null && 'did' in p).toBe(false)
  })
  it('「跟随整体范围」= 传真 null（后端清除通道契约：visibility 传 null，不是空对象/不是全宽的一份）', () => {
    expect(visGrantPayload(null, 'did:myco:d1')).toBeNull()
    expect(visGrantPayload(null, '')).toBeNull()
  })
  it('已收窄过 → 从逐人值起手；继承/全宽 → 从整体当前值起手', () => {
    const task: Visibility = { space: 'session', sessions: ['s-1', 's-2'], windowMs: null }
    const narrowed: Visibility = { space: 'session', sessions: ['s-1'], windowMs: null }
    expect(visGrantStart(narrowed, task, ITEMS)).toEqual({ space: 'session', sessions: ['s-1'], windowMs: null })
    expect(visGrantStart(null, task, ITEMS)).toEqual({ space: 'session', sessions: ['s-1', 's-2'], windowMs: null })
    expect(visGrantStart(VIS_WIDE, task, ITEMS)).toEqual({ space: 'session', sessions: ['s-1', 's-2'], windowMs: null })
    // 整体缺项 → 回 schema 默认值（不炸）
    expect(visGrantStart(null, null, ITEMS)).toEqual({ space: 'machine', sessions: [], windowMs: 21600000 })
  })
})

/** §3.20「展开即脏」修复（2026-10-06）：基线 = 展开那一刻的快照（模式 + 值同源对齐），
 *  dirty = 用户真正动过。四个口径逐条钉死（组件 MemberScopeBlock 只是把状态喂进来）。 */
describe('visGrantDirty · 逐人脏判定（基线=展开快照）', () => {
  const snap = visGrantStart(null, { space: 'machine', sessions: [], windowMs: null }, ITEMS) // 跟随人的起手快照
  it('① 展开那一刻不脏：模式=基线模式，draft=基线（同源快照）', () => {
    expect(visGrantDirty('follow', 'follow', snap, { ...snap })).toBe(false)
    expect(visGrantDirty('custom', 'custom', snap, { ...snap })).toBe(false)
  })
  it('② 「跟随整体范围」基线是"跟随"状态本身：切到「单独指定」才算改动', () => {
    expect(visGrantDirty('follow', 'custom', snap, { ...snap })).toBe(true)
  })
  it('③ 再切回「跟随整体范围」= 回到基线状态 → 不脏（值有没有动过都不看——这一态存的是 null）', () => {
    expect(visGrantDirty('follow', 'follow', snap, { ...snap, windowMs: 3600000 })).toBe(false)
  })
  it('④ 单独指定下：只有 draft ≠ 基线（用户真正动过）才脏；动了再改回原值 = 不脏', () => {
    expect(visGrantDirty('custom', 'custom', snap, { ...snap, space: 'session' })).toBe(true)
    expect(visGrantDirty('custom', 'custom', snap, { ...snap, space: 'session', sessions: [] })).toBe(true)
    expect(visGrantDirty('custom', 'custom', snap, { ...snap })).toBe(false)
  })
})

/* ═══════════ 2026-10-24 多项目契约：路径口径 / projects 白名单 / 会话先按项目筛 / 回写体 ═══════════ */

describe('visPath* · 路径归一（同一个项目两种写法不能算两个）', () => {
  it('samePath：反斜杠/正斜杠、大小写、尾分隔符都不算差异', () => {
    expect(visSamePath('D:\\Projects\\labs\\myco', 'd:/projects/labs/myco/')).toBe(true)
    expect(visSamePath('D:\\a', 'D:\\b')).toBe(false)
    expect(visSamePath('', '')).toBe(false)
    expect(visPathKey('C:\\X\\')).toBe('c:/x')
  })
  it('under：子目录算项目内；前缀相似不算（分隔符判定）', () => {
    expect(visPathUnder('D:\\p\\sub\\x', 'D:\\p')).toBe(true)
    expect(visPathUnder('D:\\p', 'D:\\p\\')).toBe(true)
    expect(visPathUnder('D:\\p2', 'D:\\p')).toBe(false)
    expect(visPathUnder('C:\\any', 'C:')).toBe(true) // 盘符根
    expect(visPathUnder('', 'D:\\p')).toBe(false)
  })
  it('tail / parent：同名项目靠父目录区分', () => {
    expect(visPathTail('D:\\labs\\myco')).toBe('myco')
    expect(visPathTail('D:\\labs\\myco\\')).toBe('myco')
    expect(visPathParent('D:\\labs\\myco')).toBe('labs')
    expect(visPathParent('D:\\myco')).toBe('D:') // 盘符就是它的父段
  })
})

describe('visProjectsOf · projects 白名单归一（空 = 沿用分享自身 cwd）', () => {
  it('数组/单值/空值都认，路径等价去重保序', () => {
    expect(visProjectsOf({ projects: ['D:\\a', 'd:/a/', 'D:\\b'] })).toEqual(['D:\\a', 'D:\\b'])
    expect(visProjectsOf({ projects: 'D:\\a' })).toEqual(['D:\\a'])
    expect(visProjectsOf({ projects: [] })).toEqual([])
    expect(visProjectsOf({})).toEqual([])
    expect(visProjectsOf(null)).toEqual([])
  })
})

describe('会话→项目归属映射（option 字段 / schema.sessionCwds）', () => {
  it('option 自带的 cwd/项目归属字段名多拼法都认，取不到 = 空串', () => {
    expect(visSessionCwdOf({ cwd: 'D:\\p' })).toBe('D:\\p')
    expect(visSessionCwdOf({ projectCwd: ' D:\\p ' })).toBe('D:\\p')
    expect(visSessionCwdOf({ project: 'D:\\p' })).toBe('D:\\p')
    expect(visSessionCwdOf({ workspace: 'D:\\p' })).toBe('D:\\p')
    expect(visSessionCwdOf({ path: 'D:\\p' })).toBe('D:\\p')
    expect(visSessionCwdOf({})).toBe('')
    expect(visSessionCwdOf(null)).toBe('')
  })
  it('schema 级映射三种形状：直接映射 / 值带壳 / items 数组', () => {
    expect(visSessionCwdsOf({ 's-1': 'D:\\p' })).toEqual({ 's-1': 'D:\\p' })
    expect(visSessionCwdsOf({ 's-1': { cwd: 'D:\\p' } })).toEqual({ 's-1': 'D:\\p' })
    expect(visSessionCwdsOf({ items: [{ sessionId: 's-1', cwd: 'D:\\p' }] })).toEqual({ 's-1': 'D:\\p' })
    expect(visSessionCwdsOf(null)).toEqual({})
  })
  it('补 cwd：option 自带优先（不覆盖），只补缺的', () => {
    const opts: VisOption[] = [{ value: 's-1' }, { value: 's-2', cwd: 'D:\\own' }]
    expect(visApplySessionCwds(opts, { 's-1': 'D:\\m', 's-2': 'D:\\m' })).toEqual([
      { value: 's-1', cwd: 'D:\\m' },
      { value: 's-2', cwd: 'D:\\own' },
    ])
  })
})

describe('visFilterSessionsByProjects · 会话勾选先按项目筛（未选=全部；拿不到映射=全部+说明）', () => {
  const OPTS: VisOption[] = [
    { value: 's-a', label: 'A 项目里的', cwd: 'D:\\labs\\myco\\ui' },
    { value: 's-b', label: 'B 项目里的', cwd: 'D:\\labs\\other' },
    { value: 's-c', label: '归属不明' },
  ]
  const PROJS = ['D:\\labs\\myco']
  it('未选项目 → 全部、不筛（mapped:true）', () => {
    const r = visFilterSessionsByProjects(OPTS, [])
    expect(r.items).toEqual(OPTS)
    expect(r.mapped).toBe(true)
    expect(r.hidden + r.hiddenUnknown).toBe(0)
  })
  it('有映射：只留属于所选项目的；不在项目内/归属不明的计数（界面据此说明，没静默丢）', () => {
    const r = visFilterSessionsByProjects(OPTS, PROJS)
    expect(r.items.map((o) => o.value)).toEqual(['s-a'])
    expect(r.mapped).toBe(true)
    expect(r.hidden).toBe(1) // s-b：在别的项目
    expect(r.hiddenUnknown).toBe(1) // s-c：拿不到归属
  })
  it('候选全都拿不到映射 → 显示全部 + mapped:false（不静默隐藏，界面配灰字说明）', () => {
    const r = visFilterSessionsByProjects([{ value: 's-x' }, { value: 's-y' }], PROJS)
    expect(r.items.map((o) => o.value)).toEqual(['s-x', 's-y'])
    expect(r.mapped).toBe(false)
    expect(r.hidden + r.hiddenUnknown).toBe(0)
  })
  it('会话 cwd 是项目子目录也算该项目；多项目取并集；无归属会话不算', () => {
    expect(visSessionInProjects({ cwd: 'D:\\labs\\myco\\sub' }, PROJS)).toBe(true)
    expect(visSessionInProjects({ cwd: 'D:\\labs\\myco2' }, PROJS)).toBe(false)
    expect(visSessionInProjects({}, PROJS)).toBe(false)
    expect(visSessionInProjects({ cwd: 'D:\\x' }, [])).toBe(true)
    const r = visFilterSessionsByProjects(OPTS, ['D:\\labs\\myco', 'D:\\labs\\other'])
    expect(r.items.map((o) => o.value)).toEqual(['s-a', 's-b'])
  })
})

describe('visDisplayItems / VIS_PROJECT_TIER_LABEL · 项目档显示层叫「指定项目」', () => {
  it('只覆盖 space 的 project 选项 label，其它原样；不改原对象', () => {
    const items: VisItem[] = [{
      id: 'space', kind: 'enum',
      options: [
        { value: 'machine', label: '我的全部（整机）' },
        { value: 'project', label: '只这一个项目（myco）' },
        { value: 'session', label: '只指定会话' },
      ],
    }]
    const out = visDisplayItems(items)
    expect(VIS_PROJECT_TIER_LABEL).toBe('指定项目')
    expect(out?.[0].options?.[1].label).toBe('指定项目')
    expect(out?.[0].options?.[0].label).toBe('我的全部（整机）')
    expect(items[0].options?.[1].label).toBe('只这一个项目（myco）') // 原数组没被改
    expect(visDisplayItems(null)).toBeNull()
  })
})

describe('visNotNarrowed · 多项目也算真收窄', () => {
  it('project/session 档 projects 非空 = 收窄；machine 档忽略 projects', () => {
    expect(visNotNarrowed({ space: 'project', sessions: [], projects: ['D:\\a'], windowMs: null })).toBe(false)
    expect(visNotNarrowed({ space: 'session', sessions: [], projects: ['D:\\a'], windowMs: null })).toBe(false)
    expect(visNotNarrowed({ space: 'machine', sessions: [], projects: ['D:\\a'], windowMs: null })).toBe(true)
  })
})

describe('visScopeLabel / visCeilingLabel · 多项目个数（N）', () => {
  const DISP = visDisplayItems(ITEMS) ?? ITEMS // 显示层：project 档 label = 指定项目
  it('project 档选了 N 个项目 → 指定项目（N）；没选 → 不带个数', () => {
    expect(visScopeLabel({ space: 'project', sessions: [], projects: ['D:\\a', 'D:\\b'], windowMs: 21600000 }, DISP))
      .toBe('指定项目（2）')
    expect(visScopeLabel({ space: 'project', sessions: [], projects: [], windowMs: 21600000 }, DISP))
      .toBe('指定项目')
  })
  it('整体基线：项目个数写成「N 个」', () => {
    expect(visCeilingLabel({ space: 'project', sessions: [], projects: ['D:\\a', 'D:\\b'], windowMs: 21600000 }, DISP))
      .toBe('指定项目（2 个） · 最近 6 小时')
    expect(visCeilingLabel({ space: 'project', sessions: [], projects: [], windowMs: null }, DISP))
      .toBe('指定项目 · 不限（全部历史）')
  })
})

describe('buildVisibilityPayload · 完整回写体（projects 契约 2026-10-24）', () => {
  it('project 档：带 projects 白名单（去空），projectCwd 统一 null（后端=沿用分享 cwd 语义）', () => {
    const d = { ...visDraftFrom(CUR, ITEMS), space: 'project', projects: ['D:\\labs\\myco', '  '] }
    expect(buildVisibilityPayload(CUR, ITEMS, d)).toEqual({
      space: 'project', sessions: ['s-1'], windowMs: 21600000,
      projects: ['D:\\labs\\myco'], projectCwd: null,
    })
  })
  it('session 档：sessions 与 projects 都带（后端先按项目筛再按会话筛）', () => {
    const d = { ...visDraftFrom(CUR, ITEMS), space: 'session', sessions: ['s-2'], projects: ['D:\\a'] }
    const p = buildVisibilityPayload(CUR, ITEMS, d)
    expect(p.space).toBe('session')
    expect(p.sessions).toEqual(['s-2'])
    expect(p.projects).toEqual(['D:\\a'])
    expect(p.projectCwd).toBeNull()
  })
  it('machine 档：projects 清空（不生效但形状一致，旧值不残留）', () => {
    const p = buildVisibilityPayload({ ...CUR, projects: ['D:\\stale'] }, ITEMS, { ...visDraftFrom(CUR, ITEMS), space: 'machine' })
    expect(p.space).toBe('machine')
    expect(p.projects).toEqual([])
    expect(p.projectCwd).toBeNull()
  })
})
