import { Hono } from 'hono'
import YAML from 'yaml'
import { randomBytes } from 'node:crypto'
import type { CustomRule, Node, Profile, RuleTemplate, Subscription } from '../../shared/types.ts'
import { RULE_TYPES } from '../../shared/types.ts'
import { db, newProfile } from './db.ts'
import {
  clearFailures,
  clearSession,
  clientIp,
  hashPassword,
  isAuthed,
  issueSession,
  loginBlocked,
  recordFailure,
  requireAuth,
  verifyPassword,
} from './auth.ts'
import { parseSubscription } from './core/sub-parse.ts'
import { toUri } from './core/uri-emit.ts'
import { uid } from './core/util.ts'
import { MODULES, MODULE_PRESETS } from './core/rules/modules.ts'
import { generate, policyOptions, resolveProxies, type GenContext } from './core/generate.ts'
import { DEFAULT_EXCLUDE, DEFAULT_SUB_UA, refreshSubscription, refreshTemplate } from './services/subscription.ts'
import { testNodes } from './services/latency.ts'
import { backupToS3, exportBackup, importBackup, listS3Backups, restoreFromS3 } from './services/backup.ts'
import { s3List } from './services/s3.ts'

export const api = new Hono()

export function genCtx(): GenContext {
  const d = db.data
  return { nodes: d.nodes, subscriptions: d.subscriptions, templates: d.templates, customRules: d.customRules, settings: d.settings }
}

const bad = (msg: string) => ({ error: msg })

// ------------------------------- 认证 -------------------------------

api.get('/auth/status', (c) => c.json({ setup: !!db.data.auth.passwordHash, authed: isAuthed(c) }))

api.post('/auth/setup', async (c) => {
  if (db.data.auth.passwordHash) return c.json(bad('已初始化'), 400)
  const { password } = await c.req.json()
  if (!password || String(password).length < 6) return c.json(bad('密码至少 6 位'), 400)
  db.data.auth.passwordHash = hashPassword(String(password))
  db.flush()
  issueSession(c)
  return c.json({ ok: true })
})

api.post('/auth/login', async (c) => {
  const ip = clientIp(c)
  if (loginBlocked(ip)) return c.json(bad('尝试次数过多，请 10 分钟后再试'), 429)
  const { password } = await c.req.json()
  const hash = db.data.auth.passwordHash
  if (!hash || !verifyPassword(String(password ?? ''), hash)) {
    recordFailure(ip)
    return c.json(bad('密码错误'), 401)
  }
  clearFailures(ip)
  issueSession(c)
  return c.json({ ok: true })
})

api.post('/auth/logout', (c) => {
  clearSession(c)
  return c.json({ ok: true })
})

api.use('/*', requireAuth)

api.post('/auth/password', async (c) => {
  const { oldPassword, newPassword } = await c.req.json()
  if (!verifyPassword(String(oldPassword ?? ''), db.data.auth.passwordHash!)) return c.json(bad('原密码错误'), 400)
  if (!newPassword || String(newPassword).length < 6) return c.json(bad('新密码至少 6 位'), 400)
  db.data.auth.passwordHash = hashPassword(String(newPassword))
  db.flush()
  issueSession(c)
  return c.json({ ok: true })
})

// ------------------------------- 节点 -------------------------------

function nodeView(n: Node) {
  return { ...n, uri: toUri({ ...n.proxy, name: n.name }) }
}

api.get('/nodes', (c) => c.json(db.data.nodes.map(nodeView)))

/** 粘贴导入：分享链接 / base64 / Clash YAML / sing-box JSON */
api.post('/nodes/import', async (c) => {
  const { text, tags } = await c.req.json()
  const r = parseSubscription(String(text ?? ''))
  const added: Node[] = r.proxies.map((p) => ({
    id: uid(),
    name: p.name,
    proxy: p,
    source: { kind: 'manual' },
    enabled: true,
    tags: Array.isArray(tags) ? tags : [],
    createdAt: Date.now(),
  }))
  // 自建节点放在订阅节点前面
  const firstOther = db.data.nodes.findIndex((n) => n.source.kind !== 'manual')
  if (firstOther < 0) db.data.nodes.push(...added)
  else db.data.nodes.splice(firstOther, 0, ...added)
  db.save()
  return c.json({ added: added.length, errors: r.errors, format: r.format })
})

api.post('/nodes/parse', async (c) => {
  const { text } = await c.req.json()
  return c.json(parseSubscription(String(text ?? '')))
})

api.put('/nodes/:id', async (c) => {
  const n = db.data.nodes.find((x) => x.id === c.req.param('id'))
  if (!n) return c.json(bad('节点不存在'), 404)
  const body = await c.req.json()
  if (typeof body.name === 'string' && body.name.trim()) n.name = body.name.trim()
  if (typeof body.enabled === 'boolean') n.enabled = body.enabled
  if (Array.isArray(body.tags)) n.tags = body.tags.map(String)
  if (body.proxyYaml !== undefined && n.source.kind !== 'chain') {
    try {
      const p = YAML.parse(String(body.proxyYaml))
      if (!p || typeof p !== 'object' || !p.type || !p.server || !p.port) throw new Error('缺少 type / server / port')
      n.proxy = { ...p, name: p.name || n.name, port: Number(p.port) }
    } catch (e: any) {
      return c.json(bad(`节点配置错误：${e.message}`), 400)
    }
  }
  if (n.source.kind === 'chain' && (body.relayId || body.targetId)) {
    const err = validateChain(body.targetId ?? n.source.targetId, body.relayId ?? n.source.relayId, n.id)
    if (err) return c.json(bad(err), 400)
    n.source = { kind: 'chain', targetId: body.targetId ?? n.source.targetId, relayId: body.relayId ?? n.source.relayId }
  }
  db.save()
  return c.json(nodeView(n))
})

function dependents(ids: Set<string>): Node[] {
  return db.data.nodes.filter(
    (n) => n.source.kind === 'chain' && !ids.has(n.id) && (ids.has(n.source.targetId) || ids.has(n.source.relayId)),
  )
}

api.post('/nodes/batch', async (c) => {
  const { action, ids, tags } = await c.req.json()
  const set = new Set<string>(ids || [])
  if (action === 'delete') {
    const deps = dependents(set)
    db.data.nodes = db.data.nodes.filter((n) => !set.has(n.id) || n.source.kind === 'sub')
    db.save()
    return c.json({ ok: true, brokenChains: deps.map((d) => d.name) })
  }
  for (const n of db.data.nodes) {
    if (!set.has(n.id)) continue
    if (action === 'enable') n.enabled = true
    if (action === 'disable') n.enabled = false
    if (action === 'tag' && Array.isArray(tags)) n.tags = [...new Set([...n.tags, ...tags])]
    if (action === 'untag') n.tags = []
  }
  db.save()
  return c.json({ ok: true })
})

api.post('/nodes/reorder', async (c) => {
  const { ids } = await c.req.json()
  const pos = new Map<string, number>((ids as string[]).map((id, i) => [id, i]))
  const moving = db.data.nodes.filter((n) => pos.has(n.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  let i = 0
  db.data.nodes = db.data.nodes.map((n) => (pos.has(n.id) ? moving[i++] : n))
  db.save()
  return c.json({ ok: true })
})

api.delete('/nodes/:id', (c) => {
  const id = c.req.param('id')
  const n = db.data.nodes.find((x) => x.id === id)
  if (!n) return c.json(bad('节点不存在'), 404)
  if (n.source.kind === 'sub') return c.json(bad('订阅节点请在订阅源中管理（可停用）'), 400)
  const deps = dependents(new Set([id]))
  db.data.nodes = db.data.nodes.filter((x) => x.id !== id)
  db.save()
  return c.json({ ok: true, brokenChains: deps.map((d) => d.name) })
})

function validateChain(targetId: string, relayId: string, selfId?: string): string | null {
  const byId = new Map(db.data.nodes.map((n) => [n.id, n]))
  const target = byId.get(targetId)
  const relay = byId.get(relayId)
  if (!target || !relay) return '节点不存在'
  if (targetId === relayId) return '落地节点和中转节点不能相同'
  if (target.source.kind === 'chain') return '落地节点不能是链式节点（多级链请把链式节点作为中转）'
  // 中转链上不能出现自己或落地节点
  let cur: Node | undefined = relay
  for (let i = 0; cur && i < 10; i++) {
    if (cur.id === selfId || cur.id === targetId) return '链路出现循环'
    if (cur.source.kind !== 'chain') return null
    cur = byId.get(cur.source.relayId)
  }
  return cur ? '链路层级过深' : null
}

api.post('/nodes/chain', async (c) => {
  const { targetId, relayId, name } = await c.req.json()
  const err = validateChain(targetId, relayId)
  if (err) return c.json(bad(err), 400)
  const byId = new Map(db.data.nodes.map((n) => [n.id, n]))
  const target = byId.get(targetId)!
  const relay = byId.get(relayId)!
  const node: Node = {
    id: uid(),
    name: String(name || '').trim() || `${target.name} ⇐ ${relay.name}`,
    proxy: target.proxy,
    source: { kind: 'chain', targetId, relayId },
    enabled: true,
    tags: [],
    createdAt: Date.now(),
  }
  // 放在落地节点后面
  const idx = db.data.nodes.findIndex((n) => n.id === targetId)
  const lastChain = db.data.nodes.findLastIndex((n) => n.source.kind === 'chain' && n.source.targetId === targetId)
  db.data.nodes.splice(Math.max(idx, lastChain) + 1, 0, node)
  db.save()
  return c.json(nodeView(node))
})

api.post('/nodes/test', async (c) => {
  const { ids } = await c.req.json()
  const set = new Set<string>(ids || [])
  const byId = new Map(db.data.nodes.map((n) => [n.id, n]))
  const list = db.data.nodes.filter((n) => set.size === 0 || set.has(n.id))
  const results = await testNodes(list, byId)
  db.save()
  return c.json(results)
})

// ------------------------------- 订阅源 -------------------------------

function subPatch(s: Subscription, b: any) {
  if (typeof b.name === 'string') s.name = b.name.trim() || s.name
  if (typeof b.url === 'string') s.url = b.url.trim()
  if (typeof b.userAgent === 'string') s.userAgent = b.userAgent.trim()
  if (b.intervalHours !== undefined) s.intervalHours = Math.max(0, Number(b.intervalHours) || 0)
  if (typeof b.includeRegex === 'string') s.includeRegex = b.includeRegex
  if (typeof b.excludeRegex === 'string') s.excludeRegex = b.excludeRegex
  if (typeof b.namePrefix === 'string') s.namePrefix = b.namePrefix
  if (typeof b.enabled === 'boolean') s.enabled = b.enabled
}

api.get('/subs/defaults', (c) => c.json({ userAgent: DEFAULT_SUB_UA, excludeRegex: DEFAULT_EXCLUDE }))

api.get('/subs', (c) => c.json(db.data.subscriptions))

api.post('/subs', async (c) => {
  const b = await c.req.json()
  if (!/^https?:\/\//.test(String(b.url || ''))) return c.json(bad('订阅链接无效'), 400)
  const s: Subscription = {
    id: uid(),
    name: '',
    url: '',
    userAgent: DEFAULT_SUB_UA,
    intervalHours: 12,
    includeRegex: '',
    excludeRegex: DEFAULT_EXCLUDE,
    namePrefix: '',
    enabled: true,
    createdAt: Date.now(),
  }
  subPatch(s, b)
  if (!s.name) s.name = new URL(s.url).hostname
  db.data.subscriptions.push(s)
  db.save()
  let result: any = null
  let error: string | null = null
  try {
    result = await refreshSubscription(s)
  } catch (e: any) {
    error = e.message
  }
  return c.json({ sub: s, result, error })
})

api.put('/subs/:id', async (c) => {
  const s = db.data.subscriptions.find((x) => x.id === c.req.param('id'))
  if (!s) return c.json(bad('订阅不存在'), 404)
  subPatch(s, await c.req.json())
  db.save()
  return c.json(s)
})

api.post('/subs/:id/refresh', async (c) => {
  const s = db.data.subscriptions.find((x) => x.id === c.req.param('id'))
  if (!s) return c.json(bad('订阅不存在'), 404)
  try {
    return c.json({ sub: s, result: await refreshSubscription(s) })
  } catch (e: any) {
    return c.json(bad(e.message), 502)
  }
})

api.delete('/subs/:id', (c) => {
  const id = c.req.param('id')
  const ids = new Set(db.data.nodes.filter((n) => n.source.kind === 'sub' && n.source.subId === id).map((n) => n.id))
  const deps = dependents(ids)
  db.data.subscriptions = db.data.subscriptions.filter((s) => s.id !== id)
  db.data.nodes = db.data.nodes.filter((n) => !ids.has(n.id))
  for (const p of db.data.profiles) p.sources = p.sources.filter((s) => s !== id)
  db.save()
  return c.json({ ok: true, brokenChains: deps.map((d) => d.name) })
})

// ------------------------------- 规则 -------------------------------

api.get('/rules/meta', (c) =>
  c.json({
    modules: MODULES.map(({ id, name, description, fixed, defaultPolicy, required, rules }) => ({
      id,
      name,
      description,
      fixed,
      defaultPolicy,
      required,
      sources: rules.map((r) => (r.geosite ? `geosite:${r.geosite}` : `geoip:${r.geoip}`)),
    })),
    presets: MODULE_PRESETS,
    ruleTypes: RULE_TYPES,
    policies: policyOptions(),
    templatePresets: TEMPLATE_PRESETS,
  }),
)

api.get('/rules/custom', (c) => c.json(db.data.customRules))

api.put('/rules/custom', async (c) => {
  const list = await c.req.json()
  if (!Array.isArray(list)) return c.json(bad('格式错误'), 400)
  db.data.customRules = list.map((r: any, i: number) => {
    const rule: CustomRule = {
      id: r.id || uid(),
      enabled: r.enabled !== false,
      position: r.position === 'tail' ? 'tail' : 'head',
      remark: String(r.remark || ''),
      kind: r.kind === 'ruleset' ? 'ruleset' : 'rule',
      policy: String(r.policy || '🚀 节点选择').trim(),
      order: i,
    }
    if (rule.kind === 'rule') {
      rule.type = r.type
      rule.value = String(r.value || '').trim()
      if (r.noResolve) rule.noResolve = true
    } else {
      rule.url = String(r.url || '').trim()
      rule.behavior = r.behavior || 'classical'
      rule.format = r.format || 'text'
      rule.interval = Number(r.interval) || 86400
      if (r.noResolve) rule.noResolve = true
    }
    return rule
  })
  db.save()
  return c.json(db.data.customRules)
})

// ------------------------------- 规则模板 -------------------------------

const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config'
const TEMPLATE_PRESETS = [
  { name: 'ACL4SSR 全分组（重度）', kind: 'ini', url: `${ACL}/ACL4SSR_Online_Full.ini` },
  { name: 'ACL4SSR 标准版', kind: 'ini', url: `${ACL}/ACL4SSR_Online.ini` },
  { name: 'ACL4SSR 精简版', kind: 'ini', url: `${ACL}/ACL4SSR_Online_Mini.ini` },
  { name: 'ACL4SSR 全分组 + 多地区', kind: 'ini', url: `${ACL}/ACL4SSR_Online_Full_MultiMode.ini` },
]

api.get('/templates', (c) => c.json(db.data.templates))

function detectKind(content: string): 'clash' | 'ini' {
  return /^\s*(custom_proxy_group|ruleset)\s*=/m.test(content) ? 'ini' : 'clash'
}

api.post('/templates', async (c) => {
  const b = await c.req.json()
  const t: RuleTemplate = {
    id: uid(),
    name: String(b.name || '').trim() || '未命名模板',
    kind: 'clash',
    url: b.url ? String(b.url).trim() : undefined,
    content: String(b.content || ''),
    updatedAt: Date.now(),
  }
  if (t.url) {
    db.data.templates.push(t)
    try {
      await refreshTemplate(t.id)
    } catch (e: any) {
      db.data.templates = db.data.templates.filter((x) => x.id !== t.id)
      return c.json(bad(`下载失败：${e.message}`), 400)
    }
  } else {
    db.data.templates.push(t)
  }
  t.kind = b.kind === 'ini' || b.kind === 'clash' ? b.kind : detectKind(t.content)
  const err = validateTemplate(t)
  if (err) {
    db.data.templates = db.data.templates.filter((x) => x.id !== t.id)
    return c.json(bad(err), 400)
  }
  db.save()
  return c.json(t)
})

function validateTemplate(t: RuleTemplate): string | null {
  if (t.kind === 'ini') {
    return /custom_proxy_group\s*=/.test(t.content) ? null : '没有找到 custom_proxy_group，不是有效的 ini 模板'
  }
  try {
    const y = YAML.parse(t.content, { maxAliasCount: -1 })
    if (!y || typeof y !== 'object') return 'YAML 内容为空'
    if (!Array.isArray(y['proxy-groups']) && !Array.isArray(y.rules)) return '模板中没有 proxy-groups 或 rules'
    return null
  } catch (e: any) {
    return `YAML 解析失败：${e.message}`
  }
}

api.put('/templates/:id', async (c) => {
  const t = db.data.templates.find((x) => x.id === c.req.param('id'))
  if (!t) return c.json(bad('模板不存在'), 404)
  const b = await c.req.json()
  const prev = { ...t }
  if (typeof b.name === 'string') t.name = b.name.trim() || t.name
  if (typeof b.content === 'string') t.content = b.content
  if (b.url !== undefined) t.url = String(b.url).trim() || undefined
  if (b.kind === 'ini' || b.kind === 'clash') t.kind = b.kind
  const err = validateTemplate(t)
  if (err) {
    Object.assign(t, prev)
    return c.json(bad(err), 400)
  }
  t.updatedAt = Date.now()
  db.save()
  return c.json(t)
})

api.post('/templates/:id/refresh', async (c) => {
  try {
    await refreshTemplate(c.req.param('id'))
    return c.json(db.data.templates.find((x) => x.id === c.req.param('id')))
  } catch (e: any) {
    return c.json(bad(e.message), 502)
  }
})

api.delete('/templates/:id', (c) => {
  const id = c.req.param('id')
  db.data.templates = db.data.templates.filter((t) => t.id !== id)
  for (const p of db.data.profiles) if (p.templateId === id) p.ruleMode = 'modules'
  db.save()
  return c.json({ ok: true })
})

// ------------------------------- 输出配置 -------------------------------

const PROFILE_FIELDS: (keyof Profile)[] = [
  'name',
  'nodeMode',
  'sources',
  'nodeIds',
  'includeRegex',
  'excludeRegex',
  'ruleMode',
  'modules',
  'templateId',
  'useCustomRules',
  'regionGroups',
  'groupsIncludeNodes',
  'addFlags',
  'trafficInfo',
  'overrideYaml',
]

function profilePatch(p: Profile, b: any): string | null {
  for (const k of PROFILE_FIELDS) if (b[k] !== undefined) (p as any)[k] = b[k]
  if (p.overrideYaml?.trim()) {
    try {
      YAML.parse(p.overrideYaml)
    } catch (e: any) {
      return `覆写 YAML 有误：${e.message}`
    }
  }
  return null
}

api.get('/profiles', (c) => c.json(db.data.profiles))

api.post('/profiles', async (c) => {
  const b = await c.req.json()
  const p = newProfile(String(b.name || '新配置'))
  const err = profilePatch(p, b)
  if (err) return c.json(bad(err), 400)
  db.data.profiles.push(p)
  db.save()
  return c.json(p)
})

api.put('/profiles/:id', async (c) => {
  const p = db.data.profiles.find((x) => x.id === c.req.param('id'))
  if (!p) return c.json(bad('配置不存在'), 404)
  const err = profilePatch(p, await c.req.json())
  if (err) return c.json(bad(err), 400)
  db.save()
  return c.json(p)
})

api.post('/profiles/:id/reset-token', (c) => {
  const p = db.data.profiles.find((x) => x.id === c.req.param('id'))
  if (!p) return c.json(bad('配置不存在'), 404)
  p.token = randomBytes(16).toString('hex')
  db.save()
  return c.json(p)
})

api.delete('/profiles/:id', (c) => {
  db.data.profiles = db.data.profiles.filter((p) => p.id !== c.req.param('id'))
  db.save()
  return c.json({ ok: true })
})

/** 预览：可传入未保存的配置 */
api.post('/profiles/preview', async (c) => {
  const { profile, target } = await c.req.json()
  const base = db.data.profiles.find((x) => x.id === profile?.id) || newProfile('预览')
  const p = { ...base, ...profile }
  const r = generate(genCtx(), p, target === 'singbox' || target === 'v2ray' ? target : 'clash')
  const text = target === 'v2ray' ? Buffer.from(r.text, 'base64').toString('utf8') : r.text
  const resolved = resolveProxies(genCtx(), p)
  return c.json({ text, warnings: r.warnings, nodeCount: resolved.visible.length })
})

// ------------------------------- 设置与备份 -------------------------------

function settingsView() {
  const s = db.data.settings
  return { ...s, s3: { ...s.s3, secretAccessKey: '', hasSecret: !!s.s3.secretAccessKey } }
}

api.get('/settings', (c) => c.json(settingsView()))

api.put('/settings', async (c) => {
  const b = await c.req.json()
  const s = db.data.settings
  for (const k of ['publicUrl', 'ruleMirror', 'ruleMirrorCustom', 'ruleDownloadViaProxy', 'testUrl'] as const) {
    if (b[k] !== undefined) (s as any)[k] = b[k]
  }
  s.publicUrl = s.publicUrl.trim().replace(/\/+$/, '')
  if (b.s3) {
    const { secretAccessKey, hasSecret: _h, lastBackupAt: _l, lastError: _e, ...rest } = b.s3
    Object.assign(s.s3, rest)
    if (secretAccessKey) s.s3.secretAccessKey = secretAccessKey
    s.s3.keep = Math.max(0, Number(s.s3.keep) || 0)
    s.s3.intervalHours = Math.max(0, Number(s.s3.intervalHours) || 0)
  }
  db.save()
  return c.json(settingsView())
})

api.get('/backup/export', (c) => {
  const name = `switch-backup-${new Date().toISOString().slice(0, 10)}.json`
  c.header('Content-Disposition', `attachment; filename="${name}"`)
  return c.json(exportBackup())
})

api.post('/backup/import', async (c) => {
  try {
    importBackup(await c.req.json())
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/backup/s3/test', async (c) => {
  try {
    const cfg = db.data.settings.s3
    await s3List(cfg, cfg.prefix || '')
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/backup/s3/backup', async (c) => {
  try {
    return c.json({ key: await backupToS3() })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.get('/backup/s3/list', async (c) => {
  try {
    return c.json(await listS3Backups())
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/backup/s3/restore', async (c) => {
  const { key } = await c.req.json()
  try {
    await restoreFromS3(String(key))
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})
