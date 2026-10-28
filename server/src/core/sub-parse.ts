import YAML from 'yaml'
import type { Proxy } from '../../../shared/types.ts'
import { isProxyUri, parseUri } from './uri-parse.ts'
import { fromSingboxOutbound } from './singbox.ts'
import { CLASH_YAML, b64decode, looksBase64 } from './util.ts'

export interface ParseResult {
  proxies: Proxy[]
  errors: string[]
  format: 'clash' | 'singbox' | 'uri' | 'base64' | 'unknown'
}

function isProxyObj(v: any): v is Proxy {
  return v && typeof v === 'object' && typeof v.type === 'string' && v.server && v.port
}

function normalizeProxy(v: any): Proxy {
  const p: Proxy = { ...v, port: Number(v.port), server: String(v.server), name: String(v.name ?? '') }
  if (!p.name) p.name = `${p.type}-${p.server}:${p.port}`
  return p
}

/** 从分享链接解析出的节点 → 原始链接（不写进 Proxy，避免混入输出配置） */
const rawLinks = new WeakMap<Proxy, string>()
export function rawOf(p: Proxy): string | undefined {
  return rawLinks.get(p)
}

function parseLines(text: string): { proxies: Proxy[]; errors: string[] } {
  const proxies: Proxy[] = []
  const errors: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    if (!isProxyUri(line)) continue
    try {
      const p = parseUri(line)
      rawLinks.set(p, line)
      proxies.push(p)
    } catch (e: any) {
      errors.push(`${line.slice(0, 40)}…: ${e.message}`)
    }
  }
  return { proxies, errors }
}

/** 解析任意格式的订阅 / 粘贴内容：Clash YAML、sing-box JSON、分享链接、base64 */
export function parseSubscription(content: string): ParseResult {
  const text = content.replace(/^﻿/, '').trim()
  if (!text) return { proxies: [], errors: [], format: 'unknown' }

  // 1) 分享链接（明文）
  if (/^[a-zA-Z0-9+]+:\/\//m.test(text) && text.split(/\r?\n/).some((l) => isProxyUri(l))) {
    const r = parseLines(text)
    if (r.proxies.length) return { ...r, format: 'uri' }
  }

  // 2) JSON（sing-box）
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text)
      const outbounds: any[] = Array.isArray(j) ? j : j.outbounds
      if (Array.isArray(outbounds)) {
        const proxies: Proxy[] = []
        const errors: string[] = []
        for (const o of outbounds) {
          try {
            const p = fromSingboxOutbound(o)
            if (p) proxies.push(p)
          } catch (e: any) {
            errors.push(`${o?.tag}: ${e.message}`)
          }
        }
        if (proxies.length) return { proxies, errors, format: 'singbox' }
      }
    } catch {}
  }

  // 3) YAML（Clash / mihomo 完整配置、proxies 列表、单个节点）
  try {
    const y = YAML.parse(text, CLASH_YAML)
    let list: any[] | null = null
    if (y && Array.isArray(y.proxies)) list = y.proxies
    else if (Array.isArray(y)) list = y
    else if (isProxyObj(y)) list = [y]
    if (list) {
      const proxies = list.filter(isProxyObj).map(normalizeProxy)
      if (proxies.length) return { proxies, errors: [], format: 'clash' }
    }
  } catch {}

  // 4) base64
  if (looksBase64(text)) {
    try {
      const decoded = b64decode(text)
      const r = parseLines(decoded)
      if (r.proxies.length || r.errors.length) return { ...r, format: 'base64' }
    } catch {}
  }

  return { proxies: [], errors: ['无法识别的订阅格式'], format: 'unknown' }
}

/** 解析 subscription-userinfo 头 */
export function parseUserinfo(h: string | null | undefined) {
  if (!h) return undefined
  const o: Record<string, number> = {}
  for (const part of h.split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (k && v && /^\d+$/.test(v)) o[k] = Number(v)
  }
  if (!('total' in o) && !('upload' in o) && !('download' in o)) return undefined
  return {
    upload: o.upload ?? 0,
    download: o.download ?? 0,
    total: o.total ?? 0,
    expire: o.expire || undefined,
  }
}
