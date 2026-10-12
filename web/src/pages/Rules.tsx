import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowRight, Pencil, Plus, Trash2, RefreshCw, FileCode2, ListTree, Eye } from 'lucide-react'
import { NO_RESOLVE_TYPES, type CustomRule, type RulePosition, type RuleTemplate } from '@shared/types'
import { parseRuleLines, rulesToYaml, yamlToRules } from '@shared/rules-yaml'
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
  'DOMAIN-WILDCARD': { desc: '域名通配符，* 匹配一段，? 匹配一个字符', ph: '*.google.com' },
  'DOMAIN-REGEX': { desc: '域名正则', ph: '^ad\\..*\\.com$' },
  GEOSITE: { desc: '域名分类（自动转为 MetaCubeX 规则集）', ph: 'openai' },
  GEOIP: { desc: 'IP 归属地 / 分类（自动转为规则集）', ph: 'cn' },
  'IP-CIDR': { desc: 'IPv4 地址段', ph: '1.1.1.0/24' },
  'IP-CIDR6': { desc: 'IPv6 地址段', ph: '2001:db8::/32' },
  'IP-SUFFIX': { desc: 'IP 后缀，按末尾若干位匹配', ph: '8.8.8.8/24' },
  'IP-ASN': { desc: 'IP 所属 ASN（需要客户端下载 ASN 数据库）', ph: '13335' },
  'SRC-GEOIP': { desc: '来源 IP 的归属地', ph: 'cn' },
  'SRC-IP-ASN': { desc: '来源 IP 所属 ASN', ph: '9808' },
  'SRC-IP-CIDR': { desc: '来源 IP，用于给局域网内某台设备单独分流', ph: '192.168.1.100/32' },
  'SRC-IP-SUFFIX': { desc: '来源 IP 后缀', ph: '192.168.1.201/8' },
  'DST-PORT': { desc: '目标端口，可写范围', ph: '443 或 8000-9000' },
  'SRC-PORT': { desc: '来源端口', ph: '12345' },
  'IN-PORT': { desc: '入站端口', ph: '7890' },
  'IN-TYPE': { desc: '入站类型', ph: 'SOCKS/HTTP' },
  'IN-USER': { desc: '入站用户名', ph: 'alice' },
  'IN-NAME': { desc: '入站名称', ph: 'ss-in' },
  'PROCESS-NAME': { desc: '进程名，仅桌面端 / Android 有效', ph: 'Telegram.exe' },
  'PROCESS-NAME-WILDCARD': { desc: '进程名通配符', ph: 'chrome*' },
  'PROCESS-NAME-REGEX': { desc: '进程名正则', ph: '^(avp|avpui)[.]exe$' },
  'PROCESS-PATH': { desc: '进程完整路径', ph: '/usr/bin/curl' },
  'PROCESS-PATH-WILDCARD': { desc: '进程路径通配符', ph: '/usr/*/curl' },
  'PROCESS-PATH-REGEX': { desc: '进程路径正则', ph: '.*bin/curl$' },
  UID: { desc: 'Linux 用户 ID', ph: '1000' },
  NETWORK: { desc: '网络类型', ph: 'udp' },
  DSCP: { desc: 'DSCP 标记（仅 TPROXY UDP 入站）', ph: '4' },
  'RULE-SET': { desc: '引用配置中已有的规则集名称', ph: 'geosite-openai' },
  AND: { desc: '逻辑与：括号里的条件全部满足', ph: '((DOMAIN,example.com),(NETWORK,UDP))' },
  OR: { desc: '逻辑或：括号里的条件任意一个满足', ph: '((NETWORK,UDP),(DST-PORT,443))' },
  NOT: { desc: '逻辑非：括号里的条件不满足', ph: '((DOMAIN-SUFFIX,cn))' },
}

const IP_TYPES = NO_RESOLVE_TYPES

const GEOSITE_SUGGEST = ['openai', 'anthropic', 'google-gemini', 'category-ai-!cn', 'netflix', 'youtube', 'google', 'github', 'telegram', 'twitter', 'spotify', 'tiktok', 'steam', 'steam@cn', 'epicgames', 'apple', 'microsoft', 'bilibili', 'cn', 'geolocation-!cn', 'category-ads-all', 'private', 'tld-cn', 'gfw', 'cursor', 'xai', 'perplexity', 'discord', 'reddit', 'pixiv', 'twitch', 'disney', 'paypal', 'amazon']
const GEOIP_SUGGEST = ['cn', 'private', 'telegram', 'google', 'netflix', 'twitter', 'facebook', 'cloudflare']

function ruleText(r: CustomRule) {
  if (r.kind === 'ruleset') return r.url || ''
  if (r.kind === 'set') return r.remark
  return r.value || ''
}

const KIND_LABEL: Record<CustomRule['kind'], string> = { rule: '单条规则', set: '规则集', ruleset: '远程规则集' }
const newId = () => Math.random().toString(36).slice(2, 14)

function CustomRules() {
  const { data: rules, isLoading } = useCustomRules()
  const { data: meta } = useRulesMeta()
  const { data: nodes } = useNodes()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [mode, setMode] = useState<'visual' | 'yaml'>('visual')
  const [editing, setEditing] = useState<{ rule?: CustomRule } | null>(null)
  const [yamlText, setYamlText] = useState('')
  const [yamlDirty, setYamlDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (rules && !yamlDirty) setYamlText(rulesToYaml(rules))
  }, [rules, yamlDirty])

  /** 保存整个列表，头部规则始终排在尾部规则之前 */
  const save = async (list: CustomRule[]) => {
    const next = [...list.filter((x) => x.position === 'head'), ...list.filter((x) => x.position === 'tail')].map((r, i) => ({ ...r, order: i }))
    const prev = qc.getQueryData(['customRules'])
    qc.setQueryData(['customRules'], next)
    try {
      await api.put('/rules/custom', next)
      return true
    } catch (e: any) {
      qc.setQueryData(['customRules'], prev)
      toast(e.message, 'error')
      return false
    } finally {
      qc.invalidateQueries({ queryKey: ['customRules'] })
    }
  }

  const ordered = useMemo(() => [...(rules || [])].sort((a, b) => a.order - b.order), [rules])

  /** 只在同一位置（头部 / 尾部）内移动 */
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= ordered.length || ordered[j].position !== ordered[i].position) return
    const next = [...ordered]
    ;[next[i], next[j]] = [next[j], next[i]]
    save(next)
  }

  const upsert = async (r: CustomRule) => {
    const idx = ordered.findIndex((x) => x.id === r.id)
    let next: CustomRule[]
    if (idx >= 0 && ordered[idx].position === r.position) next = ordered.map((x) => (x.id === r.id ? r : x))
    else next = [...ordered.filter((x) => x.id !== r.id), r] // 新增或换了位置：放到该位置的末尾
    return save(next)
  }

  const remove = async (r: CustomRule) => {
    const body = r.kind === 'rule' ? <code className="text-xs">{r.type},{r.value}</code> : r.remark || r.url
    if (!(await confirm({ title: `删除这个${KIND_LABEL[r.kind]}？`, body, danger: true, okText: '删除' }))) return
    save(ordered.filter((x) => x.id !== r.id))
  }

  const saveYaml = async () => {
    setSaving(true)
    try {
      const list = yamlToRules(yamlText, rules || [], newId)
      await api.put('/rules/custom', list)
      await qc.invalidateQueries({ queryKey: ['customRules'] })
      setYamlDirty(false)
      toast(`已保存 ${list.length} 项`)
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={mode} onChange={switchMode} options={[{ value: 'visual', label: '可视化' }, { value: 'yaml', label: 'YAML' }]} />
        {mode === 'visual' && (
          <Button variant="primary" onClick={() => setEditing({})}>
            <Plus className="size-4" />
            添加
          </Button>
        )}
      </div>
      {mode === 'visual' ? (
        <Card>
          <CardHeader
            title="自定义规则"
            desc={<>「头部」排在所有规则之前，优先级最高；「尾部」排在兜底规则（漏网之鱼）之前。对开启了「使用自定义规则」的订阅输出生效。</>}
          />
          {!ordered.length ? (
            <div className="px-4 py-10 text-center text-sm text-zinc-500">
              还没有自定义规则。可以添加单条规则，也可以把一组规则粘贴成一个规则集。
            </div>
          ) : (
            <ul>
              {ordered.map((r, i) => (
                <RuleRow
                  key={r.id}
                  r={r}
                  canUp={i > 0 && ordered[i - 1].position === r.position}
                  canDown={i < ordered.length - 1 && ordered[i + 1].position === r.position}
                  onMove={(d) => move(i, d)}
                  onEnabled={(v) => save(ordered.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))}
                  onEdit={() => setEditing({ rule: r })}
                  onDelete={() => remove(r)}
                />
              ))}
            </ul>
          )}
        </Card>
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
          meta={meta}
          nodeNames={(nodes || []).map((n) => n.name)}
          existingPolicies={(rules || []).map((r) => r.policy).filter(Boolean)}
          onClose={() => setEditing(null)}
          onSave={async (r) => {
            if (await upsert(r)) setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function PolicyBadge({ policy }: { policy: string }) {
  return <Badge color={policy === 'DIRECT' ? 'green' : policy === 'REJECT' ? 'red' : 'zinc'}>{policy}</Badge>
}

function RuleRow({
  r,
  canUp,
  canDown,
  onMove,
  onEnabled,
  onEdit,
  onDelete,
}: {
  r: CustomRule
  canUp: boolean
  canDown: boolean
  onMove: (d: -1 | 1) => void
  onEnabled: (v: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const set = r.kind === 'set' ? parseRuleLines(r.rules || '', r.policy).rules : null
  const policies = set ? [...new Set(set.map((l) => l.policy || r.policy))] : []
  return (
    <li className={cx('flex items-center gap-2 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800', !r.enabled && 'opacity-50')}>
      <div className="flex flex-col">
        <button className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" disabled={!canUp} onClick={() => onMove(-1)} title="上移"><ArrowUp className="size-3.5" /></button>
        <button className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" disabled={!canDown} onClick={() => onMove(1)} title="下移"><ArrowDown className="size-3.5" /></button>
      </div>
      <span
        className={cx(
          'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
          r.position === 'head' ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {r.position === 'head' ? '头部' : '尾部'}
      </span>
      <div className="min-w-0 flex-1">
        {r.kind === 'rule' && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <Badge color="blue">{r.type}</Badge>
              <span className="min-w-0 truncate font-mono text-xs" title={r.value}>{r.value}</span>
              <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
              <PolicyBadge policy={r.policy} />
              {r.noResolve && <span className="text-[11px] text-zinc-400">no-resolve</span>}
            </div>
            {r.remark && <div className="mt-0.5 truncate text-xs text-zinc-500">{r.remark}</div>}
          </>
        )}
        {r.kind === 'set' && set && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <Badge color="amber">规则集</Badge>
              <span className="min-w-0 truncate font-medium">{r.remark}</span>
              <span className="text-xs text-zinc-500">{set.length} 条</span>
              <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
              {policies.slice(0, 3).map((p) => <PolicyBadge key={p} policy={p} />)}
              {policies.length > 3 && <span className="text-xs text-zinc-400">等 {policies.length} 个策略</span>}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={set.map((l) => `${l.type},${l.value}`).join('\n')}>
              {set.slice(0, 4).map((l) => l.value).join('  ·  ')}
              {set.length > 4 && '  …'}
            </div>
          </>
        )}
        {r.kind === 'ruleset' && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <Badge color="violet">远程规则集</Badge>
              <span className="min-w-0 truncate font-medium">{r.remark}</span>
              <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
              <PolicyBadge policy={r.policy} />
              {r.noResolve && <span className="text-[11px] text-zinc-400">no-resolve</span>}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{r.url}</div>
          </>
        )}
      </div>
      <Switch checked={r.enabled} onChange={onEnabled} />
      <IconButton title="编辑" onClick={onEdit}><Pencil className="size-4" /></IconButton>
      <IconButton title="删除" onClick={onDelete} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
    </li>
  )
}

/** 策略选择：分组 / 内置 / 指定节点 / 新建分组 */
function PolicySelect({
  value,
  onChange,
  groupPolicies,
  nodeNames,
  emptyLabel,
}: {
  value: string
  onChange: (v: string) => void
  groupPolicies: string[]
  nodeNames: string[]
  /** 允许留空时的选项文字 */
  emptyLabel?: string
}) {
  const known = !value || groupPolicies.includes(value) || nodeNames.includes(value)
  const [custom, setCustom] = useState(!known)
  return (
    <div className="flex gap-2">
      <Select
        value={custom ? '__custom' : value}
        onChange={(e) => {
          if (e.target.value === '__custom') {
            setCustom(true)
            onChange('')
          } else {
            setCustom(false)
            onChange(e.target.value)
          }
        }}
        className={custom ? 'w-40 shrink-0' : ''}
      >
        {emptyLabel && <option value="">{emptyLabel}</option>}
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
      {custom && <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="例如：🎮 Steam" autoFocus />}
    </div>
  )
}

const SET_PLACEHOLDER = `- DOMAIN-SUFFIX,reddit.com,reddit
- DOMAIN-SUFFIX,redd.it,reddit
- DOMAIN-KEYWORD,reddit
- IP-CIDR,151.101.0.0/16,DIRECT,no-resolve`

function RuleModal({
  rule,
  meta,
  nodeNames,
  existingPolicies,
  onClose,
  onSave,
}: {
  rule?: CustomRule
  meta: RulesMeta
  nodeNames: string[]
  existingPolicies: string[]
  onClose: () => void
  onSave: (r: CustomRule) => void
}) {
  const toast = useToast()
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [kind, setKind] = useState<CustomRule['kind']>(rule?.kind || 'rule')
  const [position, setPosition] = useState<RulePosition>(rule?.position || 'head')
  const [remark, setRemark] = useState(rule?.remark || '')
  const [type, setType] = useState<string>(rule?.type || 'DOMAIN-SUFFIX')
  const [value, setValue] = useState(rule?.value || '')
  const [rulesText, setRulesText] = useState(rule?.rules || '')
  const [url, setUrl] = useState(rule?.url || '')
  const [behavior, setBehavior] = useState(rule?.behavior || 'classical')
  const [format, setFormat] = useState(rule?.format || 'text')
  const [interval, setInterval_] = useState(rule?.interval || 86400)
  const [policy, setPolicy] = useState(rule ? rule.policy : meta.policies[0])
  const [noResolve, setNoResolve] = useState(!!rule?.noResolve)

  const groupPolicies = useMemo(() => [...new Set([...meta.policies, ...existingPolicies])], [meta.policies, existingPolicies])
  const parsed = useMemo(() => (kind === 'set' ? parseRuleLines(rulesText, policy) : null), [kind, rulesText, policy])
  const showNoResolve = kind === 'ruleset' ? behavior !== 'domain' : kind === 'rule' && IP_TYPES.has(type)
  const preview =
    kind === 'ruleset'
      ? `RULE-SET,${remark || '规则集'},${policy}${noResolve && showNoResolve ? ',no-resolve' : ''}`
      : `${type},${value.trim() || TYPE_INFO[type]?.ph || ''},${policy}${noResolve && showNoResolve ? ',no-resolve' : ''}`

  // 选「规则集」时默认不设默认策略，让每行自己写
  const changeKind = (k: CustomRule['kind']) => {
    setKind(k)
    if (k === 'set' && policy === meta.policies[0] && !rule) setPolicy('')
    if (k !== 'set' && !policy) setPolicy(meta.policies[0])
  }

  // 根据 URL 后缀猜测格式
  useEffect(() => {
    if (kind !== 'ruleset' || rule) return
    if (/\.mrs$/i.test(url)) setFormat('mrs')
    else if (/\.ya?ml$/i.test(url)) setFormat('yaml')
    else if (url) setFormat('text')
  }, [url, kind, rule])

  const submit = () => {
    const base = { id: rule?.id || newId(), enabled, position, order: rule?.order ?? 0 }
    if (kind === 'set') {
      if (!remark.trim()) return toast('请填写名称', 'error')
      if (parsed!.errors.length) return toast(parsed!.errors[0], 'error')
      if (!parsed!.rules.length) return toast('请填写规则内容', 'error')
      return onSave({ ...base, kind: 'set', remark: remark.trim(), rules: rulesText.trim(), policy: policy.trim() })
    }
    if (!policy.trim()) return toast('请选择策略', 'error')
    if (kind === 'ruleset') {
      if (!/^https?:\/\//.test(url)) return toast('请填写规则集链接', 'error')
      if (format === 'mrs' && behavior === 'classical') return toast('mrs 格式只支持 domain / ipcidr', 'error')
      return onSave({
        ...base,
        kind: 'ruleset',
        url: url.trim(),
        behavior: behavior as any,
        format: format as any,
        interval,
        policy: policy.trim(),
        noResolve: showNoResolve && noResolve ? true : undefined,
        remark: remark.trim() || new URL(url).pathname.split('/').pop()!.replace(/\.[a-z]+$/i, ''),
      })
    }
    if (!value.trim()) return toast('请填写匹配内容', 'error')
    if (value.includes('\n')) return toast('单条规则只能写一行，多条请选择「规则集」', 'error')
    onSave({
      ...base,
      kind: 'rule',
      type: type as any,
      value: value.trim(),
      policy: policy.trim(),
      noResolve: showNoResolve && noResolve ? true : undefined,
      remark: remark.trim(),
    })
  }

  const suggest = type === 'GEOSITE' ? GEOSITE_SUGGEST : type === 'GEOIP' ? GEOIP_SUGGEST : type === 'NETWORK' ? ['tcp', 'udp'] : null

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? `编辑${KIND_LABEL[rule.kind]}` : '添加自定义规则'}
      width="max-w-xl"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-sm">
            <Switch checked={enabled} onChange={setEnabled} />
            启用
          </label>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>保存</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={kind === 'rule' ? '备注' : '名称'}>
          <Input
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder={kind === 'rule' ? '可选' : kind === 'set' ? '例如：reddit' : '留空使用文件名'}
            autoFocus={!rule}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="类型">
            <Select value={kind} onChange={(e) => changeKind(e.target.value as CustomRule['kind'])} disabled={!!rule}>
              <option value="rule">单条规则</option>
              <option value="set">规则集（一次写多条）</option>
              <option value="ruleset">远程规则集（链接）</option>
            </Select>
          </Field>
          <Field label="模式">
            <Select value={position} onChange={(e) => setPosition(e.target.value as RulePosition)}>
              <option value="head">添加至头部</option>
              <option value="tail">添加至尾部</option>
            </Select>
          </Field>
        </div>

        {kind === 'rule' && (
          <>
            <Field label="匹配类型" hint={TYPE_INFO[type]?.desc}>
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {meta.ruleTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="匹配内容">
              <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={TYPE_INFO[type]?.ph} className="font-mono" />
            </Field>
            {suggest && (
              <div className="-mt-2 flex flex-wrap gap-1">
                {suggest.map((s) => (
                  <button key={s} type="button" onClick={() => setValue(s)} className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {kind === 'set' && parsed && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">规则内容（YAML 格式）</div>
            <CodeEditor value={rulesText} onChange={setRulesText} height="240px" />
            {!rulesText.trim() ? (
              <p className="text-xs text-zinc-500">
                每行一条：<code>类型,值,策略[,no-resolve]</code>。也可以直接粘贴 Clash 规则文件（<code>payload:</code> 格式）或纯文本，没写策略的行使用下面的默认策略。
                <button type="button" className="ml-1 text-blue-600 hover:underline" onClick={() => setRulesText(SET_PLACEHOLDER)}>填入示例</button>
              </p>
            ) : parsed.errors.length ? (
              <p className="text-xs text-red-600">{parsed.errors[0]}{parsed.errors.length > 1 && ` 等 ${parsed.errors.length} 处错误`}</p>
            ) : (
              <p className="text-xs text-emerald-600">已识别 {parsed.rules.length} 条规则</p>
            )}
          </div>
        )}

        {kind === 'ruleset' && (
          <>
            <Field label="规则集链接" hint="Clash 规则集：.yaml / .list(text) / .mrs">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/.../xxx.list" className="font-mono" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

        <Field
          label={kind === 'set' ? '默认策略' : '策略'}
          hint={kind === 'set' ? '只用于没有写策略的行。' : '流量匹配后交给谁处理。选「新建分组」会在配置中自动生成一个可切换节点的分组。'}
        >
          <PolicySelect value={policy} onChange={setPolicy} groupPolicies={groupPolicies} nodeNames={nodeNames} emptyLabel={kind === 'set' ? '不设置（每行自己写策略）' : undefined} />
        </Field>

        {showNoResolve && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={noResolve} onChange={(e) => setNoResolve(e.target.checked)} className="size-4 accent-blue-600" />
            no-resolve（不为匹配 IP 而解析域名）
          </label>
        )}

        {kind !== 'set' && (
          <div className="rounded-md bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">{preview}</div>
        )}
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
