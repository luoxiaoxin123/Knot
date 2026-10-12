import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History as HistoryIcon, RotateCcw } from 'lucide-react'
import YAML from 'yaml'
import { diffLines } from 'diff'
import { api, fmtDate, fmtTime } from '../lib/api'
import { Badge, Button, Card, Empty, Modal, PageHeader, Segmented, Spinner, cx, useConfirm, useToast } from '../components/ui'

interface Item {
  id: string
  at: number
  kind: 'profile' | 'rules' | 'template' | 'nodes'
  refId?: string
  label: string
  summary: string
  deleted: boolean
}

const KIND: Record<Item['kind'], string> = { profile: '输出配置', rules: '自定义规则', template: '规则模板', nodes: '节点' }

export default function HistoryPage() {
  const [kind, setKind] = useState<'' | Item['kind']>('')
  const [open, setOpen] = useState<Item | null>(null)
  const list = useQuery({ queryKey: ['history', kind], queryFn: () => api.get<Item[]>(`/history${kind ? `?kind=${kind}` : ''}`) })
  return (
    <div>
      <PageHeader title="历史版本" desc="输出配置、自定义规则、规则模板与自建节点的每次修改都会保存版本，可对比差异并一键恢复（2 分钟内的连续修改合并为一个版本）" />
      <div className="mb-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: '全部' },
            { value: 'profile', label: '输出配置' },
            { value: 'rules', label: '自定义规则' },
            { value: 'template', label: '规则模板' },
            { value: 'nodes', label: '节点' },
          ]}
        />
      </div>
      <Card>
        {list.isLoading ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : !list.data?.length ? (
          <Empty icon={<HistoryIcon className="size-8" />} title="还没有历史版本" desc="修改配置后这里会自动出现版本记录" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.data.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-24 shrink-0 text-xs text-zinc-500" title={fmtDate(e.at)}>{fmtTime(e.at)}</span>
                <Badge>{KIND[e.kind]}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{e.label}</span>
                  <span className={cx('ml-2 text-xs', e.deleted ? 'text-red-600' : 'text-zinc-500')}>{e.summary}</span>
                </span>
                <Button size="sm" onClick={() => setOpen(e)} disabled={e.deleted}>查看 / 恢复</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && <DiffModal item={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function DiffModal({ item, onClose }: { item: Item; onClose: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [loading, setLoading] = useState(false)
  const q = useQuery({ queryKey: ['historyItem', item.id], queryFn: () => api.get<{ entry: { data: any }; current: any }>(`/history/${item.id}`) })
  const parts = useMemo(() => {
    if (!q.data) return null
    const y = (v: any) => (v === null || v === undefined ? '' : YAML.stringify(v, { lineWidth: 0 }))
    return diffLines(y(q.data.current), y(q.data.entry.data))
  }, [q.data])
  const changed = parts?.some((p) => p.added || p.removed)

  const restore = async () => {
    if (!(await confirm({ title: '恢复到这个版本？', body: '当前内容会先保存为一个新版本，可以再恢复回来。订阅链接与短链保持不变。', okText: '恢复' }))) return
    setLoading(true)
    try {
      await api.post(`/history/${item.id}/restore`)
      toast('已恢复')
      qc.invalidateQueries()
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${KIND[item.kind]} · ${item.label} · ${fmtDate(item.at)}`}
      width="max-w-4xl"
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={restore} loading={loading} disabled={!changed}><RotateCcw className="size-4" />恢复到此版本</Button>
        </>
      }
    >
      {!parts ? (
        <div className="flex justify-center py-14"><Spinner /></div>
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-500">
            <span className="mr-3 rounded bg-red-50 px-1 text-red-700 dark:bg-red-950/50 dark:text-red-300">− 当前内容</span>
            <span className="rounded bg-emerald-50 px-1 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">+ 此版本</span>
            {!changed && <span className="ml-3">与当前内容相同</span>}
          </p>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
            {parts.map((p, i) => {
              const lines = p.value.replace(/\n$/, '').split('\n')
              // 未改动的长段落只显示首尾几行
              if (!p.added && !p.removed && lines.length > 8) {
                return (
                  <span key={i} className="text-zinc-500">
                    {lines.slice(0, 3).map((l) => `  ${l}\n`)}
                    <span className="text-zinc-400">  ⋯ {lines.length - 6} 行未改动 ⋯{'\n'}</span>
                    {lines.slice(-3).map((l) => `  ${l}\n`)}
                  </span>
                )
              }
              return (
                <span
                  key={i}
                  className={cx(
                    p.added && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
                    p.removed && 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300',
                    !p.added && !p.removed && 'text-zinc-500',
                  )}
                >
                  {lines.map((l) => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${l}\n`)}
                </span>
              )
            })}
          </pre>
        </>
      )}
    </Modal>
  )
}
