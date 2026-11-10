import { describe, it, expect } from 'vitest'
import { accountDisplayName, accountShortLabel, nicknameValue, currentYoulingName, setYoulingNameCache } from './identity'

/* 2026-09-30 昵称显示兜底链四修（手机端，与 env/ui/src/lib/accountDisplay.ts 同源约定）：
 * 空昵称与哨兵「有灵账号」不得当昵称值显示；顶栏/菜单头/done 屏短标 = `昵称 ·…尾4`；
 * currentYoulingName 读侧清洗——聊天气泡「自己名」不外流哨兵。 */
const DID = 'did:youling:7S2YE7Q6g2vx9mqZ4PsXUhszXJhjqCbFKnutmHhQ4cgb'

describe('nicknameValue / accountDisplayName（兜底链）', () => {
  it('空昵称（null/undefined/空串/空白）→ 未命名 / 空串', () => {
    expect(nicknameValue(null)).toBe('')
    expect(nicknameValue('   ')).toBe('')
    expect(accountDisplayName(undefined)).toBe('未命名')
    expect(accountDisplayName('')).toBe('未命名')
  })
  it('哨兵「有灵账号」→ 未命名 / 空串（改名输入框显示 placeholder 而非值）', () => {
    expect(nicknameValue('有灵账号')).toBe('')
    expect(accountDisplayName('有灵账号')).toBe('未命名')
  })
  it('真昵称原样（trim）', () => {
    expect(nicknameValue(' 小明 ')).toBe('小明')
    expect(accountDisplayName('小明')).toBe('小明')
  })
})

describe('accountShortLabel（顶栏/菜单头/done 屏：昵称 ·…尾4）', () => {
  it('有昵称', () => {
    expect(accountShortLabel('小明', DID)).toBe('小明 ·…4cgb')
  })
  it('空昵称兜住（不折叠、不出「已登录」占昵称位）', () => {
    expect(accountShortLabel('', DID)).toBe('未命名 ·…4cgb')
  })
  it('省略号统一单字符 …（无 ... / ⋯）', () => {
    const label = accountShortLabel('小明', DID)
    expect(label.includes('…')).toBe(true)
    expect(label.includes('...')).toBe(false)
    expect(label.includes('⋯')).toBe(false)
  })
})

describe('currentYoulingName（读侧清洗——聊天气泡/署名不外流哨兵）', () => {
  it('缓存为哨兵 → 读出空串（消费方 || 兜底接管）', () => {
    setYoulingNameCache('有灵账号')
    expect(currentYoulingName()).toBe('')
  })
  it('缓存为真昵称 → 原样', () => {
    setYoulingNameCache('小明')
    expect(currentYoulingName()).toBe('小明')
    setYoulingNameCache('') // 还原，不污染其他测试
  })
})
