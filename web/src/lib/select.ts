import type { Node, Profile, Subscription } from '@shared/types'

function re(src: string) {
  if (!src) return null
  try {
    return new RegExp(src, 'i')
  } catch {
    return null
  }
}

/** 与服务端 selectNodes 保持一致，用于界面上显示节点数量 */
export function selectNodes(p: Pick<Profile, 'nodeMode' | 'sources' | 'nodeIds' | 'includeRegex' | 'excludeRegex'>, nodes: Node[], subs: Subscription[]) {
  const disabledSubs = new Set(subs.filter((s) => !s.enabled).map((s) => s.id))
  const sources = new Set(p.sources)
  const picked = new Set(p.nodeIds)
  const inc = re(p.includeRegex)
  const exc = re(p.excludeRegex)
  return nodes.filter((n) => {
    if (!n.enabled) return false
    if (n.source.kind === 'sub' && disabledSubs.has(n.source.subId)) return false
    if (p.nodeMode === 'sources') {
      const key = n.source.kind === 'sub' ? n.source.subId : n.source.kind
      if (!sources.has(key)) return false
    } else if (p.nodeMode === 'pick' && !picked.has(n.id)) return false
    if (inc && !inc.test(n.name)) return false
    if (exc && exc.test(n.name)) return false
    return true
  })
}

export function countNodes(p: Profile, nodes: Node[], subs: Subscription[]) {
  return selectNodes(p, nodes, subs).length
}
