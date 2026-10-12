import type { Node, Proxy, Subscription } from '../../../shared/types.ts'
import { db } from '../db.ts'
import { parseSubscription, parseUserinfo } from '../core/sub-parse.ts'
import { safeRegex, uid } from '../core/util.ts'

export const DEFAULT_SUB_UA = 'clash.meta'
export const DEFAULT_EXCLUDE = '剩余|到期|过期|官网|套餐|重置|expire|traffic|网址|官方'

export async function httpGet(url: string, ua: string, timeoutMs = 30_000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { text: await res.text(), headers: res.headers }
}

/** 用新解析出的节点替换订阅原有节点，尽量保留 id（链式代理依赖 id） */
export function mergeSubNodes(sub: Subscription, proxies: Proxy[]) {
  const nodes = db.data.nodes
  const old = nodes.filter((n) => n.source.kind === 'sub' && n.source.subId === sub.id)
  const unusedOld = new Set(old)
  const byName = new Map<string, Node[]>()
  for (const n of old) byName.set(n.proxy.name, [...(byName.get(n.proxy.name) || []), n])
  const key = (p: Proxy) => `${p.type}|${p.server}|${p.port}`

  const fresh: Node[] = proxies.map((p) => {
    let match = byName.get(p.name)?.find((n) => unusedOld.has(n))
    if (!match) match = [...unusedOld].find((n) => key(n.proxy) === key(p))
    if (match) unusedOld.delete(match)
    return {
      id: match?.id || uid(),
      name: sub.namePrefix + p.name,
      proxy: p,
      source: { kind: 'sub', subId: sub.id },
      enabled: match?.enabled ?? true,
      tags: match?.tags ?? [],
      createdAt: match?.createdAt ?? Date.now(),
      latency: match && key(match.proxy) === key(p) ? match.latency : undefined,
      latencyAt: match && key(match.proxy) === key(p) ? match.latencyAt : undefined,
    }
  })
  const firstIdx = nodes.findIndex((n) => n.source.kind === 'sub' && n.source.subId === sub.id)
  const rest = nodes.filter((n) => !(n.source.kind === 'sub' && n.source.subId === sub.id))
  const at = firstIdx >= 0 ? nodes.slice(0, firstIdx).filter((n) => rest.includes(n)).length : rest.length
  rest.splice(at, 0, ...fresh)
  db.data.nodes = rest
}

export async function refreshSubscription(sub: Subscription): Promise<{ count: number; errors: string[] }> {
  try {
    const { text, headers } = await httpGet(sub.url, sub.userAgent || DEFAULT_SUB_UA)
    const parsed = parseSubscription(text)
    if (!parsed.proxies.length) throw new Error(parsed.errors[0] || '订阅中没有节点')
    const inc = safeRegex(sub.includeRegex)
    const exc = safeRegex(sub.excludeRegex)
    const proxies = parsed.proxies.filter((p) => (!inc || inc.test(p.name)) && (!exc || !exc.test(p.name)))
    mergeSubNodes(sub, proxies)
    sub.traffic = parseUserinfo(headers.get('subscription-userinfo')) ?? sub.traffic
    sub.nodeCount = proxies.length
    sub.updatedAt = Date.now()
    sub.lastError = undefined
    db.save()
    return { count: proxies.length, errors: parsed.errors }
  } catch (e: any) {
    sub.lastError = e?.name === 'TimeoutError' ? '请求超时' : e.message || String(e)
    sub.updatedAt = Date.now()
    db.save()
    throw new Error(sub.lastError)
  }
}

export async function refreshTemplate(id: string) {
  const t = db.data.templates.find((x) => x.id === id)
  if (!t || !t.url) return
  try {
    const { text } = await httpGet(t.url, 'switch')
    t.content = text
    t.lastError = undefined
  } catch (e: any) {
    t.lastError = e.message
    throw e
  } finally {
    t.updatedAt = Date.now()
    db.save()
  }
}
