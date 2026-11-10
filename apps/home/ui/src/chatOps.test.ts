import { describe, expect, it } from 'vitest'
import {
  fmtConvTime, unreadBadge, sortConvs, totalUnread, buildTimeline, msgCopyText,
  canRecall, quoteLine, makeReplyAnchor, replyAnchorOf, notifBody, chatNotifContent,
  avaColor, draftPreview, loadConvPrefs, saveConvPrefs, MERGE_GAP_MS,
  clampMenuPos, imgZoomAt, imgPanBy, imgViewInit, imgViewReset,
  IMG_ZOOM_MIN, IMG_ZOOM_MAX, SYNCING_TEXT,
  type ConvRow, type ConvPref,
} from './chatOps'
import type { ChatMsg } from './ChatBubble'

/* 批三 chatOps 锚点测试：会话微信化/时间体系/撤回/引用/通知构造/置顶排序。 */

const NOW = new Date(2026, 8, 29, 15, 0, 0) // 2026-09-29 15:00（周二）
const T = (h: number, min: number, dayOffset = 0) =>
  new Date(2026, 8, 29 + dayOffset, h, min, 0).getTime()

describe('fmtConvTime 会话行内时间（微信语义）', () => {
  it('今天 → HH:mm', () => {
    expect(fmtConvTime(T(9, 5), NOW)).toBe('09:05')
  })
  it('昨天 → 昨天', () => {
    expect(fmtConvTime(T(23, 59, -1), NOW)).toBe('昨天')
  })
  it('一周内 → 星期x', () => {
    expect(fmtConvTime(T(10, 0, -2), NOW)).toBe('星期日') // 9-27 是周日
    expect(fmtConvTime(T(10, 0, -6), NOW)).toBe('星期三') // 9-23 是周三
  })
  it('同年内 → M月D日', () => {
    expect(fmtConvTime(T(10, 0, -20), NOW)).toBe('9月9日')
  })
  it('跨年 → YYYY/M/D', () => {
    expect(fmtConvTime(new Date(2025, 11, 31, 10, 0).getTime(), NOW)).toBe('2025/12/31')
  })
  it('空/坏值 → 空串', () => {
    expect(fmtConvTime(0, NOW)).toBe('')
    expect(fmtConvTime(NaN, NOW)).toBe('')
  })
})

describe('unreadBadge 未读数字化', () => {
  it('常规/99+/零', () => {
    expect(unreadBadge(3)).toBe('3')
    expect(unreadBadge(99)).toBe('99')
    expect(unreadBadge(128)).toBe('99+')
    expect(unreadBadge(0)).toBe('')
    expect(unreadBadge(undefined)).toBe('')
  })
})

const C = (id: string, lastTs: number, unreadN = 0): ConvRow =>
  ({ id, kind: 'friend', title: id, lastTs, lastText: '', unreadN })

describe('sortConvs 置顶排序', () => {
  it('默认按 lastTs 新→旧', () => {
    const out = sortConvs([C('a', 100), C('b', 300), C('c', 200)], {})
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })
  it('置顶块在前；块内按置顶时刻新→旧', () => {
    const prefs: Record<string, ConvPref> = { a: { pin: 1000 }, c: { pin: 2000 } }
    const out = sortConvs([C('a', 100), C('b', 900), C('c', 200)], prefs)
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b']) // c 新置顶最前；b lastTs 大但非置顶
  })
  it('totalUnread 免打扰会话不计入总数', () => {
    const prefs: Record<string, ConvPref> = { b: { mute: true } }
    expect(totalUnread([C('a', 1, 3), C('b', 2, 5), C('c', 3, 0)], prefs)).toBe(3)
    expect(totalUnread([C('a', 1, 3), C('b', 2, 5)], {})).toBe(8)
  })
})

describe('convPrefs 持久化往返', () => {
  it('save → load 还原；坏数据回空', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    saveConvPrefs({ 'x': { pin: 1, mute: true } }, store)
    expect(loadConvPrefs(store)).toEqual({ x: { pin: 1, mute: true } })
    mem.set('myco-conv-prefs', '{bad json')
    expect(loadConvPrefs(store)).toEqual({})
  })
})

const M = (msgId: string, ts: number, dir: 'in' | 'out', kind = 'text', fromName = ''): ChatMsg =>
  ({ msgId, from: dir === 'out' ? 'me' : 'peer', to: 'x', kind, payload: kind === 'text' ? { text: `正文${msgId}` } : {}, ts, dir, fromName })

describe('buildTimeline 时间体系', () => {
  it('首条=今天 → 只时间条；gap>5min 断开 → 时间条', () => {
    const items = buildTimeline([M('a', T(9, 0), 'in'), M('b', T(9, 3), 'in'), M('c', T(9, 10), 'in')], { now: NOW })
    const kinds = items.map((i) => i.t)
    expect(kinds).toEqual(['time', 'msg', 'msg', 'time', 'msg'])
    // 5min 内同人同向 → merged
    const msgs = items.filter((i) => i.t === 'msg') as { t: 'msg'; m: ChatMsg; merged: boolean }[]
    expect(msgs.map((x) => x.merged)).toEqual([false, true, false])
  })
  it('跨天 → 日期分隔条（9月x日），随后时间条', () => {
    const items = buildTimeline([M('a', T(23, 50, -1), 'in'), M('b', T(0, 5), 'in')], { now: NOW })
    // 首条（昨天）前日期条+时间条；第二条跨天再日期条+时间条 → 共 2 条日期条
    const dateItems = items.filter((i) => i.t === 'date')
    expect(dateItems.length).toBe(2)
    const kinds = items.map((i) => i.t)
    expect(kinds).toEqual(['date', 'time', 'msg', 'date', 'time', 'msg'])
    expect((dateItems[0] as { t: 'date'; label: string }).label).toBe('9月28日')
    expect((dateItems[1] as { t: 'date'; label: string }).label).toBe('9月29日')
  })
  it('跨年日期条带年', () => {
    const items = buildTimeline([M('a', new Date(2025, 11, 31, 10, 0).getTime(), 'in')], { now: NOW })
    const d = items.find((i) => i.t === 'date') as { t: 'date'; label: string }
    expect(d.label).toBe('2025年12月31日')
  })
  it('系统条打断 merge；不同方向不 merge', () => {
    const items = buildTimeline([
      M('a', T(9, 0), 'in'), M('s', T(9, 1), 'in', 'sys'), M('b', T(9, 2), 'in'), M('c', T(9, 3), 'out'),
    ], { now: NOW })
    const msgs = items.filter((i) => i.t === 'msg') as { t: 'msg'; merged: boolean }[]
    expect(msgs.map((x) => x.merged)).toEqual([false, false, false, false])
  })
  it('未读分割线锚：firstUnreadMsgId 前插一次，且只插一次', () => {
    const items = buildTimeline([M('a', T(9, 0), 'in'), M('b', T(9, 1), 'in'), M('c', T(9, 2), 'out')], { now: NOW, firstUnreadMsgId: 'b' })
    const un = items.filter((i) => i.t === 'unread')
    expect(un.length).toBe(1)
    const idx = items.findIndex((i) => i.t === 'unread')
    expect(items[idx + 1].t).toBe('msg')
    expect((items[idx + 1] as { t: 'msg'; m: ChatMsg }).m.msgId).toBe('b')
  })
  it('gap 恰好 5min 不断开（>5min 才断）', () => {
    const items = buildTimeline([M('a', T(9, 0), 'in'), M('b', T(9, 0) + MERGE_GAP_MS, 'in')], { now: NOW })
    expect(items.filter((i) => i.t === 'time').length).toBe(1) // 只有首条的时间条
    expect((items[2] as { t: 'msg'; merged: boolean }).merged).toBe(true)
  })
})

describe('msgCopyText 复制文本口径', () => {
  it('各 kind', () => {
    expect(msgCopyText(M('a', 1, 'in'))).toBe('正文a')
    expect(msgCopyText({ ...M('i', 1, 'in', 'image'), payload: {} })).toBe('[图片]')
    expect(msgCopyText({ ...M('f', 1, 'in', 'file'), payload: { name: '报告.pdf' } })).toBe('[文件] 报告.pdf')
    expect(msgCopyText({ ...M('t', 1, 'in', 'task-share'), payload: { title: '写周报' } })).toBe('[任务卡] 写周报')
    // 2026-10-11 任务卡改名留痕条
    expect(msgCopyText({ ...M('tr', 1, 'in', 'task-rename'), payload: { title: '新名' } })).toBe('✏️ 任务卡改名为「新名」')
    expect(msgCopyText(M('r', 1, 'out', 'recalled'))).toBe('')
  })
})

describe('canRecall 撤回判定（2 分钟窗口）', () => {
  const now = T(12, 0)
  it('自己 2min 内正文 → 可撤', () => {
    expect(canRecall(M('a', now - 60_000, 'out'), now)).toBe(true)
  })
  it('超 2min → 不可撤', () => {
    expect(canRecall(M('a', now - 121_000, 'out'), now)).toBe(false)
  })
  it('对方消息/系统条/已撤回/发送中 → 不可撤', () => {
    expect(canRecall(M('a', now - 1000, 'in'), now)).toBe(false)
    expect(canRecall(M('a', now - 1000, 'out', 'sys'), now)).toBe(false)
    expect(canRecall(M('a', now - 1000, 'out', 'recalled'), now)).toBe(false)
    expect(canRecall({ ...M('a', now - 1000, 'out'), sendState: 'sending' }, now)).toBe(false)
  })
  it('2026-10-11：task-rename 留痕条是系统条——不可撤回、不打断合并聚合', () => {
    expect(canRecall(M('tr', now - 1000, 'out', 'task-rename'), now)).toBe(false)
    // 改名条与前后文本行不 merge（系统条打断聚合，与 sys 同款）
    const items = buildTimeline([
      M('a', T(9, 0), 'in'), M('tr', T(9, 1), 'in', 'task-rename'), M('b', T(9, 2), 'in'),
    ], { now: NOW })
    const msgs = items.filter((i) => i.t === 'msg') as { t: 'msg'; merged: boolean }[]
    expect(msgs.map((x) => x.merged)).toEqual([false, false, false])
  })
})

describe('引用回复锚', () => {
  const friends = [{ did: 'peer', name: '小明' }]
  it('makeReplyAnchor → replyAnchorOf 往返', () => {
    const src = M('a', 1, 'in', 'text', '小明')
    const anchor = makeReplyAnchor(src, friends)
    expect(anchor.name).toBe('小明')
    expect(anchor.text).toBe('正文a')
    const withReply: ChatMsg = { ...M('b', 2, 'out'), payload: { text: '引用你', replyTo: anchor } }
    expect(replyAnchorOf(withReply)).toEqual(anchor)
  })
  it('quoteLine 摘要：对方昵称/我；超长截断', () => {
    expect(quoteLine(M('a', 1, 'in', 'text', '小明'), friends)).toBe('小明: 正文a')
    expect(quoteLine(M('a', 1, 'out'), friends)).toBe('我: 正文a')
    const long: ChatMsg = { ...M('l', 1, 'in', 'text', '小明'), payload: { text: 'x'.repeat(50) } }
    expect(quoteLine(long, friends).length).toBeLessThan(40)
    expect(quoteLine(long, friends)).toContain('…')
  })
  it('replyAnchorOf 无 replyTo/坏形态 → null', () => {
    expect(replyAnchorOf(M('a', 1, 'in'))).toBeNull()
    expect(replyAnchorOf({ ...M('b', 1, 'in'), payload: { replyTo: { msgId: 3 } } })).toBeNull()
  })
})

describe('系统通知内容构造', () => {
  it('正文截 60 字', () => {
    expect(notifBody('短')).toBe('短')
    expect(notifBody('y'.repeat(80))).toBe(`${'y'.repeat(60)}…`)
  })
  it('单聊：标题=好友昵称，正文=预览', () => {
    const c: ConvRow = { id: 'x', kind: 'friend', title: '小明', lastTs: 1, lastText: '[图片]' }
    expect(chatNotifContent(c)).toEqual({ title: '小明', body: '[图片]' })
  })
  it('群聊：标题=群名，正文=发送者: 预览', () => {
    const c: ConvRow = { id: 'g', kind: 'group', title: '周末爬山', lastTs: 1, lastText: '[任务卡] 买水' }
    expect(chatNotifContent(c, '小红')).toEqual({ title: '周末爬山', body: '小红: [任务卡] 买水' })
  })
  it('标题是全称 did 时压 …尾4（护栏）', () => {
    const c: ConvRow = { id: 'x', kind: 'friend', title: 'did:youling:ABCDEFGH', lastTs: 1, lastText: 'hi' }
    expect(chatNotifContent(c).title).toBe('…EFGH')
  })
})

describe('头像散列取色/草稿预览', () => {
  it('avaColor 同名稳定、合法渐变、palette 内', () => {
    const a = avaColor('小明')
    expect(a).toBe(avaColor('小明'))
    expect(a).toMatch(/^linear-gradient\(135deg,#[0-9a-f]{6},#[0-9a-f]{6}\)$/)
    expect(avaColor('')).toMatch(/^linear-gradient/)
  })
  it('draftPreview 截 20', () => {
    expect(draftPreview('')).toBe('')
    expect(draftPreview(undefined)).toBe('')
    expect(draftPreview('  在吗  ')).toBe('在吗')
    expect(draftPreview('z'.repeat(30))).toBe(`${'z'.repeat(20)}…`)
  })
})

/* ── 批四（2026-09-29 实测修复）：菜单 clamp / 图片缩放状态机 / 同步文案立法 ── */

describe('clampMenuPos 右键菜单不出窗', () => {
  const W = 320, H = 640 // myco 窄窗实测尺寸
  it('中部正常右下展开', () => {
    expect(clampMenuPos(100, 200, 120, 90, W, H)).toEqual({ x: 100, y: 200 })
  })
  it('贴右→翻到光标左侧；贴底→翻到光标上方', () => {
    expect(clampMenuPos(300, 600, 120, 90, W, H)).toEqual({ x: 180, y: 510 })
  })
  it('翻左出界→二次 clamp 回窗内（菜单比光标还靠左的极端）', () => {
    const p = clampMenuPos(30, 620, 120, 90, W, H)
    expect(p.x).toBeGreaterThanOrEqual(4)
    expect(p.x + 120).toBeLessThanOrEqual(W - 4)
    expect(p.y + 90).toBeLessThanOrEqual(H - 4)
  })
  it('菜单比窗口大→退化贴 pad 边（保证可见可操作）', () => {
    const p = clampMenuPos(100, 100, 400, 800, W, H)
    expect(p).toEqual({ x: 4, y: 4 })
  })
  it('四角都在窗内（全网格扫）', () => {
    for (const x of [0, 50, 160, 310, 319]) {
      for (const y of [0, 300, 630, 639]) {
        const p = clampMenuPos(x, y, 130, 130, W, H)
        expect(p.x).toBeGreaterThanOrEqual(4)
        expect(p.y).toBeGreaterThanOrEqual(4)
        expect(p.x + 130).toBeLessThanOrEqual(W - 4)
        expect(p.y + 130).toBeLessThanOrEqual(H - 4)
      }
    }
  })
})

describe('图片查看器缩放/平移状态机', () => {
  it('初始=自适应（scale 1，无平移）；双击复位回初始', () => {
    expect(imgViewInit()).toEqual({ scale: 1, tx: 0, ty: 0 })
    const s = imgPanBy(imgZoomAt(imgViewInit(), 10, 10, -300), 30, -20)
    expect(imgViewReset()).toEqual(imgViewInit())
    expect(s).not.toEqual(imgViewInit()) //  Sanity：先确实有变化
  })
  it('滚轮放大/缩小，clamp 在 [0.5, 5]', () => {
    let s = imgViewInit()
    for (let i = 0; i < 100; i++) s = imgZoomAt(s, 0, 0, -120)
    expect(s.scale).toBe(IMG_ZOOM_MAX)
    for (let i = 0; i < 200; i++) s = imgZoomAt(s, 0, 0, 120)
    expect(s.scale).toBe(IMG_ZOOM_MIN)
  })
  it('光标锚点不动：缩放前后光标下图像点同一（(p-t)/s 不变式）', () => {
    const s0 = { scale: 1.4, tx: 25, ty: -40 }
    const px = 60, py = 33
    const s1 = imgZoomAt(s0, px, py, -240)
    const anchor = (s: typeof s0) => ({ x: (px - s.tx) / s.scale, y: (py - s.ty) / s.scale })
    const a0 = anchor(s0), a1 = anchor(s1)
    expect(a1.x).toBeCloseTo(a0.x, 10)
    expect(a1.y).toBeCloseTo(a0.y, 10)
    expect(s1.scale).toBeGreaterThan(s0.scale)
  })
  it('拖拽平移=增量累加', () => {
    const s = imgPanBy(imgPanBy(imgViewInit(), 10, 5), -3, 7)
    expect(s).toEqual({ scale: 1, tx: 7, ty: 12 })
  })
  it('已到边界再滚=原态（不抖）', () => {
    let s = imgViewInit()
    for (let i = 0; i < 100; i++) s = imgZoomAt(s, 0, 0, 120)
    expect(imgZoomAt(s, 40, 40, 120)).toBe(s) // 引用相等=无状态漂移
  })
})

describe('同步状态条文案立法（纯状态描述，无操作引导）', () => {
  it('文案=正在同步消息…', () => {
    expect(SYNCING_TEXT).toBe('正在同步消息…')
  })
  it('不含"可以/打字/直接/立即上屏"类引导话术（2026-09-29 用户实测立法）', () => {
    expect(SYNCING_TEXT).not.toMatch(/可以|打字|直接|立即|试试|点击/)
  })
})
