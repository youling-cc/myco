/**
 * deep-link.ts — 深链接登录（DL-Auth）：处理 myco://auth?ticket=<t>&callback=<url>
 *
 * 2026-10-28 jason 定稿「直接做B」：手机浏览器 → myco:// 深链接 → myco 弹确认
 * → 签名 ticket → 回调浏览器登录。复用 explore.ts 的签名/出票链路。
 *
 * Android 侧（MainActivity.java）在 onPageFinished / onNewIntent 注入：
 *   window.__mycoDeepLink = "myco://auth?ticket=xxx&callback=yyy"
 *   window.dispatchEvent(new CustomEvent('myco-deep-link', {detail:{url:...}}))
 *
 * 安全边界：
 *   - callback 域名白名单（仅 youling.cc 系）
 *   - 用户必须点击确认（不自动签名）
 *   - ticket 一次性（服务端保证）
 */

import { openExternal } from './explore'
import { CALLBACK_HOSTS } from './config'

/** 解析 myco://auth URI → { ticket, callback } | null */
export function parseAuthDeepLink(url: string): { ticket: string; callback: string } | null {
  try {
    if (!url.startsWith('myco://auth')) return null
    const qs = url.split('?')[1] || ''
    const params = new URLSearchParams(qs)
    const ticket = params.get('ticket')
    const callback = params.get('callback')
    if (!ticket || !callback) return null
    return { ticket, callback }
  } catch { return null }
}

/** 验证 callback URL 域名在白名单内 */
export function isCallbackAllowed(callback: string): boolean {
  try {
    const u = new URL(callback)
    return CALLBACK_HOSTS.includes(u.hostname)
  } catch { return false }
}

/**
 * 初始化深链接监听（App.tsx 挂载时调用一次）。
 * 收到 myco://auth → 弹确认（React state 由调用方管理）→ 确认后签名+回调。
 */
export type DeepLinkAuthRequest = { ticket: string; callback: string }

export function initDeepLinkListener(
  onRequest: (req: DeepLinkAuthRequest) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { url?: string } | undefined
    const url = detail?.url || (window as unknown as { __mycoDeepLink?: string }).__mycoDeepLink
    if (!url) return
    const parsed = parseAuthDeepLink(url)
    if (!parsed) return
    if (!isCallbackAllowed(parsed.callback)) {
      console.warn('[deep-link] callback 域名不在白名单:', parsed.callback)
      return
    }
    onRequest(parsed)
  }
  window.addEventListener('myco-deep-link', handler as EventListener)
  // 兜底：如果 Android 在 JS 加载前就注入了（冷启动），读全局变量
  const existing = (window as unknown as { __mycoDeepLink?: string }).__mycoDeepLink
  if (existing) {
    const parsed = parseAuthDeepLink(existing)
    if (parsed && isCallbackAllowed(parsed.callback)) {
      // 延迟一拍让 UI 先渲染
      setTimeout(() => onRequest(parsed), 500)
    }
  }
  return () => window.removeEventListener('myco-deep-link', handler as EventListener)
}

/**
 * 确认后执行：签名 ticket → 提交平台 → 回调浏览器。
 * 返回 callback URL（带 autologin 参数）供调用方打开。
 */
export async function confirmDeepLinkAuth(
  ticket: string,
  callback: string,
  signFn: (ticket: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await signFn(ticket)
  if (!r.ok) return { ok: false, error: r.error || '签名失败' }
  // 拼接 autologin 参数
  const sep = callback.includes('?') ? '&' : '?'
  const url = `${callback}${sep}autologin=${encodeURIComponent(ticket)}`
  return { ok: true, url }
}

/** 打开回调 URL（浏览器登录） */
export function openAuthCallback(url: string): void {
  openExternal(url)
}
