// 从 Sub-Store / 妙妙屋（miaomiaowu）迁移
import { DatabaseSync } from 'node:sqlite'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Node, Proxy, Subscription } from '../../../shared/types.ts'
import { DATA_DIR, db, newProfile } from '../db.ts'
import { parseSubscription } from '../core/sub-parse.ts'
import { b64decode, uid } from '../core/util.ts'
import { DEFAULT_EXCLUDE, DEFAULT_SUB_UA, refreshSubscription } from './subscription.ts'

export interface MigrateReport {
  subscriptions: number
  nodes: number
  chains: number
  profiles: number
  skipped: string[]
}

function addSub(name: string, url: string, ua?: string): Subscription | null {
  const u = url.trim()
  if (!/^https?:\/\//.test(u)) return null
  const exist = db.data.subscriptions.find((s) => s.url === u)
  if (exist) return exist
  const s: Subscription = {
    id: uid(),
    name: name || new URL(u).hostname,
    url: u,
    userAgent: ua || DEFAULT_SUB_UA,
    intervalHours: 12,
    includeRegex: '',
    excludeRegex: DEFAULT_EXCLUDE,
    namePrefix: '',
    enabled: true,
    createdAt: Date.now(),
  }
  db.data.subscriptions.push(s)
  return s
}

function addManual(p: Proxy, name: string, tags: string[], enabled = true): Node {
  const n: Node = { id: uid(), name, proxy: { ...p, name }, source: { kind: 'manual' }, enabled, tags, createdAt: Date.now() }
  const firstOther = db.data.nodes.findIndex((x) => x.source.kind !== 'manual')
  if (firstOther < 0) db.data.nodes.push(n)
  else db.data.nodes.splice(firstOther, 0, n)
  return n
}

/** 导入后后台拉取新订阅 */
function refreshLater(subs: Subscription[]) {
  setTimeout(async () => {
    for (const s of subs) await refreshSubscription(s).catch(() => {})
  }, 100)
}

// ------------------------------------------------------------------ Sub-Store

export function importSubStore(text: string): MigrateReport {
  let data: any
  const raw = text.trim()
  try {
    data = JSON.parse(raw)
  } catch {
    try {
      data = JSON.parse(b64decode(raw))
    } catch {
      throw new Error('不是有效的 Sub-Store 备份（JSON）')
    }
  }
  if (!data || (!Array.isArray(data.subs) && !Array.isArray(data.collections))) throw new Error('备份中没有 subs / collections')
  const report: MigrateReport = { subscriptions: 0, nodes: 0, chains: 0, profiles: 0, skipped: [] }
  const created: Subscription[] = []
  // Sub-Store 订阅名 → 本项目的来源（订阅 id 或 'manual'）
  const sourceOf = new Map<string, string[]>()
  let processOps = 0

  for (const sub of data.subs || []) {
    const name = String(sub.displayName || sub.name || '')
    const sources: string[] = []
    processOps += Array.isArray(sub.process) ? sub.process.length : 0
    const remote = sub.source !== 'local' || ['localFirst', 'remoteFirst'].includes(sub.mergeSources)
    if (remote && sub.url) {
      const urls = String(sub.url).split(/[\r\n]+/).map((x: string) => x.trim().split('#')[0]).filter(Boolean)
      urls.forEach((u: string, i: number) => {
        const before = db.data.subscriptions.length
        const s = addSub(urls.length > 1 ? `${name} ${i + 1}` : name, u, sub.ua)
        if (!s) report.skipped.push(`订阅「${name}」的链接无效：${u.slice(0, 40)}`)
        else {
          sources.push(s.id)
          if (db.data.subscriptions.length > before) {
            created.push(s)
            report.subscriptions++
          }
        }
      })
    }
    if (sub.source === 'local' && sub.content) {
      const r = parseSubscription(String(sub.content))
      for (const p of r.proxies) addManual(p, p.name, [name])
      report.nodes += r.proxies.length
      if (r.proxies.length) sources.push('manual')
      if (r.errors.length) report.skipped.push(`本地订阅「${name}」有 ${r.errors.length} 条无法解析`)
    }
    sourceOf.set(String(sub.name), sources)
  }

  for (const col of data.collections || []) {
    processOps += Array.isArray(col.process) ? col.process.length : 0
    const sources = [...new Set((col.subscriptions || []).flatMap((n: string) => sourceOf.get(n) || []))] as string[]
    if (!sources.length) {
      report.skipped.push(`组合订阅「${col.displayName || col.name}」没有可用的订阅`)
      continue
    }
    const p = newProfile(String(col.displayName || col.name))
    p.nodeMode = 'sources'
    p.sources = sources
    db.data.profiles.push(p)
    report.profiles++
    if (sources.includes('manual')) report.skipped.push(`组合订阅「${p.name}」包含本地订阅，已按“全部自建节点”导入，可在输出配置里改为手动挑选`)
  }

  if (processOps) report.skipped.push(`${processOps} 个节点操作（过滤 / 重命名 / 脚本）无法迁移，可用订阅源的正则过滤与名称前缀代替`)
  for (const k of ['artifacts', 'rules', 'files', 'modules']) {
    if (Array.isArray(data[k]) && data[k].length) report.skipped.push(`${data[k].length} 个 ${k} 未迁移`)
  }
  db.save()
  refreshLater(created)
  return report
}

// ------------------------------------------------------------------ 妙妙屋

function cols(d: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((d.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name))
  } catch {
    return new Set()
  }
}

export function importMiaomiaowu(file: Buffer, opts: { includeSynced?: boolean } = {}): MigrateReport {
  if (file.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error('不是 SQLite 数据库文件（请上传妙妙屋数据目录里的 traffic.db）')
  const tmp = join(DATA_DIR, `migrate-${uid()}.db`)
  writeFileSync(tmp, file)
  const d = new DatabaseSync(tmp, { readOnly: true })
  const report: MigrateReport = { subscriptions: 0, nodes: 0, chains: 0, profiles: 0, skipped: [] }
  try {
    const nodeCols = cols(d, 'nodes')
    if (!nodeCols.has('clash_config')) throw new Error('数据库里没有妙妙屋的 nodes 表')

    // 外部订阅
    const created: Subscription[] = []
    const extNames = new Set<string>()
    if (cols(d, 'external_subscriptions').size) {
      const ec = cols(d, 'external_subscriptions')
      const rows = d.prepare(`SELECT name, url${ec.has('user_agent') ? ', user_agent' : ''} FROM external_subscriptions`).all() as any[]
      for (const r of rows) {
        extNames.add(String(r.name))
        const before = db.data.subscriptions.length
        const s = addSub(String(r.name), String(r.url), r.user_agent || undefined)
        if (s && db.data.subscriptions.length > before) {
          created.push(s)
          report.subscriptions++
        }
      }
    }

    // 节点
    const rows = d.prepare('SELECT * FROM nodes ORDER BY id').all() as any[]
    const idMap = new Map<number, Node>()
    const chainRows: { row: any; proxy: Proxy; tags: string[] }[] = []
    let synced = 0
    for (const r of rows) {
      let proxy: Proxy
      try {
        proxy = JSON.parse(r.clash_config)
      } catch {
        report.skipped.push(`节点「${r.node_name}」配置无法解析`)
        continue
      }
      if (!proxy?.type || !proxy.server) {
        report.skipped.push(`节点「${r.node_name}」缺少服务器信息`)
        continue
      }
      let tags: string[] = []
      try {
        tags = JSON.parse(r.tags || '[]')
      } catch {}
      if (!tags.length && r.tag) tags = [String(r.tag)]
      tags = tags.filter((t) => t && t !== '手动输入')
      // 从外部订阅同步来的节点由订阅源重新拉取，默认不重复导入
      if (!opts.includeSynced && tags.some((t) => extNames.has(t))) {
        synced++
        continue
      }
      const relayId = r.chain_proxy_node_id ?? (() => {
        try {
          return JSON.parse(r.relay_group_node_ids || '[]')[0]
        } catch {
          return undefined
        }
      })()
      const clean: Proxy = { ...proxy, port: Number(proxy.port) }
      delete clean['dialer-proxy']
      if (relayId) {
        chainRows.push({ row: { ...r, relayId }, proxy: clean, tags })
        continue
      }
      const n = addManual(clean, String(r.node_name || proxy.name), tags, r.enabled !== 0)
      idMap.set(Number(r.id), n)
      report.nodes++
    }
    if (synced) report.skipped.push(`${synced} 个外部订阅同步的节点未单独导入（订阅源会重新拉取）`)

    // 链式节点：妙妙屋把落地配置存在链式节点自身，这里拆成「落地节点 + 链式节点」
    for (const { row, proxy, tags } of chainRows) {
      const relay = idMap.get(Number(row.relayId))
      const name = String(row.node_name || proxy.name)
      if (!relay) {
        const n = addManual(proxy, name, tags)
        idMap.set(Number(row.id), n)
        report.nodes++
        report.skipped.push(`链式节点「${name}」的中转节点不存在，已作为普通节点导入`)
        continue
      }
      const key = (p: Proxy) => `${p.type}|${p.server}|${p.port}`
      let target = db.data.nodes.find((n) => n.source.kind === 'manual' && key(n.proxy) === key(proxy))
      if (!target) {
        target = addManual(proxy, `${name}（落地）`, tags)
        report.nodes++
      }
      const chain: Node = {
        id: uid(),
        name,
        proxy: target.proxy,
        source: { kind: 'chain', targetId: target.id, relayId: relay.id },
        enabled: true,
        tags,
        createdAt: Date.now(),
      }
      db.data.nodes.push(chain)
      idMap.set(Number(row.id), chain)
      report.chains++
      if (row.relay_group_name) report.skipped.push(`「${name}」原本使用中转组「${row.relay_group_name}」，已改为其中第一个节点`)
    }

    db.save()
    refreshLater(created)
    if (cols(d, 'subscribe_files').size) {
      const n = (d.prepare('SELECT COUNT(*) AS c FROM subscribe_files').get() as any).c
      if (n) report.skipped.push(`${n} 个订阅文件（含规则模板）未迁移，请在「订阅输出」中重新配置分流规则`)
    }
    return report
  } finally {
    d.close()
    rmSync(tmp, { force: true })
  }
}
