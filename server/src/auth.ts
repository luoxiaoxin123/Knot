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

export function issueSession(c: Context) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  // 密码哈希的一部分参与签名：改密码后旧会话自动失效
  const ver = (db.data.auth.passwordHash || '').slice(-8)
  const payload = `${exp}.${ver}`
  setCookie(c, COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:'),
  })
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' })
}

export function isAuthed(c: Context): boolean {
  const v = getCookie(c, COOKIE)
  if (!v) return false
  const i = v.lastIndexOf('.')
  const payload = v.slice(0, i)
  const sig = v.slice(i + 1)
  const expected = sign(payload)
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  const [exp, ver] = payload.split('.')
  if (Number(exp) < Date.now() / 1000) return false
  return ver === (db.data.auth.passwordHash || '').slice(-8)
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthed(c)) return c.json({ error: '未登录' }, 401)
  await next()
}

// 简单的登录失败限流：每个 IP 10 分钟内最多 10 次
const failures = new Map<string, { n: number; until: number }>()

export function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    (c.env as any)?.incoming?.socket?.remoteAddress ||
    'unknown'
  )
}

export function loginBlocked(ip: string): boolean {
  const f = failures.get(ip)
  return !!f && f.n >= 10 && f.until > Date.now()
}

export function recordFailure(ip: string) {
  const f = failures.get(ip)
  if (!f || f.until < Date.now()) failures.set(ip, { n: 1, until: Date.now() + 10 * 60_000 })
  else f.n++
}

export function clearFailures(ip: string) {
  failures.delete(ip)
}

/** 首次启动时可通过环境变量设置管理员密码 */
export function initAuthFromEnv() {
  const pw = process.env.ADMIN_PASSWORD
  if (pw && !db.data.auth.passwordHash) {
    db.data.auth.passwordHash = hashPassword(pw)
    db.save()
  }
}
