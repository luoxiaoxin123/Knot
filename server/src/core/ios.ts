// Surge / Loon / Quantumult X 配置生成。
// 节点、分组、规则沿用 Clash 结构（clashStructure），再转换为各客户端语法。
// 规则集：内置模块改用 blackmatrix7/ios_rule_script 中对应客户端格式的规则，GEOIP,CN 使用客户端内置数据库。
import type { GenContext, GenResult } from './generate.ts'
import { clashStructure } from './generate.ts'
import type { Profile, Proxy } from '../../../shared/types.ts'

export type IosTarget = 'surge' | 'loon' | 'qx'

const BM7 = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule'
const CLIENT_DIR: Record<IosTarget, string> = { surge: 'Surge', loon: 'Loon', qx: 'QuantumultX' }

/** meta-rules-dat geosite 名 → blackmatrix7 规则名 */
const GEOSITE_TO_BM7: Record<string, string[]> = {
  private: ['Lan'],
  'category-ads-all': ['AdvertisingLite'],
  'category-ai-!cn': ['OpenAI', 'Claude', 'Gemini'],
  openai: ['OpenAI'],
  anthropic: ['Claude'],
  'google-gemini': ['Gemini'],
  telegram: ['Telegram'],
  youtube: ['YouTube'],
  google: ['Google'],
  github: ['GitHub'],
  twitter: ['Twitter'],
  facebook: ['Facebook'],
  instagram: ['Instagram'],
  whatsapp: ['Whatsapp'],
  discord: ['Discord'],
  netflix: ['Netflix'],
  disney: ['Disney'],
  spotify: ['Spotify'],
  hbo: ['HBO'],
  primevideo: ['PrimeVideo'],
  tiktok: ['TikTok'],
  twitch: ['Twitch'],
  steam: ['Steam'],
  epicgames: ['Epic'],
  playstation: ['PlayStation'],
  nintendo: ['Nintendo'],
  microsoft: ['Microsoft'],
  onedrive: ['OneDrive'],
  bing: ['Bing'],
  apple: ['Apple'],
  bilibili: ['BiliBili'],
  'geolocation-!cn': ['Global'],
  cn: ['China'],
}

const bm7Url = (target: IosTarget, name: string) => `${BM7}/${CLIENT_DIR[target]}/${name}/${name}.list`

// ------------------------------------------------------------------ 节点

const q = (v: any) => `"${String(v).replace(/"/g, '')}"`
const hostOf = (p: Proxy) => p['ws-opts']?.headers?.Host ?? p['ws-opts']?.headers?.host
const sniOf = (p: Proxy) => p.servername ?? p.sni

function unsupported(msg: string): never {
  throw new Error(msg)
}

function surgeProxy(p: Proxy, name: string, relay?: string): string {
  const out: string[] = []
  const tls = () => {
    if (sniOf(p)) out.push(`sni=${sniOf(p)}`)
    if (p['skip-cert-verify']) out.push('skip-cert-verify=true')
  }
  const ws = () => {
    if (p.network === 'ws') {
      if (p['ws-opts']?.['v2ray-http-upgrade']) unsupported('Surge 不支持 HTTPUpgrade')
      out.push('ws=true')
      if (p['ws-opts']?.path) out.push(`ws-path=${p['ws-opts'].path}`)
      if (hostOf(p)) out.push(`ws-headers=Host:${q(hostOf(p))}`)
    } else if (p.network && p.network !== 'tcp') unsupported(`Surge 不支持 ${p.network} 传输`)
  }
  if (p['reality-opts']) unsupported('Surge 不支持 Reality')
  switch (p.type) {
    case 'ss': {
      out.push('ss', p.server, String(p.port), `encrypt-method=${p.cipher}`, `password=${q(p.password)}`)
      const o = p['plugin-opts'] || {}
      if (p.plugin === 'obfs') {
        out.push(`obfs=${o.mode || 'http'}`)
        if (o.host) out.push(`obfs-host=${o.host}`)
      } else if (p.plugin === 'shadow-tls') {
        out.push(`shadow-tls-password=${q(o.password)}`, `shadow-tls-sni=${o.host}`, `shadow-tls-version=${o.version || 3}`)
      } else if (p.plugin) unsupported(`Surge 不支持 ss 插件 ${p.plugin}`)
      if (p.udp) out.push('udp-relay=true')
      break
    }
    case 'vmess': {
      out.push('vmess', p.server, String(p.port), `username=${p.uuid}`)
      const c = String(p.cipher || 'auto').toLowerCase()
      if (c === 'aes-128-gcm') out.push('encrypt-method=aes-128-gcm')
      else if (c === 'chacha20-poly1305' || c === 'chacha20-ietf-poly1305') out.push('encrypt-method=chacha20-ietf-poly1305')
      ws()
      out.push(`vmess-aead=${Number(p.alterId || 0) === 0}`)
      if (p.tls) {
        out.push('tls=true')
        tls()
      }
      break
    }
    case 'trojan':
      out.push('trojan', p.server, String(p.port), `password=${q(p.password)}`)
      ws()
      tls()
      break
    case 'hysteria2':
      out.push('hysteria2', p.server, String(p.port), `password=${q(p.password)}`)
      if (p.ports) {
        if (relay) unsupported('Surge 的端口跳跃不能与链式代理同时使用')
        out.push(`port-hopping=${q(String(p.ports).replace(/,/g, ';'))}`)
      }
      if (p.obfs) {
        if (p.obfs !== 'salamander') unsupported(`Surge 不支持 obfs ${p.obfs}`)
        out.push(`salamander-password=${q(p['obfs-password'])}`)
      }
      if (p.down) out.push(`download-bandwidth=${parseInt(String(p.down), 10) || 0}`)
      tls()
      break
    case 'tuic':
      out.push('tuic-v5', p.server, String(p.port), `uuid=${p.uuid}`, `password=${q(p.password)}`)
      if (p.alpn?.length) out.push(`alpn=${p.alpn[0]}`)
      if (p.ports) {
        if (relay) unsupported('Surge 的端口跳跃不能与链式代理同时使用')
        out.push(`port-hopping=${q(String(p.ports).replace(/,/g, ';'))}`)
      }
      tls()
      break
    case 'anytls':
      if (p.network && p.network !== 'tcp') unsupported('Surge 的 AnyTLS 不支持该传输')
      out.push('anytls', p.server, String(p.port), `password=${q(p.password)}`)
      tls()
      break
    case 'socks5':
      out.push(p.tls ? 'socks5-tls' : 'socks5', p.server, String(p.port))
      if (p.username) out.push(`username=${q(p.username)}`, `password=${q(p.password ?? '')}`)
      if (p.tls) tls()
      if (p.udp) out.push('udp-relay=true')
      break
    case 'http':
      out.push(p.tls ? 'https' : 'http', p.server, String(p.port))
      if (p.username) out.push(`username=${q(p.username)}`, `password=${q(p.password ?? '')}`)
      if (p.tls) tls()
      break
    default:
      unsupported(`Surge 不支持 ${p.type}`)
  }
  if (relay) out.push(`underlying-proxy=${relay}`)
  return `${name} = ${out.join(', ')}`
}

function loonProxy(p: Proxy, name: string): string {
  const out: string[] = []
  const transport = () => {
    if (p.network === 'ws') {
      if (p['ws-opts']?.['v2ray-http-upgrade']) unsupported('Loon 不支持 HTTPUpgrade')
      out.push('transport=ws')
      if (p['ws-opts']?.path) out.push(`path=${p['ws-opts'].path}`)
      if (hostOf(p)) out.push(`host=${hostOf(p)}`)
    } else if (p.network === 'http') {
      const h = p['http-opts'] || {}
      out.push('transport=http')
      const path = Array.isArray(h.path) ? h.path[0] : h.path
      const host = Array.isArray(h.headers?.Host) ? h.headers.Host[0] : h.headers?.Host
      if (path) out.push(`path=${path}`)
      if (host) out.push(`host=${host}`)
    } else if (p.network && p.network !== 'tcp') unsupported(`Loon 不支持 ${p.network} 传输`)
    else out.push('transport=tcp')
  }
  const tlsTail = () => {
    if (p['skip-cert-verify']) out.push('skip-cert-verify=true')
    const r = p['reality-opts']
    if (r) {
      if (sniOf(p)) out.push(`sni=${sniOf(p)}`)
      out.push(`public-key=${q(r['public-key'])}`)
      if (r['short-id']) out.push(`short-id=${r['short-id']}`)
    } else if (sniOf(p)) out.push(`tls-name=${sniOf(p)}`)
  }
  switch (p.type) {
    case 'ss': {
      out.push('shadowsocks', p.server, String(p.port), p.cipher, q(p.password))
      const o = p['plugin-opts'] || {}
      if (p.plugin === 'obfs') {
        out.push(`obfs-name=${o.mode || 'http'}`)
        if (o.host) out.push(`obfs-host=${o.host}`)
      } else if (p.plugin) unsupported(`Loon 不支持 ss 插件 ${p.plugin}`)
      break
    }
    case 'vmess': {
      const c = String(p.cipher || 'auto').toLowerCase()
      out.push('vmess', p.server, String(p.port), c === 'chacha20-poly1305' ? 'chacha20-ietf-poly1305' : c, q(p.uuid))
      transport()
      if (p.tls) out.push('over-tls=true')
      tlsTail()
      out.push(`alterId=${Number(p.alterId || 0)}`)
      break
    }
    case 'vless':
      if (p.encryption && p.encryption !== 'none') unsupported('Loon 不支持 VLESS encryption')
      if (p.flow && p.flow !== 'xtls-rprx-vision') unsupported(`Loon 不支持 flow ${p.flow}`)
      out.push('vless', p.server, String(p.port), q(p.uuid))
      transport()
      if (p.tls) out.push('over-tls=true')
      if (p.flow) out.push(`flow=${p.flow}`)
      tlsTail()
      break
    case 'trojan':
      out.push('trojan', p.server, String(p.port), q(p.password))
      if (p.network === 'ws') transport()
      else if (p.network && p.network !== 'tcp') unsupported(`Loon 的 Trojan 不支持 ${p.network}`)
      tlsTail()
      break
    case 'hysteria2':
      if (p.obfs && p.obfs !== 'salamander') unsupported(`Loon 不支持 obfs ${p.obfs}`)
      out.push('Hysteria2', p.server, String(p.port), q(p.password))
      if (p.ports) out.push(`server-ports=${q(p.ports)}`)
      if (sniOf(p)) out.push(`tls-name=${sniOf(p)}`)
      if (p['skip-cert-verify']) out.push('skip-cert-verify=true')
      if (p.obfs) out.push(`salamander-password=${p['obfs-password']}`)
      if (p.down) out.push(`download-bandwidth=${parseInt(String(p.down), 10) || 0}`)
      break
    case 'anytls':
      if (p['reality-opts']) unsupported('Loon 的 AnyTLS 不支持 Reality')
      out.push('anytls', p.server, String(p.port), q(p.password))
      tlsTail()
      break
    case 'socks5':
      out.push('socks5', p.server, String(p.port))
      if (p.username) out.push(p.username, q(p.password ?? ''))
      if (p.tls) out.push('over-tls=true')
      break
    case 'http':
      out.push(p.tls ? 'https' : 'http', p.server, String(p.port))
      if (p.username) out.push(p.username, q(p.password ?? ''))
      break
    default:
      unsupported(`Loon 不支持 ${p.type}`)
  }
  if (p.udp && !['http'].includes(p.type)) out.push('udp=true')
  return `${name} = ${out.join(',')}`
}

function qxProxy(p: Proxy, name: string): string {
  const out: string[] = []
  const tls = () => {
    out.push(`tls-verification=${!p['skip-cert-verify']}`)
    if (sniOf(p)) out.push(`tls-host=${sniOf(p)}`)
  }
  const obfs = () => {
    if (p.network === 'ws') {
      if (p['ws-opts']?.['v2ray-http-upgrade']) unsupported('QX 不支持 HTTPUpgrade')
      out.push(`obfs=${p.tls ? 'wss' : 'ws'}`)
      if (p['ws-opts']?.path) out.push(`obfs-uri=${p['ws-opts'].path}`)
      if (hostOf(p)) out.push(`obfs-host=${hostOf(p)}`)
    } else if (p.network && p.network !== 'tcp') unsupported(`QX 不支持 ${p.network} 传输`)
    else if (p.tls) out.push('obfs=over-tls')
  }
  const reality = () => {
    const r = p['reality-opts']
    if (!r) return
    out.push(`reality-base64-pubkey=${r['public-key']}`)
    if (r['short-id']) out.push(`reality-hex-shortid=${r['short-id']}`)
  }
  switch (p.type) {
    case 'ss': {
      out.push(`shadowsocks=${p.server}:${p.port}`, `method=${p.cipher}`, `password=${p.password}`)
      const o = p['plugin-opts'] || {}
      if (p.plugin === 'obfs') {
        out.push(`obfs=${o.mode || 'http'}`)
        if (o.host) out.push(`obfs-host=${o.host}`)
      } else if (p.plugin === 'v2ray-plugin') {
        out.push(`obfs=${o.tls ? 'wss' : 'ws'}`)
        if (o.host) out.push(`obfs-host=${o.host}`)
        if (o.path) out.push(`obfs-uri=${o.path}`)
      } else if (p.plugin) unsupported(`QX 不支持 ss 插件 ${p.plugin}`)
      break
    }
    case 'ssr':
      out.push(
        `shadowsocks=${p.server}:${p.port}`,
        `method=${p.cipher}`,
        `password=${p.password}`,
        `ssr-protocol=${p.protocol}`,
        ...(p['protocol-param'] ? [`ssr-protocol-param=${p['protocol-param']}`] : []),
        `obfs=${p.obfs}`,
        ...(p['obfs-param'] ? [`obfs-host=${p['obfs-param']}`] : []),
      )
      break
    case 'vmess': {
      if (p['reality-opts']) unsupported('QX 的 VMess 不支持 Reality')
      const c = String(p.cipher || 'auto').toLowerCase()
      out.push(`vmess=${p.server}:${p.port}`, `method=${c === 'none' ? 'none' : 'chacha20-poly1305'}`, `password=${p.uuid}`)
      obfs()
      if (p.tls) tls()
      out.push(`aead=${Number(p.alterId || 0) === 0}`)
      break
    }
    case 'vless':
      if (p.encryption && p.encryption !== 'none') unsupported('QX 不支持 VLESS encryption')
      if (p.flow && p.flow !== 'xtls-rprx-vision') unsupported(`QX 不支持 flow ${p.flow}`)
      out.push(`vless=${p.server}:${p.port}`, 'method=none', `password=${p.uuid}`)
      obfs()
      if (p.tls) tls()
      if (p.flow) out.push(`vless-flow=${p.flow}`)
      reality()
      break
    case 'trojan':
      out.push(`trojan=${p.server}:${p.port}`, `password=${p.password}`)
      if (p.network === 'ws') {
        out.push('obfs=wss')
        if (p['ws-opts']?.path) out.push(`obfs-uri=${p['ws-opts'].path}`)
        if (hostOf(p)) out.push(`obfs-host=${hostOf(p)}`)
      } else if (p.network && p.network !== 'tcp') unsupported(`QX 的 Trojan 不支持 ${p.network}`)
      else out.push('over-tls=true')
      tls()
      reality()
      break
    case 'anytls':
      if (p['reality-opts']) unsupported('QX 的 AnyTLS 不支持 Reality')
      out.push(`anytls=${p.server}:${p.port}`, `password=${p.password}`, 'over-tls=true')
      tls()
      break
    case 'http':
      out.push(`http=${p.server}:${p.port}`)
      if (p.username) out.push(`username=${p.username}`, `password=${p.password ?? ''}`)
      if (p.tls) {
        out.push('over-tls=true')
        tls()
      }
      break
    case 'socks5':
      out.push(`socks5=${p.server}:${p.port}`)
      if (p.username) out.push(`username=${p.username}`, `password=${p.password ?? ''}`)
      if (p.tls) {
        out.push('over-tls=true')
        tls()
      }
      break
    default:
      unsupported(`QX 不支持 ${p.type}`)
  }
  if (p.udp && p.type !== 'http') out.push('udp-relay=true')
  out.push(`tag=${name}`)
  return out.join(', ')
}

// ------------------------------------------------------------------ 规则

const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP'])

/** Clash 单条规则 → 目标客户端；不支持时返回 null */
function convertRule(target: IosTarget, type: string, value: string, policy: string, noResolve: boolean): string | null {
  const nr = noResolve && IP_TYPES.has(type) ? ',no-resolve' : ''
  if (target === 'qx') {
    const map: Record<string, string> = {
      DOMAIN: 'host',
      'DOMAIN-SUFFIX': 'host-suffix',
      'DOMAIN-KEYWORD': 'host-keyword',
      'IP-CIDR': 'ip-cidr',
      'IP-CIDR6': 'ip6-cidr',
      GEOIP: 'geoip',
    }
    if (!map[type]) return null
    return `${map[type]}, ${value}, ${policy}${noResolve && IP_TYPES.has(type) ? ', no-resolve' : ''}`
  }
  const common = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP']
  if (common.includes(type)) return `${type},${value},${policy}${nr}`
  if (target === 'surge') {
    if (type === 'PROCESS-NAME') return `PROCESS-NAME,${value},${policy}`
    if (type === 'DST-PORT') return `DEST-PORT,${value},${policy}`
    if (type === 'SRC-IP-CIDR') return `SRC-IP,${value},${policy}`
    if (type === 'IP-ASN') return `IP-ASN,${value},${policy}${nr}`
    if (type === 'DOMAIN-REGEX') return null
  }
  return null
}

export interface IosOptions {
  /** 只输出节点列表（用于客户端里的“订阅节点”） */
  listOnly?: boolean
  /** 订阅地址，Surge 托管配置自动更新用 */
  managedUrl?: string
}

export function generateIos(ctx: GenContext, profile: Profile, target: IosTarget, opts: IosOptions = {}): GenResult {
  const st = clashStructure(ctx, profile)
  const { warnings } = st
  const label = { surge: 'Surge', loon: 'Loon', qx: 'Quantumult X' }[target]
  if (profile.ruleMode === 'template') warnings.push(`${label} 输出不使用外部 Clash 模板的规则集，模板中的远程规则只有 .list 格式会保留`)

  // 名称里不能有逗号 / 等号
  const used = new Set<string>()
  const nameMap = new Map<string, string>()
  const clean = (n: string) => {
    if (nameMap.has(n)) return nameMap.get(n)!
    let base = n.replace(/[,=]/g, ' ').trim() || 'node'
    let v = base
    for (let i = 2; used.has(v); i++) v = `${base} ${i}`
    used.add(v)
    nameMap.set(n, v)
    return v
  }
  for (const g of st.groups) clean(g.name)

  // 节点：链式代理只有 Surge 支持（underlying-proxy）
  const proxyLines: string[] = []
  const ok = new Set<string>()
  const sorted = [...st.resolved.proxies].sort((a, b) => (a['dialer-proxy'] ? 1 : 0) - (b['dialer-proxy'] ? 1 : 0))
  for (const p of sorted) {
    const relay = p['dialer-proxy']
    try {
      if (relay && target !== 'surge') unsupported(`${label} 不支持链式代理`)
      if (relay && !ok.has(relay)) unsupported('中转节点不可用')
      const name = clean(p.name)
      const line =
        target === 'surge' ? surgeProxy(p, name, relay ? nameMap.get(relay) : undefined) : target === 'loon' ? loonProxy(p, name) : qxProxy(p, name)
      proxyLines.push(line)
      ok.add(p.name)
    } catch (e: any) {
      warnings.push(`「${p.name}」: ${e.message}`)
    }
  }

  if (opts.listOnly) {
    return { text: proxyLines.join('\n') + '\n', warnings, contentType: 'text/plain; charset=utf-8' }
  }

  // 分组
  const groupNames = new Set(st.groups.map((g) => g.name))
  const builtin = (m: string) => (target === 'qx' ? m.toLowerCase() : m)
  const memberOk = (m: string) => ok.has(m) || groupNames.has(m) || m === 'DIRECT' || m === 'REJECT'
  const testUrl = ctx.settings.testUrl
  const groupLines = st.groups.map((g) => {
    let members: string[] = (g.proxies || []).filter(memberOk)
    if (!members.length) members = ['DIRECT']
    const ms = members.map((m) => (m === 'DIRECT' || m === 'REJECT' ? builtin(m) : clean(m)))
    const name = clean(g.name)
    if (target === 'qx') {
      const type = { select: 'static', 'url-test': 'url-latency-benchmark', fallback: 'available', 'load-balance': 'round-robin' }[g.type as string] || 'static'
      const extra = g.type === 'url-test' ? ', check-interval=600, tolerance=50' : ''
      return `${type}=${name}, ${ms.join(', ')}${extra}`
    }
    const type = ['select', 'url-test', 'fallback', 'load-balance'].includes(g.type) ? g.type : 'select'
    const extra = type === 'select' ? '' : `, url=${testUrl}, interval=600${type === 'url-test' ? ', tolerance=50' : ''}`
    return target === 'surge' ? `${name} = ${type}, ${ms.join(', ')}${extra}` : `${name} = ${type},${ms.join(',')}${extra.replace(/, /g, ',')}`
  })

  // 规则
  const policy = (p: string) => (p === 'DIRECT' || p === 'REJECT' ? builtin(p) : clean(p))
  // 按原顺序保存，Surge 原样输出；Loon / QX 分成本地规则与远程规则两段
  const ordered: ({ local: string } | { url: string; policy: string; tag: string })[] = []
  const seenRemote = new Set<string>()
  let final = 'DIRECT'
  let skipped = 0
  for (const r of st.rules) {
    const parts = r.split(',').map((x) => x.trim())
    const noResolve = parts[parts.length - 1] === 'no-resolve'
    if (noResolve) parts.pop()
    const type = parts[0].toUpperCase()
    if (type === 'MATCH' || type === 'FINAL') {
      final = parts[1]
      continue
    }
    const pol = parts[parts.length - 1]
    const value = parts.slice(1, -1).join(',')
    if (!memberOk(pol) && !groupNames.has(pol)) {
      skipped++
      continue
    }
    if (type === 'RULE-SET') {
      const m = value.match(/^(geosite|geoip)-(.+)$/)
      if (m) {
        if (m[1] === 'geoip') {
          if (m[2] === 'cn') ordered.push({ local: target === 'qx' ? `geoip, cn, ${policy(pol)}` : `GEOIP,CN,${policy(pol)}` })
          // 其他 geoip 已包含在对应服务的 blackmatrix7 规则里
          continue
        }
        const lists = GEOSITE_TO_BM7[m[2]]
        if (!lists) {
          skipped++
          continue
        }
        for (const l of lists) {
          const key = `${l}|${pol}`
          if (seenRemote.has(key)) continue
          seenRemote.add(key)
          ordered.push({ url: bm7Url(target, l), policy: policy(pol), tag: l })
        }
        continue
      }
      const prov = st.providers[value]
      // 模板 / 自定义的 .list 文本规则集，Surge / Loon 语法兼容
      if (prov?.url && target !== 'qx' && (prov.format === 'text' || /\.list$/.test(prov.url)) && prov.behavior === 'classical') {
        ordered.push({ url: prov.url, policy: policy(pol), tag: value })
      } else skipped++
      continue
    }
    const line = convertRule(target, type, value, policy(pol), noResolve)
    if (line) ordered.push({ local: line })
    else skipped++
  }
  if (skipped) warnings.push(`${skipped} 条规则 ${label} 不支持，已跳过`)
  const local = ordered.flatMap((x) => ('local' in x ? [x.local] : []))
  const remote = ordered.flatMap((x) => ('url' in x ? [x] : []))
  const orderNote =
    target === 'surge' ? '' : `# 注意：${label} 中本地规则优先于远程规则，自定义尾部规则与 GEOIP,CN 会先于远程规则集匹配`

  const header = `# ${profile.name} — 由 Switch 生成于 ${new Date().toISOString()}`
  const skip = '127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local'
  let text = ''
  if (target === 'surge') {
    const ruleLines = [...ordered.map((x) => ('local' in x ? x.local : `RULE-SET,${x.url},${x.policy}`)), `FINAL,${policy(final)},dns-failed`]
    text = [
      opts.managedUrl ? `#!MANAGED-CONFIG ${opts.managedUrl} interval=43200 strict=false` : '',
      header,
      '',
      '[General]',
      'loglevel = notify',
      `skip-proxy = ${skip}`,
      'dns-server = 223.5.5.5, 119.29.29.29, system',
      'ipv6 = false',
      `proxy-test-url = ${testUrl}`,
      'internet-test-url = http://www.apple.com/library/test/success.html',
      'exclude-simple-hostnames = true',
      '',
      '[Proxy]',
      ...proxyLines,
      '',
      '[Proxy Group]',
      ...groupLines,
      '',
      '[Rule]',
      ...ruleLines,
      '',
    ]
      .filter((l, i) => i > 0 || l)
      .join('\n')
  } else if (target === 'loon') {
    text = [
      header,
      orderNote,
      '',
      '[General]',
      `skip-proxy = ${skip}`,
      'dns-server = system, 223.5.5.5, 119.29.29.29',
      'ipv6 = false',
      `proxy-test-url = ${testUrl}`,
      '',
      '[Proxy]',
      ...proxyLines,
      '',
      '[Proxy Group]',
      ...groupLines,
      '',
      '[Remote Rule]',
      ...remote.map((r) => `${r.url}, policy=${r.policy}, tag=${r.tag}, enabled=true`),
      '',
      '[Rule]',
      ...local,
      `FINAL,${policy(final)}`,
      '',
    ].join('\n')
  } else {
    text = [
      header,
      orderNote,
      '',
      '[general]',
      `server_check_url=${testUrl}`,
      'network_check_url=http://www.apple.com/library/test/success.html',
      'excluded_routes=192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8',
      '',
      '[dns]',
      'server=223.5.5.5',
      'server=119.29.29.29',
      '',
      '[policy]',
      ...groupLines,
      '',
      '[server_remote]',
      '',
      '[filter_remote]',
      ...remote.map((r, i) => `${r.url}, tag=${r.tag}-${i + 1}, force-policy=${r.policy}, update-interval=86400, opt-parser=false, enabled=true`),
      '',
      '[rewrite_remote]',
      '',
      '[server_local]',
      ...proxyLines,
      '',
      '[filter_local]',
      ...local,
      `final, ${policy(final)}`,
      '',
      '[rewrite_local]',
      '',
      '[task_local]',
      '',
      '[mitm]',
      '',
    ].join('\n')
  }
  return { text, warnings, contentType: 'text/plain; charset=utf-8' }
}
