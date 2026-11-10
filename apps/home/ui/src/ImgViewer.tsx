/**
 * ImgViewer — 图片查看器（2026-09-29 实测修法：站内小 overlay 看大图憋屈）。
 * 方案：优先**无边框全屏子窗口**（Tauri WebviewWindow label=imgview，单例复用）——
 *   图片占满整个屏幕、不受 320x640 窄窗限制，最接近系统图片查看器体验；
 *   子窗口开不起来（dev 浏览器/权限缺失/存量超限）→ 窗内全屏 overlay 兜底，
 *   两者共用 ZoomPanView（滚轮缩放 0.5x~5x + 拖拽平移 + 双击复位 + Esc/点击关闭）。
 * 数据通道：localStorage stash（同 app 多窗口共享 localStorage；图片 base64 常 ≤2MB，
 *   setItem 抛 QuotaExceeded 时直接回落 overlay）。子窗口已开时 emit imgview-reload 换图。
 * 缩放/平移状态机=chatOps.imgZoomAt/imgPanBy/imgViewReset（纯函数，单测在 chatOps.test.ts）。
 */
import { useEffect, useRef, useState } from 'react'
import { IMG_ZOOM_MAX, IMG_ZOOM_MIN, imgPanBy, imgViewInit, imgViewReset, imgZoomAt, type ImgViewState } from './chatOps'

const STASH_KEY = 'myco-imgview-payload'
const WIN_LABEL = 'imgview'

interface ImgPayload { url: string; name: string }

function writeStash(p: ImgPayload): boolean {
  try { localStorage.setItem(STASH_KEY, JSON.stringify(p)); return true } catch { return false }
}
function readStash(): ImgPayload | null {
  try {
    const raw = localStorage.getItem(STASH_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as ImgPayload
    return typeof p?.url === 'string' && p.url ? { url: p.url, name: p.name ?? '' } : null
  } catch { return null }
}

/** 打开图片查看器：成功（子窗口已建/已复用）→ true；失败 → false（调用方回落 overlay）。 */
export async function openImgViewer(url: string, name?: string): Promise<boolean> {
  if (!writeStash({ url, name: name ?? '' })) return false
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const exist = await WebviewWindow.getByLabel(WIN_LABEL)
    if (exist) {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('imgview-reload', {})
      await exist.setFocus()
      return true
    }
    const w = new WebviewWindow(WIN_LABEL, {
      url: 'index.html#imgview',
      title: '图片查看',
      fullscreen: true,
      decorations: false,
      resizable: true,
      shadow: false,
      alwaysOnTop: false,
      backgroundColor: '#05070c',
    })
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
      w.once('tauri://created', () => done(true)).catch(() => done(false))
      w.once('tauri://error', () => done(false)).catch(() => done(false))
      // tauri 运行时事件必回；dev 浏览器（无 __TAURI_INTERNALS__）once 挂起→超时回落 overlay
      setTimeout(() => done(false), 1500)
    })
  } catch { return false }
}

/** 缩放/平移查看视图（子窗口与窗内兜底 overlay 共用）。
 *  scale=1 时 img 自适应（max 96vw/vh）；transform origin 固定在容器中心，
 *  imgZoomAt 的 px/py 即以中心为原点——锚点数学与渲染模型一致。 */
export function ZoomPanView({ url, name, onClose }: { url: string; name?: string; onClose: () => void }) {
  const [st, setSt] = useState<ImgViewState>(imgViewInit)
  const [dragging, setDragging] = useState(false)
  const lastRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(0) // 拖拽累计位移——区分"点击关闭"与"拖拽松手"
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // wheel 必须非 passive 才能 preventDefault（阻止页面滚动）；React onWheel 是 passive，手动挂
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - (r.left + r.width / 2)
      const py = e.clientY - (r.top + r.height / 2)
      setSt((s) => imgZoomAt(s, px, py, e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={boxRef}
      onMouseDown={(e) => { lastRef.current = { x: e.clientX, y: e.clientY }; movedRef.current = 0; setDragging(true) }}
      onMouseMove={(e) => {
        const last = lastRef.current
        if (!last) return
        const dx = e.clientX - last.x
        const dy = e.clientY - last.y
        lastRef.current = { x: e.clientX, y: e.clientY }
        movedRef.current += Math.abs(dx) + Math.abs(dy)
        if (movedRef.current > 4) setSt((s) => imgPanBy(s, dx, dy))
      }}
      onMouseUp={() => { lastRef.current = null; setDragging(false) }}
      onMouseLeave={() => { lastRef.current = null; setDragging(false) }}
      onClick={() => { if (movedRef.current <= 4) onClose() }}
      onDoubleClick={() => setSt(imgViewReset())}
      style={{
        position: 'fixed', inset: 0, zIndex: 500, overflow: 'hidden', userSelect: 'none',
        background: 'rgba(5,7,12,.96)', cursor: dragging ? 'grabbing' : 'zoom-out',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <img
        src={url} alt={name || '图片'} draggable={false}
        onClick={(e) => e.stopPropagation()} /* 点图本身不关——只点黑底关（防拖拽松手误关） */
        style={{
          maxWidth: '96vw', maxHeight: '96vh',
          transform: `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`,
          transformOrigin: 'center center',
          transition: dragging ? 'none' : 'transform .12s ease-out',
          cursor: dragging ? 'grabbing' : st.scale > 1 ? 'grab' : 'default',
        }}
      />
      {/* 底部提示条（不拦截鼠标——pointerEvents:none） */}
      <div style={{
        position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)',
        padding: '5px 14px', borderRadius: 999, background: 'rgba(20,26,40,.78)',
        color: 'rgba(230,237,243,.82)', fontSize: 11.5, whiteSpace: 'nowrap', pointerEvents: 'none',
      }}>
        {st.scale.toFixed(2)}x · 滚轮缩放（{IMG_ZOOM_MIN}x~{IMG_ZOOM_MAX}x）· 拖拽平移 · 双击复位 · Esc/点黑底关闭
      </div>
    </div>
  )
}

/** 子窗口入口 App（main.tsx 按 #imgview hash 挂载本组件而非主 App）。 */
export function ImgViewerApp() {
  const [payload, setPayload] = useState<ImgPayload | null>(() => readStash())
  useEffect(() => {
    let un: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then((m) => m.listen('imgview-reload', () => setPayload(readStash())))
      .then((f) => { un = f })
      .catch(() => {})
    return () => { un?.() }
  }, [])
  const close = () => {
    void import('@tauri-apps/api/window')
      .then((w) => w.getCurrentWindow().close())
      .catch(() => window.close())
  }
  if (!payload) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#05070c', color: '#8b949e', fontSize: 13 }}>
        图片加载中…（Esc 关闭）
      </div>
    )
  }
  return <ZoomPanView url={payload.url} name={payload.name} onClose={close} />
}
