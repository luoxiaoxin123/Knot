import { connect } from 'node:net'
import type { Node } from '../../../shared/types.ts'

const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'tuic', 'wireguard'])

/** TCP 握手延迟。UDP 协议(Hysteria/TUIC/WireGuard)无法通过 TCP 测试，返回 null */
export function tcpPing(host: string, port: number, timeout = 5000): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now()
    const sock = connect({ host, port, timeout })
    const done = (v: number) => {
      sock.destroy()
      resolve(v)
    }
    sock.once('connect', () => done(Math.round(performance.now() - start)))
    sock.once('timeout', () => done(-1))
    sock.once('error', () => done(-1))
  })
}

export async function testNodes(nodes: Node[], byId: Map<string, Node>, concurrency = 32) {
  const results: Record<string, number | null> = {}
  const queue = [...nodes]
  async function worker() {
    while (queue.length) {
      const n = queue.shift()!
      // 链式节点测试第一跳（中转节点）
      let target = n
      for (let i = 0; target.source.kind === 'chain' && i < 8; i++) {
        target = byId.get(target.source.relayId) || target
        if (target.source.kind !== 'chain') break
      }
      if (UDP_TYPES.has(target.proxy.type)) {
        results[n.id] = null
        continue
      }
      const ms = await tcpPing(target.proxy.server, target.proxy.port)
      n.latency = ms
      n.latencyAt = Date.now()
      results[n.id] = ms
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker))
  return results
}
