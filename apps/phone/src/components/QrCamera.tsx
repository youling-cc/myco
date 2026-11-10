/**
 * QrCamera — 实时摄像头扫码（主流扫码界面形态：全屏取景 + 中央扫描框 + 四周遮罩 + 扫描线）。
 * 500ms 一帧 jsQR 解码，命中即回调并关闭。http 环境入口由调用方隐藏（只留"读图扫码"）。
 * onGallery 可选：取景界面右下角「图库」按钮（微信式相册位），传了才渲染。
 * 加载态来由(2026-09-20 用户实测)：裸 video 在摄像头流就绪前显示浏览器默认黑底+白色播放
 * 三角，极丑——loading 层盖住直到首帧 onLoadedData；扫码框 UI 为自绘(WebView 调不到系统扫码界面)。
 */
import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr' // 静态 import：动态 import('jsqr') 的 vite chunk 导出是 {j:{default}}，
                        // `.default` 实测 undefined——实时扫从未真正工作过(2026-09-04 排障坐实)
import { cameraErrorHint } from '@myco/cameraError' // 错误分型→友好文案单一源（ui-kit）

export function QrCamera({ onResult, onClose, onGallery }: {
  onResult: (text: string) => void
  onClose: () => void
  onGallery?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<unknown>(null) // 原始异常对象，渲染时经 cameraErrorHint 分型
  const [ready, setReady] = useState(false) // 首帧就绪（loading 遮罩淡出）

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
        const cv = document.createElement('canvas')
        const ctx = cv.getContext('2d')!
        timer = setInterval(() => {
          if (!videoRef.current || video.readyState !== videoRef.current.HAVE_ENOUGH_DATA) return
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

  return (
    // 2026-10-09 用户实测：QrCamera 此前固定 360px 高（小窗口，手机上取景框太小）。
    // 改**全屏**（100dvh，动态视口高——含地址栏收缩），点击后由调用方滚动到位。
    <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#0a0e14', height: '100dvh', minHeight: 420 }}>
      <style>{`@keyframes qr-sweep { 0%{top:8%} 50%{top:88%} 100%{top:8%} }`}</style>
      <video ref={videoRef} onLoadedData={() => setReady(true)}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }} playsInline muted />
      {/* 中央扫描窗：四角 L 标记 + 大 box-shadow 遮罩四周 + 扫描线（ready 后才显示，未就绪时下方有 loading 层） */}
      {ready && !err && (
        <>
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            width: 208, height: 208, borderRadius: 18, boxShadow: '0 0 0 9999px rgba(0,0,0,.45)',
            border: '1.5px solid rgba(255,255,255,.35)' }} />
          {[['-104px','-104px'],[null,'-104px'],[null,null],['-104px',null]].map(([l, t], i) => (
            <span key={i} style={{ position: 'absolute', left: l ? `calc(50% + ${l})` : 'auto', top: t ? `calc(50% + ${t})` : 'auto',
              right: l ? 'auto' : 'calc(50% + 104px)', bottom: t ? 'auto' : 'calc(50% + 104px)',
              width: 26, height: 26, borderTop: '3.5px solid #6b7bff', borderBottom: '3.5px solid #6b7bff',
              borderLeft: '3.5px solid #6b7bff', borderRight: '3.5px solid #6b7bff',
              borderTopWidth: t ? '3.5px' : '0', borderBottomWidth: t ? '0' : '3.5px',
              borderLeftWidth: l ? '3.5px' : '0', borderRightWidth: l ? '0' : '3.5px' }} />
          ))}
          <div style={{ position: 'absolute', left: '50%', top: '50%', width: 180, height: 2, marginLeft: -90,
            background: 'linear-gradient(90deg, transparent, #6b7bff 30%, #6b7bff 70%, transparent)',
            boxShadow: '0 0 6px #6b7bff', animation: 'qr-sweep 2.4s ease-in-out infinite' }} />
          <div style={{ position: 'absolute', bottom: 46, left: 0, right: 0, textAlign: 'center', fontSize: 12.5, color: 'rgba(255,255,255,.85)', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>将二维码放入框内，即可自动扫描</div>
        </>
      )}
      {/* 加载态：盖住裸 video 的默认黑底+播放三角（2026-09-20 用户实测丑图根因） */}
      {!ready && !err && (
        <div style={{ position: 'absolute', inset: 0, background: '#0a0e14', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <span style={{ width: 26, height: 26, borderRadius: '50%', border: '3px solid rgba(107,123,255,.25)', borderTopColor: '#6b7bff', display: 'inline-block', animation: 'qr-sweep 0s' }} className="spin-qr" />
          <style>{`.spin-qr{animation:spin-qr 1s linear infinite}@keyframes spin-qr{to{transform:rotate(360deg)}}`}</style>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,.75)' }}>正在开启摄像头…</span>
        </div>
      )}
      <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, padding: '5px 12px', fontSize: 12, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.55)', color: '#fff', zIndex: 3 }}>关闭</button>
      {onGallery && (
        <button onClick={onGallery} style={{ position: 'absolute', right: 12, bottom: 12, padding: '5px 12px', fontSize: 12, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.55)', color: '#fff', zIndex: 3 }}>🏞 图库</button>
      )}
      {/* err 分支（2026-09-30 重做）：无摄像头/拒权限/被占用分型短句 + 浅色卡片——
          PC/老机无摄像头是常态不是故障（原黑底红字「NotFoundError…」被用户当 bug 实测问题）。
          http 环境提示保留（非安全上下文 getUserMedia 直接不在，入口由 canLiveScan 隐藏）。 */}
      {err !== null && (() => { const h = cameraErrorHint(err); return (
        <div style={{ position: 'absolute', inset: 0, background: '#f6f7fb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 20, textAlign: 'center' }}>
          <span style={{ fontSize: 26 }}>📷</span>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#3c4657' }}>{h.title}</div>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: '#8a97ab' }}>{h.hint}{h.detail ? `（${h.detail}）` : ''}</div>
          <div style={{ fontSize: 11, color: '#8a97ab' }}>http 环境请用「选图扫码」</div>
        </div>
      ) })()}
    </div>
  )
}
