import type { Proxy } from '../../../shared/types.ts'
import { b64decode, b64encode, b64urlEncode } from './util.ts'
import { parseUri } from './uri-parse.ts'

function hostPort(p: Proxy): string {
  const h = p.server.includes(':') && !p.server.startsWith('[') ? `[${p.server}]` : p.server
  return `${h}:${p.port}`
}

function qs(params: Record<string, any>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    parts.push(`${k}=${encodeURIComponent(v === true ? '1' : String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

function tag(name: string): string {
  return `#${encodeURIComponent(name)}`
}

/** v2ray 系传输层 → URI 参数 */
function transportParams(p: Proxy): Record<string, any> {
  const net = p.network || 'tcp'
  const o: Record<string, any> = {}
  switch (net) {
    case 'ws': {
      const ws = p['ws-opts'] || {}
      o.type = ws['v2ray-http-upgrade'] ? 'httpupgrade' : 'ws'
      o.path = ws.path
      o.host = ws.headers?.Host ?? ws.headers?.host
      break
    }
    case 'grpc':
      o.type = 'grpc'
      o.serviceName = p['grpc-opts']?.['grpc-service-name']
      o.mode = 'gun'
      break
    case 'h2':
      o.type = 'h2'
      o.path = p['h2-opts']?.path
      o.host = (p['h2-opts']?.host || []).join(',')
      break
    case 'http': {
      const h = p['http-opts'] || {}
      o.type = 'tcp'
      o.headerType = 'http'
      o.path = (h.path || []).join(',')
      const host = h.headers?.Host
      o.host = Array.isArray(host) ? host.join(',') : host
      break
    }
    case 'xhttp':
      o.type = 'xhttp'
      o.path = p['xhttp-opts']?.path
      o.host = p['xhttp-opts']?.host
      o.mode = p['xhttp-opts']?.mode
      break
    default:
      o.type = 'tcp'
  }
  return o
}

function tlsParams(p: Proxy, sniKey = 'servername'): Record<string, any> {
  const reality = p['reality-opts']
  if (!p.tls && !reality) return { security: 'none' }
  return {
    security: reality ? 'reality' : 'tls',
    sni: p[sniKey] ?? p.sni ?? p.servername,
    fp: p['client-fingerprint'],
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    pbk: reality?.['public-key'],
    sid: reality?.['short-id'],
    allowInsecure: p['skip-cert-verify'] ? 1 : undefined,
  }
}

function emitVmess(p: Proxy): string {
  const t = transportParams(p)
  const net = t.type === 'httpupgrade' ? 'httpupgrade' : t.type
  const j: Record<string, any> = {
    v: '2',
    ps: p.name,
    add: p.server,
    port: String(p.port),
    id: p.uuid,
    aid: String(p.alterId ?? 0),
    scy: p.cipher || 'auto',
    net,
    type: t.headerType || 'none',
    host: t.host || '',
    path: net === 'grpc' ? t.serviceName || '' : t.path || '',
    tls: p['reality-opts'] ? 'reality' : p.tls ? 'tls' : '',
    sni: p.servername || '',
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn || '',
    fp: p['client-fingerprint'] || '',
  }
  if (p['skip-cert-verify']) j.allowInsecure = true
  return 'vmess://' + b64encode(JSON.stringify(j))
}

function emitVless(p: Proxy): string {
  const params = {
    encryption: p.encryption || 'none',
    flow: p.flow,
    ...tlsParams(p),
    ...transportParams(p),
  }
  return `vless://${encodeURIComponent(p.uuid)}@${hostPort(p)}${qs(params)}${tag(p.name)}`
}

function emitTrojan(p: Proxy): string {
  const reality = p['reality-opts']
  const params = {
    security: reality ? 'reality' : 'tls',
    sni: p.sni,
    fp: p['client-fingerprint'],
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    pbk: reality?.['public-key'],
    sid: reality?.['short-id'],
    allowInsecure: p['skip-cert-verify'] ? 1 : undefined,
    ...transportParams(p),
  }
  return `trojan://${encodeURIComponent(p.password)}@${hostPort(p)}${qs(params)}${tag(p.name)}`
}

function emitSS(p: Proxy): string {
  const userinfo = p.cipher.startsWith('2022-')
    ? `${encodeURIComponent(p.cipher)}:${encodeURIComponent(p.password)}`
    : b64urlEncode(`${p.cipher}:${p.password}`).replace(/=+$/, '')
  let plugin = ''
  const o = p['plugin-opts'] || {}
  if (p.plugin === 'obfs') {
    plugin = ['obfs-local', `obfs=${o.mode || 'http'}`, o.host && `obfs-host=${o.host}`].filter(Boolean).join(';')
  } else if (p.plugin === 'v2ray-plugin') {
    plugin = [
      'v2ray-plugin',
      o.mode && o.mode !== 'websocket' ? `mode=${o.mode}` : '',
      o.tls && 'tls',
      o.host && `host=${o.host}`,
      o.path && `path=${o.path}`,
      o.mux && 'mux=1',
    ]
      .filter(Boolean)
      .join(';')
  } else if (p.plugin === 'shadow-tls') {
    plugin = ['shadow-tls', o.host && `host=${o.host}`, o.password && `password=${o.password}`, `version=${o.version || 3}`]
      .filter(Boolean)
      .join(';')
  }
  return `ss://${userinfo}@${hostPort(p)}${plugin ? `/?plugin=${encodeURIComponent(plugin)}` : ''}${tag(p.name)}`
}

function emitSSR(p: Proxy): string {
  const b = (s: string) => b64urlEncode(s).replace(/=+$/, '')
  const main = [p.server, p.port, p.protocol, p.cipher, p.obfs, b(p.password)].join(':')
  const q = [
    p['obfs-param'] && `obfsparam=${b(p['obfs-param'])}`,
    p['protocol-param'] && `protoparam=${b(p['protocol-param'])}`,
    `remarks=${b(p.name)}`,
  ]
    .filter(Boolean)
    .join('&')
  return 'ssr://' + b(`${main}/?${q}`)
}

function emitHysteria2(p: Proxy): string {
  const params = {
    sni: p.sni,
    insecure: p['skip-cert-verify'] ? 1 : undefined,
    obfs: p.obfs,
    'obfs-password': p['obfs-password'],
    pinSHA256: p.fingerprint,
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    mport: p.ports,
  }
  return `hysteria2://${encodeURIComponent(p.password ?? '')}@${hostPort(p)}/${qs(params)}${tag(p.name)}`
}

function emitHysteria(p: Proxy): string {
  const params = {
    protocol: p.protocol,
    auth: p['auth-str'] ?? p.auth_str,
    peer: p.sni,
    insecure: p['skip-cert-verify'] ? 1 : undefined,
    upmbps: parseInt(String(p.up), 10) || undefined,
    downmbps: parseInt(String(p.down), 10) || undefined,
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    obfs: p.obfs ? 'xplus' : undefined,
    obfsParam: p.obfs,
    mport: p.ports,
  }
  return `hysteria://${hostPort(p)}${qs(params)}${tag(p.name)}`
}

function emitTuic(p: Proxy): string {
  const params = {
    sni: p.sni,
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    congestion_control: p['congestion-controller'],
    udp_relay_mode: p['udp-relay-mode'],
    allow_insecure: p['skip-cert-verify'] ? 1 : undefined,
    disable_sni: p['disable-sni'] ? 1 : undefined,
  }
  return `tuic://${encodeURIComponent(p.uuid)}:${encodeURIComponent(p.password ?? '')}@${hostPort(p)}${qs(params)}${tag(p.name)}`
}

function emitAnyTLS(p: Proxy): string {
  const params = {
    sni: p.sni,
    fp: p['client-fingerprint'],
    alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn,
    insecure: p['skip-cert-verify'] ? 1 : undefined,
  }
  return `anytls://${encodeURIComponent(p.password)}@${hostPort(p)}/${qs(params)}${tag(p.name)}`
}

function auth(p: Proxy): string {
  if (!p.username && !p.password) return ''
  return `${encodeURIComponent(p.username ?? '')}:${encodeURIComponent(p.password ?? '')}@`
}

function emitSocks(p: Proxy): string {
  return `socks5${p.tls ? '+tls' : ''}://${auth(p)}${hostPort(p)}${tag(p.name)}`
}

function emitHttp(p: Proxy): string {
  return `${p.tls ? 'https' : 'http'}://${auth(p)}${hostPort(p)}${tag(p.name)}`
}

function emitWireguard(p: Proxy): string {
  const address = [p.ip && `${p.ip}/32`, p.ipv6 && `${p.ipv6}/128`].filter(Boolean).join(',')
  const params = {
    publickey: p['public-key'],
    presharedkey: p['pre-shared-key'],
    address,
    mtu: p.mtu,
    reserved: Array.isArray(p.reserved) ? p.reserved.join(',') : p.reserved,
  }
  return `wireguard://${encodeURIComponent(p['private-key'])}@${hostPort(p)}/${qs(params)}${tag(p.name)}`
}

const EMITTERS: Record<string, (p: Proxy) => string> = {
  vmess: emitVmess,
  vless: emitVless,
  trojan: emitTrojan,
  ss: emitSS,
  ssr: emitSSR,
  hysteria2: emitHysteria2,
  hysteria: emitHysteria,
  tuic: emitTuic,
  anytls: emitAnyTLS,
  socks5: emitSocks,
  http: emitHttp,
  wireguard: emitWireguard,
}

/** 转换为分享链接；不支持时返回 null（例如链式节点、带插件的特殊配置） */
export function toUri(p: Proxy): string | null {
  if (p['dialer-proxy']) return null
  const fn = EMITTERS[p.type]
  if (!fn) return null
  try {
    return fn(p)
  } catch {
    return null
  }
}

/** 只改分享链接里的节点名称，其余部分保持原样；无法安全改名时返回 null */
export function renameUri(uri: string, name: string): string | null {
  try {
    const scheme = uri.slice(0, uri.indexOf('://')).toLowerCase()
    let out: string
    if (scheme === 'ssr') return null
    if (scheme === 'vmess' && !uri.includes('@')) {
      const body = uri.slice('vmess://'.length).split('#')[0]
      const j = JSON.parse(b64decode(body))
      out = 'vmess://' + b64encode(JSON.stringify({ ...j, ps: name }))
    } else {
      const i = uri.indexOf('#')
      out = (i >= 0 ? uri.slice(0, i) : uri) + '#' + encodeURIComponent(name)
    }
    return parseUri(out).name === name ? out : null
  } catch {
    return null
  }
}
