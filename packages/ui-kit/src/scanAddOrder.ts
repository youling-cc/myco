/**
 * scanAddOrder —— 「添加设备」通道的主次排序契约（PC/手机双端同源单一源）。
 *
 * 2026-09-30 设计定稿「PC 优先」：
 *  - PC 形态：粘贴识别码 = 主操作（对方把识别码经微信/QQ/邮件发来，PC 上粘贴最顺手）；
 *    摄像头实时扫（仅 canLiveScan 环境才提供）/ 从图片识别 = 底部次要链接，不抢视觉。
 *  - 手机形态：摄像头 = 主通道（举起就扫；无摄像头环境「从图片识别」升主）；
 *    粘贴识别码 = 次要折叠区。
 *
 * 消费方：apps/env/ui/src/components/MycoDevices.tsx（PC）、apps/phone/src/components/Pairing.tsx（手机）。
 * 断言：apps/home/ui/src/scanAddOrder.test.ts（PC 序）、apps/phone/src/scanAddOrder.test.ts（手机序）。
 */

/** 添加设备的三个入口通道。 */
export type ScanAddChannel = 'paste' | 'camera' | 'image'
export type ScanAddFormFactor = 'pc' | 'phone'

/** 主通道（第一视觉焦点）。 */
export function scanAddPrimary(form: ScanAddFormFactor, liveScan: boolean): ScanAddChannel {
  if (form === 'phone') return liveScan ? 'camera' : 'image'
  return 'paste'
}

/** 次要通道（降级链接/折叠区），按展示顺序返回。 */
export function scanAddSecondary(form: ScanAddFormFactor, liveScan: boolean): ScanAddChannel[] {
  if (form === 'phone') return ['paste']
  return liveScan ? ['camera', 'image'] : ['image']
}

/** 完整排序：主通道在前，次要通道随后。 */
export function scanAddOrder(form: ScanAddFormFactor, liveScan: boolean): ScanAddChannel[] {
  return [scanAddPrimary(form, liveScan), ...scanAddSecondary(form, liveScan)]
}
