/**
 * backupMask — 备份恢复码遮蔽状态机（2026-10-01 用户实测整改）。
 *
 * 背景：PC 备份弹窗遮罩点不关（第41轮"强制备份"语义保留）但无退出通道，
 * 且恢复码明文常驻屏幕——"随便乱复制还不安全"。整改（双端同口径）：
 *  - 打开/重新显示后 10 秒无操作（复制/勾选算操作，重置计时）→ 自动遮蔽（••••）并清出内存；
 *  - 复制成功后 3 秒 → 自动遮蔽（复制了就不需要看着了）；
 *  - 「重新显示」= 组件重新导出恢复码（myco_export_seed / encryptRootSeedForBackup
 *    均可重复调用）填回 + 重置 10 秒计时——码不长期驻留内存/屏幕；
 *  - 「稍后备份」（PC）= 清码关窗、不写已备份记号——账号页"未备份"提醒不丢（组件层职责）。
 *
 * 纯函数、无 React/DOM 依赖：PC（env/ui IdentityPanel 相对路径直引）与手机
 * （phone Pairing 经 @myco alias）同源；两端 vitest 同款双锁
 * （apps/home/ui/src/backupMask.test.ts / apps/phone/src/backupMask.test.ts）。
 * 先例：cameraError.ts / scanAddOrder.ts。
 */

/** 打开/重新显示后无操作遮蔽时限 */
export const BACKUP_MASK_IDLE_MS = 10_000
/** 复制成功后遮蔽时限 */
export const BACKUP_MASK_AFTER_COPY_MS = 3_000

export interface BackupPanelState {
  /** 弹窗开 */
  open: boolean
  /** 当前恢复码文本（遮蔽/关闭即清空——码不驻留内存；重新显示=组件重导后填回） */
  seed: string
  /** 本机无根钥（分身设备）——提示态，无敏感内容，不参与遮蔽 */
  noRoot: boolean
  /** 码被遮蔽（UI 显示 ••••） */
  masked: boolean
  /** 显示会话序号：bump = 重置 10s 空闲计时（组件 effect 依赖整个 state 对象即可） */
  revealSeq: number
  /** 复制成功标志（✓ 已复制提示 + 驱动 3s 遮蔽计时） */
  copied: boolean
}

export const backupPanelInitial: BackupPanelState = {
  open: false, seed: '', noRoot: false, masked: false, revealSeq: 0, copied: false,
}

export type BackupPanelEvent =
  /** 打开弹窗（组件已导出码；分身设备 seed='' + noRoot） */
  | { type: 'open'; seed: string; noRoot?: boolean }
  /** 重新显示（组件重导新码；重置 10s 计时） */
  | { type: 'reveal'; seed: string; noRoot?: boolean }
  /** 勾选"已妥善保存"——活跃交互，重置 10s 空闲计时 */
  | { type: 'interact' }
  /** 复制成功（保持显示，3s 计时由 copied 标志驱动） */
  | { type: 'copied' }
  /** 10s 无操作 → 遮蔽并清码 */
  | { type: 'idle-timeout' }
  /** 复制后 3s → 遮蔽并清码 */
  | { type: 'copy-timeout' }
  /** 稍后备份：清码关窗（不写已备份记号——组件层职责） */
  | { type: 'later' }
  /** 完成：清码关窗（记号/上云由组件层做） */
  | { type: 'finish' }

export function backupPanel(s: BackupPanelState, e: BackupPanelEvent): BackupPanelState {
  switch (e.type) {
    case 'open':
    case 'reveal':
      return { open: true, seed: e.seed, noRoot: !!e.noRoot, masked: false, revealSeq: s.revealSeq + 1, copied: false }
    case 'interact':
      // 已遮蔽则不动（码已清——勾选不是重新显示通道，重显必须走显式按钮）
      return s.masked ? s : { ...s, revealSeq: s.revealSeq + 1 }
    case 'copied':
      return s.masked ? s : { ...s, copied: true }
    case 'idle-timeout':
    case 'copy-timeout':
      return { ...s, masked: true, seed: '', copied: false }
    case 'later':
    case 'finish':
      return { open: false, seed: '', noRoot: false, masked: false, revealSeq: s.revealSeq, copied: false }
  }
}

/** 10s 空闲计时是否应挂（弹窗开 + 码可见 + 有码可遮；noRoot 提示态不计时） */
export function backupIdleTimerOn(s: BackupPanelState): boolean {
  return s.open && !s.masked && !s.noRoot && s.seed !== ''
}

/** 复制后 3s 计时是否应挂（复制成功后码仍显示，3s 到点遮蔽） */
export function backupCopyTimerOn(s: BackupPanelState): boolean {
  return s.open && !s.masked && s.copied && s.seed !== ''
}
