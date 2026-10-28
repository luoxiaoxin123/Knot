import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'knot-node-edit-'))
process.env.ADMIN_PASSWORD = 'test-password'

const { api } = await import('../src/api.ts')
const { initAuthFromEnv } = await import('../src/auth.ts')

let cookie = ''
async function req(path: string, method = 'GET', body?: any) {
  const res = await api.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  initAuthFromEnv()
  expect((await req('/auth/login', 'POST', { password: 'test-password' })).status).toBe(200)
})

// 参数顺序故意和生成的不同，用来确认显示的是原文
const RAW = 'trojan://secret@tj.example.com:443?type=ws&sni=tj.example.com&path=%2Ftj#Korea%20Trojan'

async function importOne(text: string) {
  await req('/nodes/import', 'POST', { text })
  const nodes = (await req('/nodes')).json as any[]
  return nodes[nodes.length - 1]
}
const yamlOf = (n: any) => YAML.stringify({ ...n.proxy, name: n.name })

describe('编辑节点', () => {
  it('导入后保留原始分享链接', async () => {
    const n = await importOne(RAW)
    expect(n.raw).toBe(RAW)
    expect(n.uri).toBe(RAW)
  })

  it('不做修改直接保存，原始链接不变', async () => {
    const n = await importOne(RAW)
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: n.name, tags: ['a'], proxyYaml: yamlOf(n) })
    expect(r.json.raw).toBe(RAW)
  })

  it('改 YAML 里的 name 会改名，原始链接同步改名', async () => {
    const n = await importOne(RAW)
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: n.name, proxyYaml: yamlOf(n).replace('name: Korea Trojan', 'name: 韩国 01') })
    expect(r.json.name).toBe('韩国 01')
    expect(r.json.proxy.name).toBe('韩国 01')
    expect(r.json.uri).toBe(RAW.replace('#Korea%20Trojan', '#' + encodeURIComponent('韩国 01')))
  })

  it('改分享链接 # 后的名称和端口都会生效', async () => {
    const n = await importOne(RAW)
    const uri = RAW.replace(':443', ':8443').replace('#Korea%20Trojan', '#KR2')
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: n.name, proxyUri: uri })
    expect(r.json.name).toBe('KR2')
    expect(r.json.proxy.port).toBe(8443)
    expect(r.json.uri).toBe(uri)
  })

  it('名称输入框优先于配置里的名称', async () => {
    const n = await importOne(RAW)
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: '输入框', proxyYaml: yamlOf(n).replace('name: Korea Trojan', 'name: 配置里') })
    expect(r.json.name).toBe('输入框')
  })

  it('用 YAML 改了配置后，原始链接作废，改为按配置生成', async () => {
    const n = await importOne(RAW)
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: n.name, proxyYaml: yamlOf(n).replace('server: tj.example.com', 'server: 9.9.9.9') })
    expect(r.json.proxy.server).toBe('9.9.9.9')
    expect(r.json.raw).toBeUndefined()
    expect(r.json.uri).toMatch(/^trojan:\/\/secret@9\.9\.9\.9:443/)
  })

  it('vmess 原始链接改名', async () => {
    const vm = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'VM', add: 'vm.example.com', port: '443', id: '6d4c5b2a-1111-2222-3333-444455556666', aid: '0', net: 'ws', path: '/vm', tls: 'tls' })).toString('base64')
    const n = await importOne(vm)
    const r = await req(`/nodes/${n.id}`, 'PUT', { name: '台湾' })
    const j = JSON.parse(Buffer.from(r.json.uri.slice(8), 'base64').toString())
    expect(j.ps).toBe('台湾')
    expect(j.path).toBe('/vm')
  })
})
