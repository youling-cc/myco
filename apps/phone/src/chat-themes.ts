/**
 * 聊天视图主题色系统 —— 多彩圆点切换，各区域（气泡/模型chip/背景光斑/pending边框）跟变。
 *
 * 顶部 title 栏只放 3 个快捷圆点（mac 三色圆圈风，QUICK_THEME_IDS）；
 * 设置里放完整调色板（CHAT_THEMES，彩虹 + 高级色）+ 自定义调色（customTheme）。
 * ChatView 根节点按当前主题 inline 设置 CSS 变量，样式引用 var()，切换即全局变。
 * 主题选择持久化在 uiStore（localStorage）。
 */

export interface ChatTheme {
  id: string
  name: string
  /** 主色（用户气泡/发送键/左色边渐变起点） */
  accent: string
  /** 渐变次色（渐变终点） */
  accent2: string
  /** 背景光斑 1（右上） */
  glow1: string
  /** 背景光斑 2（左下） */
  glow2: string
  /** 圆点切换器的显示色（渐变/纯色） */
  dot: string
}

/** 完整调色板（高级柔和色，参考 Tailwind 400/500 色阶，不刺眼）。 */
export const CHAT_THEMES: ChatTheme[] = [
  { id: 'blue',   name: '淡蓝',   accent: '#6b7bff', accent2: '#5567f5', glow1: 'rgba(139,92,246,.22)', glow2: 'rgba(59,130,246,.18)', dot: 'linear-gradient(135deg,#6b7bff,#3b82f6)' },
  { id: 'pink',   name: '淡粉',   accent: '#f472b6', accent2: '#ec4899', glow1: 'rgba(244,114,182,.22)', glow2: 'rgba(236,72,153,.16)', dot: 'linear-gradient(135deg,#f472b6,#ec4899)' },
  { id: 'green',  name: '淡绿',   accent: '#34d399', accent2: '#10b981', glow1: 'rgba(52,211,153,.20)', glow2: 'rgba(16,185,129,.16)', dot: 'linear-gradient(135deg,#34d399,#10b981)' },
  { id: 'red',    name: '淡红',   accent: '#f87171', accent2: '#ef4444', glow1: 'rgba(248,113,113,.22)', glow2: 'rgba(239,68,68,.16)', dot: 'linear-gradient(135deg,#fca5a5,#f87171)' },
  { id: 'orange', name: '暖橙',   accent: '#fb923c', accent2: '#f97316', glow1: 'rgba(251,146,60,.24)', glow2: 'rgba(249,115,22,.16)', dot: 'linear-gradient(135deg,#fb923c,#f97316)' },
  { id: 'amber',  name: '蜜黄',   accent: '#fbbf24', accent2: '#f59e0b', glow1: 'rgba(251,191,36,.26)', glow2: 'rgba(245,158,11,.16)', dot: 'linear-gradient(135deg,#fbbf24,#f59e0b)' },
  { id: 'cyan',   name: '青空',   accent: '#22d3ee', accent2: '#06b6d4', glow1: 'rgba(34,211,238,.22)', glow2: 'rgba(6,182,212,.16)', dot: 'linear-gradient(135deg,#22d3ee,#06b6d4)' },
  { id: 'violet', name: '紫罗兰', accent: '#a78bfa', accent2: '#8b5cf6', glow1: 'rgba(167,139,250,.24)', glow2: 'rgba(139,92,246,.18)', dot: 'linear-gradient(135deg,#a78bfa,#8b5cf6)' },
  { id: 'sunset', name: '日暮',   accent: '#fb7185', accent2: '#f43f5e', glow1: 'rgba(251,113,133,.22)', glow2: 'rgba(244,63,94,.16)', dot: 'linear-gradient(135deg,#fb7185,#f43f5e)' },
  { id: 'ocean',  name: '海洋',   accent: '#38bdf8', accent2: '#0ea5e9', glow1: 'rgba(56,189,248,.22)', glow2: 'rgba(14,165,233,.16)', dot: 'linear-gradient(135deg,#38bdf8,#0ea5e9)' },
  { id: 'mint',   name: '薄荷',   accent: '#2dd4bf', accent2: '#14b8a6', glow1: 'rgba(45,212,191,.22)', glow2: 'rgba(20,184,166,.16)', dot: 'linear-gradient(135deg,#2dd4bf,#14b8a6)' },
  { id: 'sakura', name: '樱花',   accent: '#f9a8d4', accent2: '#f472b6', glow1: 'rgba(249,168,212,.26)', glow2: 'rgba(244,114,182,.16)', dot: 'linear-gradient(135deg,#f9a8d4,#f472b6)' },
]

/** 顶部 title 栏快捷圆点（mac 三色圆圈风，按 R/G/B 顺序）。 */
export const QUICK_THEME_IDS = ['red', 'green', 'blue']

export const DEFAULT_THEME_ID = 'blue'

export function themeById(id: string | undefined): ChatTheme {
  return CHAT_THEMES.find((t) => t.id === id) ?? CHAT_THEMES[0]
}

/** 快捷圆点对应的主题（按 QUICK_THEME_IDS 顺序）。 */
export function quickThemes(): ChatTheme[] {
  return QUICK_THEME_IDS.map((id) => themeById(id))
}

// ── 自定义调色 ──

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(v, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
/** 变暗（factor 0-1，越小越暗）。 */
function darken(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor))
}
/** 加透明度。 */
function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

/** 自定义调色：给一个主色 hex，生成完整主题（渐变次色变暗 + 光斑透明化）。 */
export function customTheme(hex: string): ChatTheme {
  return {
    id: 'custom',
    name: '自定义',
    accent: hex,
    accent2: darken(hex, 0.14),
    glow1: alpha(hex, 0.22),
    glow2: alpha(hex, 0.16),
    dot: hex,
  }
}

/** 常见调色板（自定义区快捷选色，彩虹 + 中性高级色）。 */
export const PALETTE_SWATCHES = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#2dd4bf',
  '#22d3ee', '#60a5fa', '#6b7bff', '#a78bfa', '#e879f9', '#f472b6',
]
