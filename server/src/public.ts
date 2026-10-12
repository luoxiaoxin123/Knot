// 公开的订阅接口：/sub/<token>（输出配置）、/x/<短链>、/s/<token>（临时分享）
import { Hono, type Context } from 'hono'
import type { AccessControl, AccessLog, OutputTarget, Profile, Share } from '../../shared/types.ts'
import { db, newProfile } from './db.ts'
import { genCtx } from './ctx.ts'
import { checkAccess, clientIp, pushLog } from './access.ts'
import { generate, selectNodes } from './core/generate.ts'

export const pub = new Hono()

/** 根据 UA 判断客户端需要的格式 */
export function detectTarget(ua: string): OutputTarget {
  const u = ua.toLowerCase()
  if (/sing-box|singbox|sfa|sfi|sfm|sft/.test(u)) return 'singbox'
  if (/clash|mihomo|stash|meta|verge|flclash|nyanpasu|koala|hiddify/.test(u)) return 'clash'
  return 'v2ray'
}

function pickTarget(c: Context): OutputTarget {
  const q = (c.req.query('target') || c.req.query('t') || '').toLowerCase()
  if (q === 'clash' || q === 'mihomo') return 'clash'
  if (q === 'singbox' || q === 'sing-box') return 'singbox'
  if (q === 'v2ray' || q === 'base64') return 'v2ray'
  return detectTarget(c.req.header('user-agent') || '')
}

/** 访问控制 + 记录日志；被拒绝时返回响应 */
function guard(c: Context, key: string, ac: AccessControl, owner: { access?: AccessLog[] }, target: OutputTarget) {
  const ip = clientIp(c)
  const ua = (c.req.header('user-agent') || '').slice(0, 120)
  const denied = checkAccess(key, ac, ip)
  owner.access = pushLog(owner.access, { at: Date.now(), ip, ua, target, ...(denied ? { denied } : {}) })
  db.save()
  if (denied) return c.text(denied, denied === '请求过于频繁' ? 429 : 403)
  return null
}

function respond(c: Context, p: Profile, target: OutputTarget, trafficInfo: boolean) {
  const r = generate(genCtx(), p, target)
  c.header('Content-Type', r.contentType)
  c.header('Profile-Update-Interval', '12')
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.name)}`)
  c.header('Cache-Control', 'no-store')
  const ac = p.accessControl
  const parts: string[] = []
  if (trafficInfo) {
    // 汇总所选节点涉及的外部订阅流量
    const subIds = new Set(selectNodes(genCtx(), p).flatMap((n) => (n.source.kind === 'sub' ? [n.source.subId] : [])))
    const subs = db.data.subscriptions.filter((s) => subIds.has(s.id) && s.traffic)
    if (subs.length) {
      const sum = (k: 'upload' | 'download' | 'total') => subs.reduce((a, s) => a + (s.traffic![k] || 0), 0)
      parts.push(`upload=${sum('upload')}`, `download=${sum('download')}`, `total=${sum('total')}`)
      const expires = subs.map((s) => s.traffic!.expire).filter((x): x is number => !!x)
      if (ac.expiresAt) expires.push(Math.floor(ac.expiresAt / 1000))
      if (expires.length) parts.push(`expire=${Math.min(...expires)}`)
    }
  }
  if (!parts.length && ac.expiresAt) parts.push('upload=0', 'download=0', 'total=0', `expire=${Math.floor(ac.expiresAt / 1000)}`)
  if (parts.length) c.header('Subscription-Userinfo', parts.join('; '))
  return c.body(r.text)
}

function serveProfile(c: Context, p: Profile | undefined) {
  if (!p) return c.text('Not Found', 404)
  const target = pickTarget(c)
  const blocked = guard(c, `p:${p.id}`, p.accessControl, p, target)
  if (blocked) return blocked
  return respond(c, p, target, p.trafficInfo)
}

/** 临时分享转换为一个只包含所选节点的输出配置 */
export function shareProfile(s: Share): Profile {
  const p = newProfile(s.name || '分享')
  return {
    ...p,
    id: `share-${s.id}`,
    nodeMode: 'pick',
    nodeIds: s.nodeIds,
    modules: s.withRules ? p.modules : ['private', 'final'],
    useCustomRules: false,
    regionGroups: false,
    groupsIncludeNodes: true,
    trafficInfo: false,
    accessControl: s.accessControl,
  }
}

pub.get('/sub/:token', (c) => serveProfile(c, db.data.profiles.find((x) => x.token === c.req.param('token'))))

pub.get('/x/:code', (c) => {
  const code = c.req.param('code')
  return serveProfile(c, code ? db.data.profiles.find((x) => x.shortCode === code) : undefined)
})

pub.get('/s/:token', (c) => {
  const s = db.data.shares.find((x) => x.token === c.req.param('token'))
  if (!s) return c.text('Not Found', 404)
  const target = pickTarget(c)
  const blocked = guard(c, `s:${s.id}`, s.accessControl, s, target)
  if (blocked) return blocked
  return respond(c, shareProfile(s), target, false)
})
