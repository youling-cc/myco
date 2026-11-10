/**
 * legacyAccount.ts — 旧格式账号引导（2026-10-07 清档闸门立法）单一文案源 + 显隐判定。
 *
 * 背景（群体评审实锤）：旧格式 did（非 canonical）账号的名册自愈 /root/create 被服务端
 * 400 code=unsupported_did_format 一律拒建——此前客户端只 tracing::warn 静默，用户表现
 * 「加好友 403/搜不到」却毫无感知。core 侧已检出即停试并在 myco_status 透出
 * accountFormatLegacy；本文件是 UI 侧的文案与显隐单一源（账号页引导条/顶栏警示标共用，
 * 手机端同款文案见 apps/phone/src/identity.ts 注释对齐）。
 *
 * 两条出路（G2 区分，文案必须同时给到）：
 *   ① 注销重注册：**解绑本机账号**（危险区「解绑账号」折叠——输入"解绑"二字确认）
 *      后重新注册——新身份，旧好友链不可延续。（2026-10-08 用户实测修订：不再提
 *      「注销设备」——它只删设备身份不清账号，回来账号列表里旧格式账号仍在=死循环，
 *      且与「解绑」折叠的确认暗语（输入"解绑"）错位造成"输了注销没反应"的困惑。）
 *   ② 种子延续身份：先导出恢复码，重注册后用恢复码导入——同一把钥匙（canonical did），
 *      但旧格式 did 串的好友关系不随之迁移（服务端已清档）。
 */

/** 模态标题（PC/手机一致——2026-10-09 设计定稿：不说"旧格式"，说"格式无效，不支持"）。 */
export const LEGACY_FORMAT_TITLE = '格式无效，不支持'

/** 模态正文（PC/手机一致——一字不改，两端同步维护）。 */
export const LEGACY_FORMAT_BODY =
  '此账号的格式已失效，加好友、被搜索等功能不可用。重新注册会创建新账号（好友关系需重新建立）；想保留这把身份钥匙，可先导出恢复码，重新注册后导入。'

/** 模态按钮（PC/手机一致）。 */
export const LEGACY_FORMAT_ACTION = '清除此账号（回未关联态）'
export const LEGACY_FORMAT_ACTION_BACKUP = '先导出恢复码（去账号页备份）'

/** 顶栏警示短标（chip 形态，放账号名旁）。 */
export const LEGACY_FORMAT_CHIP = '⚠️ 格式无效'

/**
 * 引导条显隐：检出标记 + 本机有账号上下文（rootDid）才出——未关联/游客态谈不上
 * 「本账号旧格式」。数据源 myco_status.accountFormatLegacy（identityStore 投影）。
 */
export function shouldShowLegacyBanner(
  rootDid: string | null | undefined,
  accountFormatLegacy: boolean | undefined | null,
): boolean {
  return !!rootDid && !!accountFormatLegacy
}

/**
 * 「解绑账号」危险区的显隐（2026-10-08 用户实测 bug 的回归锁）。
 *
 * <p>背景：解绑成功后未关联态页面上仍渲染该区（红框"请先完成备份，再解绑。"——因
 * `accountBackedUp` 标记随解绑一并清除，文案恰好落在"未备份"分支，用户看起来像
 * "解绑没生效"）。根因有两个，缺一即复现：① 成功回调里没有收起（`unbindOpen` 残留）
 * ② 渲染条件只判 `unbindOpen`、不判身份态。本函数把两条一起钉住：
 * **必须处于具身态且有账号上下文**才可能显示——解绑后（role→unlinked / rootDid 空）
 * 无论 `unbindOpen` 是否被清都不会再渲染。
 *
 * @param unbindOpen 用户在危险区展开了「解绑账号」折叠
 * @param role       身份角色（'embodiment' 才是有账号可解绑的态）
 * @param rootDid    本机账号 did（无账号则 null/空）
 */
export function shouldShowUnbindPanel(
  unbindOpen: boolean,
  role: string | null | undefined,
  rootDid: string | null | undefined,
): boolean {
  return !!unbindOpen && role === 'embodiment' && !!rootDid
}
