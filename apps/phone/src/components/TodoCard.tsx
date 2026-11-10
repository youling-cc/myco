/**
 * TodoCard — phone 端 PM 待办只读卡(纲领六)。
 *
 * 显示今日开口待办(结果导向,R 锚点);只读——勾选/增删在 PC dock 操作。
 * transport 不支持 todos()(Mock/旧后端)时静默不渲染。
 */
import { useEffect, useState } from 'react'
import { type Transport, type PmTodo } from '../transport'

export function TodoCard({ transport }: { transport: Transport }) {
  const [items, setItems] = useState<PmTodo[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!transport.todos) return
    let stop = false
    const load = async () => {
      try {
        const t = await transport.todos!()
        if (!stop) setItems(t)
      } catch {
        if (!stop) setItems(null)
      }
    }
    void load()
    const t = setInterval(load, 60_000) // 分钟级刷新(只读低频)
    return () => { stop = true; clearInterval(t) }
  }, [transport])

  if (!items) return null
  const openItems = items.filter((i) => i.status !== 'done')
  const doneCount = items.length - openItems.length

  return (
    <div className="mx-3 mt-2 rounded-xl bg-white shadow-sm border border-black/5">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2.5">
        <span className="text-[13px] font-semibold text-gray-800 flex-1 text-left">
          今日待办
          {openItems.length > 0 && <span className="ml-1.5 text-[11px] text-white bg-[#6b7bff] rounded-full px-1.5 py-px">{openItems.length}</span>}
        </span>
        {doneCount > 0 && <span className="text-[10px] text-gray-400">已完成 {doneCount}</span>}
        <span className="text-gray-400 text-[11px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 space-y-1.5">
          {openItems.length === 0 && <div className="text-[11px] text-gray-400 pb-1">今天没有开口待办</div>}
          {openItems.map((i) => (
            <div key={i.id} className="flex items-start gap-2">
              <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[#6b7bff] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-gray-800 leading-snug">{i.text}</div>
                <div className="flex gap-1 mt-0.5 flex-wrap">
                  {i.projectName && <span className="text-[9px] px-1 rounded bg-gray-100 text-gray-500">{i.projectName}</span>}
                  {i.rLink?.rScore != null && (
                    <span className="text-[9px] px-1 rounded bg-amber-50 text-amber-600">
                      R={i.rLink.rScore.toFixed(2)}{i.rLink.rThreshold ? `/${i.rLink.rThreshold}` : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div className="text-[9px] text-gray-300 pt-0.5">只读 · 完成勾选在 PC 工作台</div>
        </div>
      )}
    </div>
  )
}
