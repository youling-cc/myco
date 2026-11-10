/**
 * accountDisplay.ts — 账号昵称显示兜底链（2026-09-30 用户实测四修立法）。
 *
 * 空昵称语义：后端（Rust account_name()/创建默认/手机端 accounts.json）把「无名字」
 * 一律落成哨兵字符串「有灵账号」——它只能在数据层当 null 用，绝不能当昵称值显示
 * （实测曾同时漏进改名输入框/公钥行标签/顶栏）。显示层统一走这里：
 *   - 显示文案：空/哨兵 →「未命名」（顶栏/卡片/会话列表）
 *   - 输入框值：空/哨兵 → 空串（配 placeholder「给自己起个名字」）
 *   - 短标拼接：`昵称 ·…尾4`（省略号统一单字符 …，不混用 .../⋯）
 * 数据源与改名命令本身不动（与 did 前缀逻辑同理，刚收敛过）。
 *
 * 2026-10-01 批（账号页「切换账号」重排）新增两个单一源（实现=ui-kit accountDisplay，
 * 本文件 re-export——home 经 @wsui/lib/accountDisplay 照常消费）：
 *   - accountTail：全页尾号唯一格式 `…尾4`（顶栏/卡片/下拉菜单/列表一律经它）
 *   - credText：本机凭据状态文案——role 是「本机对该账号持有什么凭据」不是账号属性，
 *     不再用「主设备/分身」短词当徽章（语义错位收敛的设计定稿文案）。
 */

/** 后端「无名字」哨兵——历史上创建/读取兜底都写这个字面量。 */
const NAMELESS_SENTINEL = '有灵账号'

// 实现单一源=ui-kit（phone 经 @myco/accountDisplay 消费同一份；env/ui 无 @myco alias 走相对路径）
export { accountTail, credText } from '../../../../../packages/ui-kit/src/accountDisplay'
import { accountTail } from '../../../../../packages/ui-kit/src/accountDisplay'

/** 昵称原值清洗：空/哨兵 → ''，其余 trim 原样。 */
export function nicknameValue(name: string | null | undefined): string {
  const t = (name ?? '').trim()
  return t && t !== NAMELESS_SENTINEL ? t : ''
}

/** 账号显示名：空/哨兵 →「未命名」。 */
export function accountDisplayName(name: string | null | undefined): string {
  return nicknameValue(name) || '未命名'
}

/** 账号短标（顶栏/卡片/登录完成屏）：`昵称 ·…尾4`——did 全文只留公钥行一处。 */
export function accountShortLabel(name: string | null | undefined, did: string): string {
  const tail = accountTail(did)
  return tail ? `${accountDisplayName(name)} ·${tail}` : accountDisplayName(name)
}
