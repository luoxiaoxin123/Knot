import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Eye, Search } from 'lucide-react'
import type { Profile } from '@shared/types'
import { api } from '../lib/api'
import { useNodes, useProfiles, useRulesMeta, useSubs, useTemplates } from '../lib/hooks'
import { selectNodes } from '../lib/select'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CopyButton,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner,
  ToggleRow,
  cx,
  useToast,
} from '../components/ui'
import { CodeEditor } from '../components/CodeEditor'
import { TypeBadge } from './Nodes'

const OVERRIDE_EXAMPLE = `# 示例：开启 TUN、修改端口、局域网共享
# mixed-port: 7897
# allow-lan: true
# tun:
#   enable: true
#   stack: mixed
#   auto-route: true
#   auto-detect-interface: true
`

export default function ProfileEditPage() {
  const { id } = useParams()
  const { data: profiles } = useProfiles()
  const profile = profiles?.find((p) => p.id === id)
  if (!profiles) return <div className="flex justify-center py-14"><Spinner /></div>
  if (!profile) return <div className="py-14 text-center text-sm text-zinc-500">配置不存在。<Link to="/profiles" className="text-blue-600">返回</Link></div>
  return <Editor key={profile.id} initial={profile} />
}

function Editor({ initial }: { initial: Profile }) {
  const [f, setF] = useState<Profile>(initial)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const { data: nodes } = useNodes()
  const { data: subs } = useSubs()
  const { data: templates } = useTemplates()
  const { data: meta } = useRulesMeta()
  const qc = useQueryClient()
  const toast = useToast()
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setDirty(true)
  }

  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', fn)
    return () => window.removeEventListener('beforeunload', fn)
  }, [dirty])

  const selected = useMemo(() => selectNodes(f, nodes || [], subs || []), [f, nodes, subs])

  const save = async () => {
    setSaving(true)
    try {
      const p = await api.put<Profile>(`/profiles/${f.id}`, f)
      qc.setQueryData<Profile[]>(['profiles'], (old) => old?.map((x) => (x.id === p.id ? p : x)))
      setDirty(false)
      toast('已保存')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const sources = [
    { key: 'manual', label: '自建节点' },
    { key: 'chain', label: '链式节点' },
    ...(subs || []).map((s) => ({ key: s.id, label: s.name })),
  ]

  return (
    <div className="pb-20">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link to="/profiles" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ArrowLeft className="size-4" /></Link>
          <h1 className="text-xl font-semibold tracking-tight">{f.name || '未命名'}</h1>
        </div>
        <Button onClick={() => setPreview(true)}><Eye className="size-4" />预览配置</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader title="基本" />
            <div className="p-4">
              <Field label="名称" hint="会作为客户端里的配置名称">
                <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="节点" desc={`当前选中 ${selected.length} 个节点`} />
            <div className="space-y-4 p-4">
              <Segmented
                value={f.nodeMode}
                onChange={(v) => set('nodeMode', v)}
                options={[
                  { value: 'all', label: '全部节点' },
                  { value: 'sources', label: '按来源' },
                  { value: 'pick', label: '手动挑选' },
                ]}
              />
              {f.nodeMode === 'sources' && (
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {sources.map((s) => (
                    <label key={s.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={f.sources.includes(s.key)}
                        onChange={(v) => set('sources', v ? [...f.sources, s.key] : f.sources.filter((x) => x !== s.key))}
                      />
                      {s.label}
                    </label>
                  ))}
                  <p className="w-full text-xs text-zinc-500">订阅更新后新增的节点会自动包含。</p>
                </div>
              )}
              {f.nodeMode === 'pick' && <NodePicker value={f.nodeIds} onChange={(v) => set('nodeIds', v)} />}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="名称包含（正则）"><Input value={f.includeRegex} onChange={(e) => set('includeRegex', e.target.value)} placeholder="香港|日本" className="font-mono" /></Field>
                <Field label="名称排除（正则）"><Input value={f.excludeRegex} onChange={(e) => set('excludeRegex', e.target.value)} placeholder="x\d+倍|游戏" className="font-mono" /></Field>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="选项" />
            <div className="divide-y divide-zinc-100 px-4 dark:divide-zinc-800">
              <ToggleRow label="地区分组" hint="自动生成 香港 / 台湾 / 日本 / 新加坡 / 美国 / 韩国 自动测速分组（只生成有节点的地区；链式节点按落地地区归类）" checked={f.regionGroups} onChange={(v) => set('regionGroups', v)} />
              <ToggleRow label="分流组内列出全部节点" hint="可以给每个服务单独指定节点；节点很多时可关闭以精简配置" checked={f.groupsIncludeNodes} onChange={(v) => set('groupsIncludeNodes', v)} />
              <ToggleRow label="节点名加国旗" hint="根据名称识别地区并添加 🇭🇰 🇯🇵 等旗帜" checked={f.addFlags} onChange={(v) => set('addFlags', v)} />
              <ToggleRow label="下发流量信息" hint="汇总所选外部订阅的已用流量 / 总量 / 到期时间，客户端可直接显示" checked={f.trafficInfo} onChange={(v) => set('trafficInfo', v)} />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="分流规则" />
            <div className="space-y-4 p-4">
              <Segmented
                value={f.ruleMode}
                onChange={(v) => set('ruleMode', v)}
                options={[
                  { value: 'modules', label: '内置模块' },
                  { value: 'template', label: '外部模板' },
                ]}
              />
              {f.ruleMode === 'modules' && meta && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-zinc-500">预设：</span>
                    {meta.presets.map((p) => (
                      <Button key={p.id} size="sm" title={p.description} onClick={() => set('modules', p.modules)}>{p.name}</Button>
                    ))}
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {meta.modules.map((m) => {
                      const on = m.required || f.modules.includes(m.id)
                      return (
                        <label
                          key={m.id}
                          title={m.description}
                          className={cx(
                            'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors',
                            on ? 'border-blue-200 bg-blue-50/60 dark:border-blue-900/60 dark:bg-blue-950/20' : 'border-zinc-200 dark:border-zinc-800',
                            m.required && 'cursor-default',
                          )}
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={on}
                            onChange={(v) => !m.required && set('modules', v ? [...f.modules, m.id] : f.modules.filter((x) => x !== m.id))}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{m.name}</span>
                            <span className="block truncate text-xs text-zinc-500">{m.description}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </>
              )}
              {f.ruleMode === 'template' && (
                <Field label="选择模板" hint={<>在「规则 → 外部规则模板」中导入。sing-box 输出不支持外部模板，会改用内置模块。</>}>
                  <Select value={f.templateId || ''} onChange={(e) => set('templateId', e.target.value)}>
                    <option value="" disabled>请选择</option>
                    {(templates || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </Field>
              )}
              <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <ToggleRow label="使用自定义规则" hint={<>「规则 → 自定义规则」中的头部 / 尾部规则</>} checked={f.useCustomRules} onChange={(v) => set('useCustomRules', v)} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="覆写配置（Clash）" desc="与生成的配置深度合并，可修改端口、DNS、TUN 等任意字段" />
            <div className="p-4">
              <CodeEditor value={f.overrideYaml || OVERRIDE_EXAMPLE} onChange={(v) => set('overrideYaml', v === OVERRIDE_EXAMPLE ? '' : v)} height="200px" />
            </div>
          </Card>
        </div>
      </div>

      <div className={cx('fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur transition-transform md:left-52 dark:border-zinc-800 dark:bg-zinc-900/95', dirty ? 'translate-y-0' : 'pointer-events-none invisible translate-y-full')}>
        <div className="mx-auto flex max-w-6xl items-center justify-end gap-2 px-4 py-3 md:px-8">
          <span className="mr-auto text-sm text-zinc-500">有未保存的修改</span>
          <Button onClick={() => { setF(initial); setDirty(false) }}>还原</Button>
          <Button variant="primary" onClick={save} loading={saving}>保存</Button>
        </div>
      </div>

      {preview && <PreviewModal profile={f} onClose={() => setPreview(false)} />}
    </div>
  )
}

function NodePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data: nodes } = useNodes()
  const [q, setQ] = useState('')
  const set = new Set(value)
  const list = (nodes || []).filter((n) => !q || n.name.toLowerCase().includes(q.toLowerCase()))
  const allOn = list.length > 0 && list.every((n) => set.has(n.id))
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
        <Checkbox
          checked={allOn}
          indeterminate={!allOn && list.some((n) => set.has(n.id))}
          onChange={(v) => {
            const s = new Set(value)
            list.forEach((n) => (v ? s.add(n.id) : s.delete(n.id)))
            onChange([...s])
          }}
        />
        <Search className="size-3.5 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <span className="text-xs text-zinc-500">已选 {value.length}</span>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {list.map((n) => (
          <label key={n.id} className={cx('flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50', !n.enabled && 'opacity-50')}>
            <Checkbox checked={set.has(n.id)} onChange={(v) => onChange(v ? [...value, n.id] : value.filter((x) => x !== n.id))} />
            <TypeBadge type={n.proxy.type} />
            <span className="truncate">{n.name}</span>
            {n.source.kind === 'chain' && <Badge color="violet">链式</Badge>}
          </label>
        ))}
      </div>
    </div>
  )
}

function PreviewModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [target, setTarget] = useState<'clash' | 'singbox' | 'v2ray'>('clash')
  const [data, setData] = useState<{ text: string; warnings: string[]; nodeCount: number } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setData(null)
    setError('')
    api
      .post<{ text: string; warnings: string[]; nodeCount: number }>('/profiles/preview', { profile, target })
      .then(setData)
      .catch((e) => setError(e.message))
  }, [profile, target])
  return (
    <Modal open onClose={onClose} title="预览配置（未保存的修改也会体现）" width="max-w-4xl">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented value={target} onChange={setTarget} options={[{ value: 'clash', label: 'Clash' }, { value: 'singbox', label: 'sing-box' }, { value: 'v2ray', label: 'V2Ray' }]} />
          {data && <CopyButton text={data.text} label="复制" />}
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        {!data && !error && <div className="flex justify-center py-14"><Spinner /></div>}
        {data && (
          <>
            {data.warnings.length > 0 && (
              <ul className="space-y-0.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {data.warnings.map((w, i) => <li key={i}>• {w}</li>)}
              </ul>
            )}
            <CodeEditor value={data.text} readOnly height="60vh" lang={target === 'singbox' ? 'json' : target === 'clash' ? 'yaml' : 'text'} />
          </>
        )}
      </div>
    </Modal>
  )
}
