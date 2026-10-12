import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Pencil, Trash2, Rss, AlertCircle } from 'lucide-react'
import type { Subscription } from '@shared/types'
import { api, fmtBytes, fmtTime } from '../lib/api'
import { useSubs } from '../lib/hooks'
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Switch, cx, useConfirm, useToast } from '../components/ui'

const UA_PRESETS = ['clash.meta', 'mihomo', 'clash-verge/v2.0.0', 'v2rayN/7.0', 'sing-box', 'Shadowrocket/2.2']

function Traffic({ s }: { s: Subscription }) {
  const t = s.traffic
  if (!t || !t.total) return null
  const used = t.upload + t.download
  const pct = Math.min(100, (used / t.total) * 100)
  const expire = t.expire ? new Date(t.expire * 1000) : null
  const daysLeft = expire ? Math.ceil((expire.getTime() - Date.now()) / 86400_000) : null
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex justify-between text-xs text-zinc-500">
        <span>
          已用 {fmtBytes(used)} / {fmtBytes(t.total)}
        </span>
        {expire && (
          <span className={cx(daysLeft !== null && daysLeft < 7 && 'text-amber-600')}>
            {daysLeft !== null && daysLeft < 0 ? '已过期' : `${expire.toLocaleDateString()} 到期`}
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={cx('h-full rounded-full', pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-blue-600')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function SubsPage() {
  const { data: subs, isLoading } = useSubs()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Partial<Subscription> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = () => {
    qc.invalidateQueries({ queryKey: ['subs'] })
    qc.invalidateQueries({ queryKey: ['nodes'] })
  }

  const refresh = async (s: Subscription) => {
    setBusy(s.id)
    try {
      const r = await api.post<{ result: { count: number } }>(`/subs/${s.id}/refresh`)
      toast(`「${s.name}」已更新，${r.result.count} 个节点`)
    } catch (e: any) {
      toast(`更新失败：${e.message}`, 'error')
    } finally {
      setBusy(null)
      reload()
    }
  }

  const refreshAll = async () => {
    for (const s of subs || []) if (s.enabled) await refresh(s)
  }

  const remove = async (s: Subscription) => {
    if (!(await confirm({ title: `删除订阅「${s.name}」？`, body: '该订阅的所有节点也会被删除，依赖这些节点的链式代理会失效。', danger: true, okText: '删除' }))) return
    await api.del(`/subs/${s.id}`)
    reload()
  }

  const toggle = async (s: Subscription, enabled: boolean) => {
    await api.put(`/subs/${s.id}`, { enabled })
    reload()
  }

  return (
    <div>
      <PageHeader
        title="订阅源"
        desc="导入外部（机场）订阅，节点会与自建节点一起参与输出、链式代理"
        actions={
          <>
            {!!subs?.length && (
              <Button onClick={refreshAll} disabled={!!busy}>
                <RefreshCw className={cx('size-4', busy && 'animate-spin')} />
                全部更新
              </Button>
            )}
            <Button variant="primary" onClick={() => setEditing({})}>
              <Plus className="size-4" />
              添加订阅
            </Button>
          </>
        }
      />
      {isLoading ? (
        <div className="flex justify-center py-14"><Spinner /></div>
      ) : !subs?.length ? (
        <Card>
          <Empty icon={<Rss className="size-8" />} title="还没有订阅源" desc="支持 Clash / mihomo YAML、Base64、分享链接列表与 sing-box JSON 格式的订阅。" action={<Button variant="primary" onClick={() => setEditing({})}><Plus className="size-4" />添加订阅</Button>} />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {subs.map((s) => (
            <Card key={s.id} className={cx('p-4', !s.enabled && 'opacity-60')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <Badge color="blue">{s.nodeCount ?? 0} 节点</Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-zinc-500" title={s.url}>{s.url.replace(/([?&](token|key|password)=)[^&]+/gi, '$1***')}</div>
                </div>
                <Switch checked={s.enabled} onChange={(v) => toggle(s, v)} />
              </div>
              <Traffic s={s} />
              {s.lastError && (
                <div className="mt-3 flex items-start gap-1.5 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-px size-3.5 shrink-0" />
                  {s.lastError}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <span className="text-xs text-zinc-500">
                  {fmtTime(s.updatedAt)} 更新 · {s.intervalHours ? `每 ${s.intervalHours} 小时自动更新` : '手动更新'}
                </span>
                <div className="flex gap-0.5">
                  <IconButton title="立即更新" onClick={() => refresh(s)} disabled={busy === s.id}>
                    <RefreshCw className={cx('size-4', busy === s.id && 'animate-spin')} />
                  </IconButton>
                  <IconButton title="编辑" onClick={() => setEditing(s)}><Pencil className="size-4" /></IconButton>
                  <IconButton title="删除" onClick={() => remove(s)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && <SubModal sub={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </div>
  )
}

function SubModal({ sub, onClose, onDone }: { sub: Partial<Subscription>; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const defaults = useQuery({ queryKey: ['subDefaults'], queryFn: () => api.get<{ userAgent: string; excludeRegex: string }>('/subs/defaults') })
  const isNew = !sub.id
  const [f, setF] = useState({
    name: sub.name || '',
    url: sub.url || '',
    userAgent: sub.userAgent ?? '',
    intervalHours: sub.intervalHours ?? 12,
    includeRegex: sub.includeRegex || '',
    excludeRegex: sub.excludeRegex ?? undefined,
    namePrefix: sub.namePrefix || '',
  })
  const [loading, setLoading] = useState(false)
  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }))
  const ua = f.userAgent || defaults.data?.userAgent || 'clash.meta'
  const exclude = f.excludeRegex ?? defaults.data?.excludeRegex ?? ''
  const [customUa, setCustomUa] = useState(!!sub.userAgent && !UA_PRESETS.includes(sub.userAgent))
  const uaPreset = customUa ? '__custom' : ua

  const save = async () => {
    setLoading(true)
    try {
      const body = { ...f, userAgent: ua, excludeRegex: exclude }
      if (isNew) {
        const r = await api.post<{ error?: string; result?: { count: number } }>('/subs', body)
        if (r.error) toast(`已添加，但拉取失败：${r.error}`, 'error')
        else toast(`已添加，导入 ${r.result?.count ?? 0} 个节点`)
      } else {
        await api.put(`/subs/${sub.id}`, body)
        toast('已保存，过滤规则会在下次更新时生效')
      }
      onDone()
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
      title={isNew ? '添加订阅' : '编辑订阅'}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={loading} disabled={!f.url}>
            {isNew ? '添加并拉取' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="订阅链接">
          <Input value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://..." autoFocus={isNew} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" hint="留空使用域名">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="自动更新" hint="0 表示不自动更新">
            <div className="flex items-center gap-2">
              <Input type="number" min={0} value={f.intervalHours} onChange={(e) => set('intervalHours', Number(e.target.value))} />
              <span className="shrink-0 text-sm text-zinc-500">小时</span>
            </div>
          </Field>
        </div>
        <Field label="User-Agent" hint="机场会根据 UA 返回不同格式，clash.meta 通常能拿到最完整的节点信息">
          <div className="flex gap-2">
            <Select
              value={uaPreset}
              onChange={(e) => {
                const custom = e.target.value === '__custom'
                setCustomUa(custom)
                set('userAgent', custom ? '' : e.target.value)
              }}
              className="w-44 shrink-0"
            >
              {UA_PRESETS.map((u) => <option key={u} value={u}>{u}</option>)}
              <option value="__custom">自定义</option>
            </Select>
            {customUa && <Input value={f.userAgent} onChange={(e) => set('userAgent', e.target.value)} placeholder="自定义 UA" />}
          </div>
        </Field>
        <Field label="节点名前缀" hint="例如「[机场A] 」，便于区分来源">
          <Input value={f.namePrefix} onChange={(e) => set('namePrefix', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="保留节点（正则）" hint="留空保留全部">
            <Input value={f.includeRegex} onChange={(e) => set('includeRegex', e.target.value)} placeholder="香港|日本|美国" className="font-mono" />
          </Field>
          <Field label="排除节点（正则）" hint="默认排除流量/到期等提示节点">
            <Input value={exclude} onChange={(e) => set('excludeRegex', e.target.value)} className="font-mono" />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
