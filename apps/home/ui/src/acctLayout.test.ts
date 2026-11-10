import { describe, it, expect } from 'vitest'
import {
  ACCT_SECTIONS, FONT_LEVELS, SECTION_LABELS, sectionOrder, fontSize, dangerConfirmOk,
  acctMenuItems, acctMenuHeight, ACCT_MENU_W, switchMenuVisible,
} from './acctLayout'
import { sameAccountDid } from './didUtil'

/* 2026-09-30 批 B：账号页区块排序 + 字号三级收敛——纯函数快照防回归。
 * 2026-10-01 重排：③账号管理区(management) 整区下线（切换/登录/创建收进顶部卡
 * 「切换账号 ▾」真下拉）——区块 3→2；新增下拉菜单纯逻辑用例。 */

describe('ACCT_SECTIONS（区块排序：我是谁→本机是谁）', () => {
  it('恰好两个区块（management 已随下拉收编下线）', () => {
    expect(ACCT_SECTIONS).toHaveLength(2)
  })
  it('顺序 = identity → devices', () => {
    expect(sectionOrder()).toEqual(['identity', 'devices'])
  })
  it('management 区块标签已删（防悄悄复活）', () => {
    expect(ACCT_SECTIONS).not.toContain('management')
    expect(Object.keys(SECTION_LABELS)).not.toContain('management')
  })
  it('每区块有中文标签', () => {
    for (const s of ACCT_SECTIONS) {
      expect(SECTION_LABELS[s]).toBeTruthy()
    }
  })
})

describe('FONT_LEVELS（字号三级收敛：14/12/11）', () => {
  it('标题 14', () => { expect(fontSize('title')).toBe(14) })
  it('正文 12', () => { expect(fontSize('body')).toBe(12) })
  it('辅说明 11（didt 10.5 并入）', () => { expect(fontSize('caption')).toBe(11) })
  it('无第四级（10.5/13.5 等中间值已消灭）', () => {
    const vals = Object.values(FONT_LEVELS)
    expect(vals).not.toContain(10.5)
    expect(vals).not.toContain(13.5)
    expect(vals).not.toContain(12.5)
  })
})

describe('acctMenuItems（下拉菜单行构造）', () => {
  const accts = [
    { did: 'did:youling:AAAA', name: '小甲', role: 'embodiment', lastLogin: '2026-10-01T00:00:00' },
    { did: 'did:myco:BBBB', name: '小乙', role: 'agent' },
    { did: 'did:youling:CCCC', name: '', role: 'lost' },
  ]
  it('当前账号置顶 + current 标记（前缀不敏感：did:myco:/did:youling: 同账号）', () => {
    const items = acctMenuItems(accts, 'did:youling:BBBB', sameAccountDid)
    expect(items[0]).toMatchObject({ did: 'did:myco:BBBB', current: true })
    expect(items.slice(1).every((m) => !m.current)).toBe(true)
  })
  it('行数据带 name/role/lastLogin（凭据文案与 hover title 的原料）', () => {
    const items = acctMenuItems(accts, null)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ name: '小甲', role: 'embodiment', lastLogin: '2026-10-01T00:00:00', current: false })
  })
  it('空清单 → 空菜单行', () => {
    expect(acctMenuItems([], 'did:youling:X', sameAccountDid)).toEqual([])
  })
})

describe('switchMenuVisible（单账号隐藏「切换账号 ▾」）', () => {
  it('只有当前账号 → false（右侧只放「＋ 登录另一个账号」小链接）', () => {
    expect(switchMenuVisible([{ did: 'did:youling:A' }], 'did:youling:A', sameAccountDid)).toBe(false)
  })
  it('只有当前账号但历史前缀形态不同 → 仍算同一账号 → false', () => {
    expect(switchMenuVisible([{ did: 'did:myco:A' }], 'did:youling:A', sameAccountDid)).toBe(false)
  })
  it('存在其他账号 → true', () => {
    expect(switchMenuVisible([{ did: 'did:youling:A' }, { did: 'did:youling:B' }], 'did:youling:A', sameAccountDid)).toBe(true)
  })
  it('未登录（currentDid 空）→ 有账号即 true', () => {
    expect(switchMenuVisible([{ did: 'did:youling:A' }], null, sameAccountDid)).toBe(true)
    expect(switchMenuVisible([], null, sameAccountDid)).toBe(false)
  })
})

describe('acctMenuHeight/ACCT_MENU_W（首帧定位估算）', () => {
  it('高度随行数单调递增（clamp 二段校正前的首帧不闪跳即可）', () => {
    expect(acctMenuHeight(1)).toBeLessThan(acctMenuHeight(3))
    expect(acctMenuHeight(3)).toBeLessThan(acctMenuHeight(8))
  })
  it('菜单宽度为正的固定值', () => {
    expect(ACCT_MENU_W).toBeGreaterThan(0)
  })
})

describe('dangerConfirmOk（危险区红字确认状态机）', () => {
  it('空输入 → false', () => {
    expect(dangerConfirmOk('', '注销')).toBe(false)
    expect(dangerConfirmOk('   ', '注销')).toBe(false)
  })
  it('输错字 → false', () => {
    expect(dangerConfirmOk('解绑', '注销')).toBe(false)
    expect(dangerConfirmOk('注', '注销')).toBe(false)
    expect(dangerConfirmOk('注销吧', '注销')).toBe(false)
  })
  it('输对关键词 → true', () => {
    expect(dangerConfirmOk('注销', '注销')).toBe(true)
    expect(dangerConfirmOk('解绑', '解绑')).toBe(true)
  })
  it('前后空白 trim 后匹配 → true', () => {
    expect(dangerConfirmOk('  注销  ', '注销')).toBe(true)
  })
  it('两个关键词互不串——注销≠解绑', () => {
    expect(dangerConfirmOk('注销', '解绑')).toBe(false)
    expect(dangerConfirmOk('解绑', '注销')).toBe(false)
  })
})

/* ═══ 2026-10-03 批：单行账号卡 + 首登/切换反馈分叉 ═══ */

import { acctCardLine, ACCT_LINE_SHRINK, DONE_ACCT_KEY, SWITCH_ACCT_KEY, acctFeedbackRoute, switchToastText } from './acctLayout'

const DID = 'did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'

describe('acctCardLine（账号卡单行数据）', () => {
  it('nm=显示名 tail=…尾4 full=title 全名兜底', () => {
    expect(acctCardLine('cjfan', DID)).toEqual({
      nm: 'cjfan', tail: '…4cgb', full: `cjfan · ${DID}`,
    })
  })
  it('空/哨兵名走兜底链「未命名」', () => {
    expect(acctCardLine('', DID).nm).toBe('未命名')
    expect(acctCardLine('有灵账号', DID).nm).toBe('未命名')
  })
  it('did 空 → 无尾号，full 退纯显示名（手机未登录态同款）', () => {
    const L = acctCardLine('Fan', null)
    expect(L.tail).toBe('')
    expect(L.full).toBe('Fan')
  })
})

describe('ACCT_LINE_SHRINK（单行收缩合同：名收尾号钉）', () => {
  it('名是唯一收缩项：minWidth:0 + overflow ellipsis + flex 收缩', () => {
    expect(ACCT_LINE_SHRINK.nm.minWidth).toBe(0)
    expect(ACCT_LINE_SHRINK.nm.overflow).toBe('hidden')
    expect(ACCT_LINE_SHRINK.nm.textOverflow).toBe('ellipsis')
    expect(ACCT_LINE_SHRINK.nm.flex).toBe('0 1 auto')
  })
  it('尾号不收缩（名收到头才轮到容器裁它）', () => {
    expect(ACCT_LINE_SHRINK.tail.flexShrink).toBe(0)
  })
})

describe('acctFeedbackRoute（首登 done 屏 / 切换轻反馈分叉）', () => {
  it('首登（此前无账号）→ doneAcct 键（庆祝+引导页保留）', () => {
    const r = acctFeedbackRoute(false, 'Fan', 'sHaW')
    expect(r?.key).toBe(DONE_ACCT_KEY)
    expect(JSON.parse(r!.payload)).toEqual({ name: 'Fan', tail: 'sHaW' })
  })
  it('切换（已登录态换账号）→ switchAcct 键，绝不能写 doneAcct（用户实测修）', () => {
    const r = acctFeedbackRoute(true, 'Fan', 'sHaW')
    expect(r?.key).toBe(SWITCH_ACCT_KEY)
    expect(r?.key).not.toBe(DONE_ACCT_KEY)
  })
  it('tail4 空（did 缺失）→ 不写任何键', () => {
    expect(acctFeedbackRoute(false, 'Fan', '')).toBeNull()
    expect(acctFeedbackRoute(true, 'Fan', '')).toBeNull()
  })
})

describe('switchToastText（切换轻反馈文案兜底链）', () => {
  it('有名 → 已切换到 X', () => {
    expect(switchToastText({ name: 'Fan', tail: 'sHaW' })).toBe('已切换到 Fan')
  })
  it('名空/哨兵 → 尾4 兜底', () => {
    expect(switchToastText({ name: '', tail: 'sHaW' })).toBe('已切换到 …sHaW')
    expect(switchToastText({ name: '有灵账号', tail: 'sHaW' })).toBe('已切换到 …sHaW')
  })
  it('全空 → 新账号', () => {
    expect(switchToastText(null)).toBe('已切换到新账号')
    expect(switchToastText({})).toBe('已切换到新账号')
  })
})
