/**
 * qr.ts — DID 出示/扫码的 QR 编解码（设计见 design/08-identity/AUTH-DID-QR.md）。
 * QR 只是 DID 的图形化搬运，不含新信任语义：扫到 = 复制粘贴了 DID。
 */
import qrcode from 'qrcode-generator' // 纯 ESM；`qrcode`(CJS) 的 polyfill 图在打包后引发 TDZ
import jsQR from 'jsqr' // 静态 import：动态 import('jsqr') 经 vite 产出的 chunk 导出是
                        // {j:{default:fn}}(CJS interop 打包 bug)，`.default` 实测 undefined，
                        // 识别管线从未真正通过(2026-09-04 图库识别排障坐实)

export interface AddPayload { v: 1; type: 'myco-add'; did: string; name?: string }

/** 出示侧载荷：精简格式 `{t:'a',d:<did 无前缀>,m?:name}`（2026-10-09）。
 *  与 PC 邀请码同策：短字段名 + did 去 `did:myco:` 前缀——二维码每少一字符都降一档
 *  密度，直接决定手机镜头能否识别（用户实测"扫不动"根因）。解析侧兼容旧全名格式。 */
export function buildAddPayload(did: string, name?: string): string {
  return JSON.stringify({
    t: 'a',
    d: (did || '').replace(/^did:(myco|youling):/, ''),
    ...(name ? { m: name } : {}),
  })
}

/** 解析扫码内容：JSON payload 或裸 did:myco: 文本都接受；非法 → null。 */
export function parseAddPayload(text: string, validDid: (did: string) => boolean): { did: string; name?: string } | null {
  const p = parseQrPayload(text, validDid)
  return p?.kind === 'add' ? { did: p.did, name: p.name } : null
}

export type QrPayload =
  | { kind: 'add'; did: string; name?: string }                                    // 设备出示：把我加进你的账号
  | { kind: 'invite'; did: string; nonce: string; exp?: number; name?: string }    // 主设备邀请：扫我 → 投你的 DID 给我

/** 通用扫码解析：精简格式（2026-10-09）/ 旧全名格式 / 裸 DID 文本 —— 全兼容。 */
export function parseQrPayload(text: string, validDid: (did: string) => boolean): QrPayload | null {
  const t = (text || '').trim()
  if (!t) return null
  /** 精简格式的 did 去掉了 method 前缀（省二维码密度）→ 解析时补回（默认 myco）。 */
  const withPrefix = (d: unknown): string => {
    const s = typeof d === 'string' ? d : ''
    if (!s) return ''
    return /^did:/.test(s) ? s : `did:myco:${s}`
  }
  try {
    const j = JSON.parse(t)
    // ── 精简格式（优先）：{t:'i'|'a', d:<did 可无前缀>, n?:nonce, e?:exp, m?:name} ──
    if (j?.t === 'i' || j?.t === 'a') {
      const did = withPrefix(j.d)
      if (!validDid(did)) return null
      const name = typeof j.m === 'string' && j.m ? j.m.slice(0, 32) : undefined
      if (j.t === 'a') {
        return { kind: 'add', did, ...(name ? { name } : {}) }
      }
      if (typeof j.n !== 'string' || !j.n) return null
      return {
        kind: 'invite', did, nonce: j.n,
        ...(typeof j.e === 'number' ? { exp: j.e } : {}),
        ...(name ? { name } : {}),
      }
    }
    // ── 旧全名格式（兼容存量二维码 / 已发出的文本）──
    if (j?.type === 'myco-add' && typeof j.did === 'string' && validDid(j.did)) {
      return { kind: 'add', did: j.did, name: typeof j.name === 'string' && j.name ? j.name.slice(0, 32) : undefined }
    }
    if (j?.type === 'myco-invite' && typeof j.did === 'string' && validDid(j.did) && typeof j.nonce === 'string' && j.nonce) {
      return {
        kind: 'invite', did: j.did, nonce: j.nonce,
        exp: typeof j.exp === 'number' ? j.exp : undefined,
        name: typeof j.name === 'string' && j.name ? j.name.slice(0, 32) : undefined,
      }
    }
    return null
  } catch {
    return validDid(t) ? { kind: 'add', did: t } : null
  }
}

/** 生成 QR dataURL（出示侧 img.src 用）。px 参数保留兼容旧调用，实际按 cellSize 出图。 */
export async function qrDataUrl(text: string, _px = 380): Promise<string> {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(5, 5)
}

/** 从图片文件解 QR（拍照/相册——http 非安全上下文没有摄像头 API 时的主路径）。解不出 → null。
 *  2026-10-09 用户实测：手机拍照的图带 **EXIF orientation**（竖拍存成横图），此前
 *  `createImageBitmap` 默认忽略 EXIF → 图被"躺倒/拉伸" → jsQR 识别不到（"相机没拍到图"）。
 *  修：`imageOrientation: 'from-image'` 尊重 EXIF 旋转（浏览器自动转正）。 */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const cv = document.createElement('canvas')
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height)) // 太大的图先缩，jsQR 更快更稳
    cv.width = Math.round(bmp.width * scale)
    cv.height = Math.round(bmp.height * scale)
    const ctx = cv.getContext('2d')!
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height)
    const img = ctx.getImageData(0, 0, cv.width, cv.height)
    return jsQR(img.data, img.width, img.height)?.data ?? null
  } catch { return null }
}

/** 摄像头实时扫描是否可用（仅安全上下文=https/localhost）。 */
export function canLiveScan(): boolean {
  try { return !!navigator.mediaDevices?.getUserMedia } catch { return false }
}
