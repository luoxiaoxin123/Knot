import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db } from './db.ts'

const COOKIE = 'sw_session'
const MAX_AGE = 30 * 24 * 3600

export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 32)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$')
  if (!saltHex || !hashHex) return false
  const hash = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32)
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}

function sign(payload: string): string {
  return createHmac('sha256', db.data.auth.secret).update(payload).digest('base64url')
}

const MAX_SESSIONS = 50

function sessions() {
  const now = Date.now() / 1000
  return (db.data.auth.sessions = (db.data.auth.sessions || []).filter((x) => x.exp > now))
}

/** 登记一个服务端会话：Cookie 只携带会话 id，退出登录等操作可以让它立即失效 */
export function issueSession(c: Context) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  const id = randomBytes(16).toString('base64url')
  db.data.auth.sessions = [...sessions(), { id, exp, createdAt: Date.now() }].slice(-MAX_SESSIONS)
  db.flush()
  const payload = `${id}.${exp}`
  setCookie(c, COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:'),
  })
}

/** 当前请求的会话 id（签名有效且未被撤销） */
function currentSession(c: Context): string | null {
  const v = getCookie(c, COOKIE)
  if (!v) return null
  const i = v.lastIndexOf('.')
  if (i < 0) return null
  const payload = v.slice(0, i)
  const sig = v.slice(i + 1)
  const expected = sign(payload)
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  const [id, exp] = payload.split('.')
  if (!id || !(Number(exp) > Date.now() / 1000)) return null
  return sessions().some((x) => x.id === id) ? id : null
}

export function isAuthed(c: Context): boolean {
  return currentSession(c) !== null
}

/** 退出登录：撤销当前会话 */
export function clearSession(c: Context) {
  const id = currentSession(c)
  if (id) {
    db.data.auth.sessions = sessions().filter((x) => x.id !== id)
    db.flush()
  }
  deleteCookie(c, COOKIE, { path: '/' })
}

/** 修改密码、两步验证或通行密钥后调用：其他设备上的登录全部失效，当前会话保留 */
export function revokeOtherSessions(c: Context) {
  const id = currentSession(c)
  db.data.auth.sessions = sessions().filter((x) => x.id === id)
  db.flush()
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthed(c)) return c.json({ error: '未登录' }, 401)
  await next()
}

// 简单的登录失败限流：每个 IP 10 分钟内最多 10 次
const failures = new Map<string, { n: number; until: number }>()
const MAX_TRACKED_IPS = 10_000

export function loginBlocked(ip: string): boolean {
  const f = failures.get(ip)
  return !!f && f.n >= 10 && f.until > Date.now()
}

export function recordFailure(ip: string) {
  const f = failures.get(ip)
  const now = Date.now()
  if (failures.size >= MAX_TRACKED_IPS) {
    // 先清掉已过期的；仍然太多时丢弃最早记录的，避免大量来源地址把内存撑满
    for (const [k, v] of failures) if (v.until < now) failures.delete(k)
    for (const k of failures.keys()) {
      if (failures.size < MAX_TRACKED_IPS) break
      failures.delete(k)
    }
  }
  if (!f || f.until < now) failures.set(ip, { n: 1, until: now + 10 * 60_000 })
  else f.n++
}

export function clearFailures(ip: string) {
  failures.delete(ip)
}

// 首次初始化令牌：未设置密码时每次启动生成一个并打印到日志，只有能看到服务器日志的人才能完成初始化，
// 避免刚部署、还没设密码时被别人抢先访问页面设置密码
let setupToken: string | null = null

export function needsSetup() {
  return !db.data.auth.passwordHash
}

export function checkSetupToken(token: unknown): boolean {
  if (!setupToken || typeof token !== 'string') return false
  // 忽略大小写、空格和分隔的短横线
  const a = Buffer.from(token.replace(/[^0-9a-f]/gi, '').toUpperCase())
  const b = Buffer.from(setupToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function consumeSetupToken() {
  setupToken = null
}

/** 首次启动时可通过环境变量设置管理员密码；否则生成初始化令牌 */
export function initAuthFromEnv() {
  const pw = process.env.ADMIN_PASSWORD
  if (pw && !db.data.auth.passwordHash) {
    db.data.auth.passwordHash = hashPassword(pw)
    db.save()
  }
  if (needsSetup()) {
    setupToken = randomBytes(10).toString('hex').toUpperCase()
    console.log(
      [
        '',
        '========================================================',
        '  尚未设置管理密码。在网页上初始化时需要填写这个令牌：',
        `  ${setupToken.match(/.{4}/g)!.join('-')}`,
        '  （每次启动重新生成；Docker 中用 docker logs knot 查看）',
        '========================================================',
        '',
      ].join('\n'),
    )
  }
}
