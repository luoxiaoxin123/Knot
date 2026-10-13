import { randomBytes, createHash } from 'node:crypto'

export function uid(len = 12): string {
  return randomBytes(len).toString('base64url').slice(0, len)
}

export function hashId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('base64url').slice(0, 12)
}

export function b64decode(s: string): string {
  let t = s.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  return Buffer.from(t, 'base64').toString('utf8')
}

export function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

/** 判断字符串是否像 base64 */
export function looksBase64(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '')
  return t.length > 0 && /^[A-Za-z0-9+/_=-]+$/.test(t)
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function truthy(v: string | null | undefined): boolean {
  if (v == null) return false
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export function splitList(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 删除对象里值为 undefined / '' / 空数组 / 空对象 的字段 */
export function compact<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(compact(v)).length === 0)
    ) {
      delete o[k]
    }
  }
  return o
}

/**
 * YAML 别名展开上限。Clash 配置常用锚点复用分组，库默认的 100 不够；
 * 但不能关掉（-1）：几百字节的嵌套别名就能展开成几百 MB，保存或输出时撑爆内存
 */
export const YAML_MAX_ALIAS = 10_000

export function safeRegex(src: string): RegExp | null {
  if (!src) return null
  try {
    return new RegExp(src, 'i')
  } catch {
    return null
  }
}

export function deepClone<T>(v: T): T {
  return structuredClone(v)
}

/** 深合并：数组直接覆盖 */
export function deepMerge(target: any, src: any): any {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src
  const out: any = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(src)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v
  }
  return out
}
