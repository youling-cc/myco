/**
 * NodeRoamer — 节点漫游器(2026-08-25 期1,design/04-agent/fleet-division-and-node-federation.md §3)。
 *
 * 手机从"遥控这一台 PC"升格为"在我的节点群之间漫游":
 *  - 节点列表:多台已配对 PC(本地存 myco-phone.nodes),点选切换(断开→重建 transport)
 *  - 审批收件箱:轮询当前节点全部会话细态(projection `status`),waiting_approval
 *    的会话出卡,一键批准/拒绝(approvalSteps 按 harness 分派——与 FineState 同源逻辑)
 *  - 添加节点走既有 Pairing 流程(配对/授权体系不动)
 * 手机独占能力(审批/传感器/通知)中,审批是本期落地项。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Transport, SessionInfo } from '../transport'
import { approvalSteps, resolveHarness } from './FineState'

/** 已配对节点(localStorage;迁移自旧单节点 myco-phone.mode/value) */
export interface NodeEntry {
  id: string
  name: string
  mode: 'http' | 'direct' | 'webrtc' | 'mock'
  value: string
}

const LS_NODES = 'myco-phone.nodes'

export function loadNodes(): NodeEntry[] {
  try {
    const raw = localStorage.getItem(LS_NODES)
    if (raw) return JSON.parse(raw) as NodeEntry[]
  } catch { /* 坏数据忽略 */ }
  // 旧单节点迁移
  const mode = localStorage.getItem('youling.mode') as NodeEntry['mode'] | null
  const value = localStorage.getItem('youling.value')
  if (mode && value) {
    const n: NodeEntry[] = [{ id: 'n1', name: valueName(value, mode), mode, value }]
    saveNodes(n)
    return n
  }
  return []
}

export function saveNodes(nodes: NodeEntry[]) {
  localStorage.setItem(LS_NODES, JSON.stringify(nodes))
}

function valueName(value: string, mode: NodeEntry['mode']): string {
  if (mode === 'webrtc') return `PC · ${value.slice(0, 14)}…`
  if (mode === 'direct') return value.replace(/^https?:\/\//, '').slice(0, 24)
  return mode
}

/** 审批卡:一次待批会话 */
function ApprovalCard({ session, approval, harness, onAct, busy }: {
  session: SessionInfo; approval: string | null; harness: string; onAct: (approve: boolean) => void; busy: boolean
}) {
  return (
    <div className="nr-approval">
      <div className="nr-ap-head">
        <span className="nr-ap-badge">{harness === 'unknown' ? '?' : harness}</span>
        <span className="nr-ap-task">{session.taskId}</span>
      </div>
      <div className="nr-ap-text">{approval ?? '等待审批(查看终端确认内容)'}</div>
      <div className="nr-ap-btns">
        <button className="nr-btn ok" disabled={busy} onClick={() => onAct(true)}>批准</button>
        <button className="nr-btn no" disabled={busy} onClick={() => onAct(false)}>拒绝</button>
      </div>
    </div>
  )
}

export function NodeRoamer({ transport, nodes, activeId, onSwitch, onAddNode, onOpenSession }: {
  transport: Transport
  nodes: NodeEntry[]
  activeId: string | null
  onSwitch: (n: NodeEntry) => void
  onAddNode: () => void
  onOpenSession: (s: SessionInfo) => void
}) {
  const [approvals, setApprovals] = useState<{ session: SessionInfo; approval: string | null; harness: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
const [actErr, setActErr] = useState<string | null>(null) // 2026-10-16：审批动作失败反馈（原静默）
  const [scanAt, setScanAt] = useState(0)
  const alive = useRef(true)

  // 审批扫描:10s 一轮,遍历会话查细态(status 走 projection,三 transport 共享)
  const scan = useCallback(async () => {
    if (!transport.status) return
    try {
      const list = await transport.list()
      const hits: { session: SessionInfo; approval: string | null; harness: string }[] = []
      for (const s of list) {
        try {
          const st = await transport.status(s)
          if (st.fineState === 'waiting_approval') {
            hits.push({ session: s, approval: st.approval ?? null, harness: resolveHarness(st.appType, s.command) })
          }
        } catch { /* 单会话失败不挡全局 */ }
      }
      if (alive.current) { setApprovals(hits); setScanAt(Date.now()) }
    } catch { /* 节点失联:保留上次结果,TaskList 自身的连接错误会暴露 */ }
  }, [transport])

  useEffect(() => {
    alive.current = true
    void scan()
    const t = setInterval(() => void scan(), 10_000)
    return () => { alive.current = false; clearInterval(t) }
  }, [scan])

  // 审批动作:approvalSteps 按 harness 生成注入序列(与 ChatView.respondApproval
  // 同源语义——步间 150ms 让 harness 输入处理器 stabilize)
  const act = async (s: SessionInfo, harness: string, approve: boolean) => {
    setBusy(s.sessionId)
    setActErr(null)
    try {
      const steps = approvalSteps(harness, approve)
      for (const st of steps) {
        if (st.text != null) await transport.input(s, st.text)
        else if (st.key) await transport.key(s, st.key)
        await new Promise((r) => setTimeout(r, 150))
      }
    } catch (e) {
      // 2026-10-16 修「静默失败」（死按钮审计 🟡）：连接断时 transport.input/key 抛错
      // ——此前 try/finally 无 catch：unhandled rejection、卡片重扫还在=「点了没反应」
      // （对照 ChatView.respondApproval 有 catch→setErr）。
      setActErr(`审批动作失败：${String(e).replace(/^Error:\s*/, '').slice(0, 80)}`)
    } finally {
      setBusy(null)
      setTimeout(() => void scan(), 1200)
    }
  }

  return (
    <div className="nr">
      <div className="nr-sec">
        <div className="nr-title">节点{activeId ? '' : '(未连接)'}</div>
        <div className="nr-nodes">
          {nodes.map((n) => (
            <button key={n.id} className={`nr-node${n.id === activeId ? ' on' : ''}`} onClick={() => n.id !== activeId && onSwitch(n)}>
              <span className="nr-node-dot" />
              <span className="nr-node-name">{n.name}</span>
              {n.id === activeId && <span className="nr-node-tag">当前</span>}
            </button>
          ))}
          <button className="nr-node add" onClick={onAddNode}>+ 添加节点</button>
        </div>
      </div>
      <div className="nr-sec">
        <div className="nr-title">
          审批收件箱{approvals.length > 0 ? ` · ${approvals.length}` : ''}
          <span className="nr-scan">{scanAt ? `${Math.round((Date.now() - scanAt) / 1000)}s 前扫描` : ''}</span>
        </div>
        {approvals.length === 0 && <div className="nr-empty">无待审批——AI 卡审批时会出现在这里,手机一键批</div>}
        {actErr && <div className="nr-empty" style={{ color: '#dc2626' }}>{actErr}</div>}
        {approvals.map((a) => (
          <div key={a.session.sessionId}>
            <ApprovalCard
              session={a.session} approval={a.approval} harness={a.harness}
              busy={busy === a.session.sessionId}
              onAct={(ok) => void act(a.session, a.harness, ok)}
            />
            <button className="nr-open" onClick={() => onOpenSession(a.session)}>查看终端 ↗</button>
          </div>
        ))}
      </div>
    </div>
  )
}
