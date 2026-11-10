/**
 * TaskEnvList — **任务卡上的 env 行**（手机端，2026-10-23）。
 *
 * 与 PC（`apps/home/ui/src/TaskEnvList.tsx`）同构，但执行面不同：
 *   · PC：`invoke('vnet_env_open')` → Rust 执行器（presence/keep/探测/起客户端一条龙）；
 *   · 手机：`window.__mycoVnet.add` 起本地固定口 → 用壳桥打开 RDP / 系统浏览器。
 *     探测与状态机权威仍在 PC（手机没有本机管理面），所以手机的 `no-service` 只在
 *     "隧道建到对面但对面服务没起"时由 RDP/浏览器自己失败体现；本组件**不谎报 ready**：
 *     只有"固定口已起 + 桥已把客户端拉起来"才置绿。
 *
 * 入口纪律（R28）：本组件只允许挂在**任务卡**上（FriendsPanel 的 task-share 气泡）。
 * 设备卡/好友卡不挂任何直连入口。
 */
import { useCallback, useMemo, useState } from 'react'
import {
  capsGate,
  capsOfCard,
  dotColor,
  envsOfCard,
  KIND_ICON,
  KIND_LABEL,
  localPortOf,
  stateText,
  type EnvRowState,
  type TaskEnv,
} from '../task-env'
import { openTaskEnv } from '../task-open'

interface RowState {
  state: EnvRowState
  note: string
}

function rowOf(): RowState {
  return { state: 'idle', note: '' }
}

export function TaskEnvList({
  card,
  /** 自己发的卡不挂（env 的目标是"对面那台"） */
  enabled = true,
}: {
  card: Record<string, unknown> | null | undefined
  enabled?: boolean
}) {
  const envs = useMemo(() => envsOfCard(card), [card])
  const gate = useMemo(() => capsGate(capsOfCard(card || {})), [card])
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const keyOf = (env: TaskEnv, i: number): string => `${i}:${env.kind}:${localPortOf(env)}`
  const patch = useCallback((key: string, p: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] || rowOf()), ...p } }))
  }, [])

  const onOpen = useCallback(
    async (env: TaskEnv, i: number) => {
      const key = keyOf(env, i)
      // 执行面统一在 `task-open.ts`（列表行与这里的 env 行**同一份实现**：
      // presence 预检 / 固定口 / RDP 复制地址 / DSH 浏览器，一处改动两处生效）。
      patch(key, { state: 'building', note: '正在连接…' })
      const out = await openTaskEnv(env, {
        gate,
        onBuilding: (note) => patch(key, { state: 'building', note }),
      })
      patch(key, { state: out.state, note: out.note })
    },
    [gate, patch],
  )

  if (!enabled) return null
  if (!envs.length) return null

  return (
    <div data-myco-env-list="1" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {envs.map((env, i) => {
        const key = keyOf(env, i)
        const r = rows[key] || rowOf()
        const busy = r.state === 'building'
        const label = env.label || KIND_LABEL[env.kind] || env.kind
        return (
          <div
            key={key}
            data-myco-env="1"
            data-env-kind={env.kind}
            data-env-state={r.state}
            style={{
              maxWidth: 238,
              padding: '7px 9px 8px',
              borderRadius: 11,
              background: 'var(--card,#fff)',
              border: '1px solid var(--border,#e2e5ee)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 12 }}>{KIND_ICON[env.kind] || '🔌'}</span>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: 'var(--text,#1c2333)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(r.state), display: 'inline-block' }} />
                <span style={{ fontSize: 10, color: 'var(--muted,#8a93a8)' }}>{stateText(r.state, env.kind)}</span>
              </span>
            </div>
            {/* 2026-10-25 用户反馈：不再展示 127.0.0.1:<端口> 地址行与「复制」按钮——
                点「打开」自动建链并拉起客户端（RDP 无桥时地址已自动复制到剪贴板）。 */}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void onOpen(env, i)
                }}
                disabled={busy}
                data-env-open="1"
                style={{
                  flex: 1,
                  border: 0,
                  borderRadius: 9,
                  padding: '6px 8px',
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                  background: 'linear-gradient(135deg,var(--mc-accent,#6b7bff),var(--mc-accent-2,#5567f5))',
                  color: '#fff',
                }}
              >
                {busy ? '打开中…' : '打开'}
              </button>
            </div>
            {r.note && (
              <div
                style={{
                  marginTop: 5,
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  wordBreak: 'break-all',
                  color:
                    r.state === 'denied' || r.state === 'no-service'
                      ? '#b45309'
                      : r.state === 'offline'
                        ? '#8a93a8'
                        : '#7ea8d4',
                }}
              >
                {r.note}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
