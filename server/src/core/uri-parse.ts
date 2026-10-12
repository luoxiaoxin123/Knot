import type { Proxy } from '../../../shared/types.ts'
import { b64decode, compact, safeDecode, splitList, truthy } from './util.ts'

interface Parts {
  scheme: string
  user: string
  host: string
  port: string
  path: string
  q: URLSearchParams
  name: string
}

/** 手动拆分 URI，兼容 IPv6、端口范围(hy2 端口跳跃)、未编码字符等不规范写法 */
export function splitUri(uri: string): Parts {
  const m = uri.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s)
  if (!m) throw new Error('不是有效的链接')
  const scheme = m[1].toLowerCase()
  let rest = m[2]
  let name = ''
  const hashIdx = rest.indexOf('#')
  if (hashIdx >= 0) {
    name = safeDecode(rest.slice(hashIdx + 1)).trim()
    rest = rest.slice(0, hashIdx)
  }
  let query = ''
  const qIdx = rest.indexOf('?')
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1)
    rest = rest.slice(0, qIdx)
  }
  let path = ''
  const slashIdx = rest.indexOf('/')
  if (slashIdx >= 0) {
    path = rest.slice(slashIdx)
    rest = rest.slice(0, slashIdx)
  }
  let user = ''
  const atIdx = rest.lastIndexOf('@')
  if (atIdx >= 0) {
    user = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
  }
  let host = rest
  let port = ''
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    host = rest.slice(1, end)
    port = rest.slice(end + 1).replace(/^:/, '')
  } else {
    const c = rest.lastIndexOf(':')
    if (c >= 0) {
      host = rest.slice(0, c)
      port = rest.slice(c + 1)
    }
  }
  // URLSearchParams 会把 + 解析为空格，path 等字段里的 + 需要保留
  const q = new URLSearchParams(query.replace(/\+/g, '%2B'))
  return { scheme, user: safeDecode(user), host, port, path, q, name }
}

function toPort(p: string, fallback = 443): number {
  const n = parseInt(p, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function get(q: URLSearchParams, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = q.get(k)
    if (v !== null && v !== '') return v
  }
  return undefined
}

/** v2ray 系(vless/trojan/vmess 标准格式)的传输层参数 */
function applyTransport(p: Proxy, q: URLSearchParams) {
  let net = (get(q, 'type', 'net') || 'tcp').toLowerCase()
  const host = get(q, 'host')
  const path = get(q, 'path')
  const headerType = get(q, 'headerType')
  if (net === 'tcp' && headerType === 'http') net = 'http'
  switch (net) {
    case 'ws':
      p.network = 'ws'
      p['ws-opts'] = compact({ path: path || '/', headers: host ? { Host: host } : undefined })
      break
    case 'httpupgrade':
      p.network = 'ws'
      p['ws-opts'] = compact({
        path: path || '/',
        headers: host ? { Host: host } : undefined,
        'v2ray-http-upgrade': true,
      })
      break
    case 'grpc':
      p.network = 'grpc'
      p['grpc-opts'] = compact({ 'grpc-service-name': get(q, 'serviceName', 'path') || '' })
      break
    case 'h2':
      p.network = 'h2'
      p['h2-opts'] = compact({ path: path || '/', host: host ? splitList(host) : undefined })
      break
    case 'http':
      p.network = 'http'
      p['http-opts'] = compact({
        method: get(q, 'method'),
        path: path ? splitList(path) : ['/'],
        headers: host ? { Host: splitList(host) } : undefined,
      })
      break
    case 'xhttp':
    case 'splithttp':
      p.network = 'xhttp'
      p['xhttp-opts'] = compact({ path: path || '/', host, mode: get(q, 'mode') })
      break
    default:
      p.network = 'tcp'
  }
}

function applyTls(p: Proxy, q: URLSearchParams, defaultSecurity = 'none') {
  const security = (get(q, 'security') || defaultSecurity).toLowerCase()
  const sni = get(q, 'sni', 'peer', 'servername')
  const fp = get(q, 'fp')
  const alpn = get(q, 'alpn')
  if (security === 'tls' || security === 'reality' || security === 'xtls') {
    p.tls = true
    if (sni) p.servername = sni
    if (fp) p['client-fingerprint'] = fp
    if (alpn) p.alpn = splitList(safeDecode(alpn))
    if (truthy(get(q, 'allowInsecure', 'insecure', 'allow_insecure'))) p['skip-cert-verify'] = true
    if (security === 'reality') {
      p['reality-opts'] = compact({ 'public-key': get(q, 'pbk'), 'short-id': get(q, 'sid') ?? '' })
      if (!p['client-fingerprint']) p['client-fingerprint'] = 'chrome'
    }
  }
}

function parseVmess(uri: string): Proxy {
  const body = uri.slice('vmess://'.length)
  // 非 v2rayN JSON 格式时按标准 URI 处理
  if (body.includes('@')) {
    const u = splitUri(uri)
    const p: Proxy = {
      name: u.name,
      type: 'vmess',
      server: u.host,
      port: toPort(u.port),
      uuid: u.user,
      alterId: parseInt(get(u.q, 'alterId', 'aid') || '0', 10) || 0,
      cipher: get(u.q, 'encryption', 'scy') || 'auto',
      udp: true,
    }
    applyTransport(p, u.q)
    applyTls(p, u.q)
    return compact(p)
  }
  const hashIdx = body.indexOf('#')
  const raw = hashIdx >= 0 ? body.slice(0, hashIdx) : body
  const j = JSON.parse(b64decode(raw))
  const q = new URLSearchParams()
  const set = (k: string, v: any) => v !== undefined && v !== null && v !== '' && q.set(k, String(v))
  set('type', j.net)
  set('headerType', j.type)
  set('host', j.host)
  set('path', j.path)
  set('security', j.tls === 'tls' ? 'tls' : j.tls === 'reality' ? 'reality' : 'none')
  set('sni', j.sni)
  set('fp', j.fp)
  set('alpn', j.alpn)
  set('pbk', j.pbk)
  set('sid', j.sid)
  if (j.allowInsecure || j.skipCertVerify) q.set('allowInsecure', '1')
  if (j.net === 'grpc') set('serviceName', j.path)
  const p: Proxy = {
    name: String(j.ps ?? '').trim() || (hashIdx >= 0 ? safeDecode(body.slice(hashIdx + 1)) : ''),
    type: 'vmess',
    server: String(j.add),
    port: toPort(String(j.port)),
    uuid: String(j.id),
    alterId: parseInt(j.aid ?? '0', 10) || 0,
    cipher: j.scy || 'auto',
    udp: true,
  }
  applyTransport(p, q)
  applyTls(p, q)
  return compact(p)
}

function parseVless(uri: string): Proxy {
  const u = splitUri(uri)
  const p: Proxy = {
    name: u.name,
    type: 'vless',
    server: u.host,
    port: toPort(u.port),
    uuid: u.user,
    udp: true,
  }
  const flow = get(u.q, 'flow')
  if (flow) p.flow = flow
  const enc = get(u.q, 'encryption')
  if (enc && enc !== 'none') p.encryption = enc
  applyTransport(p, u.q)
  applyTls(p, u.q)
  return compact(p)
}

function parseTrojan(uri: string): Proxy {
  const u = splitUri(uri)
  const p: Proxy = {
    name: u.name,
    type: 'trojan',
    server: u.host,
    port: toPort(u.port),
    password: u.user,
    udp: true,
  }
  applyTransport(p, u.q)
  if (p.network === 'tcp') delete p.network
  // trojan 默认就是 TLS，mihomo 用 sni 字段
  const security = (get(u.q, 'security') || 'tls').toLowerCase()
  const sni = get(u.q, 'sni', 'peer')
  if (sni) p.sni = sni
  const fp = get(u.q, 'fp')
  if (fp) p['client-fingerprint'] = fp
  const alpn = get(u.q, 'alpn')
  if (alpn) p.alpn = splitList(safeDecode(alpn))
  if (truthy(get(u.q, 'allowInsecure', 'insecure'))) p['skip-cert-verify'] = true
  if (security === 'reality') {
    p['reality-opts'] = compact({ 'public-key': get(u.q, 'pbk'), 'short-id': get(u.q, 'sid') ?? '' })
  }
  return compact(p)
}

function parseSS(uri: string): Proxy {
  let body = uri.slice('ss://'.length)
  let name = ''
  const hashIdx = body.indexOf('#')
  if (hashIdx >= 0) {
    name = safeDecode(body.slice(hashIdx + 1)).trim()
    body = body.slice(0, hashIdx)
  }
  // 旧格式：整个 method:password@host:port 被 base64
  if (!body.includes('@')) {
    const qIdx = body.indexOf('?')
    const main = qIdx >= 0 ? body.slice(0, qIdx) : body
    const tail = qIdx >= 0 ? body.slice(qIdx) : ''
    body = b64decode(main.replace(/\/$/, '')) + tail
  }
  const u = splitUri('ss://' + body)
  let userinfo = u.user
  if (!userinfo.includes(':')) userinfo = b64decode(userinfo)
  const c = userinfo.indexOf(':')
  const cipher = userinfo.slice(0, c)
  const password = userinfo.slice(c + 1)
  const p: Proxy = {
    name: name || u.name,
    type: 'ss',
    server: u.host,
    port: toPort(u.port),
    cipher,
    password,
    udp: true,
  }
  const plugin = get(u.q, 'plugin')
  if (plugin) {
    const [pname, ...opts] = safeDecode(plugin).split(';')
    const kv: Record<string, string> = {}
    for (const o of opts) {
      const i = o.indexOf('=')
      if (i < 0) kv[o] = 'true'
      else kv[o.slice(0, i)] = o.slice(i + 1)
    }
    if (pname === 'obfs-local' || pname === 'simple-obfs') {
      p.plugin = 'obfs'
      p['plugin-opts'] = compact({ mode: kv.obfs || 'http', host: kv['obfs-host'] })
    } else if (pname === 'v2ray-plugin') {
      p.plugin = 'v2ray-plugin'
      p['plugin-opts'] = compact({
        mode: kv.mode || 'websocket',
        tls: 'tls' in kv ? true : undefined,
        host: kv.host,
        path: kv.path,
        mux: 'mux' in kv ? kv.mux !== 'false' && kv.mux !== '0' : undefined,
      })
    } else if (pname === 'shadow-tls') {
      p.plugin = 'shadow-tls'
      p['plugin-opts'] = compact({
        host: kv.host,
        password: kv.password,
        version: kv.version ? Number(kv.version) : 3,
      })
    }
  }
  if (truthy(get(u.q, 'uot', 'udp-over-tcp'))) p['udp-over-tcp'] = true
  return compact(p)
}

function parseSSR(uri: string): Proxy {
  const decoded = b64decode(uri.slice('ssr://'.length))
  const [main, qs = ''] = decoded.split('/?')
  // host 可能是 IPv6，从右往左取 5 个字段
  const parts = main.split(':')
  const passB64 = parts.pop()!
  const obfs = parts.pop()!
  const method = parts.pop()!
  const protocol = parts.pop()!
  const port = parts.pop()!
  const host = parts.join(':')
  const q = new URLSearchParams(qs)
  const d = (k: string) => {
    const v = q.get(k)
    return v ? b64decode(v) : undefined
  }
  return compact({
    name: d('remarks') || `${host}:${port}`,
    type: 'ssr',
    server: host,
    port: toPort(port),
    cipher: method,
    password: b64decode(passB64),
    protocol,
    obfs,
    'protocol-param': d('protoparam'),
    'obfs-param': d('obfsparam'),
    udp: true,
  })
}

function parseHysteria2(uri: string): Proxy {
  const u = splitUri(uri.replace(/^hy2:\/\//i, 'hysteria2://'))
  // 端口可能是 "443,20000-30000" 这样的端口跳跃写法
  const portStr = u.port || '443'
  const firstPort = toPort(portStr.split(/[,-]/)[0])
  const p: Proxy = {
    name: u.name,
    type: 'hysteria2',
    server: u.host,
    port: firstPort,
    password: u.user,
    udp: true,
  }
  const mport = get(u.q, 'mport') || (/[,-]/.test(portStr) ? portStr : undefined)
  if (mport) p.ports = mport
  const sni = get(u.q, 'sni', 'peer')
  if (sni) p.sni = sni
  if (truthy(get(u.q, 'insecure', 'allowInsecure'))) p['skip-cert-verify'] = true
  const obfs = get(u.q, 'obfs')
  if (obfs && obfs !== 'none') {
    p.obfs = obfs
    p['obfs-password'] = get(u.q, 'obfs-password', 'obfsParam') || ''
  }
  const pin = get(u.q, 'pinSHA256')
  if (pin) p.fingerprint = pin
  const alpn = get(u.q, 'alpn')
  if (alpn) p.alpn = splitList(alpn)
  const up = get(u.q, 'up', 'upmbps')
  const down = get(u.q, 'down', 'downmbps')
  if (up) p.up = up
  if (down) p.down = down
  return compact(p)
}

function parseHysteria(uri: string): Proxy {
  const u = splitUri(uri)
  const p: Proxy = {
    name: u.name,
    type: 'hysteria',
    server: u.host,
    port: toPort(u.port),
    'auth-str': get(u.q, 'auth'),
    sni: get(u.q, 'peer', 'sni'),
    'skip-cert-verify': truthy(get(u.q, 'insecure')) || undefined,
    up: get(u.q, 'upmbps', 'up') || '50',
    down: get(u.q, 'downmbps', 'down') || '100',
    alpn: get(u.q, 'alpn') ? splitList(get(u.q, 'alpn')) : undefined,
    protocol: get(u.q, 'protocol'),
    obfs: get(u.q, 'obfsParam', 'obfs'),
    udp: true,
  }
  const mport = get(u.q, 'mport')
  if (mport) p.ports = mport
  return compact(p)
}

function parseTuic(uri: string): Proxy {
  const u = splitUri(uri)
  const [uuid, password = ''] = u.user.split(':')
  return compact({
    name: u.name,
    type: 'tuic',
    server: u.host,
    port: toPort(u.port),
    uuid,
    password,
    sni: get(u.q, 'sni'),
    alpn: splitList(get(u.q, 'alpn') || 'h3'),
    'congestion-controller': get(u.q, 'congestion_control', 'congestion-controller') || 'bbr',
    'udp-relay-mode': get(u.q, 'udp_relay_mode', 'udp-relay-mode') || 'native',
    'skip-cert-verify': truthy(get(u.q, 'allow_insecure', 'insecure', 'allowInsecure')) || undefined,
    'disable-sni': truthy(get(u.q, 'disable_sni')) || undefined,
    'reduce-rtt': truthy(get(u.q, 'reduce_rtt')) || undefined,
    udp: true,
  })
}

function parseAnyTLS(uri: string): Proxy {
  const u = splitUri(uri)
  return compact({
    name: u.name,
    type: 'anytls',
    server: u.host,
    port: toPort(u.port),
    password: u.user,
    sni: get(u.q, 'sni', 'peer'),
    'client-fingerprint': get(u.q, 'fp'),
    alpn: get(u.q, 'alpn') ? splitList(get(u.q, 'alpn')) : undefined,
    'skip-cert-verify': truthy(get(u.q, 'insecure', 'allowInsecure')) || undefined,
    udp: true,
  })
}

function parseSocks(uri: string): Proxy {
  const u = splitUri(uri)
  let user = u.user
  // v2rayN: socks://base64(user:pass)@host:port
  if (user && !user.includes(':')) {
    try {
      const d = b64decode(user)
      if (d.includes(':')) user = d
    } catch {}
  }
  const i = user.indexOf(':')
  return compact({
    name: u.name,
    type: 'socks5',
    server: u.host,
    port: toPort(u.port, 1080),
    username: i >= 0 ? user.slice(0, i) : user || undefined,
    password: i >= 0 ? user.slice(i + 1) : undefined,
    tls: u.scheme === 'socks5+tls' || undefined,
    udp: true,
  })
}

function parseHttp(uri: string): Proxy {
  const u = splitUri(uri)
  const i = u.user.indexOf(':')
  const tls = u.scheme === 'https'
  return compact({
    name: u.name,
    type: 'http',
    server: u.host,
    port: toPort(u.port, tls ? 443 : 80),
    username: i >= 0 ? u.user.slice(0, i) : u.user || undefined,
    password: i >= 0 ? u.user.slice(i + 1) : undefined,
    tls: tls || undefined,
    sni: get(u.q, 'sni'),
    'skip-cert-verify': truthy(get(u.q, 'insecure', 'allowInsecure')) || undefined,
  })
}

function parseWireguard(uri: string): Proxy {
  const u = splitUri(uri.replace(/^wg:\/\//i, 'wireguard://'))
  const addrs = splitList(get(u.q, 'address', 'ip'))
  const v4 = addrs.find((a) => !a.includes(':'))
  const v6 = addrs.find((a) => a.includes(':'))
  const reserved = get(u.q, 'reserved')
  return compact({
    name: u.name,
    type: 'wireguard',
    server: u.host,
    port: toPort(u.port, 51820),
    'private-key': u.user,
    'public-key': get(u.q, 'publickey', 'public-key', 'peer_public_key'),
    'pre-shared-key': get(u.q, 'presharedkey', 'pre-shared-key'),
    ip: v4 ? v4.replace(/\/\d+$/, '') : undefined,
    ipv6: v6 ? v6.replace(/\/\d+$/, '') : undefined,
    mtu: get(u.q, 'mtu') ? Number(get(u.q, 'mtu')) : undefined,
    reserved: reserved ? (reserved.includes(',') ? splitList(reserved).map(Number) : reserved) : undefined,
    udp: true,
  })
}

const PARSERS: Record<string, (uri: string) => Proxy> = {
  vmess: parseVmess,
  vless: parseVless,
  trojan: parseTrojan,
  ss: parseSS,
  ssr: parseSSR,
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
  hysteria: parseHysteria,
  tuic: parseTuic,
  anytls: parseAnyTLS,
  socks: parseSocks,
  socks5: parseSocks,
  'socks5+tls': parseSocks,
  http: parseHttp,
  https: parseHttp,
  wireguard: parseWireguard,
  wg: parseWireguard,
}

export const SUPPORTED_SCHEMES = Object.keys(PARSERS)

export function isProxyUri(line: string): boolean {
  const m = line.trim().match(/^([a-zA-Z0-9+]+):\/\//)
  return !!m && m[1].toLowerCase() in PARSERS
}

export function parseUri(line: string): Proxy {
  const uri = line.trim()
  const scheme = uri.slice(0, uri.indexOf('://')).toLowerCase()
  const fn = PARSERS[scheme]
  if (!fn) throw new Error(`不支持的协议: ${scheme}`)
  const p = fn(uri)
  if (!p.server || !p.port) throw new Error('缺少服务器地址或端口')
  if (!p.name) p.name = `${p.type}-${p.server}:${p.port}`
  return p
}
