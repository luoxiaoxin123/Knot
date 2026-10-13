// 反复读写不能改变内容（参考妙妙屋 iluobei/miaomiaowu#126：正则改写序列化后的 YAML，
// 含 emoji 的字符串每写回一次反斜杠翻倍）。这里覆盖所有「读出 → 编辑 → 写回」的路径。
import { describe, it, expect } from 'vitest'
import YAML from 'yaml'
import type { CustomRule, Node, Proxy } from '../../shared/types.ts'
import { expandCustomRules, rulesToYaml, yamlToRules } from '../../shared/rules-yaml.ts'
import { parseSubscription } from '../src/core/sub-parse.ts'
import { parseUri } from '../src/core/uri-parse.ts'
import { toUri } from '../src/core/uri-emit.ts'
import { generate, type GenContext } from '../src/core/generate.ts'
import { profile, settings } from './fixtures.ts'

const ROUNDS = 10
const tricky = String.raw`.*\\steam\.exe$`

describe('多次读写后内容不变', () => {
  it('自定义规则：YAML 编辑模式保存再打开', () => {
    let id = 0
    let rules: CustomRule[] = [
      { id: 'a', enabled: true, position: 'head', remark: '', kind: 'rule', type: 'PROCESS-NAME-REGEX', value: tricky, policy: '🎮 游戏', order: 0 },
      { id: 'b', enabled: true, position: 'head', remark: '', kind: 'rule', type: 'DOMAIN-REGEX', value: String.raw`^a\.b\d+"x'$`, policy: 'DIRECT', order: 1 },
      { id: 'c', enabled: true, position: 'tail', remark: '🎯 规则集', kind: 'set', policy: '🚀 节点选择', rules: `PROCESS-PATH-REGEX,${tricky}\nDOMAIN,中文.example`, order: 2 },
    ]
    const first = rulesToYaml(rules)
    for (let i = 0; i < ROUNDS; i++) rules = yamlToRules(rulesToYaml(rules), rules, () => `g${id++}`)
    expect(rulesToYaml(rules)).toBe(first)
    const flat = expandCustomRules(rules)
    expect(flat.find((r) => r.type === 'PROCESS-NAME-REGEX')!.value).toBe(tricky)
    expect(flat.find((r) => r.type === 'PROCESS-PATH-REGEX')!.value).toBe(tricky)
  })

  const proxy: Proxy = {
    name: '🇯🇵 东京 \\ "引号" #1',
    type: 'vless',
    server: 'a.example.com',
    port: 443,
    uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    network: 'ws',
    tls: true,
    servername: 'a.example.com',
    'ws-opts': { path: String.raw`/ray\path?ed=2048&x=🚀`, headers: { Host: 'a.example.com' } },
  }

  it('节点：编辑 YAML 保存再打开', () => {
    // 前端 Nodes.tsx 用 YAML.stringify 显示，后端 PUT /nodes/:id 用 YAML.parse 读回
    let p = proxy
    for (let i = 0; i < ROUNDS; i++) p = YAML.parse(YAML.stringify(p, { lineWidth: 0 }))
    expect(p).toEqual(proxy)
  })

  it('节点：分享链接导出再导入', () => {
    let p = proxy
    for (let i = 0; i < ROUNDS; i++) p = parseUri(toUri(p)!)
    expect(p.name).toBe(proxy.name)
    expect(p['ws-opts']?.path).toBe(proxy['ws-opts']!.path)
  })

  it('Clash 输出再作为订阅导入', () => {
    const ctx = (p: Proxy): GenContext => ({
      nodes: [{ id: 'n', name: p.name, proxy: p, source: { kind: 'manual' }, enabled: true, tags: [], createdAt: 0 } as Node],
      subscriptions: [],
      templates: [],
      customRules: [],
      settings,
    })
    const pr = profile({ addFlags: false, regionGroups: false })
    let p = proxy
    for (let i = 0; i < ROUNDS; i++) p = parseSubscription(generate(ctx(p), pr, 'clash').text).proxies[0]
    expect(p.name).toBe(proxy.name)
    expect(p['ws-opts']).toEqual(proxy['ws-opts'])
  })

  it('数据文件 / 备份 / 历史版本（JSON）', () => {
    let d: any = { nodes: [{ proxy }], customRules: [{ value: tricky }] }
    const first = JSON.stringify(d)
    for (let i = 0; i < ROUNDS; i++) d = JSON.parse(JSON.stringify(d))
    expect(JSON.stringify(d)).toBe(first)
  })
})
