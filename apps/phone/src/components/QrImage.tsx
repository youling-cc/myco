/** QrImage — 出示侧二维码（DID 载荷 → img）。 */
import { useEffect, useState } from 'react'
import { qrDataUrl } from '../qr'

export function QrImage({ text, size = 190 }: { text: string; size?: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let dead = false
    qrDataUrl(text, size * 2).then((u) => { if (!dead) setUrl(u) }).catch(() => {})
    return () => { dead = true }
  }, [text, size])
  if (!url) return <div style={{ width: size, height: size, margin: '0 auto' }} />
  return (
    <img src={url} width={size} height={size} alt="本机 DID 二维码"
      style={{ borderRadius: 10, background: '#fff', padding: 8, display: 'block', margin: '0 auto' }} />
  )
}
