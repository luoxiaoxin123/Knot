import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 独立的数据目录：这个测试会设置管理密码，不能写到开发用的 ./data
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'knot-auth-'))
delete process.env.ADMIN_PASSWORD

const { api } = await import('../src/api.ts')
const { initAuthFromEnv } = await import('../src/auth.ts')

let token = ''
beforeAll(() => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  initAuthFromEnv()
  token = String(log.mock.calls.flat().join('\n').match(/[0-9A-F]{4}(?:-[0-9A-F]{4}){4}/)?.[0])
  log.mockRestore()
})

let ip = 1
async function req(path: string, opts: { method?: string; body?: any; cookie?: string } = {}) {
  const res = await api.request(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      // 每个请求换一个来源 IP，避免触发登录限流
      'x-forwarded-for': `203.0.113.${ip++ % 250}`,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  return { status: res.status, json: (await res.json().catch(() => null)) as any, cookie }
}

const authed = async (cookie: string) => (await req('/auth/status', { cookie })).json.authed as boolean

describe('初始化令牌', () => {
  it('未设置密码时打印令牌', () => {
    expect(token).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/)
  })
  it('没有令牌或令牌错误时不能初始化', async () => {
    expect((await req('/auth/setup', { body: { password: 'secret1' } })).status).toBe(403)
    expect((await req('/auth/setup', { body: { password: 'secret1', token: '0000-0000-0000-0000-0000' } })).status).toBe(403)
    expect((await req('/auth/status')).json.setup).toBe(false)
  })
  it('令牌正确时完成初始化（忽略大小写和短横线），之后令牌失效', async () => {
    const r = await req('/auth/setup', { body: { password: 'secret1', token: token.toLowerCase().replace(/-/g, '') } })
    expect(r.status).toBe(200)
    expect(await authed(r.cookie!)).toBe(true)
    expect((await req('/auth/setup', { body: { password: 'other12', token } })).status).toBe(400)
  })
})

describe('会话', () => {
  const login = async () => (await req('/auth/login', { body: { password: 'secret1' } })).cookie!

  it('退出登录后旧 Cookie 立即失效，其他会话不受影响', async () => {
    const a = await login()
    const b = await login()
    expect(await authed(a)).toBe(true)
    await req('/auth/logout', { body: {}, cookie: a })
    expect(await authed(a)).toBe(false)
    expect((await req('/nodes', { cookie: a })).status).toBe(401)
    expect(await authed(b)).toBe(true)
  })
  it('修改密码后其他设备的会话失效，当前会话保留', async () => {
    const a = await login()
    const b = await login()
    const r = await req('/auth/password', { body: { oldPassword: 'secret1', newPassword: 'secret2' }, cookie: a })
    expect(r.status).toBe(200)
    expect(await authed(a)).toBe(true)
    expect(await authed(b)).toBe(false)
    await req('/auth/password', { body: { oldPassword: 'secret2', newPassword: 'secret1' }, cookie: a })
  })
  it('伪造或篡改的 Cookie 无效', async () => {
    const a = await login()
    expect(await authed(a.replace(/=(.)/, (_, c) => '=' + (c === 'A' ? 'B' : 'A')))).toBe(false)
    expect(await authed('sw_session=garbage')).toBe(false)
  })
})
