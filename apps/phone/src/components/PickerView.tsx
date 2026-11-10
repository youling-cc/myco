/**
 * PickerView — claude 功能/选择界面的屏幕镜像（终端样式呈现）。
 *
 * 不结构化解析——ta 把功能屏（──── 之下的原样文本，含选中标记）直接镜像过来，
 * 这里按终端等宽样式呈现（含选中行，可滚动），加操作键透传 claude。
 * 比"解析成列表+高亮"健壮：任何功能屏（/rewind 二级确认、/context、/status 分页器）
 * 都原样显示，不依赖格式解析。
 *
 * 按「是否有 ❯ 选中项」区分两类（依据 PICKER-COMMAND-TEST-REPORT.md）：
 *  - 选择 picker（/model /rewind /memory /mcp /resume）：有 ❯ → 显示 ↑↓⏎TabEsc 全套
 *  - 纯展示屏（/context /status /help）：无 ❯ → 只显示 ↑↓(滚动) + Esc(返回)，不误导用户去"选择"
 *
 * phone/canvas 共用（canvas 经 @phone 引）。
 */
import type { PickerState } from '../belief-store'

const SELECT = '❯' // ❯ claude 选中项标记

export function PickerView({ picker, onKey }: { picker: PickerState; onKey: (k: string) => void }) {
  // 有 ❯ = 真·选择界面；无 ❯ = 纯展示功能屏（只滚动/返回，无确认动作）
  const selectable = picker.lines.some((l) => l.trimStart().startsWith(SELECT))
  return (
    <div className="picker-view">
      <div className="picker-screen">
        {picker.lines.map((line, i) => (
          <div key={i} className={`picker-line ${line.trimStart().startsWith(SELECT) ? 'is-selected' : ''}`}>
            {line || ' '}
          </div>
        ))}
      </div>
      <div className="picker-keys">
        <button className="nav-key" onClick={() => onKey('up')}>↑</button>
        <button className="nav-key" onClick={() => onKey('down')}>↓</button>
        {selectable && <button className="nav-key nav-enter" onClick={() => onKey('enter')}>⏎</button>}
        {selectable && <button className="nav-key" onClick={() => onKey('tab')}>Tab</button>}
        <button className="nav-key nav-esc" onClick={() => onKey('esc')}>Esc</button>
      </div>
    </div>
  )
}
