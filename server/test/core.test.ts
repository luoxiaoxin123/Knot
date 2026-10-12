import { describe, it, expect } from 'vitest'
import YAML from 'yaml'
import { parseUri } from '../src/core/uri-parse.ts'
import { toUri } from '../src/core/uri-emit.ts'
import { parseSubscription } from '../src/core/sub-parse.ts'
import { generateClash, generateSingbox, generateV2ray, type GenContext } from '../src/core/generate.ts'
import type { Node, CustomRule } from '../../shared/types.ts'
import { URIS, settings, profile } from './fixtures.ts'

function mkNodes(): Node[] {
  return URIS.map((u, i) => {
    const p = parseUri(u)
    return { id: 'n' + i, name: p.name, proxy: p, source: { kind: 'manual' }, enabled: true, tags: [], createdAt: 0 }
  })
}

describe('uri parse/emit', () => {
  it('parses all fixtures', () => {
    for (const u of URIS) {
      const p = parseUri(u)
      expect(p.server).toBeTruthy()
      expect(p.port).toBeGreaterThan(0)
    }
  })
  it('vless reality', () => {
    const p = parseUri(URIS[0])
    expect(p).toMatchObject({ type: 'vless', flow: 'xtls-rprx-vision', tls: true, servername: 'www.microsoft.com', 'reality-opts': { 'short-id': '6ba85179e30d4fc2' } })
    expect(p.name).toBe('🇭🇰 HK Reality')
  })
  it('ws path keeps query', () => {
    expect(parseUri(URIS[1])['ws-opts'].path).toBe('/ray?ed=2048')
  })
  it('hy2 v6 port hopping', () => {
    const p = parseUri(URIS[4])
    expect(p).toMatchObject({ server: '2001:db8::1', port: 8443, ports: '8443,20000-30000', password: 'letmein' })
  })
  it('ss variants', () => {
    expect(parseUri(URIS[5])).toMatchObject({ cipher: 'aes-256-gcm', password: 'password' })
    expect(parseUri(URIS[6])).toMatchObject({ cipher: '2022-blake3-aes-128-gcm', password: 'MTIzNDU2Nzg5MGFiY2RlZg==' })
    expect(parseUri(URIS[7])).toMatchObject({ server: '10.0.0.1', port: 8388, name: 'legacy' })
    expect(parseUri(URIS[8])).toMatchObject({ plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'bing.com' } })
  })
  it('round trips', () => {
    for (const u of URIS) {
      const p = parseUri(u)
      const back = parseUri(toUri(p)!)
      expect(back).toEqual(p)
    }
  })
  it('subscription formats', () => {
    const plain = URIS.join('\n')
    expect(parseSubscription(plain).proxies.length).toBe(URIS.length)
    expect(parseSubscription(Buffer.from(plain).toString('base64')).proxies.length).toBe(URIS.length)
    const yaml = YAML.stringify({ proxies: URIS.map(parseUri) })
    expect(parseSubscription(yaml).format).toBe('clash')
  })
})

describe('generate', () => {
  const nodes = mkNodes()
  // 链式：JP WS 经由 HK Reality 中转；再嵌套一层
  nodes.push({ id: 'c1', name: 'JP via HK', proxy: nodes[1].proxy, source: { kind: 'chain', targetId: 'n1', relayId: 'n0' }, enabled: true, tags: [], createdAt: 0 })
  nodes.push({ id: 'c2', name: 'US via JP via HK', proxy: nodes[2].proxy, source: { kind: 'chain', targetId: 'n2', relayId: 'c1' }, enabled: true, tags: [], createdAt: 0 })
  const customRules: CustomRule[] = [
    { id: 'r1', enabled: true, position: 'head', remark: '', kind: 'rule', type: 'DOMAIN-SUFFIX', value: 'example.org', policy: 'DIRECT', order: 0 },
    { id: 'r2', enabled: true, position: 'tail', remark: 'steam', kind: 'rule', type: 'GEOSITE', value: 'steam', policy: '🎮 我的游戏', order: 1 },
    { id: 'r3', enabled: true, position: 'head', remark: 'mylist', kind: 'ruleset', url: 'https://example.com/a.list', behavior: 'classical', format: 'text', policy: 'REJECT', order: 2 },
  ]
  const ctx: GenContext = { nodes, subscriptions: [], templates: [], customRules, settings }

  it('clash', () => {
    const r = generateClash(ctx, profile({ nodeMode: 'pick', nodeIds: ['c2', 'n3'], addFlags: false }))
    const y = YAML.parse(r.text)
    const names = y.proxies.map((p: any) => p.name)
    // 依赖的中转节点被自动补全
    expect(names).toEqual(expect.arrayContaining(['US via JP via HK', 'JP via HK', '🇭🇰 HK Reality']))
    const c2 = y.proxies.find((p: any) => p.name === 'US via JP via HK')
    expect(c2['dialer-proxy']).toBe('JP via HK')
    // 中转节点不进分组
    expect(y['proxy-groups'][0].proxies).not.toContain('JP via HK')
    expect(y.rules[0]).toBe('DOMAIN-SUFFIX,example.org,DIRECT')
    expect(y.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼')
    expect(y.rules.at(-2)).toBe('RULE-SET,geosite-steam,🎮 我的游戏')
    expect(y['proxy-groups'].some((g: any) => g.name === '🎮 我的游戏')).toBe(true)
    // 链式节点按落地节点归入地区组
    expect(y['proxy-groups'].find((g: any) => g.name === '🇺🇸 美国节点').proxies).toEqual(['US via JP via HK'])
    expect(y['proxy-groups'].find((g: any) => g.name === '🇭🇰 香港节点')).toBeUndefined()
  })
  it('flags follow landing node', () => {
    const y = YAML.parse(generateClash(ctx, profile()).text)
    const names = y.proxies.map((p: any) => p.name)
    expect(names).toContain('🇺🇸 US via JP via HK')
    expect(names).toContain('🇯🇵 JP via HK')
  })
  it('singbox + v2ray', () => {
    const s = JSON.parse(generateSingbox(ctx, profile()).text)
    expect(s.outbounds.find((o: any) => o.tag === '🇯🇵 JP via HK').detour).toBe('🇭🇰 HK Reality')
    const v = Buffer.from(generateV2ray(ctx, profile()).text, 'base64').toString()
    expect(v.split('\n').length).toBe(URIS.length)
  })
})

describe('custom rules yaml', () => {
  it('round trips', async () => {
    const { rulesToYaml, yamlToRules } = await import('../../shared/rules-yaml.ts')
    let n = 0
    const gen = () => 'id' + n++
    const text = `head:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - IP-CIDR,1.1.1.0/24,REJECT,no-resolve
  - RULE-SET,mylist,🎮 Steam
tail:
  - GEOSITE,steam,🚀 节点选择
rule-providers:
  mylist:
    type: http
    behavior: domain
    format: mrs
    url: https://example.com/a.mrs
    interval: 3600
`
    const rules = yamlToRules(text, [], gen)
    expect(rules).toHaveLength(4)
    expect(rules[1]).toMatchObject({ type: 'IP-CIDR', noResolve: true, policy: 'REJECT', position: 'head' })
    expect(rules[2]).toMatchObject({ kind: 'ruleset', remark: 'mylist', format: 'mrs', behavior: 'domain', interval: 3600 })
    expect(rules[3]).toMatchObject({ position: 'tail', type: 'GEOSITE' })
    const again = yamlToRules(rulesToYaml(rules), [], gen)
    expect(again.map(({ id, ...r }) => r)).toEqual(rules.map(({ id, ...r }) => r))
    expect(() => yamlToRules('head:\n  - FOO,bar,DIRECT', [], gen)).toThrow()
  })
})

describe('custom groups', () => {
  const nodes = mkNodes()
  const ctx: GenContext = { nodes, subscriptions: [], templates: [], customRules: [], settings }
  it('replaces groups, renames targets, adds new nodes and fills missing groups', async () => {
    const { draftCustomGroups } = await import('../src/core/generate.ts')
    const base = profile({ addFlags: false, regionGroups: false, modules: ['ai', 'gfw', 'cn', 'final'] })
    const draft = draftCustomGroups(ctx, base)
    expect(draft.map((g) => g.name)).toEqual(['🚀 节点选择', '♻️ 自动选择', '🤖 AI 服务', '🎯 国内直连', '🐟 漏网之鱼'])
    expect(draft[0].members).toContain('node:n0')
    expect(draft[0].autoNew).toBe(true)
    // 编辑：AI 改名并只保留两个节点，删除「国内直连」，known 不包含 n13（模拟新节点）
    const ai = { ...draft[2], name: '🤖 AI', members: ['node:n2', 'node:n0'], autoNew: false }
    const groups = [draft[0], draft[1], ai, draft[4], { id: 'x', name: '我的组', type: 'url-test' as const, members: ['node:n1'], autoNew: true, filter: 'VMess' }]
    const known = nodes.filter((n) => n.id !== 'n13').map((n) => n.id)
    const p = { ...base, groupMode: 'custom' as const, customGroups: groups, knownNodeIds: known }
    const r = generateClash(ctx, p)
    const y = YAML.parse(r.text)
    const g = (name: string) => y['proxy-groups'].find((x: any) => x.name === name)
    expect(g('🤖 AI').proxies).toEqual(['US gRPC', '🇭🇰 HK Reality'])
    expect(g('我的组').proxies).toEqual(['JP WS', '台湾 VMess'])
    expect(y.rules.some((x: string) => x.endsWith(',🤖 AI'))).toBe(true)
    expect(y.rules.some((x: string) => x.endsWith(',🤖 AI 服务'))).toBe(false)
    expect(g('🎯 国内直连')).toBeTruthy()
    expect(r.warnings.join()).toContain('国内直连')
    const sb = JSON.parse(generateSingbox(ctx, p).text)
    const tags = new Set(sb.outbounds.map((o: any) => o.tag))
    for (const rule of sb.route.rules) if (rule.outbound) expect(tags.has(rule.outbound)).toBe(true)
    expect(sb.outbounds.find((o: any) => o.tag === '🤖 AI').outbounds).toEqual(['US gRPC', '🇭🇰 HK Reality'])
  })
})

describe('ios / stash formats', () => {
  const nodes = mkNodes()
  // Trojan 经由 SS 中转（Surge 支持 underlying-proxy）
  nodes.push({ id: 'c9', name: 'Trojan via SS', proxy: nodes[9].proxy, source: { kind: 'chain', targetId: 'n9', relayId: 'n5' }, enabled: true, tags: [], createdAt: 0 })
  const ctx: GenContext = { nodes, subscriptions: [], templates: [], customRules: [], settings }
  const p = profile({ addFlags: false, modules: ['private', 'ai', 'cn', 'final'] })
  it('surge', async () => {
    const { generate } = await import('../src/core/generate.ts')
    const r = generate(ctx, p, 'surge', { managedUrl: 'https://x/sub' })
    expect(r.text.startsWith('#!MANAGED-CONFIG https://x/sub')).toBe(true)
    expect(r.text).toContain('Trojan via SS = trojan, tj.example.com, 443, password="secret"')
    expect(r.text).toMatch(/Trojan via SS = .*underlying-proxy=Tokyo SS/)
    expect(r.text).toContain('RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/OpenAI/OpenAI.list,🤖 AI 服务')
    expect(r.text).toContain('GEOIP,CN,🎯 国内直连')
    expect(r.text.trim().endsWith('FINAL,🐟 漏网之鱼,dns-failed')).toBe(true)
    // Surge 不支持 VLESS
    expect(r.text).not.toContain('= vless')
    expect(r.warnings.join()).toContain('Surge 不支持 vless')
  })
  it('loon / qx skip chains and keep reality', async () => {
    const { generate } = await import('../src/core/generate.ts')
    const loon = generate(ctx, p, 'loon')
    expect(loon.text).toMatch(/HK Reality = vless,1\.2\.3\.4,443,.*public-key="SbVK/)
    expect(loon.warnings.join()).toContain('Loon 不支持链式代理')
    const qx = generate(ctx, p, 'qx')
    expect(qx.text).toContain('reality-base64-pubkey=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc')
    expect(qx.text).toContain('final, 🐟 漏网之鱼')
    const list = generate(ctx, p, 'qx', { listOnly: true })
    expect(list.text.split('\n').filter(Boolean).every((l) => l.includes('tag='))).toBe(true)
  })
  it('stash', async () => {
    const { generate } = await import('../src/core/generate.ts')
    const y = YAML.parse(generate(ctx, p, 'stash').text)
    const hy = y.proxies.find((x: any) => x.type === 'hysteria2' && x.name === 'SG Hy2')
    expect(hy.auth).toBe('pass@word')
    expect(hy.password).toBeUndefined()
    expect(Object.values(y['rule-providers']).every((x: any) => x.format === 'text')).toBe(true)
    expect(y.sniffer).toBeUndefined()
  })
})
