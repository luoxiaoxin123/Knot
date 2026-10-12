// 两步验证：TOTP（RFC 6238）+ 恢复码，以及通行密钥（WebAuthn）
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { Passkey } from '../../shared/types.ts'
import { db } from './db.ts'

// ------------------------------------------------------------------ TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1] & 15
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 10 ** digits).padStart(digits, '0')
}

/** 校验 TOTP，允许前后各 1 个时间窗；返回命中的时间步，失败返回 -1 */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number {
  const c = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return -1
  const secret = base32Decode(secretB32)
  const step = Math.floor(now / 30_000)
  for (const d of [0, -1, 1]) {
    const expect = hotp(secret, step + d)
    if (timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return step + d
  }
  return -1
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let pendingTotp: { secret: string; at: number } | null = null

export function totpEnabled() {
  return !!db.data.auth.totp?.enabled
}

export function startTotpSetup() {
  const secret = base32Encode(randomBytes(20))
  pendingTotp = { secret, at: Date.now() }
  const uri = `otpauth://totp/Knot:admin?secret=${secret}&issuer=Knot&algorithm=SHA1&digits=6&period=30`
  return { secret, uri }
}

/** 确认开启：返回一次性恢复码（只显示这一次） */
export function confirmTotpSetup(code: string): string[] | null {
  if (!pendingTotp || Date.now() - pendingTotp.at > 15 * 60_000) return null
  const step = verifyTotp(pendingTotp.secret, code)
  if (step < 0) return null
  const codes = Array.from({ length: 8 }, () => {
    const s = randomBytes(5).toString('hex')
    return `${s.slice(0, 5)}-${s.slice(5)}`
  })
  db.data.auth.totp = { secret: pendingTotp.secret, enabled: true, lastStep: step, recoveryHashes: codes.map(sha) }
  pendingTotp = null
  db.flush()
  return codes
}

/** 登录时校验验证码或恢复码 */
export function checkSecondFactor(code: string): { ok: boolean; usedRecovery?: boolean } {
  const t = db.data.auth.totp
  if (!t?.enabled) return { ok: true }
  const c = String(code || '').trim()
  if (/^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(c)) {
    const h = sha(c.toLowerCase())
    const idx = t.recoveryHashes.indexOf(h)
    if (idx < 0) return { ok: false }
    t.recoveryHashes.splice(idx, 1)
    db.flush()
    return { ok: true, usedRecovery: true }
  }
  const step = verifyTotp(t.secret, c)
  // 同一个验证码不能重复使用
  if (step < 0 || (t.lastStep !== undefined && step <= t.lastStep)) return { ok: false }
  t.lastStep = step
  db.save()
  return { ok: true }
}

export function disableTotp() {
  db.data.auth.totp = undefined
  db.flush()
}

// ------------------------------------------------------------------ 通行密钥

const challenges = new Map<string, { challenge: string; at: number; kind: 'reg' | 'auth' }>()

function putChallenge(kind: 'reg' | 'auth', challenge: string) {
  const now = Date.now()
  for (const [k, v] of challenges) if (now - v.at > 5 * 60_000) challenges.delete(k)
  const id = randomBytes(12).toString('base64url')
  challenges.set(id, { challenge, at: now, kind })
  return id
}

function takeChallenge(id: string, kind: 'reg' | 'auth') {
  const c = challenges.get(id)
  challenges.delete(id)
  if (!c || c.kind !== kind || Date.now() - c.at > 5 * 60_000) return null
  return c.challenge
}

/** 浏览器所在的源；RP ID 取其主机名。WebAuthn 只能在 HTTPS 或 localhost 下使用 */
function originOf(c: Context): { origin: string; rpID: string } {
  const origin = c.req.header('origin')
  if (!origin) throw new Error('缺少 Origin 请求头')
  const u = new URL(origin)
  const host = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(',')[0].trim().replace(/:\d+$/, '')
  if (host && host !== u.hostname) throw new Error('请求来源与站点地址不一致')
  return { origin: u.origin, rpID: u.hostname }
}

export function passkeys(): Passkey[] {
  return (db.data.auth.passkeys ||= [])
}

export async function passkeyRegisterOptions(c: Context) {
  const { rpID } = originOf(c)
  const options = await generateRegistrationOptions({
    rpName: 'Knot',
    rpID,
    userName: 'admin',
    userDisplayName: 'Knot 管理员',
    attestationType: 'none',
    excludeCredentials: passkeys().filter((p) => p.rpID === rpID).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
  return { options, challengeId: putChallenge('reg', options.challenge) }
}

export async function passkeyRegisterVerify(c: Context, challengeId: string, response: any, name: string) {
  const { origin, rpID } = originOf(c)
  const challenge = takeChallenge(challengeId, 'reg')
  if (!challenge) throw new Error('请求已过期，请重试')
  const r = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID })
  if (!r.verified || !r.registrationInfo) throw new Error('验证失败')
  const cred = r.registrationInfo.credential
  const pk: Passkey = {
    id: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString('base64url'),
    counter: cred.counter,
    transports: cred.transports,
    name: name.trim() || '通行密钥',
    rpID,
    createdAt: Date.now(),
  }
  passkeys().push(pk)
  db.flush()
  return pk
}

export async function passkeyLoginOptions(c: Context) {
  const { rpID } = originOf(c)
  const list = passkeys().filter((p) => p.rpID === rpID)
  if (!list.length) throw new Error('当前域名下没有已登记的通行密钥')
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: list.map((p) => ({ id: p.id, transports: p.transports })),
    userVerification: 'preferred',
  })
  return { options, challengeId: putChallenge('auth', options.challenge) }
}

export async function passkeyLoginVerify(c: Context, challengeId: string, response: any): Promise<Passkey> {
  const { origin, rpID } = originOf(c)
  const challenge = takeChallenge(challengeId, 'auth')
  if (!challenge) throw new Error('请求已过期，请重试')
  const pk = passkeys().find((p) => p.id === response?.id && p.rpID === rpID)
  if (!pk) throw new Error('未知的通行密钥')
  const r = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')), counter: pk.counter, transports: pk.transports },
  })
  if (!r.verified) throw new Error('验证失败')
  pk.counter = r.authenticationInfo.newCounter
  pk.lastUsedAt = Date.now()
  db.save()
  return pk
}

export function hasPasskeyFor(c: Context): boolean {
  try {
    const { rpID } = originOf(c)
    return passkeys().some((p) => p.rpID === rpID)
  } catch {
    // GET 请求通常不带 Origin，按 Host 判断
    const host = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(',')[0].trim().replace(/:\d+$/, '')
    return passkeys().some((p) => p.rpID === host)
  }
}
