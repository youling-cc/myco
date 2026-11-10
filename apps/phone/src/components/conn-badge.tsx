/**
 * conn-badge.tsx — 设备列表「连接方式」徽标（2026-10-11 设计定稿：图标+文字）。
 *
 * 设计对齐 PC/DSH 页面底部的连接指示器（apps/home dsh_share.rs 的
 * `conn_status_snippet`）：
 *   · 直连 = ⚡闪电（绿）+「直连」
 *   · 中转 = ☁白云 +「中转」
 *   · 连接中 = 旋转图标 +「连接中」
 * 同款 SVG path / 旋转动画（1.1s 线性循环 + prefers-reduced-motion 关动画），
 * 配色按手机浅色卡片微调（云端填充改成浅灰蓝——原版白云是压在深色页面上的）。
 */
import type { ReactNode } from 'react'

/** 徽标三态。 */
export type ConnBadgeMode = 'direct' | 'relay' | 'connecting'

/** 直连探测结果（Pairing.probeDirect 的状态值）。 */
export type DirectProbe = 'probing' | 'ok' | 'fail' | undefined

/**
 * 探测/连接状态 → 徽标模式（纯函数，单测锁）。
 * 优先级：vnet 实际路径（2026-11-06 目标⑥，最权威）> 正在连接 > 有直连能力
 * （WebRTC 或探测 ok）> 中转 > 连接中（探测中/未知）。
 *
 * vnetPath 是 myco vnet 客户端状态文件里的 `path=` 值（"P2P IPv6"/"P2P UDP"/
 * "Relay"）——隧道真正走哪条路由它说了算，老的 HTTP /ping 探测只是"v6 可达性"
 * 的近似。有了它徽标不再骗人（例：探测 ok 但隧道实际走了中继）。
 */
export function connBadgeMode(
  probe: DirectProbe,
  webrtc: boolean | null | undefined,
  connecting: boolean,
  vnetPath?: string,
): ConnBadgeMode {
  if (vnetPath) {
    const p = vnetPath.toUpperCase()
    if (p.includes('P2P')) return 'direct'
    if (p.includes('RELAY')) return connecting ? 'connecting' : 'relay'
  }
  if (connecting) return 'connecting'
  if (probe === 'ok' || webrtc) return 'direct'
  if (probe === 'fail') return 'relay'
  return 'connecting' // probing / 未知：还在试
}

/** 从 EnvServer `{"act":"vnet"}` 的 status 文本里解析 `path=` 行（无则 undefined）。 */
export function vnetPathFromStatusText(status: string | undefined | null): string | undefined {
  if (!status) return undefined
  const m = /(?:^|\n)path=(.*)/.exec(status)
  return m ? m[1].trim() : undefined
}

/** 徽标文字（用户口径：直连 / 中转 / 连接中）。 */
export const CONN_BADGE_TEXT: Record<ConnBadgeMode, string> = {
  direct: '直连',
  relay: '中转',
  connecting: '连接中',
}

/** 徽标悬浮提示（一句话说清数据走哪条路——与 conn_status_snippet 的 TT 同源语感）。 */
const CONN_BADGE_TITLE: Record<ConnBadgeMode, string> = {
  direct: '端到端直连（IPv6/打洞）· 数据不过任何服务器',
  relay: '云端中转 · 加密转发，服务器看不到内容',
  connecting: '正在建立连接…优先直连，不通自动切换云端',
}

/** 三枚图标（与 conn_status_snippet 同款 path；云端配色按浅色底调）。 */
const ICONS: Record<ConnBadgeMode, ReactNode> = {
  direct: (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 3 14h7l-1 8 12-14h-7l1-6z" fill="#1f9d55" />
    </svg>
  ),
  relay: (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M17.5 19a4.5 4.5 0 0 0 .38-8.98 6 6 0 0 0-11.4-1.4A5 5 0 0 0 7 19h10.5z"
        fill="#e3eaf6"
        stroke="#8a97ab"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  connecting: (
    <svg className="myco-conn-spin" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#94a3b8" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 3v18" />
        <path d="M4.2 7.5l15.6 9" />
        <path d="M19.8 7.5l-15.6 9" />
      </g>
    </svg>
  ),
}

/** 旋转动画样式（幂等注入；与 FriendsPanel 的 mycoSpin 同款 1.1s 线性循环）。 */
const CONN_STYLE_ID = 'myco-conn-badge-style'
function ensureConnStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CONN_STYLE_ID)) return
  const st = document.createElement('style')
  st.id = CONN_STYLE_ID
  st.textContent = `
@keyframes mycoConnRot { to { transform: rotate(360deg) } }
.myco-conn-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 8px;
  border-radius:999px; background:rgba(15,23,42,.05); border:1px solid rgba(15,23,42,.08);
  font:11px/1.2 system-ui,"Segoe UI",sans-serif; font-weight:600; color:#475569;
  user-select:none; -webkit-user-select:none; white-space:nowrap }
.myco-conn-badge svg { display:block; flex:none }
.myco-conn-spin { animation: mycoConnRot 1.1s linear infinite; transform-origin: 50% 50% }
@media (prefers-reduced-motion: reduce) { .myco-conn-spin { animation: none } }
`
  document.head.appendChild(st)
}

/** 徽标组件（图标+文字，同一 pill 里）。 */
export function ConnBadge({ mode }: { mode: ConnBadgeMode }): ReactNode {
  ensureConnStyle()
  return (
    <span className="myco-conn-badge" title={CONN_BADGE_TITLE[mode]}>
      {ICONS[mode]}
      <span>{CONN_BADGE_TEXT[mode]}</span>
    </span>
  )
}
