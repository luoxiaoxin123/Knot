import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Import } from 'lucide-react'
import { Button, Card, CardHeader, Modal, useToast } from './ui'

interface Report {
  subscriptions: number
  nodes: number
  chains: number
  profiles: number
  skipped: string[]
}

async function upload(url: string, body: BodyInit, type: string): Promise<Report> {
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': type }, credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `导入失败 (${res.status})`)
  return data
}

export function MigrateCard() {
  const toast = useToast()
  const qc = useQueryClient()
  const subStoreRef = useRef<HTMLInputElement>(null)
  const mmwRef = useRef<HTMLInputElement>(null)
  const [includeSynced, setIncludeSynced] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [report, setReport] = useState<{ from: string; r: Report } | null>(null)

  const run = async (from: string, fn: () => Promise<Report>) => {
    setBusy(from)
    try {
      const r = await fn()
      setReport({ from, r })
      qc.invalidateQueries()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader title="从其他工具迁移" desc="导入的内容会追加到现有数据中，不会覆盖。导入前的节点状态会保存到「历史版本」。" />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Sub-Store</div>
            <div className="text-xs text-zinc-500">Sub-Store 设置 → 备份 → 下载的 JSON 文件。远程订阅 → 订阅源，本地订阅 → 节点，组合订阅 → 订阅输出。</div>
          </div>
          <Button onClick={() => subStoreRef.current?.click()} loading={busy === 'substore'}><Import className="size-4" />选择备份文件</Button>
          <input
            ref={subStoreRef}
            type="file"
            accept=".json,application/json,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) run('substore', async () => upload('/api/migrate/substore', await f.text(), 'text/plain'))
            }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div>
            <div className="text-sm font-medium">妙妙屋（miaomiaowu）</div>
            <div className="text-xs text-zinc-500">上传数据目录里的 <code>traffic.db</code>。节点、链式代理与外部订阅会被导入。</div>
            <label className="mt-1.5 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={includeSynced} onChange={(e) => setIncludeSynced(e.target.checked)} className="accent-blue-600" />
              同时导入从外部订阅同步来的节点（默认跳过，由订阅源重新拉取）
            </label>
          </div>
          <Button onClick={() => mmwRef.current?.click()} loading={busy === 'mmw'}><Import className="size-4" />选择 traffic.db</Button>
          <input
            ref={mmwRef}
            type="file"
            accept=".db,.sqlite,application/octet-stream"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) run('mmw', () => upload(`/api/migrate/miaomiaowu${includeSynced ? '?includeSynced=1' : ''}`, f, 'application/octet-stream'))
            }}
          />
        </div>
      </div>
      <Modal open={!!report} onClose={() => setReport(null)} title="迁移完成" width="max-w-lg" footer={<Button variant="primary" onClick={() => setReport(null)}>好的</Button>}>
        {report && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['订阅源', report.r.subscriptions],
                ['节点', report.r.nodes],
                ['链式节点', report.r.chains],
                ['输出配置', report.r.profiles],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md bg-zinc-50 p-2 text-center dark:bg-zinc-800/60">
                  <div className="text-lg font-semibold">{v}</div>
                  <div className="text-xs text-zinc-500">{k}</div>
                </div>
              ))}
            </div>
            {report.r.subscriptions > 0 && <p className="text-xs text-zinc-500">新订阅源正在后台拉取节点，稍后在「订阅源」页查看。</p>}
            {report.r.skipped.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">未迁移 / 需要注意：</div>
                <ul className="space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {report.r.skipped.map((s, i) => <li key={i}>• {s}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  )
}
