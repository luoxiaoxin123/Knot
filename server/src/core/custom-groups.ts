// 自定义代理组：拖拽编辑器保存的分组替换自动生成的分组，规则保持不变
import type { CustomGroup, Profile, ProxyGroupType } from '../../../shared/types.ts'
import type { ResolvedProxies } from './generate.ts'
import { REGIONS } from './region.ts'
import { safeRegex, uid } from './util.ts'

const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'])
const TYPES: ProxyGroupType[] = ['select', 'url-test', 'fallback', 'load-balance']

function idOfName(resolved: ResolvedProxies) {
  return new Map([...resolved.nameOf].map(([id, name]) => [name, id]))
}

/** 自动生成的 Clash 分组 → 可编辑分组 */
export function groupsToCustom(groups: any[], resolved: ResolvedProxies): CustomGroup[] {
  const idOf = idOfName(resolved)
  const visible = new Set(resolved.visible)
  return groups.map((g) => {
    const proxies: string[] = Array.isArray(g.proxies) ? g.proxies : []
    const members = proxies.map((p) => (visible.has(p) && idOf.has(p) ? `node:${idOf.get(p)}` : p))
    const nodeCount = proxies.filter((p) => visible.has(p)).length
    const all = visible.size > 0 && nodeCount === visible.size
    const region = REGIONS.find((r) => g.name === `${r.flag} ${r.name}节点`)
    const includeAll = !!(g['include-all'] || g['include-all-proxies'])
    return {
      id: uid(),
      name: g.name,
      type: TYPES.includes(g.type) ? g.type : 'select',
      members,
      autoNew: all || includeAll || !!region,
      filter: includeAll ? g.filter || '' : region && !all ? region.re.source : '',
      origin: g.name,
    }
  })
}

/** 规则字符串的策略位置（最后一项，忽略 no-resolve / src 选项） */
function targetIndex(parts: string[]): number {
  let i = parts.length - 1
  if (i > 0 && ['no-resolve', 'src'].includes(parts[i].trim())) i--
  return i
}

export function ruleTarget(rule: string): string {
  const parts = rule.split(',')
  return parts[targetIndex(parts)]?.trim() ?? ''
}

function rewriteTarget(rule: string, fn: (t: string) => string): string {
  const parts = rule.split(',')
  const i = targetIndex(parts)
  parts[i] = fn(parts[i].trim())
  return parts.join(',')
}

/** 解析自定义分组成员为最终节点 / 分组名（含自动加入的新节点） */
function resolveMembers(profile: Profile, resolved: ResolvedProxies, dropReject: boolean) {
  const visible = new Set(resolved.visible)
  const idOf = idOfName(resolved)
  const known = new Set(profile.knownNodeIds || [])
  const newNodes = resolved.visible.filter((n) => !known.has(idOf.get(n)!))
  const groupNames = new Set(profile.customGroups.map((g) => g.name))
  return profile.customGroups.map((cg) => {
    const out: string[] = []
    for (const m of cg.members) {
      if (m.startsWith('node:')) {
        const n = resolved.nameOf.get(m.slice(5))
        if (n && visible.has(n)) out.push(n)
      } else if (groupNames.has(m) && m !== cg.name) out.push(m)
      else if (BUILTIN.has(m) && !(dropReject && m.startsWith('REJECT'))) out.push(m)
    }
    if (cg.autoNew) {
      const re = safeRegex(cg.filter)
      for (const n of newNodes) if (!re || re.test(n)) out.push(n)
    }
    return { cg, members: [...new Set(out)] }
  })
}

function renameMap(profile: Profile) {
  return new Map(profile.customGroups.filter((g) => g.origin && g.origin !== g.name).map((g) => [g.origin!, g.name]))
}

export function applyCustomGroups(
  autoGroups: any[],
  rules: string[],
  providers: Record<string, any>,
  profile: Profile,
  resolved: ResolvedProxies,
  testUrl: string,
  warnings: string[],
): { groups: any[]; rules: string[] } {
  const groups = resolveMembers(profile, resolved, false).map(({ cg, members }) => {
    const g: any = { name: cg.name, type: cg.type, proxies: members.length ? members : ['DIRECT'] }
    if (cg.type !== 'select') {
      g.url = testUrl
      g.interval = 300
      if (cg.type === 'url-test') {
        g.tolerance = 50
        g.lazy = true
      }
      if (cg.type === 'load-balance') g.strategy = 'consistent-hashing'
    }
    return g
  })
  const rename = renameMap(profile)
  const out = rules.map((r) => rewriteTarget(r, (t) => rename.get(t) ?? t))
  for (const p of Object.values(providers)) if (p?.proxy && rename.has(p.proxy)) p.proxy = rename.get(p.proxy)

  // 规则引用了自定义分组里没有的策略 → 自动补一个分组，保证配置可用
  const valid = new Set<string>([...groups.map((g) => g.name), ...BUILTIN, ...resolved.proxies.map((p) => p.name)])
  const first = groups.find((g) => g.type === 'select')?.name
  for (const r of out) {
    const t = ruleTarget(r)
    if (!t || valid.has(t)) continue
    valid.add(t)
    const auto = autoGroups.find((g) => g.name === t)
    const proxies = auto ? (auto.proxies as string[]).filter((p) => valid.has(p)) : []
    groups.push({ name: t, type: 'select', proxies: proxies.length ? proxies : [...(first ? [first] : []), ...resolved.visible, 'DIRECT'] })
    warnings.push(`规则使用的分组「${t}」不在自定义分组中，已自动补充`)
  }
  return { groups, rules: out }
}

/** sing-box：用自定义分组替换自动生成的 selector / urltest */
export function applyCustomGroupsSingbox(
  config: any,
  profile: Profile,
  resolved: ResolvedProxies,
  okNodes: Set<string>,
  testUrl: string,
  warnings: string[],
) {
  const groupTags = new Set(profile.customGroups.map((g) => g.name))
  const nodeOk = (n: string) => okNodes.has(n) || groupTags.has(n) || n === 'DIRECT'
  const groups = resolveMembers(profile, resolved, true).map(({ cg, members }) => {
    const list = members.filter(nodeOk)
    const outbounds = list.length ? list : ['DIRECT']
    return cg.type === 'select'
      ? { type: 'selector', tag: cg.name, outbounds, default: outbounds[0], interrupt_exist_connections: true }
      : { type: 'urltest', tag: cg.name, outbounds, url: testUrl, interval: '5m', tolerance: 50 }
  })
  const rename = renameMap(profile)
  const ren = (t: string | undefined) => (t && rename.has(t) ? rename.get(t)! : t)
  const nodes = config.outbounds.filter((o: any) => o.type !== 'selector' && o.type !== 'urltest')
  const valid = new Set<string>([...groups.map((g) => g.tag), ...nodes.map((o: any) => o.tag)])
  const ensure = (t: string | undefined) => {
    if (!t || valid.has(t)) return
    valid.add(t)
    const first = groups.find((g) => g.type === 'selector')?.tag
    const outbounds = [...(first ? [first] : []), ...resolved.visible.filter((n) => okNodes.has(n)), 'DIRECT']
    groups.push({ type: 'selector', tag: t, outbounds, default: outbounds[0], interrupt_exist_connections: true })
    warnings.push(`规则使用的分组「${t}」不在自定义分组中，已自动补充`)
  }
  for (const r of config.route.rules) {
    if (r.outbound) {
      r.outbound = ren(r.outbound)
      ensure(r.outbound)
    }
  }
  config.route.final = ren(config.route.final)
  ensure(config.route.final)
  for (const s of config.dns.servers) {
    if (s.detour) {
      s.detour = ren(s.detour)
      ensure(s.detour)
    }
  }
  for (const rs of config.route.rule_set) {
    if (rs.download_detour) {
      rs.download_detour = ren(rs.download_detour)
      ensure(rs.download_detour)
    }
  }
  config.outbounds = [...groups, ...nodes]
}
