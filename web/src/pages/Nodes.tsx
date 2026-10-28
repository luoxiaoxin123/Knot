import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCells } from '../components/CheckBadges'
import { Flag, FlagPicker } from '../components/Flag'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, Pencil, Trash2, Plus, Gauge, Search, Copy, Server, ArrowRight, QrCode, Send, ScanSearch, Flag as FlagIcon, FolderInput } from 'lucide-react'
import YAML from 'yaml'
import type { Subscription } from '@shared/types'
import { api, copyText } from '../lib/api'
import { subBase, useNodes, useSettings, useSubs, type NodeView } from '../lib/hooks'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  Segmented,
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
import { ShareModal } from '../components/ShareModal'

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
  const title = `${n.latencyKind === 'real' ? '内核真实延迟' : 'TCP 握手延迟'}${n.latencyAt ? ` · ${new Date(n.latencyAt).toLocaleString()}` : ''}`
  if (n.latency < 0 && n.check?.relayDown) return <span className="text-amber-600" title={`${title}\n${n.check.error}`}>中转不通</span>
  if (n.latency < 0) return <span className="text-red-500" title={n.check?.error ? `${title}\n${n.check.error}` : title}>不可用</span>
  const c = n.latency < 200 ? 'text-emerald-600' : n.latency < 500 ? 'text-amber-600' : 'text-red-500'
  return <span className={cx('tabular-nums', c)} title={title}>{n.latency} ms</span>
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge color={TYPE_COLOR[type] || 'zinc'}>{TYPE_LABEL[type] || type}</Badge>
}

type Filter = 'all' | 'chain' | string

const DEFAULT_GROUP = 'default'
const groupOf = (n: { group?: string }) => n.group || DEFAULT_GROUP
/** 筛选用的 key：自建节点按分组（g:名称），链式为 chain，订阅节点为订阅 id */
const filterKey = (n: NodeView) => (n.source.kind === 'manual' ? `g:${groupOf(n)}` : n.source.kind === 'chain' ? 'chain' : n.source.subId)

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
  const [sharing, setSharing] = useState<string[] | null>(null)
  const [flagFor, setFlagFor] = useState<{ ids: string[]; value?: string } | null>(null)
  const { data: settings } = useSettings()

  const byId = useMemo(() => new Map((nodes || []).map((n) => [n.id, n])), [nodes])
  const subMap = useMemo(() => new Map((subs || []).map((s) => [s.id, s])), [subs])

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return (nodes || []).filter((n) => {
      if (filter !== 'all' && filterKey(n) !== filter) return false
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

  const core = useQuery({ queryKey: ['core'], queryFn: () => api.get<{ available: boolean; version: string }>('/core/status'), staleTime: Infinity })
  const hasCore = !!core.data?.available
  const [checking, setChecking] = useState(false)

  /** 有内核时用内核测真实延迟（支持 UDP 协议与链式），否则 TCP 握手 */
  const runTest = async (ids: string[]) => {
    setTesting(true)
    try {
      if (hasCore) await api.post('/nodes/check', { ids, unlock: false })
      else await api.post('/nodes/test', { ids })
      await refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setTesting(false)
    }
  }

  const runUnlock = async (ids: string[]) => {
    setChecking(true)
    toast(`正在检测 ${ids.length} 个节点的出口与解锁情况…`, 'info')
    try {
      await api.post('/nodes/check', { ids, unlock: true })
      await refresh()
      toast('检测完成')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setChecking(false)
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

  const saveFlag = async (ids: string[], flag: string) => {
    setFlagFor(null)
    const set = new Set(ids)
    qc.setQueryData<NodeView[]>(['nodes'], (old) => old?.map((x) => (set.has(x.id) ? { ...x, flag: flag || undefined } : x)))
    try {
      if (ids.length === 1) await api.put(`/nodes/${ids[0]}`, { flag })
      else await api.post('/nodes/batch', { action: 'flag', ids, flag })
    } catch (e: any) {
      toast(e.message, 'error')
    }
    refresh()
  }

  const counts = useMemo(() => {
    const c = { all: nodes?.length || 0, chain: 0 } as Record<string, number>
    for (const n of nodes || []) c[filterKey(n)] = (c[filterKey(n)] || 0) + 1
    return c
  }, [nodes])

  /** 自建节点的分组（按首次出现的顺序），没有自建节点时也保留 default */
  const groups = useMemo(() => {
    const g = [...new Set((nodes || []).filter((n) => n.source.kind === 'manual').map(groupOf))]
    return g.length ? g : [DEFAULT_GROUP]
  }, [nodes])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)

  const filters: { value: Filter; label: string; group?: string }[] = [
    { value: 'all', label: '全部' },
    ...groups.map((g) => ({ value: `g:${g}`, label: g, group: g })),
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
            <Button onClick={() => runTest(list.map((n) => n.id))} loading={testing} disabled={!list.length} title={hasCore ? '使用 mihomo 内核测试真实延迟' : '未检测到 mihomo 内核，使用 TCP 握手延迟'}>
              <Gauge className="size-4" />
              {hasCore ? '延迟测试' : 'TCP 延迟测试'}
            </Button>
            {hasCore && (
              <Button onClick={() => runUnlock(list.filter((n) => n.enabled).map((n) => n.id))} loading={checking} disabled={!list.length} title="检测出口 IP 与 ChatGPT / Claude / Gemini / Netflix / YouTube 解锁">
                <ScanSearch className="size-4" />
                解锁检测
              </Button>
            )}
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
        <div className="flex min-w-0 max-w-full flex-wrap gap-1">
          {filters.map((f) => (
            <div
              key={f.value}
              className={cx(
                'flex max-w-full items-center rounded-full border text-xs font-medium transition-colors',
                filter === f.value
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
              )}
            >
              <button onClick={() => setFilter(f.value)} onDoubleClick={() => f.group && setRenaming(f.group)} className="flex min-w-0 items-center px-2.5 py-1" title={f.group ? '自建分组，双击可改名' : undefined}>
                <span className="min-w-0 truncate">{f.label}</span>
                <span className="ml-1 shrink-0 opacity-60">{counts[f.value] || 0}</span>
              </button>
              {f.group && filter === f.value && (
                <button onClick={() => setRenaming(f.group!)} className="-ml-1 mr-1 rounded-full p-1 hover:bg-white/20" title="重命名分组" aria-label="重命名分组">
                  <Pencil className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {someSelected && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900/60 dark:bg-blue-950/30">
          <span className="mr-1 font-medium">已选 {selected.size} 个</span>
          <Button size="sm" onClick={() => batch('enable')}>启用</Button>
          <Button size="sm" onClick={() => batch('disable')}>停用</Button>
          <Button size="sm" onClick={() => runTest([...selected])} loading={testing}>延迟测试</Button>
          {hasCore && <Button size="sm" onClick={() => runUnlock([...selected])} loading={checking}>解锁检测</Button>}
          <Button size="sm" onClick={async () => {
            const uris = [...selected].map((id) => byId.get(id)?.uri).filter(Boolean)
            await copyText(uris.join('\n'))
            toast(`已复制 ${uris.length} 条分享链接`)
          }}>复制链接</Button>
          <Button size="sm" onClick={() => setFlagFor({ ids: [...selected] })}><FlagIcon className="size-3.5" />设置旗帜</Button>
          {[...selected].some((id) => byId.get(id)?.source.kind === 'manual') && <Button size="sm" onClick={() => setMoving(true)}><FolderInput className="size-3.5" />移动到分组</Button>}
          <Button size="sm" onClick={() => setSharing([...selected])}><Send className="size-3.5" />临时分享</Button>
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
                  <th className="hidden px-2 py-2 font-medium 2xl:table-cell">地址</th>
                  <th className="hidden whitespace-nowrap px-2 py-2 font-medium sm:table-cell">来源</th>
                  <th className="hidden whitespace-nowrap px-2 py-2 font-medium xl:table-cell">出口 / 解锁</th>
                  <th className="hidden whitespace-nowrap px-2 py-2 text-right font-medium sm:table-cell">延迟</th>
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
                    onShare={() => setSharing([n.id])}
                    onFlag={() => setFlagFor({ ids: [n.id], value: n.flag })}
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

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} groups={groups} initialGroup={filter.startsWith('g:') ? filter.slice(2) : groups[0]} />
      {renaming !== null && (
        <GroupNameModal
          title={`重命名分组「${renaming}」`}
          initial={renaming}
          groups={groups}
          hint="只影响自建节点的分组名；改成已有的分组名会把两个分组合并。"
          onClose={() => setRenaming(null)}
          onSave={async (to) => {
            await api.post('/nodes/groups/rename', { from: renaming, to })
            if (filter === `g:${renaming}`) setFilter(`g:${to}`)
            setRenaming(null)
            refresh()
          }}
        />
      )}
      {moving && (
        <GroupNameModal
          title="移动到分组"
          initial={filter.startsWith('g:') ? filter.slice(2) : groups[0]}
          groups={groups}
          hint="只移动选中的自建节点；输入新名字会新建分组。"
          onClose={() => setMoving(false)}
          onSave={async (group) => {
            await api.post('/nodes/batch', { action: 'group', ids: [...selected], group })
            setMoving(false)
            refresh()
          }}
        />
      )}
      {editing && <EditModal node={editing} nodes={nodes || []} onClose={() => setEditing(null)} onDone={refresh} />}
      {chainFor && <ChainModal target={chainFor} nodes={nodes || []} subMap={subMap} onClose={() => setChainFor(null)} onDone={refresh} />}
      <QrModal open={!!qr} onClose={() => setQr(null)} title={qr?.title || ''} text={qr?.text || ''} />
      {flagFor && (
        <FlagPicker
          value={flagFor.value}
          title={flagFor.ids.length > 1 ? `给 ${flagFor.ids.length} 个节点设置旗帜` : `设置旗帜 · ${byId.get(flagFor.ids[0])?.name || ''}`}
          onClose={() => setFlagFor(null)}
          onChange={(code) => saveFlag(flagFor.ids, code)}
        />
      )}
      {sharing && (
        <ShareModal
          nodeIds={sharing}
          nodeNames={sharing.map((id) => byId.get(id)?.name || id)}
          onClose={() => setSharing(null)}
          onCreated={(s) => setQr({ title: `分享链接已生成 · ${s.name}`, text: `${subBase(settings)}/s/${s.token}` })}
        />
      )}
    </div>
  )
}

/** 名称前的旗帜；没设置时显示一个淡色的占位按钮 */
function FlagButton({ own, inherited, onClick }: { own?: string; inherited?: string; onClick: () => void }) {
  const code = own || inherited
  return (
    <button
      type="button"
      onClick={onClick}
      title={code ? (own ? '更改旗帜' : '沿用落地节点的旗帜，点击单独设置') : '设置旗帜'}
      className={cx(
        'flex h-5 w-6 shrink-0 items-center justify-center rounded text-base leading-none transition-colors',
        code ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'border border-dashed border-zinc-300 text-zinc-300 hover:border-zinc-400 hover:text-zinc-500 dark:border-zinc-700 dark:text-zinc-600',
        !own && inherited && 'opacity-50',
      )}
    >
      {code ? <Flag code={code} /> : <FlagIcon className="size-3" />}
    </button>
  )
}

function sourceLabel(n: NodeView, subMap: Map<string, Subscription>) {
  if (n.source.kind === 'manual') return <Badge>{groupOf(n)}</Badge>
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
  onShare,
  onFlag,
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
  onShare: () => void
  onFlag: () => void
}) {
  const chain = n.source.kind === 'chain' ? n.source : null
  const target = chain ? byId.get(chain.targetId) : undefined
  const relay = chain ? byId.get(chain.relayId) : undefined
  const broken = chain && (!target || !relay)
  const [expanded, setExpanded] = useState(false)
  const p = target?.proxy || n.proxy
  const tr = transportOf(target || n)
  const latency =
    UDP_TYPES.has((relay || n).proxy.type) && n.latency === undefined ? <span className="text-zinc-400" title="UDP 协议需要 mihomo 内核测速">UDP</span> : <Latency n={n} />
  return (
    <tr className={cx('border-b border-zinc-100 last:border-0 hover:bg-zinc-50/70 dark:border-zinc-800/70 dark:hover:bg-zinc-800/30', !n.enabled && 'opacity-50')}>
      <td className="px-3 py-2.5 align-top"><Checkbox checked={checked} onChange={onCheck} /></td>
      <td className="w-full max-w-0 px-2 py-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="flex shrink-0 items-center gap-1.5 pt-px">
            <FlagButton own={n.flag} inherited={target?.flag} onClick={onFlag} />
            <TypeBadge type={p.type} />
          </span>
          {/* 名称最多两行，过长再省略；点击展开/收起完整名称（手机上没有悬停提示） */}
          <span
            className={cx('min-w-0 cursor-pointer font-medium break-all', !expanded && 'line-clamp-2')}
            title={n.name}
            onClick={() => setExpanded((v) => !v)}
          >
            {n.name}
          </span>
          {broken && <Badge color="red" className="shrink-0">失效</Badge>}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
          {chain ? (
            <span className="flex min-w-0 max-w-full items-center gap-1">
              <span className="truncate">{relay?.name ?? '（已删除）'}</span>
              <ArrowRight className="size-3 shrink-0" />
              <span className="truncate">{target?.name ?? '（已删除）'}</span>
            </span>
          ) : (
            <span className="min-w-0 max-w-full truncate font-mono 2xl:hidden">{p.server}:{p.port}</span>
          )}
          {tr && <span className="whitespace-nowrap text-zinc-400">· {tr}</span>}
          {/* 手机上没有延迟列，延迟显示在这里 */}
          <span className="whitespace-nowrap sm:hidden">· {latency}</span>
          {n.tags.map((t) => <Badge key={t} color="blue">{t}</Badge>)}
        </div>
        {/* 窄屏没有「出口 / 解锁」列，检测结果显示在名称下方 */}
        {n.check?.unlock && (
          <div className="mt-1.5 xl:hidden">
            <CheckCells check={n.check} inline />
          </div>
        )}
      </td>
      <td className="hidden px-2 py-2 font-mono text-xs text-zinc-600 2xl:table-cell dark:text-zinc-400">
        <span className="block max-w-56 truncate" title={`${p.server}:${p.port}`}>{p.server}:{p.port}</span>
      </td>
      <td className="hidden whitespace-nowrap px-2 py-2 sm:table-cell">{sourceLabel(n, subMap)}</td>
      <td className="hidden min-w-68 px-2 py-2 xl:table-cell"><CheckCells check={n.check} /></td>
      <td className="hidden whitespace-nowrap px-2 py-2 text-right text-xs sm:table-cell">{latency}</td>
      <td className="px-2 py-2">
        <div className="flex items-center justify-end gap-0.5">
          <Switch checked={n.enabled} onChange={onEnabled} title={n.enabled ? '已启用' : '已停用'} />
          <span className="w-1" />
          {/* 常用操作直接显示（手机上收进菜单），其余放在「更多」里；没有的按钮用等宽占位，保证每行对齐 */}
          <span className="hidden items-center gap-0.5 sm:flex">
            {!chain ? <IconButton title="配置链式代理" onClick={onChain}><Link2 className="size-4" /></IconButton> : <span className="size-7 shrink-0" />}
            <IconButton title="编辑" onClick={onEdit}><Pencil className="size-4" /></IconButton>
          </span>
          <Menu
            items={[
              { label: '编辑', icon: <Pencil />, onClick: onEdit },
              !chain && { label: '配置链式代理', icon: <Link2 />, onClick: onChain },
              { label: '设置旗帜', icon: <FlagIcon />, onClick: onFlag },
              'divider',
              { label: '复制分享链接', icon: <Copy />, onClick: onCopy, disabled: !n.uri },
              { label: '二维码', icon: <QrCode />, onClick: onQr, disabled: !n.uri },
              { label: '临时分享', icon: <Send />, onClick: onShare },
              n.source.kind !== 'sub' && 'divider',
              n.source.kind !== 'sub' && { label: '删除', icon: <Trash2 />, onClick: onDelete, danger: true },
            ]}
          />
        </div>
      </td>
    </tr>
  )
}

// ------------------------------------------------------------------ 导入

function ImportModal({ open, onClose, onDone, groups, initialGroup }: { open: boolean; onClose: () => void; onDone: () => void; groups: string[]; initialGroup: string }) {
  const [text, setText] = useState('')
  const [group, setGroup] = useState(initialGroup)
  useEffect(() => {
    if (open) setGroup(initialGroup)
  }, [open, initialGroup])
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
      const r = await api.post<{ added: number; errors: string[] }>('/nodes/import', { text, group })
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
        <Field label="分组" hint="选择已有分组，或输入新名字新建分组">
          <GroupInput value={group} onChange={setGroup} groups={groups} />
        </Field>
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
  const [group, setGroup] = useState(groupOf(node))
  const groupList = useMemo(() => [...new Set(nodes.filter((n) => n.source.kind === 'manual').map(groupOf))], [nodes])
  const { name: _n, ...rest } = node.proxy
  const [yaml, setYaml] = useState(() => YAML.stringify({ name: node.name, ...rest }, { lineWidth: 0 }))
  const [uri, setUri] = useState(node.uri || '')
  const [format, setFormat] = useState<'yaml' | 'uri'>('yaml')
  const chain = node.source.kind === 'chain' ? node.source : null
  const [relayId, setRelayId] = useState(chain?.relayId || '')
  const [loading, setLoading] = useState(false)
  const isSub = node.source.kind === 'sub'
  const save = async () => {
    setLoading(true)
    try {
      const body: any = { name, tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) }
      if (node.source.kind === 'manual') body.group = group
      if (!chain && !isSub) {
        if (format === 'uri') {
          if (uri.trim() !== (node.uri || '')) body.proxyUri = uri
        } else body.proxyYaml = yaml
      }
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="标签" hint="多个用逗号分隔，可在订阅输出中按名称筛选"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          {node.source.kind === 'manual' && <Field label="分组"><GroupInput value={group} onChange={setGroup} groups={groupList} /></Field>}
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
          <div className="space-y-2">
            {node.uri && (
              <Segmented size="sm" value={format} onChange={setFormat} options={[
                { value: 'yaml', label: 'mihomo YAML' },
                { value: 'uri', label: '分享链接' },
              ]} />
            )}
            {format === 'uri' ? (
              <Field
                label="节点配置（分享链接）"
                hint={
                  <>
                    {node.raw ? '这是导入时的原始链接。' : '导入时不是分享链接（或已用 YAML 修改过配置），这里是按当前配置生成的链接。'}
                    {isSub ? '订阅节点的配置由订阅源决定，会在更新时覆盖，这里只读。' : '修改后保存会按链接重新解析节点配置，# 后的名称也会生效；保存时以当前显示的格式为准。'}
                  </>
                }
              >
                <Textarea value={uri} onChange={(e) => setUri(e.target.value)} readOnly={isSub} rows={6} className="break-all font-mono text-xs" />
              </Field>
            ) : (
              <Field label="节点配置（mihomo 格式）" hint={isSub ? '订阅节点的配置由订阅源决定，会在更新时覆盖，这里只读。' : '直接编辑 YAML，字段参考 mihomo 文档。'}>
                <CodeEditor value={yaml} onChange={setYaml} height="300px" readOnly={isSub} />
              </Field>
            )}
          </div>
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
          <span className={cx('min-w-0 font-medium wrap-anywhere', relay ? '' : 'text-zinc-400')}>{relay?.name || '选择中转节点'}</span>
          <ArrowRight className="size-3.5 text-zinc-400" />
          <span className="min-w-0 font-medium wrap-anywhere">{target.name}</span>
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

// ------------------------------------------------------------------ 分组

/** 分组输入：可从已有分组中选择，也可以直接输入新名字 */
function GroupInput({ value, onChange, groups }: { value: string; onChange: (v: string) => void; groups: string[] }) {
  return (
    <div className="space-y-1.5">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={DEFAULT_GROUP} maxLength={40} />
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => onChange(g)}
              className={cx(
                'max-w-full truncate rounded border px-1.5 py-0.5 text-[11px]',
                value === g ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-zinc-200 text-zinc-600 hover:border-blue-400 dark:border-zinc-700 dark:text-zinc-400',
              )}
            >
              {g}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function GroupNameModal({
  title,
  initial,
  groups,
  hint,
  onClose,
  onSave,
}: {
  title: string
  initial: string
  groups: string[]
  hint: string
  onClose: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const save = async () => {
    if (!name.trim()) return toast('分组名不能为空', 'error')
    setSaving(true)
    try {
      await onSave(name.trim())
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={saving}>保存</Button>
        </>
      }
    >
      <Field label="分组名称" hint={hint}>
        <GroupInput value={name} onChange={setName} groups={groups} />
      </Field>
    </Modal>
  )
}
