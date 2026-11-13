/**
 * fnBodyOf — 按名字取一个函数/箭头函数的**完整声明体**（源码合同断言专用）。
 *
 * 为什么需要它（2026-11-11 经验沉淀）：
 * 源码合同断言曾用 `src.slice(src.indexOf('async function foo'), src.indexOf(...) + N)`
 * 按**字符数**截窗口。函数体一长（加几行注释、把同步桥换成异步桥），窗口就截不到
 * 被断言的那一行——测试变红但代码是对的（假警），删掉又失去看门狗。
 *
 * 这里改成：定位声明 → 配对参数括号 → 配对函数体的花括号，取到函数真正结束。
 * 扫描时跳过字符串/模板串/注释/正则字面量，避免它们里面的括号干扰配对。
 *
 * 支持这些形态（本仓实际出现的）：
 *   function foo(...) {}
 *   export async function foo(...) {}
 *   const foo = (...) => {}
 *   const foo = async (...) => {}
 */
export function fnBodyOf(src: string, name: string): string {
  const start = declStart(src, name)
  if (start < 0) throw new Error(`fnBodyOf: 找不到 ${name} 的声明`)
  const parenOpen = src.indexOf('(', start)
  if (parenOpen < 0) throw new Error(`fnBodyOf: ${name} 没有参数表`)
  const parenClose = matchPair(src, parenOpen, '(', ')')
  if (parenClose < 0) throw new Error(`fnBodyOf: ${name} 的参数表没闭合`)
  // 箭头函数：参数表之后先有 `=>`，再有函数体 `{`
  let braceOpen = src.indexOf('{', parenClose)
  const arrow = src.indexOf('=>', parenClose)
  if (arrow >= 0 && (braceOpen < 0 || arrow < braceOpen)) braceOpen = src.indexOf('{', arrow)
  if (braceOpen < 0) throw new Error(`fnBodyOf: ${name} 没有函数体`)
  const braceClose = matchPair(src, braceOpen, '{', '}')
  if (braceClose < 0) throw new Error(`fnBodyOf: ${name} 的函数体没闭合`)
  return src.slice(start, braceClose + 1)
}

/** 声明起点：函数声明优先，其次 const/let/var 箭头函数。 */
function declStart(src: string, name: string): number {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pats = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\s*\\(`),
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\(`),
  ]
  for (const re of pats) {
    const m = re.exec(src)
    if (m) return m.index
  }
  return -1
}

/** 从 from 处的开括号配对到闭括号；跳过字符串/注释/正则里的括号。 */
function matchPair(src: string, from: number, open: string, close: string): number {
  let depth = 0
  for (let i = from; i < src.length; i += 1) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(src, i, c)
      if (i < 0) return -1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return -1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2)
      if (i < 0) return -1
      i += 1
      continue
    }
    if (c === '/' && regexCanStartAfter(src, i)) {
      i = skipRegex(src, i)
      if (i < 0) return -1
      continue
    }
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 跳过一段引号字面量（含转义），返回收尾引号下标。模板串整体跳过（`${}` 内不算）。 */
function skipQuoted(src: string, i: number, quote: string): number {
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') {
      j += 1
      continue
    }
    if (src[j] === quote) return j
  }
  return -1
}

/** 跳过一段正则字面量（含转义与字符类），返回收尾 `/` 下标；不是正则则 -1。 */
function skipRegex(src: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j]
    if (c === '\\') {
      j += 1
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '\n') return -1
    else if (c === '/' && !inClass) return j
  }
  return -1
}

/** 除法 vs 正则：前一个非空白字符是运算符/开括号时按正则处理。 */
function regexCanStartAfter(src: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = src[j]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
    return '(,=:[!&|?{};+-*%<>~^'.includes(c)
  }
  return true
}
