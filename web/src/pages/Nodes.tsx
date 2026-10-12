import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, Pencil, Trash2, Plus, Gauge, Search, Copy, Server, ArrowRight, QrCode } from 'lucide-react'
import YAML from 'yaml'
import type { Subscription } from '@shared/types'
import { api, copyText } from '../lib/api'
import { useNodes, useSubs, type NodeView } from '../lib/hooks'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Switch,
  Textarea,
  cx,
  useConfirm,
  useToast,
  type BadgeColor,
} from '../components/ui'
import { CodeEditor } from '../components/CodeEditor'
import { QrModal } from '../components/Qr'

const TYPE_COLOR: Record<string, BadgeColor> = {
  vless: 'blue',
  vmess: 'blue',
  trojan: 'violet',
  ss: 'green',
  ssr: 'green',
  hysteria2: 'amber',
  hysteria: 'amber',
  tuic: 'amber',
  anytls: 'violet',
  wireguard: 'red',
}

const TYPE_LABEL: Record<string, string> = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  ss: 'SS',
  ssr: 'SSR',
  hysteria2: 'Hy2',
  hysteria: 'Hy',
  tuic: 'TUIC',
  anytls: 'AnyTLS',
  wireguard: 'WG',
  socks5: 'SOCKS5',
  http: 'HTTP',
}

const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'tuic', 'wireguard'])

function transportOf(n: NodeView): string | null {
  const p = n.proxy
  const parts: string[] = []
  if (p['reality-opts']) parts.push('Reality')
  else if (p.tls) parts.push('TLS')
  if (p.network && p.network !== 'tcp') parts.push(p.network.toUpperCase())
  if (p.flow) parts.push('Vision')
  if (p.ports) parts.push('端口跳跃')
  return parts.length ? parts.join('+') : null
}

function Latency({ n }: { n: NodeView }) {
  if (n.latency === undefined) return <span className="text-zinc-400">—</span>
  if (n.latency < 0) return <span className="text-red-500">超时</span>
  const c = n.latency < 200 ? 'text-emerald-600' : n.latency < 500 ? 'text-amber-600' : 'text-red-500'
  return <span className={cx('tabular-nums', c)}>{n.latency} ms</span>
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge color={TYPE_COLOR[type] || 'zinc'}>{TYPE_LABEL[type] || type}</Badge>
}

type Filter = 'all' | 'manual' | 'chain' | string

export default function NodesPage() {
  const { data: nodes, isLoading } = useNodes()
  const { data: subs } = useSubs()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<NodeView | null>(null)
  const [chainFor, setChainFor] = useState<NodeView | null>(null)
  const [qr, setQr] = useState<{ title: string; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const byId = useMemo(() => new Map((nodes || []).map((n) => [n.id, n])), [nodes])
  const subMap = useMemo(() => new Map((subs || []).map((s) => [s.id, s])), [subs])

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return (nodes || []).filter((n) => {
      if (filter === 'manual' && n.source.kind !== 'manual') return false
      if (filter === 'chain' && n.source.kind !== 'chain') return false
      if (filter !== 'all' && filter !== 'manual' && filter !== 'chain' && !(n.source.kind === 'sub' && n.source.subId === filter)) return false
      if (!kw) return true
      return n.name.toLowerCase().includes(kw) || n.proxy.server?.toLowerCase().includes(kw) || n.proxy.type.includes(kw) || n.tags.some((t) => t.toLowerCase().includes(kw))
    })
  }, [nodes, q, filter])

  const refresh = () => qc.invalidateQueries({ queryKey: ['nodes'] })
  const allSelected = list.length > 0 && list.every((n) => selected.has(n.id))
  const someSelected = list.some((n) => selected.has(n.id))
  const toggleAll = () => {
    const s = new Set(selected)
    if (allSelected) list.forEach((n) => s.delete(n.id))
    else list.forEach((n) => s.add(n.id))
    setSelected(s)
  }
  const toggle = (id: string) => {
    const s = new Set(selected)
    s.has(id) ? s.delete(id) : s.add(id)
    setSelected(s)
  }

  const runTest = async (ids: string[]) => {
    setTesting(true)
    try {
      await api.post('/nodes/test', { ids })
      await refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setTesting(false)
    }
  }

  const batch = async (action: string) => {
    const ids = [...selected]
    if (action === 'delete') {
      const subCount = ids.filter((id) => byId.get(id)?.source.kind === 'sub').length
      const ok = await confirm({
        title: `删除 ${ids.length - subCount} 个节点？`,
        body: subCount ? `其中 ${subCount} 个订阅节点不会被删除（会在订阅更新时恢复），可以改为停用。` : '删除后无法恢复。',
        danger: true,
        okText: '删除',
      })
      if (!ok) return
    }
    try {
      const r = await api.post<{ brokenChains?: string[] }>('/nodes/batch', { action, ids })
      if (r.brokenChains?.length) toast(`以下链式节点失去了依赖：${r.brokenChains.join('、')}`, 'error')
      if (action === 'delete') setSelected(new Set())
      refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const remove = async (n: NodeView) => {
    if (!(await confirm({ title: `删除「${n.name}」？`, danger: true, okText: '删除' }))) return
    try {
      const r = await api.del<{ brokenChains?: string[] }>(`/nodes/${n.id}`)
      if (r.brokenChains?.length) toast(`以下链式节点失去了依赖：${r.brokenChains.join('、')}`, 'error')
      refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const setEnabled = async (n: NodeView, enabled: boolean) => {
    qc.setQueryData<NodeView[]>(['nodes'], (old) => old?.map((x) => (x.id === n.id ? { ...x, enabled } : x)))
    await api.put(`/nodes/${n.id}`, { enabled }).catch((e) => toast(e.message, 'error'))
  }

  const counts = useMemo(() => {
    const c = { all: nodes?.length || 0, manual: 0, chain: 0 } as Record<string, number>
    for (const n of nodes || []) {
      const k = n.source.kind === 'sub' ? n.source.subId : n.source.kind
      c[k] = (c[k] || 0) + 1
    }
    return c
  }, [nodes])

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'manual', label: '自建' },
    { value: 'chain', label: '链式' },
    ...(subs || []).map((s) => ({ value: s.id, label: s.name })),
  ]

  return (
    <div>
      <PageHeader
        title="节点"
        desc="自建节点、外部订阅节点与链式代理节点"
        actions={
          <>
            <Button onClick={() => runTest(list.map((n) => n.id))} loading={testing} disabled={!list.length}>
              <Gauge className="size-4" />
              测速
            </Button>
            <Button variant="primary" onClick={() => setImportOpen(true)}>
              <Plus className="size-4" />
              添加节点
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 地址 / 协议 / 标签" className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cx(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                filter === f.value
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
              )}
            >
              {f.label}
              <span className="ml-1 opacity-60">{counts[f.value] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {someSelected && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900/60 dark:bg-blue-950/30">
          <span className="mr-1 font-medium">已选 {selected.size} 个</span>
          <Button size="sm" onClick={() => batch('enable')}>启用</Button>
          <Button size="sm" onClick={() => batch('disable')}>停用</Button>
          <Button size="sm" onClick={() => runTest([...selected])} loading={testing}>测速</Button>
          <Button size="sm" onClick={async () => {
            const uris = [...selected].map((id) => byId.get(id)?.uri).filter(Boolean)
            await copyText(uris.join('\n'))
            toast(`已复制 ${uris.length} 条分享链接`)
          }}>复制链接</Button>
          <Button size="sm" variant="danger" onClick={() => batch('delete')}>删除</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
        </div>
      )}

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : !list.length ? (
          <Empty
            icon={<Server className="size-8" />}
            title={nodes?.length ? '没有匹配的节点' : '还没有节点'}
            desc={nodes?.length ? undefined : '粘贴 vless:// hysteria2:// ss:// 等分享链接或 Clash 配置导入自建节点，也可以在「订阅源」里添加机场订阅。'}
            action={!nodes?.length && <Button variant="primary" onClick={() => setImportOpen(true)}><Plus className="size-4" />添加节点</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <th className="w-10 px-3 py-2"><Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAll} /></th>
                  <th className="px-2 py-2 font-medium">名称</th>
                  <th className="hidden px-2 py-2 font-medium lg:table-cell">地址</th>
                  <th className="hidden px-2 py-2 font-medium sm:table-cell">来源</th>
                  <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">延迟</th>
                  <th className="px-2 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((n) => (
                  <NodeRow
                    key={n.id}
                    n={n}
                    byId={byId}
                    subMap={subMap}
                    checked={selected.has(n.id)}
                    onCheck={() => toggle(n.id)}
                    onEdit={() => setEditing(n)}
                    onChain={() => setChainFor(n)}
                    onDelete={() => remove(n)}
                    onEnabled={(v) => setEnabled(n, v)}
                    onQr={() => n.uri && setQr({ title: n.name, text: n.uri })}
                    onCopy={async () => {
                      if (!n.uri) return toast('该节点无法生成分享链接', 'error')
                      await copyText(n.uri)
                      toast('已复制分享链接')
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
      {editing && <EditModal node={editing} nodes={nodes || []} onClose={() => setEditing(null)} onDone={refresh} />}
      {chainFor && <ChainModal target={chainFor} nodes={nodes || []} subMap={subMap} onClose={() => setChainFor(null)} onDone={refresh} />}
      <QrModal open={!!qr} onClose={() => setQr(null)} title={qr?.title || ''} text={qr?.text || ''} />
    </div>
  )
}

function sourceLabel(n: NodeView, subMap: Map<string, Subscription>) {
  if (n.source.kind === 'manual') return <Badge>自建</Badge>
  if (n.source.kind === 'chain') return <Badge color="violet">链式</Badge>
  const s = subMap.get(n.source.subId)
  return <Badge color="zinc" title={s?.url}>{s?.name || '订阅'}</Badge>
}

function NodeRow({
  n,
  byId,
  subMap,
  checked,
  onCheck,
  onEdit,
  onChain,
  onDelete,
  onEnabled,
  onCopy,
  onQr,
}: {
  n: NodeView
  byId: Map<string, NodeView>
  subMap: Map<string, Subscription>
  checked: boolean
  onCheck: () => void
  onEdit: () => void
  onChain: () => void
  onDelete: () => void
  onEnabled: (v: boolean) => void
  onCopy: () => void
  onQr: () => void
}) {
  const chain = n.source.kind === 'chain' ? n.source : null
  const target = chain ? byId.get(chain.targetId) : undefined
  const relay = chain ? byId.get(chain.relayId) : undefined
  const broken = chain && (!target || !relay)
  const p = target?.proxy || n.proxy
  const tr = transportOf(target || n)
  return (
    <tr className={cx('border-b border-zinc-100 last:border-0 hover:bg-zinc-50/70 dark:border-zinc-800/70 dark:hover:bg-zinc-800/30', !n.enabled && 'opacity-50')}>
      <td className="px-3 py-2.5 align-top"><Checkbox checked={checked} onChange={onCheck} /></td>
      <td className="w-full max-w-0 px-2 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <TypeBadge type={p.type} />
          <span className="truncate font-medium" title={n.name}>{n.name}</span>
          {broken && <Badge color="red">失效</Badge>}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-zinc-500">
          {chain ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{relay?.name ?? '（已删除）'}</span>
              <ArrowRight className="size-3 shrink-0" />
              <span className="truncate">{target?.name ?? '（已删除）'}</span>
            </span>
          ) : (
            <span className="truncate font-mono lg:hidden">{p.server}:{p.port}</span>
          )}
          {tr && <span className="whitespace-nowrap text-zinc-400">· {tr}</span>}
          {n.tags.map((t) => <Badge key={t} color="blue">{t}</Badge>)}
        </div>
      </td>
      <td className="hidden px-2 py-2 font-mono text-xs text-zinc-600 lg:table-cell dark:text-zinc-400">
        <span className="block max-w-56 truncate" title={`${p.server}:${p.port}`}>{p.server}:{p.port}</span>
      </td>
      <td className="hidden px-2 py-2 sm:table-cell">{sourceLabel(n, subMap)}</td>
      <td className="hidden px-2 py-2 text-right text-xs sm:table-cell">
        {UDP_TYPES.has((relay || n).proxy.type) && n.latency === undefined ? <span className="text-zinc-400" title="UDP 协议无法通过 TCP 测速">UDP</span> : <Latency n={n} />}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center justify-end gap-0.5">
          <Switch checked={n.enabled} onChange={onEnabled} title={n.enabled ? '已启用' : '已停用'} />
          <span className="w-1" />
          {!chain && <IconButton title="配置链式代理" onClick={onChain}><Link2 className="size-4" /></IconButton>}
          <span className="hidden items-center gap-0.5 sm:flex">
            <IconButton title="复制分享链接" onClick={onCopy} disabled={!n.uri}><Copy className="size-4" /></IconButton>
            <IconButton title="二维码" onClick={onQr} disabled={!n.uri}><QrCode className="size-4" /></IconButton>
          </span>
          <IconButton title="编辑" onClick={onEdit}><Pencil className="size-4" /></IconButton>
          {n.source.kind !== 'sub' && <IconButton title="删除" onClick={onDelete} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>}
        </div>
      </td>
    </tr>
  )
}

// ------------------------------------------------------------------ 导入

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ count: number; errors: string[]; names: string[] } | null>(null)
  const toast = useToast()
  const check = async (t: string) => {
    if (!t.trim()) return setPreview(null)
    const r = await api.post<{ proxies: any[]; errors: string[] }>('/nodes/parse', { text: t })
    setPreview({ count: r.proxies.length, errors: r.errors, names: r.proxies.slice(0, 8).map((p) => p.name) })
  }
  const submit = async () => {
    setLoading(true)
    try {
      const r = await api.post<{ added: number; errors: string[] }>('/nodes/import', { text })
      toast(`已导入 ${r.added} 个节点${r.errors.length ? `，${r.errors.length} 条解析失败` : ''}`, r.added ? 'ok' : 'error')
      if (r.added) {
        setText('')
        setPreview(null)
        onDone()
        onClose()
      }
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加节点"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} loading={loading} disabled={!preview?.count}>
            导入{preview?.count ? ` ${preview.count} 个节点` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-zinc-500">
          支持：分享链接（vless / vmess / trojan / ss / ssr / hysteria2 / hysteria / tuic / anytls / wireguard / socks5 / http，每行一个）、Base64 订阅内容、Clash YAML（完整配置或 proxies 列表）、sing-box JSON。
        </p>
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            check(e.target.value).catch(() => setPreview(null))
          }}
          placeholder={'vless://uuid@1.2.3.4:443?security=reality&...#香港\nhysteria2://password@hy.example.com:443?sni=...#日本'}
        />
        {preview && (
          <div className="rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-800/50">
            <div className="font-medium">识别到 {preview.count} 个节点</div>
            {preview.names.length > 0 && <div className="mt-1 text-zinc-500">{preview.names.join('、')}{preview.count > preview.names.length ? ' …' : ''}</div>}
            {preview.errors.map((e, i) => <div key={i} className="mt-1 text-red-600">{e}</div>)}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ 编辑

function EditModal({ node, nodes, onClose, onDone }: { node: NodeView; nodes: NodeView[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(node.name)
  const [tags, setTags] = useState(node.tags.join(', '))
  const { name: _n, ...rest } = node.proxy
  const [yaml, setYaml] = useState(() => YAML.stringify({ name: node.name, ...rest }, { lineWidth: 0 }))
  const chain = node.source.kind === 'chain' ? node.source : null
  const [relayId, setRelayId] = useState(chain?.relayId || '')
  const [loading, setLoading] = useState(false)
  const isSub = node.source.kind === 'sub'
  const save = async () => {
    setLoading(true)
    try {
      const body: any = { name, tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) }
      if (!chain && !isSub) body.proxyYaml = yaml
      if (chain) body.relayId = relayId
      await api.put(`/nodes/${node.id}`, body)
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
      title="编辑节点"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={loading}>保存</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="标签" hint="多个用逗号分隔，可在订阅输出中按名称筛选"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        </div>
        {chain ? (
          <Field label="中转节点" hint="落地节点不可修改，如需更换请新建链式节点">
            <Select value={relayId} onChange={(e) => setRelayId(e.target.value)}>
              {nodes.filter((x) => x.id !== node.id && x.id !== chain.targetId).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="节点配置（mihomo 格式）" hint={isSub ? '订阅节点的配置由订阅源决定，会在更新时覆盖，这里只读。' : '直接编辑 YAML，字段参考 mihomo 文档。'}>
            <CodeEditor value={yaml} onChange={setYaml} height="300px" readOnly={isSub} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ 链式代理

function ChainModal({
  target,
  nodes,
  subMap,
  onClose,
  onDone,
}: {
  target: NodeView
  nodes: NodeView[]
  subMap: Map<string, Subscription>
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [relayId, setRelayId] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const relay = nodes.find((n) => n.id === relayId)
  const candidates = nodes.filter((n) => n.id !== target.id && n.enabled && (!q || n.name.toLowerCase().includes(q.toLowerCase())))
  const defaultName = relay ? `${target.name} ⇐ ${relay.name}` : ''
  const udpWarn = relay && UDP_TYPES.has(target.proxy.type) && (relay.proxy.type === 'http' || relay.proxy.udp === false)
  const submit = async () => {
    setLoading(true)
    try {
      await api.post('/nodes/chain', { targetId: target.id, relayId, name: name.trim() || defaultName })
      toast('已创建链式节点')
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
      title="配置链式代理"
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} loading={loading} disabled={!relayId}>创建链式节点</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-800/50">
          <span className="text-zinc-500">本机</span>
          <ArrowRight className="size-3.5 text-zinc-400" />
          <span className={cx('font-medium', relay ? '' : 'text-zinc-400')}>{relay?.name || '选择中转节点'}</span>
          <ArrowRight className="size-3.5 text-zinc-400" />
          <span className="font-medium">{target.name}</span>
          <span className="text-zinc-500">（落地）</span>
          <ArrowRight className="size-3.5 text-zinc-400" />
          <span className="text-zinc-500">目标网站</span>
        </div>
        <Field label="选择中转节点" hint="流量先连到中转节点，再由中转节点连接落地节点。中转节点本身也可以是链式节点（多级链）。">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索节点" />
        </Field>
        <div className="max-h-64 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          {candidates.map((n) => (
            <button
              key={n.id}
              onClick={() => setRelayId(n.id)}
              className={cx(
                'flex w-full items-center gap-2 border-b border-zinc-100 px-3 py-2 text-left text-sm last:border-0 dark:border-zinc-800',
                relayId === n.id ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
              )}
            >
              <input type="radio" readOnly checked={relayId === n.id} className="accent-blue-600" />
              <TypeBadge type={n.proxy.type} />
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              <span className="shrink-0">{sourceLabel(n, subMap)}</span>
            </button>
          ))}
          {!candidates.length && <div className="px-3 py-6 text-center text-xs text-zinc-500">没有可用节点</div>}
        </div>
        <Field label="链式节点名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName || '默认：落地 ⇐ 中转'} />
        </Field>
        {udpWarn && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            落地节点是 {target.proxy.type}（基于 UDP/QUIC），所选中转节点不支持 UDP 转发，链路可能无法连通。
          </p>
        )}
        <p className="text-xs text-zinc-500">
          链式代理会以 <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">dialer-proxy</code>（mihomo）/ <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">detour</code>（sing-box）输出；中转节点即使未被订阅输出选中也会自动写入配置。V2Ray 格式无法表达链式代理，会自动跳过。
        </p>
      </div>
    </Modal>
  )
}
