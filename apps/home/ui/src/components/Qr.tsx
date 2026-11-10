/** Qr — DID 出示二维码 + 图片解码（与 phone 端 qr.ts 对等；设计见 design/08-identity/AUTH-DID-QR.md）。
 *  注意：jsqr 只能动态导入（QrCamera 也是动态）——静态+动态混用会让 rollup 分块成循环引用（TDZ 崩溃）。 */
import { useEffect, useState } from 'react'
// qrcode-generator：纯 ESM 无依赖。别用 `qrcode`（CJS，拖 buffer/stream polyfill，
// CJS↔ESM 互操作在打包后初始化顺序错乱 → TDZ "before initialization" 崩溃）。
import qrcode from 'qrcode-generator'

export function QrImage({ text, size = 150 }: { text: string; size?: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let dead = false
    try {
      const qr = qrcode(0, 'M')
      qr.addData(text)
      qr.make()
      const u = qr.createDataURL(4, 4)
      if (!dead) setUrl(u)
    } catch { /* 内容过长等 */ }
    return () => { dead = true }
  }, [text, size])
  if (!url) return <div style={{ width: size, height: size }} />
  return <img src={url} width={size} height={size} alt="DID 二维码" className="rounded-lg bg-white p-1.5 block mx-auto" />
}

/** 从图片文件解 QR（WebView2 无摄像头 API 时的主路径）。解不出 → null。 */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file)
    const cv = document.createElement('canvas')
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height))
    cv.width = Math.round(bmp.width * scale)
    cv.height = Math.round(bmp.height * scale)
    const ctx = cv.getContext('2d')!
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height)
    const img = ctx.getImageData(0, 0, cv.width, cv.height)
    const jsQR = (await import('jsqr')).default
    return jsQR(img.data, img.width, img.height)?.data ?? null
  } catch { return null }
}

/** 解析扫码内容：JSON {type:'myco-add',did,name?} 或裸 did:myco: 文本；非法 → null。 */
export function parseAddPayload(text: string): { did: string; name?: string } | null {
  const t = (text || '').trim()
  if (!t) return null
  const ok = (d: string) => /^did:myco:[1-9A-HJ-NP-Za-km-z]{20,}$/.test(d)
  try {
    const j = JSON.parse(t)
    if (j?.type === 'myco-add' && typeof j.did === 'string' && ok(j.did)) {
      return { did: j.did, name: typeof j.name === 'string' && j.name ? j.name.slice(0, 32) : undefined }
    }
    return null
  } catch {
    return ok(t) ? { did: t } : null
  }
}
