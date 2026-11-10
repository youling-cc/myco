/** QrCamera — 实时摄像头扫码（安全上下文才可用：WebView2 的 tauri.localhost 是 https）。
 *  500ms 一帧 jsQR 解码，命中即回调并关闭。与 phone 端 QrCamera 同构。
 *  err 分支（2026-09-30 重做）：无摄像头/拒权限/被占用分型友好提示（ui-kit cameraError 单一源），
 *  浅色卡片替代黑底红字——PC 无摄像头是常态不是错误态。入口已由 MycoDevices liveScan 预检把守。 */
import { useEffect, useRef, useState } from 'react'
// ui-kit 单一源（2026-10-06 随 env 退役迁入 home/ui——相对路径深度不变，同 scanAddOrder 先例）
import { cameraErrorHint } from '../../../../../packages/ui-kit/src/cameraError'

export function QrCamera({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<unknown>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let dead = false
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (dead) { stream.getTracks().forEach((t) => t.stop()); return }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        const jsQR = (await import('jsqr')).default
        const cv = document.createElement('canvas')
        const ctx = cv.getContext('2d')!
        timer = setInterval(() => {
          if (!videoRef.current || video.readyState !== video.HAVE_ENOUGH_DATA) return
          cv.width = video.videoWidth
          cv.height = video.videoHeight
          ctx.drawImage(video, 0, 0)
          const img = ctx.getImageData(0, 0, cv.width, cv.height)
          const res = jsQR(img.data, img.width, img.height)
          if (res?.data) {
            dead = true
            if (timer) clearInterval(timer)
            stream?.getTracks().forEach((t) => t.stop())
            onResult(res.data)
          }
        }, 500)
      } catch (e) {
        setErr(e)
      }
    })()
    return () => {
      dead = true
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [onResult])

  // err：浅色卡片（不再整屏黑底红字），inline 覆写防 home.css `.sec button` 压紫
  if (err !== null) {
    const h = cameraErrorHint(err)
    return (
      <div className="rounded-lg border border-[var(--chrome-border)] bg-white/80 px-3 py-3 space-y-1.5">
        <div className="text-center text-[12px] font-semibold text-[var(--text-primary)]">📷 {h.title}</div>
        <div className="text-center text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {h.hint}{h.detail ? `（${h.detail}）` : ''}
        </div>
        <div className="text-center">
          <button onClick={onClose} className="linkish" style={{ fontSize: 11, background: 'none', color: '#6b7bff', padding: '2px 4px' }}>关闭</button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative rounded-lg overflow-hidden bg-black">
      <video ref={videoRef} className="w-full block" playsInline muted />
      <button onClick={onClose}
        className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded-md border-none bg-black/55 text-white">关闭</button>
    </div>
  )
}
