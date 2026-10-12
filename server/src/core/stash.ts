// Stash：Clash 兼容格式，差异在于部分节点字段名、不支持 mrs 规则集与部分 mihomo 专有设置
import type { Proxy } from '../../../shared/types.ts'
import type { ClashStructure } from './generate.ts'

const SS_CIPHERS = new Set([
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-192-ctr',
  'aes-256-ctr', 'rc4-md5', 'chacha20-ietf', 'xchacha20', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
])

const num = (v: any) => (v === undefined ? undefined : Number(String(v).match(/\d+/)?.[0] || 0))

export function toStashProxy(src: Proxy): Proxy {
  const p: Proxy = structuredClone(src)
  if (p.network === 'xhttp') throw new Error('Stash 不支持 xhttp 传输')
  if (p.network === 'ws' && p['ws-opts']?.['v2ray-http-upgrade']) throw new Error('Stash 不支持 HTTPUpgrade')
  switch (p.type) {
    case 'ss':
      if (!SS_CIPHERS.has(p.cipher)) throw new Error(`Stash 不支持加密方式 ${p.cipher}`)
      break
    case 'vless':
      if (p.encryption && p.encryption !== 'none') throw new Error('Stash 不支持 VLESS encryption')
      if (p['reality-opts'] && p.network && p.network !== 'tcp') throw new Error('Stash 的 Reality 仅支持 TCP')
      break
    case 'hysteria2':
      if (p.password !== undefined) {
        p.auth = p.password
        delete p.password
      }
      if (p.up !== undefined) p['up-speed'] = num(p.up)
      if (p.down !== undefined) p['down-speed'] = num(p.down)
      delete p.up
      delete p.down
      break
    case 'hysteria':
      if (p.up !== undefined) p['up-speed'] = num(p.up)
      if (p.down !== undefined) p['down-speed'] = num(p.down)
      delete p.up
      delete p.down
      break
    case 'tuic':
      p.version ??= 5
      break
    case 'wireguard':
      if (p['pre-shared-key']) p['preshared-key'] = p['pre-shared-key']
      break
    case 'anytls':
      if (p['reality-opts']) throw new Error('Stash 的 AnyTLS 不支持 Reality')
      break
    case 'vmess':
    case 'trojan':
    case 'socks5':
    case 'http':
    case 'ssr':
      break
    default:
      throw new Error(`Stash 不支持 ${p.type}`)
  }
  return p
}

/** 作为 generateClash 的 transform 使用 */
export function stashTransform(st: ClashStructure) {
  const ok = new Set<string>()
  const dropped = new Set<string>()
  const out: Proxy[] = []
  // 先处理普通节点，再处理依赖中转节点的链式节点
  const sorted = [...st.resolved.proxies].sort((a, b) => (a['dialer-proxy'] ? 1 : 0) - (b['dialer-proxy'] ? 1 : 0))
  for (const p of sorted) {
    if (p['dialer-proxy'] && !ok.has(p['dialer-proxy'])) {
      dropped.add(p.name)
      st.warnings.push(`「${p.name}」: 中转节点不可用`)
      continue
    }
    try {
      out.push(toStashProxy(p))
      ok.add(p.name)
    } catch (e: any) {
      dropped.add(p.name)
      st.warnings.push(`「${p.name}」: ${e.message}`)
    }
  }
  st.resolved.proxies = out
  for (const g of st.groups) {
    if (!Array.isArray(g.proxies)) continue
    g.proxies = g.proxies.filter((m: string) => !dropped.has(m))
    if (!g.proxies.length) g.proxies = ['DIRECT']
    delete g.lazy
  }

  // mrs 规则集换成同源的文本格式
  const removed = new Set<string>()
  for (const [name, p] of Object.entries(st.providers)) {
    if (p?.format !== 'mrs') continue
    if (typeof p.url === 'string' && p.url.includes('meta-rules-dat')) {
      p.url = p.url.replace(/\.mrs$/, '.list')
      p.format = 'text'
      p.path = String(p.path || '').replace(/\.mrs$/, '.list')
    } else {
      removed.add(name)
      delete st.providers[name]
      st.warnings.push(`规则集「${name}」为 mrs 格式，Stash 不支持，已跳过`)
    }
  }
  if (removed.size) st.rules = st.rules.filter((r) => !(r.startsWith('RULE-SET,') && removed.has(r.split(',')[1])))

  // 只保留 Stash 支持的常规设置
  const c = st.config
  st.config = {
    'log-level': c['log-level'] || 'info',
    mode: c.mode || 'rule',
    dns: c.dns
      ? { 'default-nameserver': c.dns['default-nameserver'], nameserver: c.dns.nameserver }
      : undefined,
  }
  if (!st.config.dns) delete st.config.dns
}
