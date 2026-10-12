// 审计日志：订阅拉取、面板登录、敏感操作。追加写入 data/logs.jsonl，内存保留最近的记录用于查询。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import type { LogEntry, LogType } from '../../shared/types.ts'
import { DATA_DIR, db } from './db.ts'
import { clientIp } from './access.ts'
import { uid } from './core/util.ts'

const FILE = join(DATA_DIR, 'logs.jsonl')
const MAX_MEMORY = 20_000
let entries: LogEntry[] = []

function retentionCutoff() {
  const days = db.data.settings.logRetentionDays || 90
  return Date.now() - days * 86400_000
}

function load() {
  if (!existsSync(FILE)) return
  const cutoff = retentionCutoff()
  const lines = readFileSync(FILE, 'utf8').split('\n')
  const out: LogEntry[] = []
  for (const l of lines) {
    if (!l) continue
    try {
      const e = JSON.parse(l)
      if (e.at >= cutoff) out.push(e)
    } catch {}
  }
  entries = out.slice(-MAX_MEMORY)
  // 过期或超量时重写文件
  if (entries.length < lines.length - 1) rewrite()
}

function rewrite() {
  const tmp = FILE + '.tmp'
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  renameSync(tmp, FILE)
}

load()

export function addLog(e: Omit<LogEntry, 'id' | 'at'>) {
  const entry: LogEntry = { id: uid(10), at: Date.now(), ...e }
  if (entry.ua) entry.ua = entry.ua.slice(0, 200)
  entries.push(entry)
  if (entries.length > MAX_MEMORY * 1.1) {
    entries = entries.slice(-MAX_MEMORY)
    rewrite()
  } else {
    try {
      appendFileSync(FILE, JSON.stringify(entry) + '\n')
    } catch (err) {
      console.warn('[日志] 写入失败', err)
    }
  }
  return entry
}

/** 从请求中取 IP / UA 写日志 */
export function logReq(c: Context, type: LogType, action: string, ok: boolean, extra: { target?: string; detail?: string } = {}) {
  return addLog({ type, action, ok, ip: clientIp(c), ua: c.req.header('user-agent') || '', ...extra })
}

export interface LogQuery {
  type?: string
  ok?: string
  q?: string
  before?: number
  limit?: number
}

export function queryLogs(q: LogQuery) {
  const kw = (q.q || '').trim().toLowerCase()
  const limit = Math.min(Math.max(q.limit || 100, 1), 500)
  const items: LogEntry[] = []
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (q.type && q.type !== 'all' && e.type !== q.type) continue
    if (q.ok === 'true' && !e.ok) continue
    if (q.ok === 'false' && e.ok) continue
    if (kw && ![e.ip, e.ua, e.detail, e.target, e.action].some((x) => x?.toLowerCase().includes(kw))) continue
    total++
    if (q.before && e.at >= q.before) continue
    if (items.length < limit) items.push(e)
  }
  return { items, total }
}

export function logStats() {
  const since = Date.now() - 86400_000
  const recent = entries.filter((e) => e.at >= since)
  const subs = recent.filter((e) => e.type === 'sub')
  const logins = recent.filter((e) => e.type === 'login' && e.action !== 'logout')
  const failedIps = new Map<string, number>()
  for (const e of logins) if (!e.ok) failedIps.set(e.ip, (failedIps.get(e.ip) || 0) + 1)
  return {
    subPulls: subs.filter((e) => e.ok).length,
    subDenied: subs.filter((e) => !e.ok).length,
    subIps: new Set(subs.map((e) => e.ip)).size,
    loginOk: logins.filter((e) => e.ok).length,
    loginFailed: logins.filter((e) => !e.ok).length,
    topFailedIps: [...failedIps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  }
}

export function clearLogs(type?: string) {
  entries = type && type !== 'all' ? entries.filter((e) => e.type !== type) : []
  rewrite()
}

/** 定期清理过期日志 */
export function pruneLogs() {
  const cutoff = retentionCutoff()
  if (entries.length && entries[0].at < cutoff) {
    entries = entries.filter((e) => e.at >= cutoff)
    rewrite()
  }
}
