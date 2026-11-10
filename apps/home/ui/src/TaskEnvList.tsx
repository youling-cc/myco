/**
 * TaskEnvList — **任务卡上的 env 行**（PC，2026-10-23）。
 *
 * 用户口径（AOP 范式）：入口只在**分享的任务卡**上；卡声明它能提供什么 env
 * （远程桌面 / DSH web / SSH / HTTP / 立体声 / adb），点一下 → myco 自动按
 * `127.0.0.1:<固定口>` 建好链路 → 起对应客户端。
 *
 * 三条硬纪律（R26/R27/R28 的 UI 面）：
 *   ① 设备卡/好友卡**不挂**本组件（只有 `ChatBubble` 的 task-share 气泡挂）；
 *   ② `offline` / `no-service` / `denied` 时**不启动客户端**——后端在探测失败时根本
 *      不 spawn，这里也不给"看起来成功了"的假文案；
 *   ③ 每个 env 行都带 `data-env-state`（真机验收/源码断言都能直接读）。
 *
 * 走 invoke 不走 `fetch(127.0.0.1:3102)`：UI 是 `tauri://` 源，打本机管理面是跨源；
 * IPC 面是 UI 的正门（第 63 轮 env 合并纪律）。`vnet_env_open` 与 HTTP
 * `POST /api/env/open` 共用 Rust `vnet_env::env_open`。
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
  openArgs,
  resultNote,
  rowStateOf,
  stateText,
  type EnvOpenResult,
  type EnvRowState,
  type TaskEnv,
} from './task-env'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

function invoker(): Invoke | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }
  const f = w.__TAURI_INTERNALS__?.invoke
  return typeof f === 'function' ? f.bind(w.__TAURI_INTERNALS__) : null
}

interface RowState {
  state: EnvRowState
  note: string
}

function rowOf(patch?: Partial<RowState>): RowState {
  return { state: 'idle', note: '', ...patch }
}

export function TaskEnvList({
  card,
  /** 自己发的卡不挂（"对面那台"才是目标）；与 RemoteDesktopCard 时代同一口径 */
  enabled = true,
}: {
  card: Record<string, unknown> | null | undefined
  enabled?: boolean
}) {
  const envs = useMemo(() => envsOfCard(card), [card])
  const caps = useMemo(() => capsOfCard(card || {}), [card])
  const gate = useMemo(() => capsGate(caps), [caps])
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const keyOf = (env: TaskEnv, i: number): string => `${i}:${env.kind}:${localPortOf(env)}`

  const patch = useCallback((key: string, p: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] || rowOf()), ...p } }))
  }, [])

  const onOpen = useCallback(
    async (env: TaskEnv, i: number) => {
      const key = keyOf(env, i)
      if (!env.device) {
        patch(key, { state: 'denied', note: '卡上缺少目标设备信息，请让对方重新分享' })
        return
      }
      if (gate === 'denied') {
        // 客户端预检直接给红点，不必打后端（后端同样会 denied，这里是即时反馈）
        patch(key, { state: 'denied', note: stateText('denied', env.kind) })
        return
      }
      const invoke = invoker()
      if (!invoke) {
        patch(key, { state: 'idle', note: '当前环境不支持（浏览器调试页没有 IPC）' })
        return
      }
      patch(key, { state: 'building', note: '正在连接…' })
      try {
        const res = (await invoke('vnet_env_open', { args: openArgs(card, env) })) as EnvOpenResult
        patch(key, {
          state: rowStateOf(res),
          note: resultNote(res),
        })
      } catch (e) {
        // IPC 层失败（旧 exe 没这条命令 / 参数错）：不当成功，也不谎报离线
        patch(key, { state: 'idle', note: `调用失败：${String((e as Error)?.message ?? e)}` })
      }
    },
    [card, gate, patch],
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
              maxWidth: 260,
              borderRadius: 11,
              border: '1px solid var(--bd, #e2e5ee)',
              background: 'var(--surface, #fff)',
              padding: '7px 9px 8px',
              boxShadow: '0 2px 8px rgba(22,30,60,.05)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 12 }} title={KIND_LABEL[env.kind] || env.kind}>
                {KIND_ICON[env.kind] || '🔌'}
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: 'var(--tx, #1c2333)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: dotColor(r.state),
                    display: 'inline-block',
                    animation: busy ? 'pulse 1s ease-in-out infinite' : undefined,
                  }}
                />
                <span style={{ fontSize: 10, color: 'var(--muted, #8a93a8)' }}>{stateText(r.state, env.kind)}</span>
              </span>
            </div>
            {/* 2026-10-25 用户反馈：不再展示 127.0.0.1:<端口> 地址行与「复制」按钮——
                点「打开」自动建链并拉起客户端，地址只是中间细节。 */}
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
                  background: 'linear-gradient(135deg,#6b7bff,#5567f5)',
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
                    r.state === 'denied' || r.state === 'no-service' || r.state === 'error'
                      ? '#b45309'
                      : r.state === 'offline'
                        ? '#8a93a8'
                        : '#4b5bd6',
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
