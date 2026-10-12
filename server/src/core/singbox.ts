import type { Proxy } from '../../../shared/types.ts'
import { compact } from './util.ts'

function mbps(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function tlsOf(p: Proxy, opts: { force?: boolean; sniKey?: string } = {}) {
  const reality = p['reality-opts']
  if (!opts.force && !p.tls && !reality) return undefined
  const fp = p['client-fingerprint']
  return compact({
    enabled: true,
    server_name: p[opts.sniKey || 'servername'] ?? p.sni ?? p.servername,
    insecure: p['skip-cert-verify'] || undefined,
    alpn: p.alpn ? (Array.isArray(p.alpn) ? p.alpn : [p.alpn]) : undefined,
    disable_sni: p['disable-sni'] || undefined,
    utls: fp || reality ? { enabled: true, fingerprint: fp || 'chrome' } : undefined,
    reality: reality
      ? { enabled: true, public_key: reality['public-key'], short_id: reality['short-id'] ?? '' }
      : undefined,
  })
}

function transportOf(p: Proxy) {
  switch (p.network) {
    case 'ws': {
      const ws = p['ws-opts'] || {}
      if (ws['v2ray-http-upgrade']) {
        return compact({ type: 'httpupgrade', path: ws.path || '/', host: ws.headers?.Host })
      }
      return compact({
        type: 'ws',
        path: ws.path || '/',
        headers: ws.headers,
        max_early_data: ws['max-early-data'],
        early_data_header_name: ws['early-data-header-name'],
      })
    }
    case 'grpc':
      return { type: 'grpc', service_name: p['grpc-opts']?.['grpc-service-name'] || '' }
    case 'h2':
      return compact({ type: 'http', host: p['h2-opts']?.host, path: p['h2-opts']?.path })
    case 'http': {
      const h = p['http-opts'] || {}
      const host = h.headers?.Host
      return compact({
        type: 'http',
        method: h.method,
        path: Array.isArray(h.path) ? h.path[0] : h.path,
        host: host ? (Array.isArray(host) ? host : [host]) : undefined,
      })
    }
    case 'xhttp':
      throw new Error('sing-box 不支持 xhttp 传输')
    default:
      return undefined
  }
}

function portsOf(ports: string | undefined): string[] | undefined {
  if (!ports) return undefined
  return String(ports)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes('-') ? s.replace('-', ':') : `${s}:${s}`))
}

/** mihomo proxy → sing-box outbound；不支持时抛错 */
export function toSingboxOutbound(p: Proxy, tag: string, detour?: string): Record<string, any> {
  const base = { tag, server: p.server, server_port: Number(p.port), detour }
  switch (p.type) {
    case 'ss': {
      let plugin: string | undefined
      let plugin_opts: string | undefined
      const o = p['plugin-opts'] || {}
      if (p.plugin === 'obfs') {
        plugin = 'obfs-local'
        plugin_opts = [`obfs=${o.mode || 'http'}`, o.host && `obfs-host=${o.host}`].filter(Boolean).join(';')
      } else if (p.plugin === 'v2ray-plugin') {
        plugin = 'v2ray-plugin'
        plugin_opts = [o.mode && `mode=${o.mode}`, o.tls && 'tls', o.host && `host=${o.host}`, o.path && `path=${o.path}`, o.mux && 'mux=1']
          .filter(Boolean)
          .join(';')
      } else if (p.plugin) {
        throw new Error(`sing-box 不支持 ss 插件 ${p.plugin}`)
      }
      return compact({
        type: 'shadowsocks',
        ...base,
        method: p.cipher,
        password: p.password,
        plugin,
        plugin_opts,
        udp_over_tcp: p['udp-over-tcp'] || undefined,
      })
    }
    case 'vmess':
      return compact({
        type: 'vmess',
        ...base,
        uuid: p.uuid,
        security: p.cipher || 'auto',
        alter_id: Number(p.alterId || 0),
        tls: tlsOf(p),
        transport: transportOf(p),
        packet_encoding: 'xudp',
      })
    case 'vless':
      if (p.encryption && p.encryption !== 'none') throw new Error('sing-box 不支持 VLESS encryption')
      return compact({
        type: 'vless',
        ...base,
        uuid: p.uuid,
        flow: p.flow,
        tls: tlsOf(p),
        transport: transportOf(p),
        packet_encoding: 'xudp',
      })
    case 'trojan':
      return compact({
        type: 'trojan',
        ...base,
        password: p.password,
        tls: tlsOf(p, { force: true, sniKey: 'sni' }),
        transport: transportOf(p),
      })
    case 'hysteria2': {
      const server_ports = portsOf(p.ports)
      return compact({
        type: 'hysteria2',
        ...base,
        server_port: server_ports ? undefined : Number(p.port),
        server_ports,
        password: p.password,
        up_mbps: mbps(p.up),
        down_mbps: mbps(p.down),
        obfs: p.obfs ? { type: p.obfs, password: p['obfs-password'] || '' } : undefined,
        tls: tlsOf(p, { force: true, sniKey: 'sni' }),
      })
    }
    case 'hysteria':
      return compact({
        type: 'hysteria',
        ...base,
        server_ports: portsOf(p.ports),
        auth_str: p['auth-str'] ?? p.auth_str,
        up_mbps: mbps(p.up) ?? 50,
        down_mbps: mbps(p.down) ?? 100,
        obfs: p.obfs,
        tls: tlsOf(p, { force: true, sniKey: 'sni' }),
      })
    case 'tuic':
      return compact({
        type: 'tuic',
        ...base,
        uuid: p.uuid,
        password: p.password,
        congestion_control: p['congestion-controller'],
        udp_relay_mode: p['udp-relay-mode'],
        zero_rtt_handshake: p['reduce-rtt'] || undefined,
        tls: tlsOf(p, { force: true, sniKey: 'sni' }),
      })
    case 'anytls':
      return compact({
        type: 'anytls',
        ...base,
        password: p.password,
        tls: tlsOf(p, { force: true, sniKey: 'sni' }),
      })
    case 'socks5':
      return compact({ type: 'socks', ...base, version: '5', username: p.username, password: p.password })
    case 'http':
      return compact({
        type: 'http',
        ...base,
        username: p.username,
        password: p.password,
        tls: p.tls ? tlsOf(p, { force: true, sniKey: 'sni' }) : undefined,
      })
    default:
      throw new Error(`sing-box 不支持 ${p.type}`)
  }
}

function tlsFrom(t: any, p: Proxy, sniKey = 'servername') {
  if (!t?.enabled) return
  if (sniKey === 'servername') p.tls = true
  if (t.server_name) p[sniKey] = t.server_name
  if (t.insecure) p['skip-cert-verify'] = true
  if (t.alpn) p.alpn = t.alpn
  if (t.utls?.enabled && t.utls.fingerprint) p['client-fingerprint'] = t.utls.fingerprint
  if (t.reality?.enabled) {
    p['reality-opts'] = compact({ 'public-key': t.reality.public_key, 'short-id': t.reality.short_id })
  }
}

function transportFrom(t: any, p: Proxy) {
  if (!t) return
  switch (t.type) {
    case 'ws':
      p.network = 'ws'
      p['ws-opts'] = compact({ path: t.path, headers: t.headers })
      break
    case 'httpupgrade':
      p.network = 'ws'
      p['ws-opts'] = compact({ path: t.path, headers: t.host ? { Host: t.host } : undefined, 'v2ray-http-upgrade': true })
      break
    case 'grpc':
      p.network = 'grpc'
      p['grpc-opts'] = { 'grpc-service-name': t.service_name || '' }
      break
    case 'http':
      p.network = p.tls ? 'h2' : 'http'
      if (p.tls) p['h2-opts'] = compact({ host: t.host, path: t.path })
      else p['http-opts'] = compact({ path: t.path ? [t.path] : undefined, headers: t.host ? { Host: t.host } : undefined })
      break
  }
}

/** sing-box outbound → mihomo proxy；非代理类型(selector/direct…)返回 null */
export function fromSingboxOutbound(o: any): Proxy | null {
  if (!o || !o.server || !o.type) return null
  const p: Proxy = { name: o.tag || `${o.type}-${o.server}`, type: o.type, server: o.server, port: Number(o.server_port) }
  switch (o.type) {
    case 'shadowsocks':
      Object.assign(p, { type: 'ss', cipher: o.method, password: o.password, udp: true })
      if (o.plugin === 'obfs-local') {
        const kv = Object.fromEntries(String(o.plugin_opts || '').split(';').map((s: string) => s.split('=')))
        p.plugin = 'obfs'
        p['plugin-opts'] = compact({ mode: kv.obfs, host: kv['obfs-host'] })
      }
      break
    case 'vmess':
      Object.assign(p, { uuid: o.uuid, alterId: o.alter_id || 0, cipher: o.security || 'auto', udp: true })
      tlsFrom(o.tls, p)
      transportFrom(o.transport, p)
      break
    case 'vless':
      Object.assign(p, { uuid: o.uuid, flow: o.flow, udp: true })
      tlsFrom(o.tls, p)
      transportFrom(o.transport, p)
      break
    case 'trojan':
      Object.assign(p, { password: o.password, udp: true })
      tlsFrom(o.tls, p, 'sni')
      transportFrom(o.transport, p)
      break
    case 'hysteria2':
      Object.assign(p, {
        password: o.password,
        up: o.up_mbps,
        down: o.down_mbps,
        obfs: o.obfs?.type,
        'obfs-password': o.obfs?.password,
        udp: true,
      })
      if (o.server_ports?.length) {
        p.ports = o.server_ports.map((s: string) => s.replace(':', '-')).join(',')
        if (!p.port) p.port = parseInt(o.server_ports[0], 10)
      }
      tlsFrom(o.tls, p, 'sni')
      break
    case 'tuic':
      Object.assign(p, {
        uuid: o.uuid,
        password: o.password,
        'congestion-controller': o.congestion_control,
        'udp-relay-mode': o.udp_relay_mode,
        udp: true,
      })
      tlsFrom(o.tls, p, 'sni')
      break
    case 'anytls':
      Object.assign(p, { password: o.password, udp: true })
      tlsFrom(o.tls, p, 'sni')
      break
    case 'socks':
      Object.assign(p, { type: 'socks5', username: o.username, password: o.password, udp: true })
      break
    case 'http':
      Object.assign(p, { username: o.username, password: o.password })
      if (o.tls?.enabled) p.tls = true
      break
    default:
      return null
  }
  delete p.tag
  return compact(p)
}
