/**
 * TaskLinkCard — youling 任务链接预览卡（第87轮）
 *
 * 聊天文本里的 `https://myco.youling.cc/task/{id}`（新）、`http://myco.youling.cc/task/{id}`
 * 或 `https://youling.cc/task/{id}`（旧链接，聊天记录里仍要渲染）自动变卡片：
 * 拉 /api/v1/task-cards/{id} 渲染富卡（标题/描述/单价/SLA/参与数），
 * API 不可达（鉴权/未部署/网络）优雅降级为样式化链接卡。点击打开落地页。
 *
 * 与内部 task-share 消息卡的区别：这是**外部 youling 平台任务**的分享链接，
 * 不是 myco 聊天协议的 task-share kind——消息本体仍是普通 text，只是渲染层识别。
 */

import { useEffect, useState } from 'react'

/** youling 平台基址——换域名只改这一处（与 HBL 会话约定一致）。
 *  2026-09-28 第90轮：固定域名 https://myco.youling.cc（443 直达 /api/v1/task-cards/）。 */
const YOULING_BASE: string = ((import.meta.env.VITE_PLATFORM_URL as string | undefined) || 'https://myco.youling.cc').replace(/\/+$/, '')
// （构建期 VITE_PLATFORM_URL 覆盖——换环境改构建 env 不改代码；解析旧链接文本的白名单不变）

/** 检测文本里的 youling 任务链接（新域名 + 两个旧域名，旧聊天记录仍渲染） */
export function extractTaskLink(text: string): string | null {
  if (!text) return null
  const m = text.match(/https?:\/\/(?:myco\.youling\.cc|youling\.cc|47\.114\.96\.83)\/task\/([a-zA-Z0-9_-]+)/)
  return m ? m[0] : null
}

interface CardData {
  title?: string
  desc?: string
  unitPrice?: string
  slaText?: string
  workerCount?: number
  taskType?: string
}

interface Props { url: string }

export function TaskLinkCard({ url }: Props) {
  const [data, setData] = useState<CardData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const m = url.match(/\/task\/([a-zA-Z0-9_-]+)/)
    if (!m) { setFailed(true); return }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    fetch(`${YOULING_BASE}/api/v1/task-cards/${m[1]}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(j => {
        const d = j?.data ?? j
        setData({
          title: d?.title || d?.name || '',
          desc: d?.desc || d?.description || '',
          unitPrice: d?.unitPrice || d?.price || '',
          slaText: d?.slaText || d?.sla || '',
          workerCount: d?.workerCount || d?.participants || 0,
          taskType: d?.taskType || d?.type || '',
        })
      })
      .catch(() => setFailed(true))
      .finally(() => clearTimeout(timer))
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [url])

  return (
    <div
      onClick={() => { if (url.startsWith('http')) window.open(url, '_blank') }}
      style={{
        width: 220, borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
        border: '1px solid rgba(22,119,255,.25)', background: 'linear-gradient(135deg,#f0f6ff,#e6f0ff)',
        boxShadow: '0 2px 8px rgba(22,119,255,.08)',
      }}
    >
      {/* 顶条 */}
      <div style={{ padding: '7px 10px 5px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 18, height: 18, borderRadius: 5, background: 'linear-gradient(135deg,#1677ff,#0958d9)', color: '#fff', fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>灵</span>
        <span style={{ fontSize: 10, color: '#1677ff', fontWeight: 600 }}>有灵任务</span>
        {data?.slaText && <span style={{ marginLeft: 'auto', fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#1677ff1a', color: '#1677ff', fontWeight: 600 }}>{data.slaText}</span>}
      </div>
      {/* 标题 */}
      <div style={{ padding: '0 10px 4px', fontSize: 13, fontWeight: 700, color: 'var(--text,#1a1a2e)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {data?.title || (failed ? 'youling 任务' : '加载中…')}
      </div>
      {/* 描述 */}
      {data?.desc && (
        <div style={{ padding: '0 10px 4px', fontSize: 11, color: '#666', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{data.desc}</div>
      )}
      {/* 底条 */}
      <div style={{ padding: '4px 10px 7px', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid rgba(22,119,255,.1)' }}>
        {data?.unitPrice && <span style={{ fontSize: 11, color: '#e65100', fontWeight: 700 }}>{data.unitPrice}</span>}
        {data?.workerCount !== undefined && data.workerCount > 0 && <span style={{ fontSize: 10, color: '#888' }}>{data.workerCount} 人参与</span>}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#1677ff' }}>查看 ›</span>
      </div>
    </div>
  )
}
