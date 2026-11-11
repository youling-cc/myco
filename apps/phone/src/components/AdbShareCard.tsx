/**
 * AdbShareCard — 任务页「🐛 ADB 调试」卡（2026-11-11，需求 ADB-SHARE-TASK.md）。
 *
 * 手机当 vnet server（5555）：整卡点击 = 开/关 server（开着=绿点，关=灰点）；
 * 首次开启自动建分享任务卡（ensureAdbCard → 设备群 task-share，PC 端可见）。
 * 调试者在 PC 上 `POST /api/vnet/forward {device:手机did, port:5555}` →
 * `adb connect 127.0.0.1:<本地口>`——四层防护（vnet PSK/身份闸 + ADB RSA + 分享授权）
 * 见需求文档 §安全模型。
 */
import { useEffect, useState } from 'react'
import {
  adbServerStart, adbServerStop, adbServerState, adbCardExists, ensureAdbCard, myDeviceDid,
  ADB_CARD_TITLE, ADB_TARGET_PORT,
} from '../adb-share'

export function AdbShareCard() {
  const [running, setRunning] = useState<boolean | null>(null) // null=未知（旧壳/未查）
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [cardShared, setCardShared] = useState<boolean | null>(null)

  useEffect(() => {
    const read = () => {
      const s = adbServerState()
      setRunning(s.running === true ? true : s.err ? null : false)
    }
    read()
    const t = setInterval(read, 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const read = () => setCardShared(adbCardExists(myDeviceDid()))
    read()
    const t = setInterval(read, 8000)
    return () => clearInterval(t)
  }, [])

  const toggle = () => {
    if (busy) return
    setBusy(true)
    setNote('')
    void (async () => {
      try {
        if (running === true) {
          const r = await adbServerStop()
          setRunning(false)
          setNote(r.ok ? '已关闭，授权设备的 ADB 连接随断' : (r.err || '关闭失败'))
          return
        }
        const r = await adbServerStart()
        setRunning(r.running === true)
        if (r.ok) {
          setNote(`已开启——授权设备可经 vnet 隧道连接本机 ${ADB_TARGET_PORT} 口`)
          const c = await ensureAdbCard().catch(() => ({ created: false, err: '失败' }))
          if (c.err) setNote(`已开启（建卡失败：${c.err}）`)
          else if (c.created) setNote('已开启，分享卡已发到设备群')
        } else {
          setNote(r.err || '启动失败，稍后再试')
        }
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0', cursor: 'pointer' }}
        title={running === true ? '点击关闭 ADB 调试服务' : '点击开启 ADB 调试服务'}
      >
        <span style={{ fontSize: 17, flexShrink: 0 }}>🐛</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{ADB_CARD_TITLE}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {running === null
              ? '当前应用版本过旧或状态未知'
              : running === true
                ? '服务运行中 · 授权设备可 adb connect'
                : '未开启（点我启动 vnet 服务）'}
            {cardShared === false && running === true ? ' · 分享卡待发' : ''}
          </div>
        </span>
        <span style={{
          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
          background: running === true ? '#22c55e' : '#9aa3b8',
          boxShadow: running === true ? '0 0 5px rgba(34,197,94,.5)' : 'none',
        }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: running === true ? '#0f766e' : 'var(--muted)', flexShrink: 0 }}>
          {running === true ? '开' : '关'}
        </span>
      </div>
      {note && <div style={{ fontSize: 10.5, color: '#0f766e', padding: '2px 0 4px' }}>{note}</div>}
    </div>
  )
}
