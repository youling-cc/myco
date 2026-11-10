/**
 * restoreImport.ts — method 屏「恢复码导入」内联表单的纯逻辑（2026-09-30 批A）。
 *
 * 从 App.tsx 抽出的可测层：
 *   - normalizeRestoreText：三行恢复码（手抄带行号/换行/空格）→ 后端可解的单行形态
 *   - restoreFormReduce：表单状态机（展开/收起/输入/提交中/失败/成功）
 *   - submitRestoreImport：提交编排（空文本短路、调 store、错误原文透传）
 * UI（App.tsx）只剩 useReducer + 一行跳转接线。
 */

// ── 输入归一 ────────────────────────────────────────────────────────────────

/** 手抄/截图誊录的恢复码常带行号（"1." "2)" "3、"）与空白——逐行剥行号、去空白。 */
function stripLineNo(line: string): string {
  return line.replace(/^\s*\d+\s*[.)、:：]\s*/, '')
}

/**
 * 恢复码文本归一：
 *   - 加密备份（ct=/salt=/iv= 块）：保持行结构（后端按行解析 k=v），逐行 trim、剥行号
 *   - 明文种子 base64：可能按备份弹窗的三段折行誊抄——剥行号后拼成单行、去一切空白
 */
export function normalizeRestoreText(raw: string): string {
  const lines = raw.split('\n').map(stripLineNo).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  if (lines[0].startsWith('ct=')) return lines.join('\n')
  return lines.join('').replace(/\s+/g, '')
}

/** 后端错误原文透传（tauri invoke 的 Error 包装剥壳）。 */
export function restoreErrorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, '')
}

// ── 表单状态机 ──────────────────────────────────────────────────────────────

export interface RestoreFormState {
  /** 卡片是否已展开为表单 */
  open: boolean
  text: string
  password: string
  busy: boolean
  /** 失败原因（后端原文）；null=无错误 */
  error: string | null
}

export const restoreFormInit: RestoreFormState = {
  open: false,
  text: '',
  password: '',
  busy: false,
  error: null,
}

export type RestoreFormAction =
  | { type: 'toggle' }
  | { type: 'text'; v: string }
  | { type: 'password'; v: string }
  | { type: 'submit' }
  | { type: 'fail'; error: string }
  | { type: 'done' }

export function restoreFormReduce(s: RestoreFormState, a: RestoreFormAction): RestoreFormState {
  switch (a.type) {
    case 'toggle':
      // 展开/收起都清错误行——重开表单不背上次失败的残留
      return { ...s, open: !s.open, error: null }
    case 'text':
      return { ...s, text: a.v }
    case 'password':
      return { ...s, password: a.v }
    case 'submit':
      if (s.busy) return s
      if (!normalizeRestoreText(s.text)) return { ...s, error: '请粘贴恢复码' }
      return { ...s, busy: true, error: null }
    case 'fail':
      return { ...s, busy: false, error: a.error }
    case 'done':
      // 成功复位（App 随即跳 page 屏；表单回到初始态，下次进来是干净的）
      return restoreFormInit
  }
}

// ── 提交编排 ────────────────────────────────────────────────────────────────

/**
 * 调导入链路并归一结果。importFn = identityStore.importYouling（注入便于测试）。
 * 成功 { ok: true, rootDid }；失败 { ok: false, error }（error=后端原文，UI 红字直显）。
 */
export async function submitRestoreImport(
  input: { text: string; password: string },
  importFn: (text: string, password: string) => Promise<string>,
): Promise<{ ok: true; rootDid: string } | { ok: false; error: string }> {
  const text = normalizeRestoreText(input.text)
  if (!text) return { ok: false, error: '请粘贴恢复码' }
  try {
    const rootDid = await importFn(text, input.password)
    return { ok: true, rootDid }
  } catch (e) {
    return { ok: false, error: restoreErrorText(e) }
  }
}
