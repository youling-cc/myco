/**
 * DID 完整性校验 + 复制可靠性加固（2026-10-05 双端同修，与 apps/home/ui/src/didCheck.ts 同内容）。
 *
 * 背景：用户用「复制本机识别码」复制的设备 DID 曾丢 2 字符（服务端旧代码派生残缺串，已修）。
 * 防御层：canonical 长度窗 + base58 字母表双校验拦住残缺串——复制前禁止非法串出门，
 * 粘贴输入框实时红边提示，发送按钮保持禁用（Rust 侧 chat_add_friend 仍有兜底）。
 *
 * 2026-10-10：**canonical-only**——legacy（裸 base58 尾段）已废止，不再是"合法识别码"
 * （本函数是 UI 侧的就地拦截，非解码入口；解码判定唯一真源 = `didUtil.didPubkeyBytes`）。
 */

/** `did:myco:` / `did:youling:` 前缀 + canonical base58 载荷长度窗校验（**canonical-only**）。
 *  2026-10-10 系统拍板：legacy（尾段裸 base58 32B，43~44 字符）**已废止**——不再当
 *  "合法识别码"放行（粘贴框/发送按钮/复制前就地拦下；真正的判定在 Rust/服务端，
 *  统一文案「不支持的 did 格式」）。canonical = `z` + base58(0xed 0x01 + 32B) ⇒ `z6Mk` 起 47~48 字符。 */
export function isValidDid(s: string): boolean {
  // did:myco: 或 did:youling: 前缀
  const m = /^did:(myco|youling):([A-Za-z0-9]+)$/.exec(s.trim())
  if (!m) return false
  const body = m[2]
  // canonical: z6Mk 开头且总长 z+46~48（34B base58 为 46-48 字符）
  if (body.startsWith('z6Mk')) return body.length >= 47 && body.length <= 48 && !body.includes('0') && !body.includes('O') && !body.includes('I') && !body.includes('l')
  // legacy（裸 base58 32B，43~44 字符）已废止：不支持的 did 格式 → 拦截（不再放行）
  return false
}

/** copyDidVerified 结果：
 *  - 'ok'       复制成功（含回读一致，或 WebView 无 readText 权限时降级为只写不比对）
 *  - 'invalid'  did 本身非法（长度/字符不符）——禁止复制
 *  - 'mismatch' 回读与写入不一致（复制可能不完整）
 *  - 'failed'   写剪贴板失败（非安全上下文等） */
export type CopyDidResult = 'ok' | 'invalid' | 'mismatch' | 'failed'

/** 复制 DID 并回读校验（writeText → readText 比对）。
 *  WebView 剪贴板 readText 权限失败（NotAllowedError 等）时降级为只 writeText 不比对，
 *  不阻塞正常使用；catch 里区分权限错误与不一致。 */
export async function copyDidVerified(did: string): Promise<CopyDidResult> {
  if (!isValidDid(did)) return 'invalid'
  try {
    await navigator.clipboard.writeText(did)
  } catch {
    return 'failed'
  }
  try {
    const got = await navigator.clipboard.readText()
    return got === did ? 'ok' : 'mismatch'
  } catch {
    // 读剪贴板权限被拒（WebView 常态）——降级：只写不比对，视为成功
    return 'ok'
  }
}

/** copyDidVerified 结果 → 统一 toast 文案。 */
export function copyDidToastText(r: CopyDidResult): string {
  if (r === 'invalid') return '识别码异常（长度不符），请重启登录器后重试，仍异常请反馈'
  if (r === 'mismatch') return '复制可能不完整，请粘贴后核对尾部字符'
  if (r === 'failed') return '复制失败，请重试'
  return '已复制 ✓'
}
