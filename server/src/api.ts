import { Hono } from 'hono'
import YAML from 'yaml'
import { randomBytes } from 'node:crypto'
import type { AccessControl, CustomGroup, CustomRule, Node, Profile, RuleTemplate, Share, Subscription } from '../../shared/types.ts'
import { RULE_TYPES } from '../../shared/types.ts'
import { parseRuleLines } from '../../shared/rules-yaml.ts'
import { db, defaultAccess, newProfile } from './db.ts'
import {
  checkSetupToken,
  clearFailures,
  clearSession,
  consumeSetupToken,
  hashPassword,
  isAuthed,
  issueSession,
  loginBlocked,
  recordFailure,
  requireAuth,
  revokeOtherSessions,
  verifyPassword,
} from './auth.ts'
import { clientIp, validateAllowlist } from './access.ts'
import { clearLogs, logReq, logStats, queryLogs } from './logs.ts'
import { capture, commit, getHistory, historyMiddleware, listHistory, restoreHistory } from './history.ts'
import { importMiaomiaowu, importSubStore } from './services/migrate.ts'
import {
  checkSecondFactor,
  confirmTotpSetup,
  disableTotp,
  hasPasskeyFor,
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  passkeys,
  startTotpSetup,
  totpEnabled,
} from './twofa.ts'
import { parseSubscription } from './core/sub-parse.ts'
import { toUri } from './core/uri-emit.ts'
import { YAML_MAX_ALIAS, uid } from './core/util.ts'
import { MODULES, MODULE_PRESETS } from './core/rules/modules.ts'
import { draftCustomGroups, generate, policyOptions, resolveProxies } from './core/generate.ts'
import { genCtx } from './ctx.ts'
import { checkNodes, coreVersion, findCore } from './services/core.ts'
import { DEFAULT_EXCLUDE, DEFAULT_SUB_UA, refreshSubscription, refreshTemplate } from './services/subscription.ts'
import { testNodes } from './services/latency.ts'
import { backupToS3, exportBackup, importBackup, listS3Backups, restoreFromS3 } from './services/backup.ts'
import { s3List } from './services/s3.ts'

export const api = new Hono()


const bad = (msg: string) => ({ error: msg })

// ------------------------------- 认证 -------------------------------

const VERSION = process.env.KNOT_VERSION || 'dev'

api.get('/auth/status', (c) =>
  c.json({ setup: !!db.data.auth.passwordHash, authed: isAuthed(c), passkey: hasPasskeyFor(c), version: VERSION }),
)

api.post('/auth/setup', async (c) => {
  if (db.data.auth.passwordHash) return c.json(bad('已初始化'), 400)
  const ip = clientIp(c)
  if (loginBlocked(ip)) return c.json(bad('尝试次数过多，请 10 分钟后再试'), 429)
  const { password, token } = await c.req.json()
  if (!checkSetupToken(token)) {
    recordFailure(ip)
    logReq(c, 'login', 'setup', false, { detail: '初始化令牌错误' })
    return c.json(bad('初始化令牌错误，请在服务器日志中查看'), 403)
  }
  if (!password || String(password).length < 6) return c.json(bad('密码至少 6 位'), 400)
  db.data.auth.passwordHash = hashPassword(String(password))
  consumeSetupToken()
  db.flush()
  issueSession(c)
  logReq(c, 'login', 'setup', true, { detail: '初始化管理员密码' })
  return c.json({ ok: true })
})

api.post('/auth/login', async (c) => {
  const ip = clientIp(c)
  if (loginBlocked(ip)) {
    logReq(c, 'login', 'password', false, { detail: '尝试次数过多，已被临时封禁' })
    return c.json(bad('尝试次数过多，请 10 分钟后再试'), 429)
  }
  const { password, code } = await c.req.json()
  const hash = db.data.auth.passwordHash
  if (!hash || !verifyPassword(String(password ?? ''), hash)) {
    recordFailure(ip)
    logReq(c, 'login', 'password', false, { detail: '密码错误' })
    return c.json(bad('密码错误'), 401)
  }
  let detail = '密码'
  if (totpEnabled()) {
    // 密码正确，等待输入两步验证码
    if (!code) return c.json({ need2fa: true })
    const r = checkSecondFactor(String(code))
    if (!r.ok) {
      recordFailure(ip)
      logReq(c, 'login', 'totp', false, { detail: '密码正确，但两步验证码错误' })
      return c.json(bad('验证码错误'), 401)
    }
    detail = r.usedRecovery ? `密码 + 恢复码（剩余 ${db.data.auth.totp?.recoveryHashes.length ?? 0} 个）` : '密码 + 两步验证'
  }
  clearFailures(ip)
  issueSession(c)
  logReq(c, 'login', 'password', true, { detail })
  return c.json({ ok: true })
})

api.post('/auth/passkey/login-options', async (c) => {
  if (loginBlocked(clientIp(c))) return c.json(bad('尝试次数过多，请 10 分钟后再试'), 429)
  try {
    return c.json(await passkeyLoginOptions(c))
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/auth/passkey/login', async (c) => {
  const ip = clientIp(c)
  if (loginBlocked(ip)) return c.json(bad('尝试次数过多，请 10 分钟后再试'), 429)
  const { challengeId, response } = await c.req.json()
  try {
    const pk = await passkeyLoginVerify(c, String(challengeId), response)
    clearFailures(ip)
    issueSession(c)
    logReq(c, 'login', 'passkey', true, { detail: `通行密钥：${pk.name}` })
    return c.json({ ok: true })
  } catch (e: any) {
    recordFailure(ip)
    logReq(c, 'login', 'passkey', false, { detail: e.message })
    return c.json(bad(e.message), 401)
  }
})

api.post('/auth/logout', (c) => {
  if (isAuthed(c)) logReq(c, 'login', 'logout', true)
  clearSession(c)
  return c.json({ ok: true })
})

api.use('/*', requireAuth)
api.use('/*', historyMiddleware)

api.post('/auth/password', async (c) => {
  const { oldPassword, newPassword } = await c.req.json()
  if (!verifyPassword(String(oldPassword ?? ''), db.data.auth.passwordHash!)) {
    logReq(c, 'admin', 'password_change', false, { detail: '原密码错误' })
    return c.json(bad('原密码错误'), 400)
  }
  if (!newPassword || String(newPassword).length < 6) return c.json(bad('新密码至少 6 位'), 400)
  db.data.auth.passwordHash = hashPassword(String(newPassword))
  db.flush()
  revokeOtherSessions(c)
  logReq(c, 'admin', 'password_change', true, { detail: '修改了管理密码' })
  return c.json({ ok: true })
})

// ------------------------------- 账户安全 -------------------------------

api.get('/auth/security', (c) =>
  c.json({
    totp: totpEnabled(),
    recoveryLeft: db.data.auth.totp?.recoveryHashes.length ?? 0,
    passkeys: passkeys().map(({ id, name, rpID, createdAt, lastUsedAt }) => ({ id, name, rpID, createdAt, lastUsedAt })),
  }),
)

api.post('/auth/totp/setup', (c) => {
  if (totpEnabled()) return c.json(bad('两步验证已开启'), 400)
  return c.json(startTotpSetup())
})

api.post('/auth/totp/enable', async (c) => {
  const { code } = await c.req.json()
  const codes = confirmTotpSetup(String(code || ''))
  if (!codes) return c.json(bad('验证码错误或已过期'), 400)
  revokeOtherSessions(c)
  logReq(c, 'admin', 'totp_enable', true, { detail: '开启了两步验证' })
  return c.json({ recoveryCodes: codes })
})

api.post('/auth/totp/disable', async (c) => {
  const { password, code } = await c.req.json()
  if (!verifyPassword(String(password ?? ''), db.data.auth.passwordHash!) || !checkSecondFactor(String(code || '')).ok) {
    logReq(c, 'admin', 'totp_disable', false, { detail: '密码或验证码错误' })
    return c.json(bad('密码或验证码错误'), 400)
  }
  disableTotp()
  revokeOtherSessions(c)
  logReq(c, 'admin', 'totp_disable', true, { detail: '关闭了两步验证' })
  return c.json({ ok: true })
})

api.post('/auth/passkey/register-options', async (c) => {
  try {
    return c.json(await passkeyRegisterOptions(c))
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/auth/passkey/register', async (c) => {
  const { challengeId, response, name } = await c.req.json()
  try {
    const pk = await passkeyRegisterVerify(c, String(challengeId), response, String(name || ''))
    logReq(c, 'admin', 'passkey_add', true, { detail: `添加通行密钥：${pk.name}` })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.delete('/auth/passkey/:id', (c) => {
  const id = c.req.param('id')
  const pk = passkeys().find((p) => p.id === id)
  if (!pk) return c.json(bad('不存在'), 404)
  db.data.auth.passkeys = passkeys().filter((p) => p.id !== id)
  db.flush()
  revokeOtherSessions(c)
  logReq(c, 'admin', 'passkey_remove', true, { detail: `删除通行密钥：${pk.name}` })
  return c.json({ ok: true })
})

// ------------------------------- 节点 -------------------------------

function nodeView(n: Node) {
  return { ...n, uri: toUri({ ...n.proxy, name: n.name }) }
}

api.get('/nodes', (c) => c.json(db.data.nodes.map(nodeView)))

/** 粘贴导入：分享链接 / base64 / Clash YAML / sing-box JSON */
api.post('/nodes/import', async (c) => {
  const { text, tags, group } = await c.req.json()
  const r = parseSubscription(String(text ?? ''))
  const g = groupName(group)
  const added: Node[] = r.proxies.map((p) => ({
    id: uid(),
    name: p.name,
    proxy: p,
    source: { kind: 'manual' },
    ...(g !== DEFAULT_GROUP ? { group: g } : {}),
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
  if (body.flag !== undefined) setFlag(n, body.flag)
  if (body.group !== undefined && n.source.kind === 'manual') setGroup(n, body.group)
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

const DEFAULT_GROUP = 'default'
function groupName(v: unknown) {
  return String(v ?? '').trim().slice(0, 40) || DEFAULT_GROUP
}
function setGroup(n: Node, v: unknown) {
  const g = groupName(v)
  if (g === DEFAULT_GROUP) delete n.group
  else n.group = g
}

/** 重命名自建节点分组（改名为已有分组 = 合并） */
api.post('/nodes/groups/rename', async (c) => {
  const { from, to } = await c.req.json()
  const a = groupName(from)
  const b = String(to ?? '').trim().slice(0, 40)
  if (!b) return c.json(bad('分组名不能为空'), 400)
  let count = 0
  for (const n of db.data.nodes) {
    if (n.source.kind !== 'manual' || groupName(n.group) !== a) continue
    setGroup(n, b)
    count++
  }
  db.save()
  return c.json({ ok: true, count })
})

/** 旗帜只接受两位地区代码，空值表示清除 */
function setFlag(n: Node, flag: unknown) {
  const code = String(flag || '').trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(code)) n.flag = code
  else delete n.flag
}

function dependents(ids: Set<string>): Node[] {
  return db.data.nodes.filter(
    (n) => n.source.kind === 'chain' && !ids.has(n.id) && (ids.has(n.source.targetId) || ids.has(n.source.relayId)),
  )
}

api.post('/nodes/batch', async (c) => {
  const { action, ids, tags, flag, group } = await c.req.json()
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
    if (action === 'flag') setFlag(n, flag)
    if (action === 'group' && n.source.kind === 'manual') setGroup(n, group)
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

api.get('/core/status', async (c) => {
  const path = findCore()
  return c.json({ available: !!path, path, version: path ? await coreVersion(path) : '' })
})

/** 内核真实延迟测试；unlock=true 时同时检测出口 IP 与 AI / 流媒体解锁 */
api.post('/nodes/check', async (c) => {
  const { ids, unlock } = await c.req.json()
  const list: string[] = Array.isArray(ids) && ids.length ? ids : db.data.nodes.filter((n) => n.enabled).map((n) => n.id)
  try {
    return c.json(await checkNodes(list, { unlock: !!unlock }))
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
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
  const errors: string[] = []
  const next = list.map((r: any, i: number) => {
    const kind: CustomRule['kind'] = r.kind === 'ruleset' || r.kind === 'set' ? r.kind : 'rule'
    const rule: CustomRule = {
      id: r.id || uid(),
      enabled: r.enabled !== false,
      position: r.position === 'tail' ? 'tail' : 'head',
      remark: String(r.remark || ''),
      kind,
      policy: String(r.policy || (kind === 'set' ? '' : '🚀 节点选择')).trim(),
      order: i,
    }
    if (kind === 'set') {
      rule.rules = String(r.rules || '')
      if (!rule.remark.trim()) errors.push('规则集需要填写名称')
      const parsed = parseRuleLines(rule.rules, rule.policy)
      if (parsed.errors.length) errors.push(`规则集「${rule.remark}」：${parsed.errors[0]}`)
      else if (!parsed.rules.length) errors.push(`规则集「${rule.remark}」没有任何规则`)
    } else if (kind === 'rule') {
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
  if (errors.length) return c.json(bad(errors[0]), 400)
  db.data.customRules = next
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
    const y = YAML.parse(t.content, { maxAliasCount: YAML_MAX_ALIAS })
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
  'groupMode',
  'knownNodeIds',
]

/** 校验并写入访问控制设置 */
function patchAccess(ac: AccessControl, b: any): string | null {
  if (!b || typeof b !== 'object') return null
  if (b.ipAllowlist !== undefined) {
    const list = (Array.isArray(b.ipAllowlist) ? b.ipAllowlist : String(b.ipAllowlist).split(/[\s,，]+/))
      .map((x: any) => String(x).trim())
      .filter(Boolean)
    const err = validateAllowlist(list)
    if (err) return err
    ac.ipAllowlist = list
  }
  if (typeof b.enabled === 'boolean') ac.enabled = b.enabled
  for (const k of ['expiresAt', 'maxUses', 'rateLimitPerHour'] as const) {
    if (b[k] !== undefined) ac[k] = Math.max(0, Math.floor(Number(b[k]) || 0))
  }
  // 计数只允许清零，避免编辑期间客户端拉取导致的计数被旧值覆盖
  if (b.uses === 0) ac.uses = 0
  return null
}

function sanitizeGroups(list: any): CustomGroup[] | string {
  if (!Array.isArray(list)) return '分组格式错误'
  const names = new Set<string>()
  const out: CustomGroup[] = []
  for (const g of list) {
    const name = String(g?.name || '').trim()
    if (!name) return '分组名不能为空'
    if (names.has(name)) return `分组名重复：${name}`
    if (['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL'].includes(name)) return `分组名不能是 ${name}`
    names.add(name)
    out.push({
      id: String(g.id || uid()),
      name,
      type: ['select', 'url-test', 'fallback', 'load-balance'].includes(g.type) ? g.type : 'select',
      members: Array.isArray(g.members) ? [...new Set<string>(g.members.map(String))] : [],
      autoNew: !!g.autoNew,
      filter: String(g.filter || ''),
      origin: g.origin ? String(g.origin) : undefined,
    })
  }
  // 检查分组之间的循环引用
  const byName = new Map(out.map((g) => [g.name, g]))
  const visit = (g: CustomGroup, stack: string[]): string | null => {
    if (stack.includes(g.name)) return `分组循环引用：${[...stack, g.name].join(' → ')}`
    for (const m of g.members) {
      const child = byName.get(m)
      if (child) {
        const e = visit(child, [...stack, g.name])
        if (e) return e
      }
    }
    return null
  }
  for (const g of out) {
    const e = visit(g, [])
    if (e) return e
  }
  return out
}

function profilePatch(p: Profile, b: any): string | null {
  for (const k of PROFILE_FIELDS) if (b[k] !== undefined) (p as any)[k] = b[k]
  if (b.customGroups !== undefined) {
    const g = sanitizeGroups(b.customGroups)
    if (typeof g === 'string') return g
    p.customGroups = g
  }
  const err = patchAccess(p.accessControl, b.accessControl)
  if (err) return err
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
  logReq(c, 'admin', 'token_reset', true, { detail: `重置订阅链接：${p.name}` })
  return c.json(p)
})

// 短链：/x/<code>
const SHORT_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function randomCode(len = 8) {
  const bytes = randomBytes(len)
  return Array.from(bytes, (b) => SHORT_ALPHABET[b % SHORT_ALPHABET.length]).join('')
}

api.post('/profiles/:id/short', async (c) => {
  const p = db.data.profiles.find((x) => x.id === c.req.param('id'))
  if (!p) return c.json(bad('配置不存在'), 404)
  const { code } = await c.req.json().catch(() => ({}))
  let next: string
  if (code) {
    next = String(code).trim()
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(next)) return c.json(bad('短链只能包含字母、数字、- 和 _，长度 4-32'), 400)
    if (db.data.profiles.some((x) => x.id !== p.id && x.shortCode === next)) return c.json(bad('该短链已被占用'), 400)
  } else {
    do next = randomCode()
    while (db.data.profiles.some((x) => x.shortCode === next))
  }
  p.shortCode = next
  db.save()
  return c.json(p)
})

api.delete('/profiles/:id/short', (c) => {
  const p = db.data.profiles.find((x) => x.id === c.req.param('id'))
  if (!p) return c.json(bad('配置不存在'), 404)
  p.shortCode = undefined
  db.save()
  return c.json(p)
})

api.delete('/profiles/:id', (c) => {
  db.data.profiles = db.data.profiles.filter((p) => p.id !== c.req.param('id'))
  db.save()
  return c.json({ ok: true })
})

/** 拖拽编辑器：自动生成的分组（作为初始数据）与可用节点 */
api.post('/profiles/groups-draft', async (c) => {
  const { profile } = await c.req.json()
  const base = db.data.profiles.find((x) => x.id === profile?.id) || newProfile('预览')
  const p: Profile = { ...base, ...profile }
  const ctx = genCtx()
  const resolved = resolveProxies(ctx, p)
  const byId = new Map(db.data.nodes.map((n) => [n.id, n]))
  const idOf = new Map([...resolved.nameOf].map(([id, name]) => [name, id]))
  const nodes = resolved.visible.map((name) => {
    const n = byId.get(idOf.get(name)!)!
    const target = n.source.kind === 'chain' ? byId.get(n.source.targetId) : n
    return { id: n.id, name, type: target?.proxy.type || n.proxy.type, source: n.source }
  })
  return c.json({ draft: draftCustomGroups(ctx, p), nodes })
})

/** 预览：可传入未保存的配置 */
api.post('/profiles/preview', async (c) => {
  const { profile, target } = await c.req.json()
  const base = db.data.profiles.find((x) => x.id === profile?.id) || newProfile('预览')
  const p = { ...base, ...profile }
  const r = generate(genCtx(), p, ['clash', 'stash', 'singbox', 'surge', 'loon', 'qx', 'v2ray'].includes(target) ? target : 'clash')
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
  if (b.logRetentionDays !== undefined) s.logRetentionDays = Math.min(3650, Math.max(1, Number(b.logRetentionDays) || 90))
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
  logReq(c, 'admin', 'backup_export', true, { detail: '下载了备份文件' })
  const name = `knot-backup-${new Date().toISOString().slice(0, 10)}.json`
  c.header('Content-Disposition', `attachment; filename="${name}"`)
  return c.json(exportBackup())
})

api.post('/backup/import', async (c) => {
  try {
    importBackup(await c.req.json())
    logReq(c, 'admin', 'backup_restore', true, { detail: '从本地文件恢复备份' })
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
    logReq(c, 'admin', 'backup_restore', true, { detail: `从 S3 恢复：${key}` })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

// ------------------------------- 临时分享 -------------------------------

api.get('/shares', (c) => c.json(db.data.shares))

api.post('/shares', async (c) => {
  const b = await c.req.json()
  const ids = new Set(db.data.nodes.map((n) => n.id))
  const nodeIds = (Array.isArray(b.nodeIds) ? b.nodeIds : []).filter((id: string) => ids.has(id))
  if (!nodeIds.length) return c.json(bad('请选择要分享的节点'), 400)
  const s: Share = {
    id: uid(),
    name: String(b.name || '').trim() || '临时分享',
    token: randomBytes(16).toString('hex'),
    nodeIds,
    withRules: b.withRules !== false,
    accessControl: defaultAccess(),
    createdAt: Date.now(),
  }
  const err = patchAccess(s.accessControl, b.accessControl)
  if (err) return c.json(bad(err), 400)
  db.data.shares.unshift(s)
  db.save()
  return c.json(s)
})

api.put('/shares/:id', async (c) => {
  const s = db.data.shares.find((x) => x.id === c.req.param('id'))
  if (!s) return c.json(bad('分享不存在'), 404)
  const b = await c.req.json()
  if (typeof b.name === 'string') s.name = b.name.trim() || s.name
  if (typeof b.withRules === 'boolean') s.withRules = b.withRules
  const err = patchAccess(s.accessControl, b.accessControl)
  if (err) return c.json(bad(err), 400)
  db.save()
  return c.json(s)
})

api.delete('/shares/:id', (c) => {
  db.data.shares = db.data.shares.filter((s) => s.id !== c.req.param('id'))
  db.save()
  return c.json({ ok: true })
})

// ------------------------------- 日志 -------------------------------

api.get('/logs', (c) =>
  c.json(
    queryLogs({
      type: c.req.query('type'),
      ok: c.req.query('ok'),
      q: c.req.query('q'),
      before: Number(c.req.query('before')) || undefined,
      limit: Number(c.req.query('limit')) || undefined,
    }),
  ),
)

api.get('/logs/stats', (c) => c.json(logStats()))

api.delete('/logs', (c) => {
  clearLogs(c.req.query('type'))
  logReq(c, 'admin', 'logs_clear', true, { detail: `清空日志：${c.req.query('type') || '全部'}` })
  return c.json({ ok: true })
})

// ------------------------------- 历史版本 -------------------------------

api.get('/history', (c) => c.json(listHistory(c.req.query('kind'), c.req.query('refId'))))

api.get('/history/:id', (c) => {
  const r = getHistory(c.req.param('id'))
  if (!r) return c.json(bad('版本不存在'), 404)
  return c.json(r)
})

api.post('/history/:id/restore', (c) => {
  try {
    const label = restoreHistory(c.req.param('id'))
    logReq(c, 'admin', 'history_restore', true, { detail: `恢复历史版本：${label}` })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

// ------------------------------- 迁移 -------------------------------

api.post('/migrate/substore', async (c) => {
  const before = capture('nodes')
  try {
    const report = importSubStore(await c.req.text())
    commit('nodes', undefined, '从 Sub-Store 迁移', before)
    logReq(c, 'admin', 'migration', true, { detail: `Sub-Store：${report.subscriptions} 个订阅、${report.nodes} 个节点、${report.profiles} 个输出配置` })
    return c.json(report)
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})

api.post('/migrate/miaomiaowu', async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.length > 200 * 1024 * 1024) return c.json(bad('文件过大'), 400)
  const before = capture('nodes')
  try {
    const report = await importMiaomiaowu(buf, { includeSynced: c.req.query('includeSynced') === '1' })
    commit('nodes', undefined, '从妙妙屋迁移', before)
    logReq(c, 'admin', 'migration', true, { detail: `妙妙屋：${report.subscriptions} 个订阅、${report.nodes} 个节点、${report.chains} 个链式节点` })
    return c.json(report)
  } catch (e: any) {
    return c.json(bad(e.message), 400)
  }
})
