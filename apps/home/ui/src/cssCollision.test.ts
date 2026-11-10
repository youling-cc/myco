/**
 * CSS 类名冲突护栏（2026-10-11 事故→测试沉淀）
 *
 * 事故（用户实测："账号名首字母 C 像被白色遮挡 / 上下被两条斜线切去一块"）：
 *   index.html 内联了一段 agent/fleet 面板 CSS（同文档全局生效），其中
 *   `.st { width:7px; height:7px; border-radius:50%; flex-shrink:0 }`
 *   与 demo.css 的 `.demo-topbar .st`（账号名元素，带 overflow:hidden）**撞名** ⇒
 *   账号名元素同时吃到 border-radius:50% + overflow:hidden ⇒ 208×21 的**椭圆裁切框**
 *   把文字左端（首字母）上下切掉，且 J/2/6 等靠中间的字母几乎不受影响——极难辨认。
 *
 * 该测试把"两份样式表的类名交集"锁成白名单：出现新交集即失败，强制改名或显式确认。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ROOT = resolve(HERE, '..')

/** 提取样式文本里所有 class 选择器中出现的类名 */
function classNames(cssText: string): Set<string> {
  const noComment = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Set<string>()
  // 逐条规则取选择器部分（到 { 为止）
  for (const m of noComment.matchAll(/([^{}]+)\{/g)) {
    for (const sel of m[1].split(',')) {
      const s = sel.trim()
      if (!s || s.startsWith('@')) continue
      for (const c of s.matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(c[1])
    }
  }
  return out
}

/** 已知并存的同名类（经审计确认无害：两边的声明互不冲突或被更高优先级覆盖） */
const BENIGN_OVERLAP = new Set(['dot', 'logo', 'on', 'small', 'sub'])

describe('CSS 类名冲突护栏（index.html 内联 vs demo.css）', () => {
  it('两份样式表不得出现白名单外的新同名类（.st 事故的护栏）', () => {
    const html = readFileSync(resolve(UI_ROOT, 'index.html'), 'utf-8')
    const demo = readFileSync(resolve(UI_ROOT, 'src', 'demo.css'), 'utf-8')

    const inlineStyles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .join('\n')

    const a = classNames(inlineStyles)
    const b = classNames(demo)
    const overlap = [...a].filter((c) => b.has(c))

    const unexpected = overlap.filter((c) => !BENIGN_OVERLAP.has(c)).sort()
    expect(
      unexpected,
      `index.html 内联 CSS 与 demo.css 出现新同名类：${unexpected.join(', ')}\n` +
        `（历史事故：.st 撞名 → border-radius:50% + overflow:hidden = 椭圆裁切，切掉账号名首字母）\n` +
        `修法：把类名改唯一（如账号名已改 .acct-name），或确认无害后加入 BENIGN_OVERLAP 白名单。`,
    ).toEqual([])
  })

  it('账号名元素不得再用 .st 类名（事故直接回归位）', () => {
    const demoRaw = readFileSync(resolve(UI_ROOT, 'src', 'demo.css'), 'utf-8')
    const demo = demoRaw.replace(/\/\*[\s\S]*?\*\//g, '') // 剥注释（注释里会提到 .st 事故）
    const app = readFileSync(resolve(UI_ROOT, 'src', 'App.tsx'), 'utf-8')
    // demo.css 里不得再有裸 .st 规则（.st-wrap 不算）
    const bareSt = [...demo.matchAll(/\.st\s*[{,:]/g)].length
    expect(bareSt, 'demo.css 不应再定义裸 .st 规则（会与 index.html 内联 .st 撞名）').toBe(0)
    // App.tsx 不得再把账号名 span 标成 st
    expect(/className="st"/.test(app), 'App.tsx 不应再出现 className="st"').toBe(false)
    // 账号名应使用改名后的类
    expect(/acct-name/.test(demo), 'demo.css 应有 .acct-name 规则').toBe(true)
    expect(/className="acct-name"/.test(app), 'App.tsx 账号名应用 className="acct-name"').toBe(true)
  })
})
