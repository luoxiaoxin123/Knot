import { BlockList, isIP } from 'node:net'
import type { Context } from 'hono'
import type { AccessControl, AccessLog } from '../../shared/types.ts'

function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '')
}

const PRIVATE = new BlockList()
PRIVATE.addSubnet('127.0.0.0', 8)
PRIVATE.addSubnet('10.0.0.0', 8)
PRIVATE.addSubnet('172.16.0.0', 12)
PRIVATE.addSubnet('192.168.0.0', 16)
PRIVATE.addAddress('::1', 'ipv6')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')

function isPrivate(ip: string): boolean {
  const v = isIP(ip)
  return v ? PRIVATE.check(ip, v === 6 ? 'ipv6' : 'ipv4') : false
}

export type TrustProxy = 'auto' | 'none' | 'cloudflare' | 'x-real-ip'

/** TRUST_PROXY：怎样从反向代理传来的请求头里取客户端 IP */
export function trustProxy(): TrustProxy {
  const v = (process.env.TRUST_PROXY || '').trim().toLowerCase()
  if (['none', 'false', '0', 'off', 'no'].includes(v)) return 'none'
  if (v === 'cloudflare' || v === 'x-real-ip') return v
  return 'auto'
}

/**
 * 客户端 IP。只有请求来自本机 / 内网（即经过反向代理）时才读请求头，且只读代理自己写入的部分：
 * - auto（默认）：X-Forwarded-For 最右侧一项，即离本服务最近的那层代理看到的来源地址；
 *   更靠左的项和 X-Real-IP / CF-Connecting-IP 都可能是客户端自己带上的，不采信
 * - cloudflare：CF-Connecting-IP（Cloudflare 会覆盖客户端自带的值）
 * - x-real-ip：X-Real-IP（需要代理用 $remote_addr 覆盖）
 * - none：不读请求头，直接暴露端口时使用
 */
export function clientIp(c: Context): string {
  const remote = normalizeIp((c.env as any)?.incoming?.socket?.remoteAddress || '')
  const mode = trustProxy()
  if (mode !== 'none' && (!remote || isPrivate(remote))) {
    const fwd =
      mode === 'cloudflare'
        ? c.req.header('cf-connecting-ip')
        : mode === 'x-real-ip'
          ? c.req.header('x-real-ip')
          : c.req.header('x-forwarded-for')?.split(',').pop()
    const ip = normalizeIp(fwd?.trim() || '')
    if (isIP(ip)) return ip
  }
  return remote || 'unknown'
}

/** IP 是否命中白名单（支持单个 IP 与 CIDR，IPv4 / IPv6） */
export function ipAllowed(ip: string, list: string[]): boolean {
  const entries = list.map((s) => s.trim()).filter(Boolean)
  if (!entries.length) return true
  const v = isIP(ip)
  if (!v) return false
  const bl = new BlockList()
  for (const e of entries) {
    const [addr, bits] = e.split('/')
    const t = isIP(addr)
    if (!t) continue
    const type = t === 6 ? 'ipv6' : 'ipv4'
    if (bits !== undefined) bl.addSubnet(addr, Number(bits), type)
    else bl.addAddress(addr, type)
  }
  return bl.check(ip, v === 6 ? 'ipv6' : 'ipv4')
}

export function validateAllowlist(list: string[]): string | null {
  for (const e of list) {
    const s = e.trim()
    if (!s) continue
    const [addr, bits] = s.split('/')
    const t = isIP(addr)
    if (!t) return `无效的 IP：${s}`
    if (bits !== undefined) {
      const n = Number(bits)
      if (!Number.isInteger(n) || n < 0 || n > (t === 6 ? 128 : 32)) return `无效的网段：${s}`
    }
  }
  return null
}

// 频率限制：每个链接最近一小时的拉取时间（内存中，重启后清零）
const hits = new Map<string, number[]>()

/** 检查访问控制；通过时计数并返回 null，拒绝时返回原因 */
export function checkAccess(key: string, ac: AccessControl, ip: string): string | null {
  const now = Date.now()
  if (!ac.enabled) return '链接已停用'
  if (ac.expiresAt && now > ac.expiresAt) return '链接已过期'
  if (ac.maxUses && ac.uses >= ac.maxUses) return '已达到使用次数上限'
  if (!ipAllowed(ip, ac.ipAllowlist)) return `IP ${ip} 不在白名单中`
  if (ac.rateLimitPerHour) {
    const list = (hits.get(key) || []).filter((t) => now - t < 3600_000)
    if (list.length >= ac.rateLimitPerHour) {
      hits.set(key, list)
      return '请求过于频繁'
    }
    list.push(now)
    hits.set(key, list)
  }
  ac.uses++
  return null
}

export function pushLog(logs: AccessLog[] | undefined, entry: AccessLog): AccessLog[] {
  return [entry, ...(logs || [])].slice(0, 30)
}
