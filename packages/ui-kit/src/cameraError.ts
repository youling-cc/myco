/**
 * cameraError — getUserMedia 异常 → 友好中文提示（单一源）。
 *
 * 背景（2026-09-30 用户实测截图实测问题）：PC 无摄像头是常态、不是错误态——
 * 原实现整屏黑底+红字「摄像头打不开：NotFoundError: Requested device not found」，
 * 把常态当故障吓人。这里按 DOMException.name 分型给短句 + 下一步引导，
 * 黑底红字由消费方换成浅色卡片。
 *
 * 消费方：apps/phone/src/components/QrCamera.tsx（@myco/cameraError）、
 *         apps/env/ui/src/components/QrCamera.tsx（相对路径直引）。
 * 断言：apps/phone/src/cameraError.test.ts、apps/home/ui/src/cameraError.test.ts。
 */

export interface CameraErrorHint {
  /** 一句话说清状况（非指责口吻）。 */
  title: string
  /** 下一步引导（兜底通道）。 */
  hint: string
  /** 原始错误串（仅未识别类型附带，排查用）。 */
  detail?: string
}

/** 从异常里取 DOMException.name；兼容 "NotFoundError: ..." 字符串形态（String(e) 落入）。 */
export function cameraErrorName(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e) {
    const n = (e as { name: unknown }).name
    if (typeof n === 'string' && n) return n
  }
  const m = /^\s*(?:Error:\s*)?([A-Za-z]+Error)/.exec(String(e))
  return m ? m[1] : ''
}

/** getUserMedia 失败 → 分型友好提示。 */
export function cameraErrorHint(e: unknown): CameraErrorHint {
  switch (cameraErrorName(e)) {
    case 'NotFoundError': // 无摄像头设备（PC 常态）
    case 'DevicesNotFoundError':
      return { title: '这台设备没有摄像头', hint: '改用「粘贴识别码」或「从图片识别」' }
    case 'NotAllowedError': // 用户/系统拒绝权限
    case 'PermissionDeniedError':
      return { title: '摄像头权限被拒绝', hint: '在系统设置里允许摄像头后重试，或改用「粘贴识别码」/「从图片识别」' }
    case 'NotReadableError': // 硬件被别的应用占用
    case 'TrackStartError':
      return { title: '摄像头正被其他应用占用', hint: '关掉占用摄像头的应用后重试，或改用「粘贴识别码」/「从图片识别」' }
    case 'SecurityError': // http 非安全上下文禁用摄像头
      return { title: '当前环境不支持摄像头扫码', hint: 'http 环境请改用「从图片识别」' }
    default:
      return {
        title: '摄像头打不开',
        hint: '改用「粘贴识别码」或「从图片识别」',
        detail: String(e).replace(/^Error:\s*/, ''),
      }
  }
}
