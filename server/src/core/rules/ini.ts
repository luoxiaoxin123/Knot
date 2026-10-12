// 解析 subconverter / ACL4SSR 风格的 .ini 外部配置

export interface IniGroup {
  name: string
  type: string
  /** []引用 或 正则 */
  items: { ref?: string; regex?: string }[]
  url?: string
  interval?: number
  timeout?: number
  tolerance?: number
}

export interface IniRuleset {
  group: string
  /** 远程规则列表 */
  url?: string
  behavior?: 'classical' | 'domain' | 'ipcidr'
  /** 直接规则：GEOIP,CN / FINAL / DOMAIN-SUFFIX,xx */
  inline?: string
  interval?: number
}

export interface IniConfig {
  groups: IniGroup[]
  rulesets: IniRuleset[]
  warnings: string[]
}

export function parseIni(text: string): IniConfig {
  const groups: IniGroup[] = []
  const rulesets: IniRuleset[] = []
  const warnings: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key === 'ruleset' || key === 'surge_ruleset') {
      const c = val.indexOf(',')
      if (c < 0) continue
      const group = val.slice(0, c).trim()
      let rest = val.slice(c + 1).trim()
      if (rest.startsWith('[]')) {
        rulesets.push({ group, inline: rest.slice(2) })
        continue
      }
      let behavior: IniRuleset['behavior'] = 'classical'
      const pm = rest.match(/^(clash-domain|clash-ipcidr|clash-classic|clash-classical):/)
      if (pm) {
        behavior = pm[1] === 'clash-domain' ? 'domain' : pm[1] === 'clash-ipcidr' ? 'ipcidr' : 'classical'
        rest = rest.slice(pm[0].length)
      } else if (/^(surge|quanx|quantumultx):/.test(rest)) {
        rest = rest.replace(/^[a-z]+:/, '')
      }
      let interval: number | undefined
      const lc = rest.lastIndexOf(',')
      if (lc > 0 && /^\d+$/.test(rest.slice(lc + 1).trim())) {
        interval = Number(rest.slice(lc + 1))
        rest = rest.slice(0, lc)
      }
      if (!/^https?:\/\//.test(rest)) {
        warnings.push(`跳过本地规则文件: ${rest}`)
        continue
      }
      rulesets.push({ group, url: rest, behavior, interval })
    } else if (key === 'custom_proxy_group') {
      const parts = val.split('`')
      const [name, type, ...items] = parts
      const g: IniGroup = { name: name.trim(), type: (type || 'select').trim(), items: [] }
      if (['url-test', 'fallback', 'load-balance'].includes(g.type)) {
        // 末尾两项：测试 URL 与 "interval,timeout,tolerance"
        const last = items[items.length - 1]
        if (last && /^\d*(,\d*){0,2}$/.test(last.trim())) {
          items.pop()
          const [iv, to, tol] = last.split(',').map((s) => (s.trim() ? Number(s) : undefined))
          g.interval = iv
          g.timeout = to
          g.tolerance = tol
        }
        const u = items[items.length - 1]
        if (u && /^https?:\/\//.test(u.trim())) {
          g.url = items.pop()!.trim()
        }
      }
      for (const it of items) {
        const s = it.trim()
        if (!s) continue
        if (s.startsWith('[]')) g.items.push({ ref: s.slice(2) })
        else if (s.startsWith('!!')) warnings.push(`分组 ${g.name}: 不支持的写法 ${s}`)
        else g.items.push({ regex: s })
      }
      groups.push(g)
    }
  }
  return { groups, rulesets, warnings }
}
