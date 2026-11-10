/** 孢子系图标 —— 菌光视觉语言的图标族（2026-09-05 定稿）。
 * 16×16 / 描边 1.5 / 每枚恰含一粒紫色孢子点（fill var(--spore)）。
 * JSX inline path（不用 symbol/use：老 WebView、跨文档引用、Shadow DOM 都有坑）；
 * 描边 stroke=currentColor —— 着色交给 CSS color；孢子点是固定紫，不跟 currentColor。
 * 几何来源：docs/myco-strategy/ued/myco-home-narrow-demo.html（已视觉验收）。
 */
import type { CSSProperties } from 'react'

export type IconProps = { size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }

const S = ({ size = 16, strokeWidth = 1.5, className, style, children }: IconProps & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}
    style={{ flexShrink: 0, ...style }} aria-hidden="true">{children}</svg>
)
const Spore = ({ cx, cy, r = 1.2 }: { cx: number; cy: number; r?: number }) => (
  <circle cx={cx} cy={cy} r={r} fill="var(--spore, #A78BFA)" stroke="none" />
)

/** 探索 —— 指南针，芽形指针（探索横幅/youling 之门） */
export const IconExplore = (p: IconProps) => (
  <S {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M10.9 5.1 C11 4.8 10.7 4.6 10.5 4.8 L8.4 7.7 L5.4 9.9 C5.1 10.1 5.4 10.5 5.7 10.3 L8.3 8.2 Z" fill="currentColor" stroke="none" />
    <Spore cx={8} cy={8} />
  </S>
)
/** 搜索 —— 3/4 弧缺口（孢子从缺口逃逸） */
export const IconSearch = (p: IconProps) => (
  <S {...p}>
    <path d="M8 2.6 A5.4 5.4 0 1 0 13.2 9.4" />
    <path d="M12.2 12.2 L14.2 14.2" />
    <Spore cx={12.6} cy={5} />
  </S>
)
/** 舰队 —— 三点菌丝串联（设备编队） */
export const IconFleet = (p: IconProps) => (
  <S {...p}>
    <path d="M2.5 12 C5 10.5 5.8 7.2 8.8 7 C11 6.9 11.8 5.4 13.8 4.2" />
    <circle cx="3.2" cy="11.6" r="1" />
    <circle cx="13.5" cy="4.3" r="1" />
    <Spore cx={8.8} cy={7} r={1.5} />
  </S>
)
/** 设置 —— 六点菌群围一核 */
export const IconSettings = (p: IconProps) => (
  <S {...p}>
    <circle cx="8" cy="3.2" r="1" /><circle cx="12.2" cy="5.4" r="1" /><circle cx="12.2" cy="10.6" r="1" />
    <circle cx="8" cy="12.8" r="1" /><circle cx="3.8" cy="10.6" r="1" /><circle cx="3.8" cy="5.4" r="1" />
    <Spore cx={8} cy={8} r={1.7} />
  </S>
)
/** 灯 —— 菌伞+发光点（灯墙） */
export const IconLamp = (p: IconProps) => (
  <S {...p}>
    <path d="M3 8.2 A5 5 0 0 1 13 8.2 L13 8.8 L3 8.8 Z" fill="currentColor" stroke="none" />
    <Spore cx={8} cy={11.4} r={1.3} />
  </S>
)
/** 月 —— 弦月（主题切换：夜态显示，暖金由外层 color 控制） */
export const IconMoon = (p: IconProps) => (
  <S {...p}>
    <path d="M13 9.5 A5.5 5.5 0 1 1 7 2.8 A4.6 4.6 0 0 0 13 9.5 Z" fill="currentColor" stroke="none" />
  </S>
)
/** 日 —— 四向光线（主题切换：晨态显示） */
export const IconSun = (p: IconProps) => (
  <S {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5" />
    <Spore cx={8} cy={8} r={1} />
  </S>
)
/** 箭头 —— 行尾指引 */
export const IconArrow = (p: IconProps) => (
  <S {...p}>
    <path d="M2.5 8 H12 M9 4.8 L12.4 8 L9 11.2" />
  </S>
)
/** PC —— 主设备（屏中一粒孢子=屏幕上的小生命） */
export const IconPc = (p: IconProps) => (
  <S {...p}>
    <rect x="2.5" y="3" width="11" height="8" rx="1.2" />
    <path d="M6 13.5 H10 M8 11 V13.5" />
    <Spore cx={8} cy={7} />
  </S>
)
/** 手机 —— 旁挂设备 */
export const IconPhone = (p: IconProps) => (
  <S {...p}>
    <rect x="4.5" y="2" width="7" height="12" rx="1.6" />
    <path d="M7 12.8 H9" />
    <Spore cx={8} cy={7} />
  </S>
)
/** 笔记本 —— 协作设备 */
export const IconLaptop = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="10" height="6.5" rx="1" />
    <path d="M2 12.5 H14" />
    <Spore cx={8} cy={7.2} />
  </S>
)
