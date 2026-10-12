import type { NodeCheck, UnlockService } from '@shared/types'
import { cx } from './ui'
import { flagOf } from './Flag'

const SERVICES: { key: UnlockService; label: string; name: string }[] = [
  { key: 'chatgpt', label: 'GPT', name: 'ChatGPT' },
  { key: 'claude', label: 'Claude', name: 'Claude' },
  { key: 'gemini', label: 'Gemini', name: 'Gemini' },
  { key: 'netflix', label: 'NF', name: 'Netflix' },
  { key: 'youtube', label: 'YT', name: 'YouTube Premium' },
]

const STATUS = {
  yes: { cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300', text: '可用' },
  partial: { cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300', text: '部分可用' },
  no: { cls: 'bg-red-50 text-red-600 line-through dark:bg-red-950/50 dark:text-red-300', text: '不可用' },
  unknown: { cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800', text: '无法判断' },
  error: { cls: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800', text: '检测失败' },
}


/** 节点出口 IP 与解锁状态 */
export function CheckCells({ check }: { check?: NodeCheck }) {
  if (!check?.unlock) return <span className="text-xs text-zinc-400">—</span>
  return (
    <div className="space-y-1" title={`检测于 ${new Date(check.at).toLocaleString()}`}>
      {check.ip && (
        <div className="font-mono text-[11px] text-zinc-500">
          {flagOf(check.country)} {check.ip}
        </div>
      )}
      <div className="flex flex-wrap gap-0.5">
        {SERVICES.map((s) => {
          const r = check.unlock?.[s.key]
          if (!r) return null
          const st = STATUS[r.status]
          return (
            <span
              key={s.key}
              className={cx('rounded px-1 py-0.5 text-[10px] font-medium leading-none', st.cls)}
              title={`${s.name}：${st.text}${r.region ? ` · ${r.region}` : ''}${r.note ? ` · ${r.note}` : ''}`}
            >
              {s.label}
              {r.region && r.status !== 'error' ? <span className="ml-0.5 opacity-70">{r.region}</span> : null}
            </span>
          )
        })}
      </div>
    </div>
  )
}
