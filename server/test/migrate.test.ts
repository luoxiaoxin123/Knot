import { describe, it, expect, beforeAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URIS } from './fixtures.ts'

let db: any, importSubStore: any, importMiaomiaowu: any
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sw-mig-'))
  ;({ db } = await import('../src/db.ts'))
  ;({ importSubStore, importMiaomiaowu } = await import('../src/services/migrate.ts'))
})

describe('migrate', () => {
  it('sub-store backup', () => {
    const backup = {
      settings: {},
      subs: [
        { name: 'air', displayName: '机场A', source: 'remote', url: 'https://air.example.com/sub?token=1\nhttps://air2.example.com/s#noFlow', ua: 'clash.meta', process: [{ type: 'Quick Setting Operator' }] },
        { name: 'mine', source: 'local', content: URIS.slice(0, 3).join('\n') },
      ],
      collections: [{ name: 'all', displayName: '全部', subscriptions: ['air', 'mine'], process: [] }],
      artifacts: [{ name: 'x' }],
    }
    const r = importSubStore(JSON.stringify(backup))
    expect(r).toMatchObject({ subscriptions: 2, nodes: 3, profiles: 1 })
    expect(db.data.subscriptions.map((s: any) => s.url)).toEqual(['https://air.example.com/sub?token=1', 'https://air2.example.com/s'])
    const p = db.data.profiles.find((x: any) => x.name === '全部')
    expect(p.nodeMode).toBe('sources')
    expect(p.sources).toContain('manual')
    expect(r.skipped.join()).toContain('节点操作')
    // base64 编码的备份也能识别；重复导入不会重复添加订阅
    const again = importSubStore(Buffer.from(JSON.stringify(backup)).toString('base64'))
    expect(again.subscriptions).toBe(0)
  })

  it('miaomiaowu sqlite', async () => {
    const file = join(process.env.DATA_DIR!, 'traffic.db')
    const d = new DatabaseSync(file)
    d.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, raw_url TEXT, node_name TEXT, protocol TEXT, parsed_config TEXT, clash_config TEXT, enabled INTEGER DEFAULT 1, tag TEXT DEFAULT '手动输入', tags TEXT DEFAULT '[]', chain_proxy_node_id INTEGER, relay_group_name TEXT, relay_group_node_ids TEXT);
      CREATE TABLE external_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, name TEXT, url TEXT, user_agent TEXT);`)
    const ins = d.prepare('INSERT INTO nodes (username, raw_url, node_name, protocol, parsed_config, clash_config, tag, tags, chain_proxy_node_id) VALUES (?,?,?,?,?,?,?,?,?)')
    const relay = { name: '中转', type: 'ss', server: '1.1.1.1', port: 8388, cipher: 'aes-128-gcm', password: 'x' }
    const land = { name: '落地', type: 'trojan', server: '2.2.2.2', port: 443, password: 'y', sni: 'a.com' }
    ins.run('admin', '', '中转', 'ss', '{}', JSON.stringify(relay), '手动输入', '[]', null)
    ins.run('admin', '', '落地', 'trojan', '{}', JSON.stringify(land), '自建', '["自建"]', null)
    ins.run('admin', '', '落地-链', 'trojan', '{}', JSON.stringify({ ...land, 'dialer-proxy': '中转' }), '自建', '["自建"]', 1)
    ins.run('admin', '', '机场节点', 'ss', '{}', JSON.stringify({ ...relay, server: '3.3.3.3' }), '我的机场', '["我的机场"]', null)
    d.prepare('INSERT INTO external_subscriptions (username, name, url, user_agent) VALUES (?,?,?,?)').run('admin', '我的机场', 'https://mmw-air.example.com/sub', 'clash-meta/2.4.0')
    d.close()
    const nodesBefore = db.data.nodes.length
    const r = await importMiaomiaowu(readFileSync(file))
    expect(r).toMatchObject({ subscriptions: 1, nodes: 2, chains: 1 })
    const added = db.data.nodes.slice(0).filter((n: any) => ['中转', '落地', '落地-链', '机场节点'].includes(n.name))
    expect(added.map((n: any) => n.name).sort()).toEqual(['中转', '落地', '落地-链'])
    const chain = added.find((n: any) => n.name === '落地-链')
    const byName = (n: string) => db.data.nodes.find((x: any) => x.name === n)
    expect(chain.source).toEqual({ kind: 'chain', targetId: byName('落地').id, relayId: byName('中转').id })
    expect(byName('落地').proxy['dialer-proxy']).toBeUndefined()
    expect(db.data.nodes.length).toBe(nodesBefore + 3)
    expect(r.skipped.join()).toContain('外部订阅同步')
    await expect(importMiaomiaowu(Buffer.from('not a db'))).rejects.toThrow(/SQLite/)
  })
})
