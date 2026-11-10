/**
 * accountDisplay（ui-kit 单一源）— 2026-10-01 账号页「切换账号」重排新增的跨端显示函数。
 *
 * 账号昵称兜底链（nicknameValue/accountDisplayName/accountShortLabel）的实现主体在
 * env/ui/src/lib/accountDisplay.ts（home 经 @wsui 直引）与 phone/src/identity.ts
 * （同源约定副本）——那两个文件 re-export 本文件的 accountTail/credText，保证
 * 这两个新函数实现只有一份（文案/格式改动一处生效三端）。
 */

/** 账号尾号（全页唯一格式 `…尾4`）：空 did → ''（调用方据此只显示昵称）。 */
export function accountTail(did: string | null | undefined): string {
  const t = (did ?? '').trim()
  return t ? `…${t.slice(-4)}` : ''
}

/**
 * 本机凭据状态文案（2026-10-01 设计定稿；2026-10-06 命名收口：分身→成员）：
 *   种子槽在（embodiment）→「本机持有账号钥匙」
 *   委任状在（agent）→「受委任的成员」
 *   都无（lost）→「凭据已失」
 * role 是「本机对该账号持有什么凭据」不是账号属性——不用「主设备/成员」角色名词
 * 当徽章（徽章在账号页顶部卡单独表达，此处是凭据状态长文案）。
 * 命名依据：NAMING-RATIONALE.md——角色定稿=主设备/成员；「分身」被保留给多 Soul 概念。
 */
export function credText(role: string | null | undefined): string {
  if (role === 'embodiment') return '本机持有账号钥匙'
  if (role === 'agent') return '受委任的成员'
  return '凭据已失'
}
