// 自定义规则 <-> YAML 互转（前端 YAML 编辑模式使用）
import YAML from 'yaml'
import { RULE_TYPES, type CustomRule, type RuleType } from './types.ts'

const NO_RESOLVE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'IP-ASN', 'GEOIP', 'RULE-SET'])

export function rulesToYaml(rules: CustomRule[]): string {
  const sorted = [...rules].sort((a, b) => a.order - b.order)
  const providers: Record<string, any> = {}
  const line = (r: CustomRule) => {
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
    '# head: 插入到所有规则之前（优先级最高）\n# tail: 插入到兜底规则 MATCH 之前\n# 格式：类型,值,策略[,no-resolve]，策略可以是分组名 / DIRECT / REJECT / 节点名；\n# 写一个不存在的分组名会自动新建该分组\n' +
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
