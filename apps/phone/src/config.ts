/**
 * config.ts — 中央服务地址配置（开源准备 Phase 1）
 *
 * 所有 youling.cc 域名集中在此，通过 Vite env 变量覆盖：
 *   VITE_DID_BASE       → 身份服务（DID 注册/验签/信箱/委任状）
 *   VITE_NETWORK_URL   → 平台页（任务/探索/登录）
 *   VITE_DOWNLOADS_URL  → 下载面（发版/工具）
 *   VITE_RELAY_HOST     → P2P 中继服务器
 *
 * 默认指向官方 youling.cc 部署。自部署时在 .env 里覆盖即可。
 */

/** 身份服务基址 */
export const DID_BASE: string =
  (import.meta.env?.VITE_DID_BASE as string | undefined) ||
  'https://myco.youling.cc/myco-id'

/** 网络前端基址（任务广场/探索/登录） */
export const NETWORK_URL: string = (
  (import.meta.env?.VITE_NETWORK_URL as string | undefined) ||
  'https://www.youling.cc'
).replace(/\/+$/, '')

/** 下载面基址（发版/工具页） */
export const DOWNLOADS_URL: string = (
  (import.meta.env?.VITE_DOWNLOADS_URL as string | undefined) ||
  'https://myco.youling.cc'
).replace(/\/+$/, '')

/** P2P 中继服务器地址（host:port） */
export const RELAY_HOST: string =
  (import.meta.env?.VITE_RELAY_HOST as string | undefined) ||
  'myco.youling.cc:8321'

/** 工具页完整 URL */
export const TOOLS_URL = `${DOWNLOADS_URL}/downloads/tools.html`

/** 任务卡链接前缀（平台权威注册格式） */
export const TASK_CARD_URL_PREFIX = `${DOWNLOADS_URL}/task/`

/** callback 域名白名单（深链接登录安全检查） */
export const CALLBACK_HOSTS: string[] = (() => {
  const extra = (import.meta.env?.VITE_CALLBACK_HOSTS as string | undefined) || ''
  const base = new URL(NETWORK_URL).hostname
  const defaults = [
    base,
    base.replace(/^www\./, ''),
    ...(/^www\./.test(base) ? [`dev.${base.replace(/^www\./, '')}`] : []),
    ...(/^www\./.test(base) ? [`myco.${base.replace(/^www\./, '')}`] : []),
  ]
  if (extra) defaults.push(...extra.split(',').map(s => s.trim()).filter(Boolean))
  return [...new Set(defaults)]
})()
