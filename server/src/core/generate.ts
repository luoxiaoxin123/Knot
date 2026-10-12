import YAML from 'yaml'
import type { CustomGroup, CustomRule, Node, Profile, Proxy, RuleTemplate, Settings, Subscription } from '../../../shared/types.ts'
import { applyCustomGroups, applyCustomGroupsSingbox, groupsToCustom } from './custom-groups.ts'
import { AUTO_GROUP, PROXY_GROUP, geoUrl, normalizeModules, type RuleModule } from './rules/modules.ts'
import { parseIni } from './rules/ini.ts'
import { GROUP_REGIONS, REGIONS, detectRegion, type Region } from './region.ts'
import { toUri } from './uri-emit.ts'
import { toSingboxOutbound } from './singbox.ts'
import { b64encode, deepClone, deepMerge, safeRegex } from './util.ts'

export interface GenContext {
  nodes: Node[]
  subscriptions: Subscription[]
  templates: RuleTemplate[]
  customRules: CustomRule[]
  settings: Settings
}

export interface GenResult {
  text: string
  warnings: string[]
  contentType: string
}

const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'])

// ---------------------------------------------------------------------------
// 节点解析：选择 → 命名 → 链式代理依赖补全
// ---------------------------------------------------------------------------

export interface ResolvedProxies {
  /** 全部要写入配置的节点（含链式代理依赖的中转节点） */
  proxies: Proxy[]
  /** 出现在代理组里的节点名 */
  visible: string[]
  /** 节点 id → 最终名称 */
  nameOf: Map<string, string>
  /** 最终名称 → 地区（链式节点取落地节点的地区） */
  regionOf: Map<string, Region | undefined>
  warnings: string[]
}

const FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}/u

export function selectNodes(ctx: GenContext, profile: Profile): Node[] {
  const disabledSubs = new Set(ctx.subscriptions.filter((s) => !s.enabled).map((s) => s.id))
  const sources = new Set(profile.sources)
  const picked = new Set(profile.nodeIds)
  const inc = safeRegex(profile.includeRegex)
  const exc = safeRegex(profile.excludeRegex)
  return ctx.nodes.filter((n) => {
    if (!n.enabled) return false
    if (n.source.kind === 'sub' && disabledSubs.has(n.source.subId)) return false
    if (profile.nodeMode === 'sources') {
      const key = n.source.kind === 'sub' ? n.source.subId : n.source.kind
      if (!sources.has(key)) return false
    } else if (profile.nodeMode === 'pick') {
      if (!picked.has(n.id)) return false
    }
    if (inc && !inc.test(n.name)) return false
    if (exc && exc.test(n.name)) return false
    return true
  })
}

export function resolveProxies(ctx: GenContext, profile: Profile): ResolvedProxies {
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]))
  const warnings: string[] = []
  const nameOf = new Map<string, string>()
  const regionOf = new Map<string, Region | undefined>()
  const used = new Set<string>()
  const landing = (n: Node, depth = 0): Node => {
    if (n.source.kind !== 'chain' || depth > 8) return n
    const t = byId.get(n.source.targetId)
    return t ? landing(t, depth + 1) : n
  }
  const assign = (n: Node) => {
    const region = detectRegion(landing(n).name)
    let base = n.name.trim() || n.id
    if (profile.addFlags && region && !FLAG_RE.test(base)) base = `${region.flag} ${base}`
    let name = base
    for (let i = 2; used.has(name) || BUILTIN_POLICIES.has(name); i++) name = `${base} ${i}`
    used.add(name)
    nameOf.set(n.id, name)
    regionOf.set(name, region)
    return name
  }

  const selected = selectNodes(ctx, profile)
  // 链式节点需要目标节点存在，否则跳过
  const valid = selected.filter((n) => {
    if (n.source.kind !== 'chain') return true
    const target = byId.get(n.source.targetId)
    const relay = byId.get(n.source.relayId)
    if (!target || !relay) {
      warnings.push(`链式节点「${n.name}」的${!target ? '落地' : '中转'}节点已不存在，已跳过`)
      return false
    }
    return true
  })
  const visible = valid.map(assign)

  // 补全中转节点（可能是多级），未被选中的中转节点只写入 proxies 不进分组
  const included = new Map<string, Node>(valid.map((n) => [n.id, n]))
  const queue = [...valid]
  while (queue.length) {
    const n = queue.shift()!
    if (n.source.kind !== 'chain') continue
    const relay = byId.get(n.source.relayId)
    if (relay && !included.has(relay.id)) {
      included.set(relay.id, relay)
      assign(relay)
      queue.push(relay)
    }
  }

  const proxies: Proxy[] = []
  const build = (n: Node, stack: string[]): Proxy | null => {
    if (stack.includes(n.id)) {
      warnings.push(`链式节点「${n.name}」存在循环引用，已跳过`)
      return null
    }
    if (n.source.kind !== 'chain') {
      const p = deepClone(n.proxy)
      p.name = nameOf.get(n.id)!
      return p
    }
    const target = byId.get(n.source.targetId)
    const relay = byId.get(n.source.relayId)
    if (!target || !relay) return null
    if (relay.source.kind === 'chain' && !build(relay, [...stack, n.id])) return null
    const p = deepClone(target.proxy)
    p.name = nameOf.get(n.id)!
    p['dialer-proxy'] = nameOf.get(relay.id)!
    return p
  }
  const dropped = new Set<string>()
  for (const n of included.values()) {
    const p = build(n, [])
    if (p) proxies.push(p)
    else dropped.add(nameOf.get(n.id)!)
  }
  return { proxies, visible: visible.filter((v) => !dropped.has(v)), nameOf, regionOf, warnings }
}

// ---------------------------------------------------------------------------
// 自定义规则
// ---------------------------------------------------------------------------

function slug(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

interface ClashRulesBuild {
  providers: Record<string, any>
  head: string[]
  tail: string[]
  /** 自定义规则里引用到的、尚不存在的策略名 → 需要新建分组 */
  policies: Set<string>
}

function ruleProvider(settings: Settings, kind: 'geosite' | 'geoip', name: string) {
  const pname = `${kind}-${name}`
  const p: any = {
    type: 'http',
    behavior: kind === 'geosite' ? 'domain' : 'ipcidr',
    format: 'mrs',
    url: geoUrl(kind, name, 'mihomo', settings.ruleMirror, settings.ruleMirrorCustom),
    path: `./ruleset/${pname}.mrs`,
    interval: 86400,
  }
  if (settings.ruleDownloadViaProxy) p.proxy = PROXY_GROUP
  return { pname, p }
}

const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'IP-ASN', 'GEOIP'])

function buildCustomClash(rules: CustomRule[], settings: Settings, viaProxyGroup: string | null): ClashRulesBuild {
  const out: ClashRulesBuild = { providers: {}, head: [], tail: [], policies: new Set() }
  const sorted = rules.filter((r) => r.enabled).sort((a, b) => a.order - b.order)
  for (const r of sorted) {
    const policy = (r.policy || PROXY_GROUP).trim()
    out.policies.add(policy)
    let line = ''
    if (r.kind === 'ruleset') {
      if (!r.url) continue
      const pname = `custom-${slug(r.remark) || r.id}`
      const fmt = r.format || (r.url.endsWith('.mrs') ? 'mrs' : r.url.match(/\.ya?ml$/) ? 'yaml' : 'text')
      const ext = fmt === 'mrs' ? 'mrs' : fmt === 'yaml' ? 'yaml' : 'list'
      const p: any = {
        type: 'http',
        behavior: r.behavior || 'classical',
        format: fmt,
        url: r.url,
        path: `./ruleset/${pname}.${ext}`,
        interval: r.interval || 86400,
      }
      if (settings.ruleDownloadViaProxy && viaProxyGroup) p.proxy = viaProxyGroup
      out.providers[pname] = p
      line = `RULE-SET,${pname},${policy}${r.noResolve && r.behavior !== 'domain' ? ',no-resolve' : ''}`
    } else {
      if (!r.type || !r.value) continue
      const value = r.value.trim()
      if (r.type === 'GEOSITE' || r.type === 'GEOIP') {
        // 统一转换为 mrs 规则集，避免客户端下载完整 geosite.dat
        const kind = r.type === 'GEOSITE' ? 'geosite' : 'geoip'
        const { pname, p } = ruleProvider(settings, kind, value.toLowerCase())
        if (!(settings.ruleDownloadViaProxy && viaProxyGroup)) delete p.proxy
        else p.proxy = viaProxyGroup
        out.providers[pname] = p
        line = `RULE-SET,${pname},${policy}${kind === 'geoip' && r.noResolve ? ',no-resolve' : ''}`
      } else {
        line = `${r.type},${value},${policy}${r.noResolve && IP_TYPES.has(r.type) ? ',no-resolve' : ''}`
      }
    }
    ;(r.position === 'tail' ? out.tail : out.head).push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// Clash / mihomo
// ---------------------------------------------------------------------------

export const DEFAULT_CLASH_BASE = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'info',
  ipv6: true,
  'unified-delay': true,
  'tcp-concurrent': true,
  'find-process-mode': 'strict',
  'external-controller': '127.0.0.1:9090',
  profile: { 'store-selected': true, 'store-fake-ip': true },
  sniffer: {
    enable: true,
    sniff: {
      HTTP: { ports: [80, '8080-8880'], 'override-destination': true },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    'skip-domain': ['Mijia Cloud', '+.push.apple.com'],
  },
  dns: {
    enable: true,
    ipv6: true,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter': [
      '*.lan',
      '*.local',
      '+.msftconnecttest.com',
      '+.msftncsi.com',
      'localhost.ptlogin2.qq.com',
      '+.srv.nintendo.net',
      '+.stun.playstation.net',
      '+.xboxlive.com',
      'time.*.com',
      'ntp.*.com',
      '+.market.xiaomi.com',
    ],
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    'proxy-server-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
  },
}

interface GroupCtx {
  names: string[]
  regionNames: string[]
  includeNodes: boolean
  testUrl: string
}

function memberList(kind: 'proxy' | 'direct' | 'reject', g: GroupCtx): string[] {
  const nodes = g.includeNodes ? g.names : []
  if (kind === 'reject') return ['REJECT', 'DIRECT']
  if (kind === 'direct') return ['DIRECT', PROXY_GROUP, AUTO_GROUP, ...g.regionNames, ...nodes]
  return [PROXY_GROUP, AUTO_GROUP, ...g.regionNames, ...nodes, 'DIRECT']
}

function urlTest(name: string, proxies: string[], testUrl: string) {
  return {
    name,
    type: 'url-test',
    proxies: proxies.length ? proxies : ['DIRECT'],
    url: testUrl,
    interval: 300,
    tolerance: 50,
    lazy: true,
  }
}

function regionGroups(names: string[], regionOf: Map<string, Region | undefined>): { name: string; members: string[] }[] {
  return GROUP_REGIONS.map((code) => REGIONS.find((r) => r.code === code)!)
    .map((r) => ({ name: `${r.flag} ${r.name}节点`, members: names.filter((n) => regionOf.get(n)?.code === r.code) }))
    .filter((g) => g.members.length > 0)
}

function moduleRules(
  modules: RuleModule[],
  settings: Settings,
  providers: Record<string, any>,
): { rules: string[]; final: string } {
  const rules: string[] = []
  let final = PROXY_GROUP
  for (const m of modules) {
    if (m.id === 'final') {
      final = m.name
      continue
    }
    const target = m.fixed === 'DIRECT' ? 'DIRECT' : m.fixed === 'PROXY' ? PROXY_GROUP : m.name
    for (const r of m.rules) {
      const kind = r.geosite ? 'geosite' : 'geoip'
      const name = (r.geosite || r.geoip)!
      const { pname, p } = ruleProvider(settings, kind, name)
      providers[pname] = p
      // 国内 IP 需要解析域名后匹配；其余 IP 规则不触发 DNS 解析
      const noResolve = kind === 'geoip' && m.id !== 'cn'
      rules.push(`RULE-SET,${pname},${target}${noResolve ? ',no-resolve' : ''}`)
    }
  }
  return { rules, final }
}

/** 外部 Clash 模板：替换节点，保留分组与规则 */
function applyClashTemplate(tpl: any, names: string[]): { groups: any[]; rules: string[]; providers: Record<string, any>; warnings: string[] } {
  const warnings: string[] = []
  const groups: any[] = Array.isArray(tpl['proxy-groups']) ? tpl['proxy-groups'] : []
  const groupNames = new Set(groups.map((g) => g.name))
  for (const g of groups) {
    if (g['include-all'] || g['include-all-proxies']) continue
    const entries: string[] = Array.isArray(g.proxies) ? g.proxies : []
    const keep = entries.filter((e) => groupNames.has(e) || BUILTIN_POLICIES.has(e))
    const hadNodes = keep.length < entries.length
    if (hadNodes || (keep.length === 0 && !g.use)) {
      const re = g.filter ? safeRegex(g.filter) : null
      const ex = g['exclude-filter'] ? safeRegex(g['exclude-filter']) : null
      const nodes = names.filter((n) => (!re || re.test(n)) && (!ex || !ex.test(n)))
      g.proxies = [...keep, ...nodes]
    }
    if ((!g.proxies || g.proxies.length === 0) && !g.use) {
      g.proxies = ['DIRECT']
      warnings.push(`模板分组「${g.name}」没有匹配到节点，已填充 DIRECT`)
    }
  }
  return {
    groups,
    rules: Array.isArray(tpl.rules) ? tpl.rules.map(String) : [],
    providers: tpl['rule-providers'] || {},
    warnings,
  }
}

/** subconverter ini 模板 */
function applyIniTemplate(text: string, names: string[], settings: Settings) {
  const ini = parseIni(text)
  const warnings = [...ini.warnings]
  const groups = ini.groups.map((g) => {
    const members: string[] = []
    for (const it of g.items) {
      if (it.ref) members.push(it.ref)
      else if (it.regex) {
        const re = safeRegex(it.regex)
        if (!re) {
          warnings.push(`分组「${g.name}」正则无效: ${it.regex}`)
          continue
        }
        members.push(...names.filter((n) => re.test(n)))
      }
    }
    const proxies = [...new Set(members)]
    const out: any = { name: g.name, type: g.type, proxies: proxies.length ? proxies : ['DIRECT'] }
    if (g.type !== 'select') {
      out.url = g.url || settings.testUrl
      out.interval = g.interval || 300
      if (g.tolerance !== undefined) out.tolerance = g.tolerance
      if (g.type === 'url-test') out.lazy = true
    }
    return out
  })
  // 引用了不存在的分组时移除
  const known = new Set([...groups.map((g) => g.name), ...BUILTIN_POLICIES, ...names])
  for (const g of groups) {
    g.proxies = g.proxies.filter((p: string) => known.has(p))
    if (!g.proxies.length) g.proxies = ['DIRECT']
  }
  const providers: Record<string, any> = {}
  const rules: string[] = []
  let match: string | null = null
  const usedNames = new Set<string>()
  for (const rs of ini.rulesets) {
    if (rs.inline) {
      const parts = rs.inline.split(',').map((s) => s.trim())
      if (parts[0] === 'FINAL' || parts[0] === 'MATCH') {
        match = `MATCH,${rs.group}`
        continue
      }
      const nr = parts[parts.length - 1] === 'no-resolve' ? parts.pop() : undefined
      rules.push([...parts, rs.group, ...(nr ? [nr] : [])].join(','))
      continue
    }
    const file = rs.url!.split('/').pop()!.replace(/\.[a-z]+$/i, '')
    let pname = file
    for (let i = 2; usedNames.has(pname); i++) pname = `${file}-${i}`
    usedNames.add(pname)
    const isYaml = /\.ya?ml$/i.test(rs.url!)
    const p: any = {
      type: 'http',
      behavior: rs.behavior || 'classical',
      format: isYaml ? 'yaml' : 'text',
      url: rs.url,
      path: `./ruleset/${pname}.${isYaml ? 'yaml' : 'list'}`,
      interval: rs.interval || 86400,
    }
    providers[pname] = p
    rules.push(`RULE-SET,${pname},${rs.group}`)
  }
  if (match) rules.push(match)
  return { groups, rules, providers, warnings }
}

function isMatchRule(r: string) {
  return /^\s*(MATCH|FINAL)\s*,/i.test(r)
}

interface ClashParts {
  config: any
  groups: any[]
  rules: string[]
  providers: Record<string, any>
  defaultProxy: string
}

/** 按规则模式（内置模块 / 模板）+ 自定义规则生成分组与规则 */
function buildClashParts(ctx: GenContext, profile: Profile, resolved: ResolvedProxies, warnings: string[]): ClashParts {
  const names = resolved.visible

  let config: any
  let groups: any[]
  let rules: string[]
  let providers: Record<string, any>
  let defaultProxy = PROXY_GROUP

  const template =
    profile.ruleMode === 'template' ? ctx.templates.find((t) => t.id === profile.templateId) : undefined
  if (profile.ruleMode === 'template' && !template) warnings.push('所选规则模板不存在，已使用内置模块')

  if (template?.kind === 'clash') {
    const tpl = YAML.parse(template.content, { maxAliasCount: -1 }) || {}
    const r = applyClashTemplate(tpl, names)
    warnings.push(...r.warnings)
    delete tpl.proxies
    delete tpl['proxy-groups']
    delete tpl.rules
    delete tpl['rule-providers']
    config = tpl
    groups = r.groups
    rules = r.rules
    providers = r.providers
    defaultProxy = groups.find((g) => g.type === 'select')?.name || PROXY_GROUP
  } else if (template?.kind === 'ini') {
    const r = applyIniTemplate(template.content, names, ctx.settings)
    warnings.push(...r.warnings)
    config = deepClone(DEFAULT_CLASH_BASE)
    groups = r.groups
    rules = r.rules
    providers = r.providers
    defaultProxy = groups.find((g) => g.type === 'select')?.name || PROXY_GROUP
  } else {
    config = deepClone(DEFAULT_CLASH_BASE)
    const modules = normalizeModules(profile.modules)
    const regions = profile.regionGroups ? regionGroups(names, resolved.regionOf) : []
    const gctx: GroupCtx = {
      names,
      regionNames: regions.map((r) => r.name),
      includeNodes: profile.groupsIncludeNodes,
      testUrl: ctx.settings.testUrl,
    }
    groups = [
      { name: PROXY_GROUP, type: 'select', proxies: [AUTO_GROUP, ...gctx.regionNames, ...names, 'DIRECT'] },
      urlTest(AUTO_GROUP, names, ctx.settings.testUrl),
    ]
    for (const m of modules) {
      if (m.fixed) continue
      groups.push({ name: m.name, type: 'select', proxies: memberList(m.defaultPolicy, gctx) })
    }
    for (const r of regions) groups.push(urlTest(r.name, r.members, ctx.settings.testUrl))
    providers = {}
    const mr = moduleRules(modules, ctx.settings, providers)
    rules = [...mr.rules, `MATCH,${mr.final}`]
  }

  // 自定义规则
  if (profile.useCustomRules && ctx.customRules.length) {
    const groupNames = new Set(groups.map((g) => g.name))
    const via = ctx.settings.ruleDownloadViaProxy && groupNames.has(defaultProxy) ? defaultProxy : null
    const cr = buildCustomClash(ctx.customRules, ctx.settings, via)
    Object.assign(providers, cr.providers)
    const nameSet = new Set(names)
    // 自定义规则中出现的新策略名 → 新建分组
    const newGroups: any[] = []
    for (const p of cr.policies) {
      if (groupNames.has(p) || BUILTIN_POLICIES.has(p) || nameSet.has(p)) continue
      const base = groupNames.has(defaultProxy) ? [defaultProxy] : []
      newGroups.push({ name: p, type: 'select', proxies: [...base, ...names, 'DIRECT'] })
      groupNames.add(p)
    }
    if (newGroups.length) {
      // 插在兜底分组前面
      const finalName = rules.find(isMatchRule)?.split(',')[1]?.trim()
      const idx = finalName ? groups.findIndex((g) => g.name === finalName) : -1
      if (idx >= 0) groups.splice(idx, 0, ...newGroups)
      else groups.push(...newGroups)
    }
    const matchIdx = rules.findIndex(isMatchRule)
    const body = matchIdx >= 0 ? rules.slice(0, matchIdx) : rules
    const tailMatch = matchIdx >= 0 ? rules.slice(matchIdx) : []
    rules = [...cr.head, ...body, ...cr.tail, ...tailMatch]
  }

  if (!rules.some(isMatchRule)) rules.push(`MATCH,${groups.some((g) => g.name === defaultProxy) ? defaultProxy : 'DIRECT'}`)
  return { config, groups, rules, providers, defaultProxy }
}

/** 当前配置自动生成的分组，转换为可编辑的自定义分组（拖拽编辑器的初始数据） */
export function draftCustomGroups(ctx: GenContext, profile: Profile): CustomGroup[] {
  const resolved = resolveProxies(ctx, profile)
  const parts = buildClashParts(ctx, { ...profile, groupMode: 'auto' }, resolved, [])
  return groupsToCustom(parts.groups, resolved)
}

export function generateClash(ctx: GenContext, profile: Profile): GenResult {
  const resolved = resolveProxies(ctx, profile)
  const warnings = [...resolved.warnings]
  if (!resolved.visible.length) warnings.push('没有可用节点')
  let { config, groups, rules, providers } = buildClashParts(ctx, profile, resolved, warnings)

  if (profile.groupMode === 'custom' && profile.customGroups?.length) {
    const r = applyCustomGroups(groups, rules, providers, profile, resolved, ctx.settings.testUrl, warnings)
    groups = r.groups
    rules = r.rules
  }

  // 规则集通过代理下载时，确保代理组存在
  const finalGroupNames = new Set(groups.map((g) => g.name))
  for (const p of Object.values(providers)) {
    if (p && p.proxy && !finalGroupNames.has(p.proxy) && !BUILTIN_POLICIES.has(p.proxy)) delete p.proxy
  }

  config.proxies = resolved.proxies
  config['proxy-groups'] = groups
  if (Object.keys(providers).length) config['rule-providers'] = providers
  config.rules = rules

  if (profile.overrideYaml?.trim()) {
    try {
      const ov = YAML.parse(profile.overrideYaml)
      if (ov && typeof ov === 'object') config = deepMerge(config, ov)
    } catch (e: any) {
      warnings.push(`覆写 YAML 解析失败：${e.message}`)
    }
  }

  // 键顺序：常规设置在前，节点/分组/规则在后
  const ordered: any = {}
  for (const [k, v] of Object.entries(config)) {
    if (!['proxies', 'proxy-groups', 'rule-providers', 'rules'].includes(k)) ordered[k] = v
  }
  for (const k of ['proxies', 'proxy-groups', 'rule-providers', 'rules']) if (config[k] !== undefined) ordered[k] = config[k]

  const doc = new YAML.Document(ordered)
  const proxiesNode = doc.get('proxies') as any
  if (proxiesNode?.items) {
    for (const it of proxiesNode.items) {
      it.flow = true
      // go-yaml 对 flow 映射里含 : , [ ] { } 等字符的纯量更严格，统一加引号
      YAML.visit(it, {
        Scalar(_, node) {
          if (typeof node.value === 'string' && /[^A-Za-z0-9._/\- \u0080-\uFFFF\u{10000}-\u{10FFFF}]|^[\s-]|\s$|^$/u.test(node.value)) {
            node.type = 'QUOTE_DOUBLE'
          }
        },
      })
    }
  }
  const header = `# ${profile.name} — 由 Switch 生成于 ${new Date().toISOString()}\n`
  return {
    text: header + doc.toString({ lineWidth: 0 }),
    warnings,
    contentType: 'text/yaml; charset=utf-8',
  }
}

// ---------------------------------------------------------------------------
// V2Ray（base64 分享链接）
// ---------------------------------------------------------------------------

export function generateV2ray(ctx: GenContext, profile: Profile): GenResult {
  const resolved = resolveProxies(ctx, profile)
  const warnings = [...resolved.warnings]
  const visible = new Set(resolved.visible)
  const lines: string[] = []
  for (const p of resolved.proxies) {
    if (!visible.has(p.name)) continue
    const uri = toUri(p)
    if (uri) lines.push(uri)
    else warnings.push(`「${p.name}」无法转换为分享链接${p['dialer-proxy'] ? '（链式代理仅支持 Clash / sing-box）' : ''}`)
  }
  return { text: b64encode(lines.join('\n')), warnings, contentType: 'text/plain; charset=utf-8' }
}

/** 明文分享链接（用于前端复制） */
export function proxiesToUris(proxies: Proxy[]): string[] {
  return proxies.map((p) => toUri(p)).filter((x): x is string => !!x)
}

// ---------------------------------------------------------------------------
// sing-box (1.12+)
// ---------------------------------------------------------------------------

function singboxRule(r: CustomRule, settings: Settings, ruleSets: Map<string, any>, viaProxy: string | null): any | null {
  const v = (r.value || '').trim()
  const addGeo = (kind: 'geosite' | 'geoip', name: string) => {
    const tag = `${kind}-${name}`
    if (!ruleSets.has(tag)) {
      ruleSets.set(tag, {
        type: 'remote',
        tag,
        format: 'binary',
        url: geoUrl(kind, name, 'singbox', settings.ruleMirror, settings.ruleMirrorCustom),
        ...(viaProxy ? { download_detour: viaProxy } : {}),
      })
    }
    return tag
  }
  if (r.kind === 'ruleset') return null
  switch (r.type) {
    case 'DOMAIN':
      return { domain: [v] }
    case 'DOMAIN-SUFFIX':
      return { domain_suffix: [v] }
    case 'DOMAIN-KEYWORD':
      return { domain_keyword: [v] }
    case 'DOMAIN-REGEX':
      return { domain_regex: [v] }
    case 'IP-CIDR':
    case 'IP-CIDR6':
      return { ip_cidr: [v] }
    case 'SRC-IP-CIDR':
      return { source_ip_cidr: [v] }
    case 'DST-PORT':
      return v.includes('-') ? { port_range: [v.replace('-', ':')] } : { port: [Number(v)] }
    case 'SRC-PORT':
      return v.includes('-') ? { source_port_range: [v.replace('-', ':')] } : { source_port: [Number(v)] }
    case 'PROCESS-NAME':
      return { process_name: [v] }
    case 'PROCESS-PATH':
      return { process_path: [v] }
    case 'NETWORK':
      return { network: [v.toLowerCase()] }
    case 'GEOSITE':
      return { rule_set: [addGeo('geosite', v.toLowerCase())] }
    case 'GEOIP':
      return { rule_set: [addGeo('geoip', v.toLowerCase())] }
    default:
      return null
  }
}

export function generateSingbox(ctx: GenContext, profile: Profile): GenResult {
  const resolved = resolveProxies(ctx, profile)
  const warnings = [...resolved.warnings]
  if (profile.ruleMode === 'template') warnings.push('sing-box 输出不使用外部模板，已改用内置分流模块')

  // 节点
  const outNodes: any[] = []
  const ok = new Set<string>()
  // 先转换非链式节点，再处理链式（依赖中转节点转换成功）
  const sorted = [...resolved.proxies].sort((a, b) => (a['dialer-proxy'] ? 1 : 0) - (b['dialer-proxy'] ? 1 : 0))
  let pending = sorted
  for (let round = 0; round < 8 && pending.length; round++) {
    const next: Proxy[] = []
    for (const p of pending) {
      const detour = p['dialer-proxy']
      if (detour && !ok.has(detour)) {
        next.push(p)
        continue
      }
      try {
        outNodes.push(toSingboxOutbound(p, p.name, detour))
        ok.add(p.name)
      } catch (e: any) {
        warnings.push(`「${p.name}」: ${e.message}`)
      }
    }
    if (next.length === pending.length) {
      for (const p of next) warnings.push(`「${p.name}」: 中转节点不可用`)
      break
    }
    pending = next
  }
  const names = resolved.visible.filter((n) => ok.has(n))

  const modules = normalizeModules(profile.modules)
  const regions = profile.regionGroups ? regionGroups(names, resolved.regionOf) : []
  const regionNames = regions.map((r) => r.name)
  const nonEmpty = (l: string[]) => (l.length ? l : ['DIRECT'])
  const groupOut: any[] = []
  const selector = (tag: string, outbounds: string[]) => {
    const o = nonEmpty(outbounds.filter((x) => x !== 'REJECT'))
    groupOut.push({ type: 'selector', tag, outbounds: o, default: o[0], interrupt_exist_connections: true })
  }
  const urltest = (tag: string, outbounds: string[]) =>
    groupOut.push({ type: 'urltest', tag, outbounds: nonEmpty(outbounds), url: ctx.settings.testUrl, interval: '5m', tolerance: 50 })

  const gctx: GroupCtx = { names, regionNames, includeNodes: profile.groupsIncludeNodes, testUrl: ctx.settings.testUrl }
  selector(PROXY_GROUP, [AUTO_GROUP, ...regionNames, ...names, 'DIRECT'])
  urltest(AUTO_GROUP, names)
  for (const m of modules) {
    if (m.fixed || m.defaultPolicy === 'reject') continue
    selector(m.name, memberList(m.defaultPolicy, gctx))
  }

  const viaProxy = ctx.settings.ruleDownloadViaProxy ? PROXY_GROUP : null
  const ruleSets = new Map<string, any>()
  const geoTag = (kind: 'geosite' | 'geoip', name: string) => {
    const tag = `${kind}-${name}`
    if (!ruleSets.has(tag)) {
      ruleSets.set(tag, {
        type: 'remote',
        tag,
        format: 'binary',
        url: geoUrl(kind, name, 'singbox', ctx.settings.ruleMirror, ctx.settings.ruleMirrorCustom),
        ...(viaProxy ? { download_detour: viaProxy } : {}),
      })
    }
    return tag
  }

  // 自定义规则
  const head: any[] = []
  const tail: any[] = []
  const knownTags = new Set([...groupOut.map((g) => g.tag), ...names, 'DIRECT'])
  const extraGroups: string[] = []
  if (profile.useCustomRules) {
    for (const r of ctx.customRules.filter((x) => x.enabled).sort((a, b) => a.order - b.order)) {
      const match = singboxRule(r, ctx.settings, ruleSets, viaProxy)
      if (!match) {
        if (r.kind === 'ruleset') warnings.push(`自定义规则集「${r.remark || r.url}」为 Clash 格式，sing-box 输出已跳过`)
        else warnings.push(`自定义规则 ${r.type},${r.value} 不支持 sing-box，已跳过`)
        continue
      }
      const policy = (r.policy || PROXY_GROUP).trim()
      let rule: any
      if (policy === 'REJECT' || policy === 'REJECT-DROP') rule = { ...match, action: 'reject' }
      else {
        if (!knownTags.has(policy)) {
          extraGroups.push(policy)
          knownTags.add(policy)
        }
        rule = { ...match, outbound: policy }
      }
      ;(r.position === 'tail' ? tail : head).push(rule)
    }
  }
  for (const g of extraGroups) selector(g, [PROXY_GROUP, ...names, 'DIRECT'])

  const rules: any[] = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }, ...head]
  let final = PROXY_GROUP
  let hasCn = false
  for (const m of modules) {
    if (m.id === 'final') {
      final = m.name
      continue
    }
    if (m.id === 'private') {
      rules.push({ ip_is_private: true, outbound: 'DIRECT' })
    }
    const domainSets = m.rules.filter((r) => r.geosite).map((r) => geoTag('geosite', r.geosite!))
    const ipSets = m.rules.filter((r) => r.geoip && r.geoip !== 'private').map((r) => geoTag('geoip', r.geoip!))
    const target = m.fixed === 'DIRECT' ? 'DIRECT' : m.fixed === 'PROXY' ? PROXY_GROUP : m.name
    const act = m.defaultPolicy === 'reject' ? { action: 'reject' } : { outbound: target }
    if (domainSets.length) rules.push({ rule_set: domainSets, ...act })
    if (ipSets.length) {
      if (m.id === 'cn') {
        hasCn = true
        rules.push({ action: 'resolve', strategy: 'prefer_ipv4' })
      }
      rules.push({ rule_set: ipSets, ...act })
    }
  }
  rules.push(...tail)

  const selectorNames = new Set(groupOut.map((g) => g.tag))
  for (const g of groupOut) g.outbounds = g.outbounds.filter((o: string) => selectorNames.has(o) || ok.has(o) || o === 'DIRECT')
  for (const g of groupOut) if (!g.outbounds.length) g.outbounds = ['DIRECT']
  for (const g of groupOut) if (g.default && !g.outbounds.includes(g.default)) g.default = g.outbounds[0]

  // 地区组放在服务分组之后
  for (const r of regions) urltest(r.name, r.members)

  const dnsRules: any[] = []
  if (hasCn || ruleSets.has('geosite-cn')) dnsRules.push({ rule_set: [geoTag('geosite', 'cn')], server: 'dns-direct' })

  const config = {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { type: 'https', tag: 'dns-remote', server: '8.8.8.8', detour: PROXY_GROUP },
        { type: 'https', tag: 'dns-direct', server: '223.5.5.5' },
      ],
      rules: dnsRules,
      final: 'dns-remote',
      strategy: 'prefer_ipv4',
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        auto_route: true,
        strict_route: true,
      },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 },
    ],
    outbounds: [...groupOut, ...outNodes, { type: 'direct', tag: 'DIRECT' }],
    route: {
      rules,
      rule_set: [...ruleSets.values()],
      final,
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: { external_controller: '127.0.0.1:9090' },
    },
  }
  if (profile.groupMode === 'custom' && profile.customGroups?.length) {
    applyCustomGroupsSingbox(config, profile, resolved, ok, ctx.settings.testUrl, warnings)
  }
  return { text: JSON.stringify(config, null, 2), warnings, contentType: 'application/json; charset=utf-8' }
}

export function generate(ctx: GenContext, profile: Profile, target: 'clash' | 'singbox' | 'v2ray'): GenResult {
  if (target === 'singbox') return generateSingbox(ctx, profile)
  if (target === 'v2ray') return generateV2ray(ctx, profile)
  return generateClash(ctx, profile)
}

/** 前端用：某个输出配置里可用的策略名 */
export function policyOptions(): string[] {
  const mods = normalizeModules(['private', 'ads', 'ai', 'telegram', 'youtube', 'google', 'github', 'twitter', 'meta', 'discord', 'netflix', 'disney', 'media', 'games', 'microsoft', 'apple', 'bilibili', 'gfw', 'cn', 'final'])
  return [PROXY_GROUP, AUTO_GROUP, ...mods.filter((m) => !m.fixed).map((m) => m.name), 'DIRECT', 'REJECT']
}
