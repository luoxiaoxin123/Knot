// 调用 mihomo 内核做真实延迟测试与流媒体 / AI 解锁检测：
// 临时启动一个 mihomo 进程，每个节点一个只监听本机的 mixed 入站（proxy 指定该节点），
// 延迟通过 external-controller 的 /proxies/<name>/delay 测试，解锁检测经对应入站发起 HTTP 请求。
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import YAML from 'yaml'
import { ProxyAgent, fetch as ufetch } from 'undici'
import type { Node, NodeCheck, UnlockService, UnlockStatus } from '../../../shared/types.ts'
import { DATA_DIR, db, newProfile } from '../db.ts'
import { resolveProxies } from '../core/generate.ts'
import { genCtx } from '../ctx.ts'

const CANDIDATES = ['/usr/local/bin/mihomo', '/usr/bin/mihomo', join(DATA_DIR, 'bin', 'mihomo')]

function executable(p: string) {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findCore(): string | null {
  const list = [db.data.settings.corePath, process.env.MIHOMO_PATH, ...CANDIDATES].filter((x): x is string => !!x)
  for (const dir of (process.env.PATH || '').split(':')) if (dir) list.push(join(dir, 'mihomo'))
  return list.find(executable) || null
}

export function coreVersion(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(path, ['-v'], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout.trim().split('\n')[0]))
  })
}

function freePorts(n: number): Promise<number[]> {
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<number>((resolve, reject) => {
          const s = createServer()
          s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as any).port
            s.close(() => resolve(port))
          })
          s.on('error', reject)
        }),
    ),
  )
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (queue.length) await fn(queue.shift()!)
  }))
}

let running = false

export interface CheckOptions {
  unlock: boolean
}

/** 对指定节点做内核测速（以及可选的解锁检测），结果写回节点 */
export async function checkNodes(ids: string[], opts: CheckOptions): Promise<Record<string, NodeCheck>> {
  const core = findCore()
  if (!core) throw new Error('未找到 mihomo 内核：Docker 镜像已内置；源码运行请安装 mihomo 或在设置中填写路径')
  if (running) throw new Error('已有检测任务在进行中')
  running = true
  const work = join(DATA_DIR, 'core-run')
  let proc: ChildProcess | null = null
  try {
    const profile = { ...newProfile('check'), nodeMode: 'pick' as const, nodeIds: ids, addFlags: false }
    const resolved = resolveProxies(genCtx(), profile)
    const byId = new Map(db.data.nodes.map((n) => [n.id, n]))
    const targets = ids.filter((id) => resolved.nameOf.has(id) && resolved.visible.includes(resolved.nameOf.get(id)!))
    if (!targets.length) return {}

    const [ctrl, ...ports] = await freePorts(1 + (opts.unlock ? targets.length : 0))
    const secret = randomBytes(12).toString('hex')
    const portOf = new Map(targets.map((id, i) => [id, ports[i]]))
    const config = {
      'log-level': 'warning',
      ipv6: true,
      mode: 'rule',
      'external-controller': `127.0.0.1:${ctrl}`,
      secret,
      'unified-delay': true,
      profile: { 'store-selected': false, 'store-fake-ip': false },
      proxies: resolved.proxies,
      listeners: opts.unlock
        ? targets.map((id, i) => ({ name: `in-${i}`, type: 'mixed', listen: '127.0.0.1', port: ports[i], proxy: resolved.nameOf.get(id) }))
        : [],
      rules: ['MATCH,DIRECT'],
    }
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'config.yaml'), YAML.stringify(config))
    let stderr = ''
    proc = spawn(core, ['-d', work, '-f', join(work, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout!.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
    proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)))

    const api = (path: string) =>
      fetch(`http://127.0.0.1:${ctrl}${path}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) })
    // 等待内核就绪
    const deadline = Date.now() + 10_000
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`内核启动失败：${stderr.trim().split('\n').pop() || proc.exitCode}`)
      try {
        if ((await api('/version')).ok) break
      } catch {}
      if (Date.now() > deadline) throw new Error('内核启动超时')
      await new Promise((r) => setTimeout(r, 150))
    }

    const testUrl = db.data.settings.testUrl
    const results: Record<string, NodeCheck> = {}
    await pool(targets, 16, async (id) => {
      const name = resolved.nameOf.get(id)!
      const r: NodeCheck = { at: Date.now(), delay: -1 }
      try {
        const res = await api(`/proxies/${encodeURIComponent(name)}/delay?timeout=6000&url=${encodeURIComponent(testUrl)}`)
        const j: any = await res.json()
        if (res.ok && j.delay > 0) r.delay = j.delay
        else r.error = j.message || `HTTP ${res.status}`
      } catch (e: any) {
        r.error = e.message
      }
      results[id] = r
    })

    if (opts.unlock) {
      await pool(
        targets.filter((id) => results[id].delay > 0),
        8,
        async (id) => {
          const agent = new ProxyAgent(`http://127.0.0.1:${portOf.get(id)}`)
          try {
            Object.assign(results[id], await detect(agent))
          } finally {
            await agent.close().catch(() => {})
          }
        },
      )
    }

    for (const id of targets) {
      const n = byId.get(id) as Node
      const r = results[id]
      // 只测延迟时保留上次的解锁结果
      n.check = opts.unlock ? r : { ...n.check, ...r, unlock: n.check?.unlock, ip: n.check?.ip, country: n.check?.country }
      n.latency = r.delay
      n.latencyAt = r.at
      n.latencyKind = 'real'
    }
    db.save()
    return results
  } finally {
    running = false
    if (proc && proc.exitCode === null) proc.kill('SIGKILL')
    rmSync(work, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ 解锁检测

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

type Result = { status: UnlockStatus; region?: string; note?: string }

async function get(agent: ProxyAgent, url: string, headers: Record<string, string> = {}) {
  const res = await ufetch(url, {
    dispatcher: agent,
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  })
  const text = await res.text()
  return { status: res.status, url: res.url, text, headers: Object.fromEntries(res.headers) as Record<string, string> }
}

async function safe(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn()
  } catch (e: any) {
    return { status: 'error', note: e?.name === 'TimeoutError' ? '超时' : e?.cause?.code || e?.message || '请求失败' }
  }
}

async function trace(agent: ProxyAgent, host: string) {
  const r = await get(agent, `https://${host}/cdn-cgi/trace`)
  return {
    ip: r.text.match(/^ip=(.+)$/m)?.[1],
    loc: r.text.match(/^loc=([A-Z]{2})$/m)?.[1],
  }
}

const CHECKS: Record<UnlockService, (a: ProxyAgent) => Promise<Result>> = {
  async chatgpt(a) {
    const [api, ios, t] = await Promise.all([
      get(a, 'https://api.openai.com/compliance/cookie_requirements', { authorization: 'Bearer null' }),
      get(a, 'https://ios.chat.openai.com/'),
      trace(a, 'chatgpt.com').catch(() => ({ loc: undefined })),
    ])
    const webBlocked = /unsupported_country/i.test(api.text)
    const appBlocked = /VPN/.test(ios.text)
    if (webBlocked) return { status: 'no', region: t.loc }
    if (appBlocked) return { status: 'partial', region: t.loc, note: '网页可用，App 不可用' }
    return { status: 'yes', region: t.loc }
  },
  async claude(a) {
    const [r, t] = await Promise.all([
      get(a, 'https://claude.ai/'),
      trace(a, 'claude.ai').catch(() => trace(a, 'www.cloudflare.com')).catch(() => ({ loc: undefined })),
    ])
    return judgeClaude(r, t.loc)
  },
  async gemini(a) {
    return judgeGemini(await get(a, 'https://gemini.google.com/'))
  },
  async netflix(a) {
    // 81280792: Netflix 自制剧；70143836: 非自制（绝命毒师）
    const [orig, full] = await Promise.all([get(a, 'https://www.netflix.com/title/81280792'), get(a, 'https://www.netflix.com/title/70143836')])
    const region = (full.url.match(/netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title/)?.[1] || orig.url.match(/netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\/title/)?.[1] || '').toUpperCase() || undefined
    if (full.status === 200) return { status: 'yes', region: region || 'US' }
    if (orig.status === 200) return { status: 'partial', region: region || 'US', note: '仅自制剧' }
    if (orig.status === 403 || full.status === 403) return { status: 'no', note: '被封锁' }
    return { status: 'no' }
  },
  async youtube(a) {
    const r = await get(a, 'https://www.youtube.com/premium')
    if (/www\.google\.cn/.test(r.url)) return { status: 'no', region: 'CN' }
    const region = r.text.match(/"countryCode":"([A-Z]{2})"/)?.[1] || r.text.match(/"GL":"([A-Z]{2})"/)?.[1]
    if (/Premium is not available in your country/i.test(r.text)) return { status: 'no', region }
    if (r.status !== 200) return { status: 'error', note: `HTTP ${r.status}` }
    return { status: 'yes', region }
  },
}

/** Anthropic 官方支持的国家和地区（https://www.anthropic.com/supported-countries，Claude.ai 与 API 共用） */
const CLAUDE_SUPPORTED = new Set(
  'AD AE AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BZ CA CD CF CG CH CI CL CM CO CR CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IS IT JM JO JP KE KG KH KI KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VN VU WS ZA ZM ZW'.split(' '),
)

/**
 * claude.ai 的地区限制和人机验证都由 Cloudflare 执行：
 * - 跳转到 app-unavailable-in-region → 不可用
 * - 正常打开 → 可用
 * - 被 Cloudflare 人机验证（CF 盾）拦下时看不到真实页面，改用 Cloudflare 识别的出口地区对照官方支持列表
 */
export function judgeClaude(r: { status: number; url: string; text: string; headers?: Record<string, string> }, loc?: string): Result {
  if (/unavailable-in-region/i.test(r.url)) return { status: 'no', region: loc }
  const challenged = r.headers?.['cf-mitigated'] === 'challenge' || /challenge-platform|cf_chl_|<title>Just a moment/i.test(r.text.slice(0, 50_000))
  if (!challenged && r.status < 400) return { status: 'yes', region: loc }
  const why = challenged ? '页面被 Cloudflare 人机验证拦下' : `HTTP ${r.status}`
  if (loc) return CLAUDE_SUPPORTED.has(loc) ? { status: 'yes', region: loc, note: `${why}，按出口地区判断` } : { status: 'no', region: loc, note: `${why}，按出口地区判断` }
  return { status: challenged ? 'unknown' : 'error', note: why }
}

/** Gemini 不提供服务的地区（Google 识别出的 ISO 3166 三位代码），其余地区均可用 */
const GEMINI_UNSUPPORTED = new Set(['CHN', 'HKG', 'MAC', 'RUS', 'BLR', 'CUB', 'IRN', 'PRK', 'SYR'])

/**
 * 根据 gemini.google.com 首页判断：
 * 1. `45631641,null,true` 是可用时才出现的特性标记（社区脚本通用做法），出现即可用；
 * 2. 没有标记时，看页面里 Google 对该 IP 的地区判定 `,2,1,200,"JPN"`，对照不可用地区表；
 * 3. 两者都找不到时如实返回「无法判断」，不再当成不可用。
 */
export function judgeGemini(r: { status: number; url: string; text: string }): Result {
  const host = (() => {
    try {
      return new URL(r.url).hostname
    } catch {
      return ''
    }
  })()
  if (r.status === 429 || /google\.[a-z.]+\/sorry\//.test(r.url)) return { status: 'error', note: '该 IP 被 Google 要求人机验证' }
  if (host === 'consent.google.com') return { status: 'unknown', note: 'Google 要求先同意 Cookie，无法判断' }
  if (r.status >= 400) return { status: 'error', note: `HTTP ${r.status}` }
  const region = r.text.match(/,2,1,200,"([A-Z]{3})"/)?.[1]
  const flag = r.text.includes('45631641,null,true')
  if (flag) return { status: 'yes', region }
  if (region) return GEMINI_UNSUPPORTED.has(region) ? { status: 'no', region } : { status: 'yes', region }
  return { status: 'unknown', note: `页面里没有地区信息（${host || r.url}，${r.text.length} 字节），Google 可能改了页面` }
}

async function detect(agent: ProxyAgent): Promise<Partial<NodeCheck>> {
  const [t, ...rest] = await Promise.all([
    trace(agent, 'www.cloudflare.com').catch(() => ({ ip: undefined, loc: undefined })),
    ...Object.entries(CHECKS).map(async ([k, fn]) => [k, await safe(() => fn(agent))] as const),
  ])
  return { ip: t.ip, country: t.loc, unlock: Object.fromEntries(rest) }
}
