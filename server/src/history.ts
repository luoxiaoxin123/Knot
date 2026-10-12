// 配置历史版本：输出配置、自定义规则、规则模板、自建/链式节点每次修改后保存快照，可对比和一键恢复。
// 存在 data/history.json，与主数据分开，避免主文件膨胀。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Node, Profile, RuleTemplate } from '../../shared/types.ts'
import { DATA_DIR, db, migrate } from './db.ts'
import { deepClone, uid } from './core/util.ts'

export type HistoryKind = 'profile' | 'rules' | 'template' | 'nodes'

export interface HistoryEntry {
  id: string
  at: number
  kind: HistoryKind
  /** profile / template 的 id；rules、nodes 为空 */
  refId?: string
  /** 对象名称（输出配置名、模板名） */
  label: string
  summary: string
  /** null 表示该对象在此版本中已被删除 */
  data: any
}

const FILE = join(DATA_DIR, 'history.json')
const KEEP_PER_KEY = 50
/** 同一对象短时间内的连续修改合并为一个版本 */
const COALESCE_MS = 2 * 60_000

let entries: HistoryEntry[] = []
try {
  if (existsSync(FILE)) entries = JSON.parse(readFileSync(FILE, 'utf8')).entries || []
} catch {
  entries = []
}

let timer: NodeJS.Timeout | null = null
function persist() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ entries }))
    renameSync(tmp, FILE)
  }, 300)
}

const keyOf = (kind: HistoryKind, refId?: string) => `${kind}:${refId || ''}`

function stripNode(n: Node) {
  const { latency, latencyAt, latencyKind, check, ...rest } = n
  return rest
}

/** 读取对象当前状态（深拷贝） */
export function capture(kind: HistoryKind, refId?: string): any {
  const d = db.data
  switch (kind) {
    case 'profile': {
      const p = d.profiles.find((x) => x.id === refId)
      if (!p) return null
      const { access, ...rest } = p
      return deepClone(rest)
    }
    case 'rules':
      return deepClone(d.customRules)
    case 'template': {
      const t = d.templates.find((x) => x.id === refId)
      return t ? deepClone(t) : null
    }
    case 'nodes':
      return d.nodes.filter((n) => n.source.kind !== 'sub').map((n) => deepClone(stripNode(n)))
  }
}

function labelOf(kind: HistoryKind, data: any, fallback = ''): string {
  if (kind === 'rules') return '自定义规则'
  if (kind === 'nodes') return '自建 / 链式节点'
  return data?.name || fallback
}

/** 修改完成后调用：记录新版本（首次记录时先存一份修改前的基线） */
export function commit(kind: HistoryKind, refId: string | undefined, summary: string, before: any) {
  const key = keyOf(kind, refId)
  const after = capture(kind, refId)
  if (JSON.stringify(after) === JSON.stringify(before)) return
  const mine = entries.filter((e) => keyOf(e.kind, e.refId) === key)
  const now = Date.now()
  if (!mine.length && before !== null) {
    entries.push({ id: uid(), at: now - 1, kind, refId, label: labelOf(kind, before), summary: '修改前', data: before })
  }
  const last = mine[mine.length - 1]
  const label = labelOf(kind, after ?? before)
  if (last && now - last.at < COALESCE_MS && last.summary === summary && after !== null && last.data !== null && mine.length > 1) {
    last.data = after
    last.at = now
    last.label = label
  } else {
    entries.push({ id: uid(), at: now, kind, refId, label, summary, data: after })
  }
  // 每个对象只保留最近的版本
  const all = entries.filter((e) => keyOf(e.kind, e.refId) === key)
  if (all.length > KEEP_PER_KEY) {
    const drop = new Set(all.slice(0, all.length - KEEP_PER_KEY).map((e) => e.id))
    entries = entries.filter((e) => !drop.has(e.id))
  }
  persist()
}

export function listHistory(kind?: string, refId?: string) {
  return entries
    .filter((e) => (!kind || e.kind === kind) && (!refId || e.refId === refId))
    .slice()
    .reverse()
    .map(({ data, ...rest }) => ({ ...rest, deleted: data === null }))
}

export function getHistory(id: string) {
  const e = entries.find((x) => x.id === id)
  if (!e) return null
  return { entry: e, current: capture(e.kind, e.refId) }
}

/** 恢复到某个版本 */
export function restoreHistory(id: string): string {
  const e = entries.find((x) => x.id === id)
  if (!e) throw new Error('版本不存在')
  if (e.data === null) throw new Error('该版本是删除记录，请选择更早的版本')
  const before = capture(e.kind, e.refId)
  const d = db.data
  const data = deepClone(e.data)
  switch (e.kind) {
    case 'profile': {
      const cur = d.profiles.find((x) => x.id === e.refId)
      const restored: Profile = { ...data, access: cur?.access }
      // 访问链接保持当前值，避免恢复旧版本导致客户端链接失效
      if (cur) {
        restored.token = cur.token
        restored.shortCode = cur.shortCode
        restored.accessControl = { ...restored.accessControl, uses: cur.accessControl.uses }
        Object.assign(cur, restored)
      } else {
        if (d.profiles.some((x) => x.token === restored.token)) restored.token = uid(32)
        d.profiles.push(restored)
      }
      break
    }
    case 'rules':
      d.customRules = data
      break
    case 'template': {
      const idx = d.templates.findIndex((x) => x.id === e.refId)
      if (idx >= 0) d.templates[idx] = data as RuleTemplate
      else d.templates.push(data)
      break
    }
    case 'nodes': {
      // 保留订阅节点与测速结果，只替换自建 / 链式节点
      const old = new Map(d.nodes.map((n) => [n.id, n]))
      const restored = (data as Node[]).map((n) => {
        const o = old.get(n.id)
        return o ? { ...n, latency: o.latency, latencyAt: o.latencyAt, latencyKind: o.latencyKind, check: o.check } : n
      })
      d.nodes = [...restored, ...d.nodes.filter((n) => n.source.kind === 'sub')]
      break
    }
  }
  migrate(d)
  db.save()
  commit(e.kind, e.refId, `恢复到 ${new Date(e.at).toLocaleString('zh-CN', { hour12: false })} 的版本`, before)
  return e.label
}

// ------------------------------------------------------------------ 自动记录

interface Rule {
  method: string
  re: RegExp
  kind: HistoryKind
  summary: string
}

const RULES: Rule[] = [
  { method: 'POST', re: /^\/nodes\/import$/, kind: 'nodes', summary: '导入节点' },
  { method: 'PUT', re: /^\/nodes\/[^/]+$/, kind: 'nodes', summary: '编辑节点' },
  { method: 'POST', re: /^\/nodes\/batch$/, kind: 'nodes', summary: '批量操作节点' },
  { method: 'POST', re: /^\/nodes\/reorder$/, kind: 'nodes', summary: '调整节点顺序' },
  { method: 'DELETE', re: /^\/nodes\/[^/]+$/, kind: 'nodes', summary: '删除节点' },
  { method: 'POST', re: /^\/nodes\/chain$/, kind: 'nodes', summary: '新建链式节点' },
  { method: 'PUT', re: /^\/rules\/custom$/, kind: 'rules', summary: '修改自定义规则' },
  { method: 'POST', re: /^\/templates$/, kind: 'template', summary: '导入模板' },
  { method: 'PUT', re: /^\/templates\/([^/]+)$/, kind: 'template', summary: '编辑模板' },
  { method: 'POST', re: /^\/templates\/([^/]+)\/refresh$/, kind: 'template', summary: '从链接更新模板' },
  { method: 'DELETE', re: /^\/templates\/([^/]+)$/, kind: 'template', summary: '删除模板' },
  { method: 'POST', re: /^\/profiles$/, kind: 'profile', summary: '新建输出配置' },
  { method: 'PUT', re: /^\/profiles\/([^/]+)$/, kind: 'profile', summary: '修改输出配置' },
  { method: 'DELETE', re: /^\/profiles\/([^/]+)$/, kind: 'profile', summary: '删除输出配置' },
]

/** Hono 中间件：匹配到修改类接口时，在成功后记录版本 */
export const historyMiddleware = async (c: any, next: () => Promise<void>) => {
  const path: string = c.req.path.replace(/^\/api/, '')
  const rule = RULES.find((r) => r.method === c.req.method && r.re.test(path))
  if (!rule) return next()
  const m = path.match(rule.re)
  let refId = rule.kind === 'profile' || rule.kind === 'template' ? m?.[1] : undefined
  const before = refId || rule.kind === 'nodes' || rule.kind === 'rules' ? capture(rule.kind, refId) : null
  await next()
  if (c.res.status >= 300) return
  if (!refId && (rule.kind === 'profile' || rule.kind === 'template')) {
    // 新建：从响应里取 id
    try {
      refId = (await c.res.clone().json())?.id
    } catch {}
    if (!refId) return
  }
  commit(rule.kind, refId, rule.summary, before)
}
