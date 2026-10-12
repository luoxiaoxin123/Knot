import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { OutputTarget } from '../../shared/types.ts'
import { db } from './db.ts'
import { api, genCtx } from './api.ts'
import { clientIp, initAuthFromEnv } from './auth.ts'
import { generate, selectNodes } from './core/generate.ts'
import { startScheduler } from './scheduler.ts'

initAuthFromEnv()

const app = new Hono()

app.route('/api', api)

/** 根据 UA 判断客户端需要的格式 */
export function detectTarget(ua: string): OutputTarget {
  const u = ua.toLowerCase()
  if (/sing-box|singbox|sfa|sfi|sfm|sft/.test(u)) return 'singbox'
  if (/clash|mihomo|stash|meta|verge|flclash|nyanpasu|koala|hiddify/.test(u)) return 'clash'
  return 'v2ray'
}

app.get('/sub/:token', (c) => {
  const p = db.data.profiles.find((x) => x.token === c.req.param('token'))
  if (!p) return c.text('Not Found', 404)
  const q = (c.req.query('target') || '').toLowerCase()
  const ua = c.req.header('user-agent') || ''
  const target: OutputTarget =
    q === 'clash' || q === 'mihomo' ? 'clash' : q === 'singbox' || q === 'sing-box' ? 'singbox' : q === 'v2ray' || q === 'base64' ? 'v2ray' : detectTarget(ua)

  const r = generate(genCtx(), p, target)
  p.access = [{ at: Date.now(), ip: clientIp(c), ua: ua.slice(0, 120), target }, ...(p.access || [])].slice(0, 20)
  db.save()

  c.header('Content-Type', r.contentType)
  c.header('Profile-Update-Interval', '12')
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.name)}`)
  c.header('Cache-Control', 'no-store')
  if (p.trafficInfo) {
    // 汇总所选节点涉及的外部订阅流量
    const subIds = new Set(selectNodes(genCtx(), p).flatMap((n) => (n.source.kind === 'sub' ? [n.source.subId] : [])))
    const subs = db.data.subscriptions.filter((s) => subIds.has(s.id) && s.traffic)
    if (subs.length) {
      const sum = (k: 'upload' | 'download' | 'total') => subs.reduce((a, s) => a + (s.traffic![k] || 0), 0)
      const expires = subs.map((s) => s.traffic!.expire).filter((x): x is number => !!x)
      const parts = [`upload=${sum('upload')}`, `download=${sum('download')}`, `total=${sum('total')}`]
      if (expires.length) parts.push(`expire=${Math.min(...expires)}`)
      c.header('Subscription-Userinfo', parts.join('; '))
    }
  }
  return c.body(r.text)
})

app.get('/healthz', (c) => c.text('ok'))

// 前端静态文件
const WEB_DIR = resolve(process.env.WEB_DIR || join(import.meta.dirname, 'web'))
if (existsSync(WEB_DIR)) {
  app.use('/assets/*', serveStatic({ root: WEB_DIR }))
  app.use('/favicon.svg', serveStatic({ root: WEB_DIR }))
  app.get('*', (c) => c.html(readFileSync(join(WEB_DIR, 'index.html'), 'utf8')))
}

const port = Number(process.env.PORT || 3000)
const hostname = process.env.HOST || '0.0.0.0'
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Switch 已启动: http://${hostname}:${port}  数据目录: ${process.env.DATA_DIR || './data'}`)
})
startScheduler()
