/**
 * 任务卡宽度钳制护栏（2026-10-13 用户截图经验沉淀）。
 *
 * 事故：TaskCard 写死 width:236，而气泡行内容 wrapper 有 maxWidth:78%——
 * 窄窗（320 CSS px）时 78%≈228px，236px 的卡从 wrapper 右缘溢出 8px，
 * 正好垫到「我」头像下面（用户截图实锤）。手机端当时已修，PC 端 ChatBubble 漏网。
 *
 * 本护栏钉死：TaskCard 的固定宽必须伴随 maxWidth:'100%' 钳制。
 * 布局级 rect 量测（含变异自证）见 preview/verify-taskcard.mjs：
 *   npx vite --port 5199 → node preview/verify-taskcard.mjs
 *   修复后 overlap=-7px（通过）；摘掉钳制 overlap=+1.25px（复现事故）。
 */
import { describe, it, expect } from 'vitest'
import raw from './ChatBubble.tsx?raw'

describe('任务卡宽度钳制（PC 端漏网事故护栏）', () => {
  it('TaskCard 固定宽 236 必须带 maxWidth:100% 钳制（否则窄窗压到头像）', () => {
    expect(raw).toMatch(/width: 236,\s*maxWidth: '100%'/)
  })
})
