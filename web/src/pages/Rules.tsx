import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowRight, Pencil, Plus, Trash2, RefreshCw, FileCode2, ListTree, Eye } from 'lucide-react'
import type { CustomRule, RulePosition, RuleTemplate } from '@shared/types'
import { rulesToYaml, yamlToRules } from '@shared/rules-yaml'
import { api, fmtTime } from '../lib/api'
import { useCustomRules, useNodes, useRulesMeta, useTemplates, type RulesMeta } from '../lib/hooks'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  cx,
  useConfirm,
  useToast,
} from '../components/ui'
import { CodeEditor } from '../components/CodeEditor'

export default function RulesPage() {
  const [tab, setTab] = useState<'custom' | 'modules' | 'templates'>('custom')
  return (
    <div>
      <PageHeader title="规则" desc="自定义规则、内置分流模块与外部规则模板。在「订阅输出」中选择使用哪些。" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'custom', label: '自定义规则' },
          { value: 'modules', label: '内置分流模块' },
          { value: 'templates', label: '外部规则模板' },
        ]}
      />
      {tab === 'custom' && <CustomRules />}
      {tab === 'modules' && <Modules />}
      {tab === 'templates' && <Templates />}
    </div>
  )
}

// ======================================================================= 自定义规则

const TYPE_INFO: Record<string, { desc: string; ph: string }> = {
  DOMAIN: { desc: '完整域名，精确匹配', ph: 'www.example.com' },
  'DOMAIN-SUFFIX': { desc: '域名后缀，包含所有子域名', ph: 'example.com' },
  'DOMAIN-KEYWORD': { desc: '域名包含关键字', ph: 'google' },
  'DOMAIN-REGEX': { desc: '域名正则', ph: '^ad\\..*\\.com$' },
  GEOSITE: { desc: '域名分类（自动转为 MetaCubeX 规则集）', ph: 'openai' },
  GEOIP: { desc: 'IP 归属地 / 分类（自动转为规则集）', ph: 'cn' },
  'IP-CIDR': { desc: 'IPv4 地址段', ph: '1.1.1.0/24' },
  'IP-CIDR6': { desc: 'IPv6 地址段', ph: '2001:db8::/32' },
  'IP-ASN': { desc: 'IP 所属 ASN（需要客户端下载 ASN 数据库）', ph: '13335' },
  'SRC-IP-CIDR': { desc: '来源 IP，用于给局域网内某台设备单独分流', ph: '192.168.1.100/32' },
  'DST-PORT': { desc: '目标端口，可写范围', ph: '443 或 8000-9000' },
  'SRC-PORT': { desc: '来源端口', ph: '12345' },
  'PROCESS-NAME': { desc: '进程名，仅桌面端 / Android 有效', ph: 'Telegram.exe' },
  'PROCESS-PATH': { desc: '进程完整路径', ph: '/usr/bin/curl' },
  NETWORK: { desc: '网络类型', ph: 'udp' },
  'RULE-SET': { desc: '引用配置中已有的规则集名称', ph: 'geosite-openai' },
}

const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'IP-ASN', 'GEOIP', 'RULE-SET'])

const GEOSITE_SUGGEST = ['openai', 'anthropic', 'google-gemini', 'category-ai-!cn', 'netflix', 'youtube', 'google', 'github', 'telegram', 'twitter', 'spotify', 'tiktok', 'steam', 'steam@cn', 'epicgames', 'apple', 'microsoft', 'bilibili', 'cn', 'geolocation-!cn', 'category-ads-all', 'private', 'tld-cn', 'gfw', 'cursor', 'xai', 'perplexity', 'discord', 'reddit', 'pixiv', 'twitch', 'disney', 'paypal', 'amazon']
const GEOIP_SUGGEST = ['cn', 'private', 'telegram', 'google', 'netflix', 'twitter', 'facebook', 'cloudflare']

function ruleText(r: CustomRule) {
  if (r.kind === 'ruleset') return r.url || ''
  return r.value || ''
}

function CustomRules() {
  const { data: rules, isLoading } = useCustomRules()
  const { data: meta } = useRulesMeta()
  const { data: nodes } = useNodes()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [mode, setMode] = useState<'visual' | 'yaml'>('visual')
  const [editing, setEditing] = useState<{ rule?: CustomRule; position: RulePosition } | null>(null)
  const [yamlText, setYamlText] = useState('')
  const [yamlDirty, setYamlDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (rules && !yamlDirty) setYamlText(rulesToYaml(rules))
  }, [rules, yamlDirty])

  const save = async (list: CustomRule[]) => {
    qc.setQueryData(['customRules'], list.map((r, i) => ({ ...r, order: i })))
    try {
      await api.put('/rules/custom', list)
    } catch (e: any) {
      toast(e.message, 'error')
    }
    qc.invalidateQueries({ queryKey: ['customRules'] })
  }

  const ordered = useMemo(() => [...(rules || [])].sort((a, b) => a.order - b.order), [rules])
  const head = ordered.filter((r) => r.position === 'head')
  const tail = ordered.filter((r) => r.position === 'tail')

  const move = (r: CustomRule, dir: -1 | 1) => {
    const group = r.position === 'head' ? head : tail
    const i = group.indexOf(r)
    const j = i + dir
    if (j < 0 || j >= group.length) return
    const g = [...group]
    ;[g[i], g[j]] = [g[j], g[i]]
    save(r.position === 'head' ? [...g, ...tail] : [...head, ...g])
  }

  const upsert = (list: CustomRule[], replaceId?: string) => {
    let next = [...ordered]
    if (replaceId) {
      const idx = next.findIndex((x) => x.id === replaceId)
      next.splice(idx, 1, ...list)
    } else {
      next.push(...list)
    }
    // 保持 head 在前
    next = [...next.filter((x) => x.position === 'head'), ...next.filter((x) => x.position === 'tail')]
    save(next)
  }

  const remove = async (r: CustomRule) => {
    if (!(await confirm({ title: '删除这条规则？', body: <code className="text-xs">{r.type || 'RULE-SET'},{ruleText(r)}</code>, danger: true, okText: '删除' }))) return
    save(ordered.filter((x) => x.id !== r.id))
  }

  const saveYaml = async () => {
    setSaving(true)
    try {
      const list = yamlToRules(yamlText, rules || [], () => Math.random().toString(36).slice(2, 14))
      await api.put('/rules/custom', list)
      await qc.invalidateQueries({ queryKey: ['customRules'] })
      setYamlDirty(false)
      toast(`已保存 ${list.length} 条规则`)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const switchMode = async (m: 'visual' | 'yaml') => {
    if (m === 'visual' && yamlDirty) {
      if (!(await confirm({ title: '放弃未保存的 YAML 修改？', okText: '放弃' }))) return
      setYamlDirty(false)
    }
    setMode(m)
  }

  if (isLoading || !meta) return <div className="flex justify-center py-14"><Spinner /></div>

  const section = (position: RulePosition, list: CustomRule[]) => (
    <Card>
      <CardHeader
        title={position === 'head' ? '头部规则' : '尾部规则'}
        desc={position === 'head' ? '放在所有规则之前，优先级最高。适合强制直连 / 强制代理某些网站。' : '放在兜底规则（漏网之鱼）之前，内置规则都没匹配上时才生效。'}
        actions={
          <Button size="sm" onClick={() => setEditing({ position })}>
            <Plus className="size-3.5" />
            添加
          </Button>
        }
      />
      {!list.length ? (
        <div className="px-4 py-6 text-center text-xs text-zinc-500">暂无规则</div>
      ) : (
        <ul>
          {list.map((r, i) => (
            <li key={r.id} className={cx('flex items-center gap-2 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800', !r.enabled && 'opacity-50')}>
              <div className="flex flex-col">
                <button className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" disabled={i === 0} onClick={() => move(r, -1)} title="上移"><ArrowUp className="size-3.5" /></button>
                <button className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" disabled={i === list.length - 1} onClick={() => move(r, 1)} title="下移"><ArrowDown className="size-3.5" /></button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                  <Badge color={r.kind === 'ruleset' ? 'violet' : 'blue'}>{r.kind === 'ruleset' ? '规则集' : r.type}</Badge>
                  <span className="min-w-0 truncate font-mono text-xs" title={ruleText(r)}>{r.kind === 'ruleset' ? r.remark || ruleText(r) : ruleText(r)}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
                  <Badge color={r.policy === 'DIRECT' ? 'green' : r.policy === 'REJECT' ? 'red' : 'zinc'}>{r.policy}</Badge>
                  {r.noResolve && <span className="text-[11px] text-zinc-400">no-resolve</span>}
                </div>
                {r.kind === 'rule' && r.remark && <div className="mt-0.5 truncate text-xs text-zinc-500">{r.remark}</div>}
                {r.kind === 'ruleset' && <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{r.url}</div>}
              </div>
              <Switch checked={r.enabled} onChange={(v) => save(ordered.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
              <IconButton title="编辑" onClick={() => setEditing({ rule: r, position: r.position })}><Pencil className="size-4" /></IconButton>
              <IconButton title="删除" onClick={() => remove(r)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={mode} onChange={switchMode} options={[{ value: 'visual', label: '可视化' }, { value: 'yaml', label: 'YAML' }]} />
        <span className="text-xs text-zinc-500">自定义规则对所有开启了「使用自定义规则」的订阅输出生效</span>
      </div>
      {mode === 'visual' ? (
        <>
          {section('head', head)}
          {section('tail', tail)}
        </>
      ) : (
        <Card className="p-4">
          <CodeEditor
            value={yamlText}
            onChange={(v) => {
              setYamlText(v)
              setYamlDirty(true)
            }}
            height="460px"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button disabled={!yamlDirty} onClick={() => { setYamlDirty(false); setYamlText(rulesToYaml(rules || [])) }}>还原</Button>
            <Button variant="primary" onClick={saveYaml} loading={saving} disabled={!yamlDirty}>保存</Button>
          </div>
        </Card>
      )}
      {editing && (
        <RuleModal
          rule={editing.rule}
          position={editing.position}
          meta={meta}
          nodeNames={(nodes || []).map((n) => n.name)}
          existingPolicies={(rules || []).map((r) => r.policy)}
          onClose={() => setEditing(null)}
          onSave={(list) => {
            upsert(list, editing.rule?.id)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function RuleModal({
  rule,
  position: initialPos,
  meta,
  nodeNames,
  existingPolicies,
  onClose,
  onSave,
}: {
  rule?: CustomRule
  position: RulePosition
  meta: RulesMeta
  nodeNames: string[]
  existingPolicies: string[]
  onClose: () => void
  onSave: (r: CustomRule[]) => void
}) {
  const toast = useToast()
  const [kind, setKind] = useState<'rule' | 'ruleset'>(rule?.kind || 'rule')
  const [type, setType] = useState<string>(rule?.type || 'DOMAIN-SUFFIX')
  const [value, setValue] = useState(rule?.value || '')
  const [url, setUrl] = useState(rule?.url || '')
  const [behavior, setBehavior] = useState(rule?.behavior || 'classical')
  const [format, setFormat] = useState(rule?.format || 'text')
  const [interval, setInterval_] = useState(rule?.interval || 86400)
  const [policy, setPolicy] = useState(rule?.policy || meta.policies[0])
  const [position, setPosition] = useState<RulePosition>(rule?.position || initialPos)
  const [noResolve, setNoResolve] = useState(!!rule?.noResolve)
  const [remark, setRemark] = useState(rule?.remark || '')

  const groupPolicies = useMemo(() => [...new Set([...meta.policies, ...existingPolicies])], [meta.policies, existingPolicies])
  const isKnown = groupPolicies.includes(policy) || nodeNames.includes(policy)
  const [customPolicy, setCustomPolicy] = useState(!isKnown && !!rule)

  const values = value.split('\n').map((v) => v.trim()).filter(Boolean)
  const showNoResolve = kind === 'ruleset' ? behavior !== 'domain' : IP_TYPES.has(type)
  const preview =
    kind === 'ruleset'
      ? `RULE-SET,${remark || '规则集'},${policy}${noResolve && showNoResolve ? ',no-resolve' : ''}`
      : `${type},${values[0] || TYPE_INFO[type]?.ph || ''},${policy}${noResolve && showNoResolve ? ',no-resolve' : ''}`

  // 根据 URL 后缀猜测格式
  useEffect(() => {
    if (kind !== 'ruleset' || rule) return
    if (/\.mrs$/i.test(url)) setFormat('mrs')
    else if (/\.ya?ml$/i.test(url)) setFormat('yaml')
    else if (url) setFormat('text')
  }, [url, kind, rule])

  const submit = () => {
    if (!policy.trim()) return toast('请选择策略', 'error')
    const base = { enabled: rule?.enabled ?? true, position, policy: policy.trim(), order: 0 }
    if (kind === 'ruleset') {
      if (!/^https?:\/\//.test(url)) return toast('请填写规则集链接', 'error')
      if (format === 'mrs' && behavior === 'classical') return toast('mrs 格式只支持 domain / ipcidr', 'error')
      onSave([
        {
          ...base,
          id: rule?.id || Math.random().toString(36).slice(2, 14),
          kind: 'ruleset',
          url: url.trim(),
          behavior: behavior as any,
          format: format as any,
          interval,
          noResolve: showNoResolve && noResolve ? true : undefined,
          remark: remark.trim() || new URL(url).pathname.split('/').pop()!.replace(/\.[a-z]+$/i, ''),
        },
      ])
      return
    }
    if (!values.length) return toast('请填写匹配内容', 'error')
    const list = (rule ? [values.join('')] : values).map((v, i) => ({
      ...base,
      id: i === 0 && rule ? rule.id : Math.random().toString(36).slice(2, 14),
      kind: 'rule' as const,
      type: type as any,
      value: v,
      noResolve: showNoResolve && noResolve ? true : undefined,
      remark: remark.trim(),
    }))
    onSave(list)
  }

  const suggest = type === 'GEOSITE' ? GEOSITE_SUGGEST : type === 'GEOIP' ? GEOIP_SUGGEST : type === 'NETWORK' ? ['tcp', 'udp'] : null

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? '编辑规则' : '添加规则'}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>{rule ? '保存' : values.length > 1 && kind === 'rule' ? `添加 ${values.length} 条` : '添加'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented value={kind} onChange={setKind} options={[{ value: 'rule', label: '单条规则' }, { value: 'ruleset', label: '远程规则集' }]} />
          <Segmented size="sm" value={position} onChange={setPosition} options={[{ value: 'head', label: '放在头部' }, { value: 'tail', label: '放在尾部' }]} />
        </div>

        {kind === 'rule' ? (
          <>
            <Field label="匹配类型" hint={TYPE_INFO[type]?.desc}>
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {meta.ruleTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="匹配内容" hint={rule ? undefined : '可以一次填写多行，每行生成一条规则'}>
              {rule ? (
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={TYPE_INFO[type]?.ph} className="font-mono" />
              ) : (
                <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} placeholder={TYPE_INFO[type]?.ph} />
              )}
            </Field>
            {suggest && (
              <div className="-mt-2 flex flex-wrap gap-1">
                {suggest.map((s) => (
                  <button key={s} type="button" onClick={() => setValue(rule ? s : values.includes(s) ? value : [...values, s].join('\n'))} className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="规则集链接" hint="Clash 规则集：.yaml / .list(text) / .mrs">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/.../xxx.list" className="font-mono" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="类型 behavior">
                <Select value={behavior} onChange={(e) => setBehavior(e.target.value as any)}>
                  <option value="classical">classical（混合）</option>
                  <option value="domain">domain（纯域名）</option>
                  <option value="ipcidr">ipcidr（纯 IP）</option>
                </Select>
              </Field>
              <Field label="格式">
                <Select value={format} onChange={(e) => setFormat(e.target.value as any)}>
                  <option value="text">text / list</option>
                  <option value="yaml">yaml</option>
                  <option value="mrs">mrs</option>
                </Select>
              </Field>
              <Field label="更新间隔（秒）">
                <Input type="number" value={interval} onChange={(e) => setInterval_(Number(e.target.value))} />
              </Field>
            </div>
          </>
        )}

        <Field label="策略" hint="流量匹配后交给谁处理。选「新建分组」会在配置中自动生成一个可切换节点的分组。">
          <div className="flex gap-2">
            <Select
              value={customPolicy ? '__custom' : policy}
              onChange={(e) => {
                if (e.target.value === '__custom') {
                  setCustomPolicy(true)
                  setPolicy('')
                } else {
                  setCustomPolicy(false)
                  setPolicy(e.target.value)
                }
              }}
              className={customPolicy ? 'w-40 shrink-0' : ''}
            >
              <optgroup label="分组 / 内置">
                {groupPolicies.map((p) => <option key={p} value={p}>{p}</option>)}
              </optgroup>
              {nodeNames.length > 0 && (
                <optgroup label="指定节点">
                  {nodeNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </optgroup>
              )}
              <option value="__custom">＋ 新建分组…</option>
            </Select>
            {customPolicy && <Input value={policy} onChange={(e) => setPolicy(e.target.value)} placeholder="例如：🎮 Steam" autoFocus />}
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === 'ruleset' ? '名称' : '备注'}>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={kind === 'ruleset' ? '留空使用文件名' : '可选'} />
          </Field>
          {showNoResolve && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={noResolve} onChange={(e) => setNoResolve(e.target.checked)} className="size-4 accent-blue-600" />
              no-resolve（不为匹配 IP 而解析域名）
            </label>
          )}
        </div>

        <div className="rounded-md bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
          {preview}
          {values.length > 1 && kind === 'rule' && <span className="text-zinc-400"> …等 {values.length} 条</span>}
        </div>
      </div>
    </Modal>
  )
}

// ======================================================================= 内置模块

function Modules() {
  const { data: meta } = useRulesMeta()
  if (!meta) return <div className="flex justify-center py-14"><Spinner /></div>
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <p>
          内置分流使用 <a className="text-blue-600 hover:underline" href="https://github.com/MetaCubeX/meta-rules-dat" target="_blank" rel="noreferrer">MetaCubeX/meta-rules-dat</a> 规则集：
          数据来自社区维护的 v2fly domain-list-community 与 Loyalsoldier GeoIP，每日更新；Clash 使用体积小、加载快的 <code>.mrs</code> 格式，sing-box 使用同源 <code>.srs</code>。
          相比 ACL4SSR 等传统 .list 规则，条目更全、维护更活跃、客户端内存占用更低。
        </p>
        <p className="mt-2">规则按下面的顺序匹配，每个模块生成一个可在客户端切换的分组。在「订阅输出」里勾选要启用的模块，预设：
          {meta.presets.map((p) => <span key={p.id} className="ml-1"><Badge>{p.name}</Badge></span>)}
        </p>
      </Card>
      <Card>
        <ul>
          {meta.modules.map((m, i) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800">
              <span className="w-5 pt-0.5 text-right text-xs tabular-nums text-zinc-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  {m.fixed && <Badge>{m.fixed === 'DIRECT' ? '固定直连' : '固定走节点选择'}</Badge>}
                  {!m.fixed && <Badge color={m.defaultPolicy === 'direct' ? 'green' : m.defaultPolicy === 'reject' ? 'red' : 'blue'}>默认{m.defaultPolicy === 'direct' ? '直连' : m.defaultPolicy === 'reject' ? '拦截' : '代理'}</Badge>}
                  {m.required && <Badge color="amber">必选</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">{m.description}</div>
                {m.sources.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {m.sources.map((s) => <code key={s} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{s}</code>)}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

// ======================================================================= 外部模板

function Templates() {
  const { data: templates, isLoading } = useTemplates()
  const { data: meta } = useRulesMeta()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [adding, setAdding] = useState(false)
  const [viewing, setViewing] = useState<RuleTemplate | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const reload = () => qc.invalidateQueries({ queryKey: ['templates'] })

  const refresh = async (t: RuleTemplate) => {
    setBusy(t.id)
    try {
      await api.post(`/templates/${t.id}/refresh`)
      toast('已更新')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
      reload()
    }
  }
  const remove = async (t: RuleTemplate) => {
    if (!(await confirm({ title: `删除模板「${t.name}」？`, body: '使用该模板的订阅输出会切回内置模块。', danger: true, okText: '删除' }))) return
    await api.del(`/templates/${t.id}`)
    reload()
    qc.invalidateQueries({ queryKey: ['profiles'] })
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-zinc-600 dark:text-zinc-400">
        导入别人写好的分流配置，节点会自动替换为你的节点：
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs">
          <li><b>Clash / mihomo YAML</b>：保留其 proxy-groups、rules、rule-providers、dns 等设置；分组里原有的节点会替换成你的节点（支持分组的 filter 正则）。也可以直接填机场的 Clash 订阅链接来“借用”它的规则。</li>
          <li><b>subconverter / ACL4SSR ini</b>：解析 custom_proxy_group 与 ruleset，正则分组会匹配你的节点名。</li>
        </ul>
      </Card>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" />导入模板</Button>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-14"><Spinner /></div>
      ) : !templates?.length ? (
        <Card><Empty icon={<FileCode2 className="size-8" />} title="还没有导入模板" desc="内置分流模块已经够用的话，可以不导入。" /></Card>
      ) : (
        <Card>
          <ul>
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800">
                <ListTree className="size-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <Badge color={t.kind === 'ini' ? 'amber' : 'blue'}>{t.kind === 'ini' ? 'INI' : 'YAML'}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    {t.url ? <span className="font-mono">{t.url}</span> : '手动粘贴'} · {fmtTime(t.updatedAt)}更新
                    {t.lastError && <span className="text-red-600"> · {t.lastError}</span>}
                  </div>
                </div>
                <IconButton title="查看 / 编辑" onClick={() => setViewing(t)}><Eye className="size-4" /></IconButton>
                {t.url && <IconButton title="更新" onClick={() => refresh(t)} disabled={busy === t.id}><RefreshCw className={cx('size-4', busy === t.id && 'animate-spin')} /></IconButton>}
                <IconButton title="删除" onClick={() => remove(t)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {adding && meta && <AddTemplateModal presets={meta.templatePresets} onClose={() => setAdding(false)} onDone={reload} />}
      {viewing && <ViewTemplateModal t={viewing} onClose={() => setViewing(null)} onDone={reload} />}
    </div>
  )
}

function AddTemplateModal({ presets, onClose, onDone }: { presets: RulesMeta['templatePresets']; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [src, setSrc] = useState<'preset' | 'url' | 'text'>('preset')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const add = async (body: any, key: string) => {
    setLoading(key)
    try {
      await api.post('/templates', body)
      toast('已导入')
      onDone()
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(null)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="导入规则模板"
      width="max-w-2xl"
      footer={
        src !== 'preset' && (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" loading={loading === 'custom'} disabled={src === 'url' ? !url : !content} onClick={() => add(src === 'url' ? { name, url } : { name, content }, 'custom')}>导入</Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <Segmented value={src} onChange={setSrc} options={[{ value: 'preset', label: '常用模板' }, { value: 'url', label: '从链接' }, { value: 'text', label: '粘贴内容' }]} />
        {src === 'preset' && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {presets.map((p) => (
              <li key={p.url} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="truncate font-mono text-[11px] text-zinc-500">{p.url}</div>
                </div>
                <Button size="sm" loading={loading === p.url} onClick={() => add({ name: p.name, url: p.url, kind: p.kind }, p.url)}>导入</Button>
              </li>
            ))}
          </ul>
        )}
        {src !== 'preset' && (
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的分流模板" />
          </Field>
        )}
        {src === 'url' && (
          <Field label="链接" hint="Clash YAML 配置 / 机场 Clash 订阅 / subconverter ini 都可以，会每天自动更新">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." className="font-mono" />
          </Field>
        )}
        {src === 'text' && <CodeEditor value={content} onChange={setContent} height="340px" />}
      </div>
    </Modal>
  )
}

function ViewTemplateModal({ t, onClose, onDone }: { t: RuleTemplate; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(t.name)
  const [content, setContent] = useState(t.content)
  const [loading, setLoading] = useState(false)
  const save = async () => {
    setLoading(true)
    try {
      await api.put(`/templates/${t.id}`, { name, content })
      toast('已保存')
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
      title="模板内容"
      width="max-w-3xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={loading}>保存</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {t.url && <p className="text-xs text-amber-700 dark:text-amber-400">该模板来自链接，自动更新时会覆盖这里的修改。</p>}
        <CodeEditor value={content} onChange={setContent} height="420px" lang={t.kind === 'ini' ? 'text' : 'yaml'} />
      </div>
    </Modal>
  )
}
