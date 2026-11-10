import { describe, it, expect } from 'vitest'
import { accountDisplayName, accountShortLabel, accountTail, credText, nicknameValue } from '@wsui/lib/accountDisplay'

/* 2026-09-30 昵称显示兜底链四修（共享源 env/ui/src/lib/accountDisplay.ts，@wsui 直引）：
 * 空昵称（null/undefined/空白）与后端哨兵「有灵账号」都不得当昵称值显示；
 * 顶栏/卡片短标 = `昵称 ·…尾4`，did 全文只留公钥行一处；省略号统一单字符 …。
 * 2026-10-01 账号页重排新增：accountTail（全页尾号唯一格式）+ credText（本机凭据
 * 状态文案——role 是「本机对该账号持有什么凭据」，不再用主设备/分身短词当徽章）。 */
const DID = 'did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'

describe('nicknameValue（输入框值：空/哨兵 → 空串配 placeholder）', () => {
  it('null/undefined/空串/空白 → 空串', () => {
    expect(nicknameValue(null)).toBe('')
    expect(nicknameValue(undefined)).toBe('')
    expect(nicknameValue('')).toBe('')
    expect(nicknameValue('   ')).toBe('')
  })
  it('后端哨兵「有灵账号」→ 空串（兜底文案不是值）', () => {
    expect(nicknameValue('有灵账号')).toBe('')
  })
  it('真昵称 trim 原样保留', () => {
    expect(nicknameValue(' 小明 ')).toBe('小明')
    expect(nicknameValue('小明')).toBe('小明')
  })
})

describe('accountDisplayName（显示文案：空/哨兵 →「未命名」）', () => {
  it('空昵称各形态 → 未命名（顶栏不再折叠成「已登录」）', () => {
    expect(accountDisplayName(null)).toBe('未命名')
    expect(accountDisplayName(undefined)).toBe('未命名')
    expect(accountDisplayName('')).toBe('未命名')
    expect(accountDisplayName('  ')).toBe('未命名')
  })
  it('哨兵「有灵账号」→ 未命名（绝不显示字面量）', () => {
    expect(accountDisplayName('有灵账号')).toBe('未命名')
  })
  it('有昵称 → 原样', () => {
    expect(accountDisplayName('小明')).toBe('小明')
  })
})

describe('accountShortLabel（顶栏/卡片/done 屏拼接格式：昵称 ·…尾4）', () => {
  it('有昵称：小明 ·…4cgb', () => {
    expect(accountShortLabel('小明', DID)).toBe('小明 ·…4cgb')
  })
  it('空昵称：未命名 ·…4cgb（兜住，不折叠）', () => {
    expect(accountShortLabel('', DID)).toBe('未命名 ·…4cgb')
    expect(accountShortLabel('有灵账号', DID)).toBe('未命名 ·…4cgb')
  })
  it('did 空防炸：只回显示名', () => {
    expect(accountShortLabel('', '')).toBe('未命名')
    expect(accountShortLabel('小明', '')).toBe('小明')
  })
})

describe('省略号统一（单字符 …，不混用 ... / ⋯）', () => {
  it('短标含 … 且不含 ASCII 三点/竖三点', () => {
    const label = accountShortLabel('小明', DID)
    expect(label.includes('…')).toBe(true)
    expect(label.includes('...')).toBe(false)
    expect(label.includes('⋯')).toBe(false)
  })
})

describe('accountTail（全页尾号唯一格式 …尾4——2026-10-01 重排）', () => {
  it('标准形态：…4cgb（省略号+尾4，无多余空格/横线）', () => {
    expect(accountTail(DID)).toBe('…4cgb')
  })
  it('短串照取尾 4', () => {
    expect(accountTail('abcdEFGH')).toBe('…EFGH')
  })
  it('空/null/undefined → 空串（调用方据此只显示昵称）', () => {
    expect(accountTail('')).toBe('')
    expect(accountTail(null)).toBe('')
    expect(accountTail(undefined)).toBe('')
  })
  it('前后空白 trim 后取尾（脏数据免疫）', () => {
    expect(accountTail(`  ${DID}  `)).toBe('…4cgb')
  })
  it('不含 ASCII 省略号或横线（历史上 …/-- 混写的格式收敛）', () => {
    const t = accountTail(DID)
    expect(t.includes('...')).toBe(false)
    expect(t.includes('-')).toBe(false)
    expect(t.includes(' ')).toBe(false)
  })
})

describe('credText（本机凭据状态文案——用户 2026-10-01 定稿）', () => {
  it('embodiment（种子槽在）→ 本机持有账号钥匙', () => {
    expect(credText('embodiment')).toBe('本机持有账号钥匙')
  })
  it('agent（委任状在）→ 受委任的成员', () => {
    expect(credText('agent')).toBe('受委任的成员')
  })
  it('lost/未知/缺省 → 凭据已失', () => {
    expect(credText('lost')).toBe('凭据已失')
    expect(credText('whatever')).toBe('凭据已失')
    expect(credText(undefined)).toBe('凭据已失')
    expect(credText(null)).toBe('凭据已失')
  })
  it('不再出现「主设备」短词当凭据徽章文案', () => {
    expect(credText('embodiment')).not.toContain('主设备')
  })
})
