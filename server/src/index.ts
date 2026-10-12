import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { api } from './api.ts'
import { initAuthFromEnv } from './auth.ts'
import { pub } from './public.ts'
import { startScheduler } from './scheduler.ts'

initAuthFromEnv()

const app = new Hono()

app.route('/api', api)

app.route('/', pub)

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
  console.log(`Knot 已启动: http://${hostname}:${port}  数据目录: ${process.env.DATA_DIR || './data'}`)
})
startScheduler()
