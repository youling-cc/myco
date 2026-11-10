/** isValidDid / copyDidVerified 单测——双端同内容（home/ui 与 phone 各一份）。
 *  2026-10-10 canonical-only：legacy（裸 base58 尾段）已废止 → 一律拦截。 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isValidDid, copyDidVerified, copyDidToastText } from './didCheck'

/** 无 0/O/I/l 的 base58 风格占位串。 */
const b58 = (n: number) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXY'.repeat(Math.ceil(n / 52)).slice(0, n)

describe('isValidDid · canonical 长度窗+字母表双校验', () => {
  it('合法 canonical（z6Mk 开头，body 47 字符）', () => {
    expect(isValidDid('did:myco:z6Mk' + b58(43))).toBe(true)   // 4+43=47
    expect(isValidDid('did:youling:z6Mk' + b58(44))).toBe(true) // 4+44=48
  })
  it('legacy（裸 base58 32B，body 42~44 字符）已废止 → 拦截（不支持的 did 格式）', () => {
    expect(isValidDid('did:myco:' + b58(43))).toBe(false)
    expect(isValidDid('did:youling:' + b58(44))).toBe(false)
    expect(isValidDid('did:myco:' + b58(42))).toBe(false)
  })
  it('46 字符残缺 canonical 串（复制丢字）→ 拦截', () => {
    expect(isValidDid('did:myco:z6Mk' + b58(42))).toBe(false) // 4+42=46
    expect(isValidDid('did:myco:z6Mk' + b58(40))).toBe(false) // 丢更多同理
  })
  it('无 z 前缀且长度窗外（45 字符）→ 拦截', () => {
    expect(isValidDid('did:myco:' + b58(45))).toBe(false)
  })
  it('带 base58 字母表外非法字符（0/O/I/l）→ 拦截', () => {
    expect(isValidDid('did:myco:z6Mk' + b58(39) + '0')).toBe(false)
    expect(isValidDid('did:myco:z6Mk' + b58(39) + 'O')).toBe(false)
    expect(isValidDid('did:myco:z6Mk' + b58(39) + 'I')).toBe(false)
    expect(isValidDid('did:myco:z6Mk' + b58(39) + 'l')).toBe(false)
    expect(isValidDid('did:myco:' + b58(42) + '0')).toBe(false)
  })
  it('空串 / 前缀不对 / 含空格 → 拦截', () => {
    expect(isValidDid('')).toBe(false)
    expect(isValidDid('   ')).toBe(false)
    expect(isValidDid('did:key:z6Mk' + b58(43))).toBe(false)
    expect(isValidDid('did:myco:' + b58(21) + ' ' + b58(21))).toBe(false)
  })
  it('首尾空白容忍（粘贴常带换行/空格）', () => {
    expect(isValidDid('  did:myco:z6Mk' + b58(43) + '\n')).toBe(true)
  })
})

describe('copyDidVerified · 复制前校验+回读比对', () => {
  const good = 'did:myco:z6Mk' + b58(43)
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  function stubClipboard(read?: () => Promise<string>) {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: read ? vi.fn().mockImplementation(read) : vi.fn().mockResolvedValue(good),
      },
    })
  }
  it('非法 did 禁止复制（writeText 根本不调用）', async () => {
    stubClipboard()
    expect(await copyDidVerified('did:myco:z6Mk' + b58(42))).toBe('invalid')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
  it('回读一致 → ok', async () => {
    stubClipboard(() => Promise.resolve(good))
    expect(await copyDidVerified(good)).toBe('ok')
  })
  it('回读不一致（丢字）→ mismatch，toast 提示核对尾部', async () => {
    stubClipboard(() => Promise.resolve(good.slice(0, -2)))
    expect(await copyDidVerified(good)).toBe('mismatch')
    expect(copyDidToastText('mismatch')).toBe('复制可能不完整，请粘贴后核对尾部字符')
  })
  it('readText 权限失败（NotAllowedError）→ 降级 ok 不阻塞', async () => {
    stubClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    expect(await copyDidVerified(good)).toBe('ok')
  })
  it('writeText 失败 → failed', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('x')), readText: vi.fn() } })
    expect(await copyDidVerified(good)).toBe('failed')
    expect(copyDidToastText('invalid')).toBe('识别码异常（长度不符），请重启登录器后重试，仍异常请反馈')
  })
})
