/**
 * ExpandableRow —— 统一的"整行点开，详情现场展开在下方"组件。
 * summary 行整体可点（button），右侧 ▾ 旋转提示；details 展开在卡片内下半部。
 * 账号卡片与每个 Myco 设备行共用，保证交互一致。
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function ExpandableRow({
  summary,
  details,
  defaultOpen = false,
  bordered = true,
}: {
  summary: ReactNode
  details: ReactNode
  defaultOpen?: boolean
  /** 头部内联在分组里时可不带边框；独立卡片带边框。 */
  bordered?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const wrap = bordered
    ? 'rounded-lg border border-[var(--chrome-border)] bg-white/60'
    : 'rounded-lg bg-white/40'
  return (
    <div className={wrap}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        /* inline 覆写底色/字色/内距：home.css `.sec button`（0,1,1）会把 summary 压成实心紫底，
           与 #6b7bff 链接字撞色（2026-09-30 用户截图「紫底白字不清」根因；tailwind 类 0,1,0 打不过） */
        style={{ background: 'transparent', color: 'inherit', padding: '8px 12px' }}
        className="flex items-center gap-2 w-full text-left px-3 py-2 cursor-pointer"
      >
        <span className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">{summary}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1.5 border-t border-[var(--chrome-border)] space-y-2">{details}</div>
      )}
    </div>
  )
}
