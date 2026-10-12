// 自定义规则 <-> YAML 互转（前端 YAML 编辑模式使用）
import YAML from 'yaml'
import { RULE_TYPES, type CustomRule, type RuleType } from './types.ts'

const NO_RESOLVE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'IP-ASN', 'GEOIP', 'RULE-SET'])

export interface RuleLine {
  type: RuleType
  value: string
  /** 空字符串表示沿用规则集的默认策略 */
  policy: string
  noResolve?: boolean
}

/**
 * 解析「规则集」的内容。支持：
 * - YAML 列表：`- DOMAIN-SUFFIX,reddit.com,reddit`
 * - Clash 规则文件：`payload:` 下的列表（通常不带策略）
 * - 纯文本：每行一条，# 或 // 开头为注释
 * 每行是 `类型,值[,策略][,no-resolve]`，没写策略的行使用 defaultPolicy。
 */
export function parseRuleLines(text: string, defaultPolicy = ''): { rules: RuleLine[]; errors: string[] } {
  let items: unknown[] | null = null
  try {
    const doc = YAML.parse(text)
    if (Array.isArray(doc)) items = doc
    else if (doc && typeof doc === 'object' && Array.isArray((doc as any).payload)) items = (doc as any).payload
  } catch {}
  if (!items) items = text.split(/\r?\n/).filter((l) => !/^\s*payload\s*:\s*$/.test(l))
  const rules: RuleLine[] = []
  const errors: string[] = []
  for (const raw of items) {
    const s = String(raw ?? '')
      .trim()
      .replace(/^-\s*/, '')
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim()
    if (!s || s.startsWith('#') || s.startsWith('//')) continue
    const parts = s.split(',').map((x) => x.trim())
    const noResolve = parts.length > 2 && parts[parts.length - 1].toLowerCase() === 'no-resolve'
    if (noResolve) parts.pop()
    const type = parts[0].toUpperCase()
    if (!(RULE_TYPES as readonly string[]).includes(type)) {
      errors.push(`不支持的规则类型 ${parts[0]}：${s}`)
      continue
    }
    if (parts.length < 2 || !parts[1]) {
      errors.push(`缺少匹配内容：${s}`)
      continue
    }
    const policy = parts.length > 2 ? parts.slice(2).join(',') : ''
    if (!policy && !defaultPolicy.trim()) {
      errors.push(`没有写策略，也没有设置默认策略：${s}`)
      continue
    }
    rules.push({ type: type as RuleType, value: parts[1], policy, noResolve: noResolve && NO_RESOLVE_TYPES.has(type) ? true : undefined })
  }
  return { rules, errors }
}

/** 把「规则集」展开成单条规则，生成订阅时使用 */
export function expandCustomRules(list: CustomRule[]): CustomRule[] {
  const out: CustomRule[] = []
  for (const r of [...list].sort((a, b) => a.order - b.order)) {
    if (r.kind !== 'set') {
      out.push({ ...r, order: out.length })
      continue
    }
    if (!r.enabled) continue
    parseRuleLines(r.rules || '', r.policy).rules.forEach((l, i) =>
      out.push({
        id: `${r.id}:${i}`,
        enabled: true,
        position: r.position,
        remark: r.remark,
        kind: 'rule',
        type: l.type,
        value: l.value,
        noResolve: l.noResolve,
        policy: l.policy || r.policy,
        order: out.length,
      }),
    )
  }
  return out
}

function ruleSetLines(r: CustomRule): string[] {
  return parseRuleLines(r.rules || '', r.policy).rules.map((l) => `${l.type},${l.value}${l.policy ? `,${l.policy}` : ''}${l.noResolve ? ',no-resolve' : ''}`)
}

export function rulesToYaml(rules: CustomRule[]): string {
  const sorted = [...rules].sort((a, b) => a.order - b.order)
  const providers: Record<string, any> = {}
  const line = (r: CustomRule): any => {
    if (r.kind === 'set') return { name: r.remark, ...(r.policy ? { policy: r.policy } : {}), rules: ruleSetLines(r) }
    if (r.kind === 'ruleset') {
      const name = r.remark || r.id
      providers[name] = {
        type: 'http',
        behavior: r.behavior || 'classical',
        format: r.format || 'text',
        url: r.url,
        interval: r.interval || 86400,
      }
      return `RULE-SET,${name},${r.policy}${r.noResolve ? ',no-resolve' : ''}`
    }
    return `${r.type},${r.value},${r.policy}${r.noResolve ? ',no-resolve' : ''}`
  }
  const doc: any = {
    head: sorted.filter((r) => r.position === 'head' && r.enabled).map(line),
    tail: sorted.filter((r) => r.position === 'tail' && r.enabled).map(line),
  }
  if (Object.keys(providers).length) doc['rule-providers'] = providers
  const disabled = sorted.filter((r) => !r.enabled)
  let text =
    '# head: 插入到所有规则之前（优先级最高）\n# tail: 插入到兜底规则 MATCH 之前\n# 格式：类型,值,策略[,no-resolve]，策略可以是分组名 / DIRECT / REJECT / 节点名；\n# 写一个不存在的分组名会自动新建该分组\n# 规则集：- name: 名称\n#           policy: 默认策略（可省略，用于没写策略的行）\n#           rules: [类型,值,策略, ...]\n' +
    YAML.stringify(doc, { lineWidth: 0 })
  if (disabled.length) text += `# 另有 ${disabled.length} 条已停用的规则未显示，保存时会保留\n`
  return text
}

export function yamlToRules(text: string, existing: CustomRule[], genId: () => string): CustomRule[] {
  const doc = YAML.parse(text) || {}
  if (typeof doc !== 'object') throw new Error('YAML 顶层必须是对象')
  const providers: Record<string, any> = doc['rule-providers'] || {}
  const out: CustomRule[] = []
  let order = 0
  for (const position of ['head', 'tail'] as const) {
    const list = doc[position] ?? []
    if (!Array.isArray(list)) throw new Error(`${position} 必须是列表`)
    for (const raw of list) {
      if (raw && typeof raw === 'object') {
        const name = String(raw.name || '').trim()
        if (!name) throw new Error(`${position} 中的规则集缺少 name`)
        if (!Array.isArray(raw.rules)) throw new Error(`规则集「${name}」的 rules 必须是列表`)
        const policy = String(raw.policy || '').trim()
        const rules = raw.rules.map((x: unknown) => String(x)).join('\n')
        const r = parseRuleLines(rules, policy)
        if (r.errors.length) throw new Error(`规则集「${name}」：${r.errors[0]}`)
        const prev = existing.find((x) => x.kind === 'set' && x.remark === name)
        out.push({ id: prev?.id || genId(), enabled: true, position, remark: name, kind: 'set', rules, policy, order: order++ })
        continue
      }
      const s = String(raw).trim()
      if (!s) continue
      const parts = s.split(',').map((x) => x.trim())
      const noResolve = parts[parts.length - 1] === 'no-resolve'
      if (noResolve) parts.pop()
      if (parts.length < 3) throw new Error(`规则格式错误：${s}`)
      const type = parts[0].toUpperCase()
      const policy = parts[parts.length - 1]
      const value = parts.slice(1, -1).join(',')
      if (type === 'RULE-SET' && providers[value]) {
        const p = providers[value]
        if (!p.url) throw new Error(`规则集 ${value} 缺少 url`)
        out.push({
          id: genId(),
          enabled: true,
          position,
          remark: value,
          kind: 'ruleset',
          url: p.url,
          behavior: p.behavior || 'classical',
          format: p.format || 'text',
          interval: p.interval || 86400,
          noResolve: noResolve || undefined,
          policy,
          order: order++,
        })
        continue
      }
      if (!(RULE_TYPES as readonly string[]).includes(type)) throw new Error(`不支持的规则类型 ${type}：${s}`)
      out.push({
        id: genId(),
        enabled: true,
        position,
        remark: '',
        kind: 'rule',
        type: type as RuleType,
        value,
        noResolve: noResolve && NO_RESOLVE_TYPES.has(type) ? true : undefined,
        policy,
        order: order++,
      })
    }
  }
  // 保留停用的规则
  for (const r of existing.filter((x) => !x.enabled)) out.push({ ...r, order: order++ })
  return out
}
