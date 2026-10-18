// 极简 S3 客户端（AWS SigV4），兼容 AWS S3 / Cloudflare R2 / MinIO / 阿里云 OSS / 腾讯云 COS 等
import { createHash, createHmac } from 'node:crypto'
import type { S3Config } from '../../../shared/types.ts'

const sha256 = (d: string | Buffer) => createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest()

function encodeKey(key: string) {
  return key
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/')
}

function endpointUrl(cfg: S3Config, key = '', query = ''): URL {
  let ep = cfg.endpoint.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(ep)) ep = 'https://' + ep
  const u = new URL(ep)
  if (!cfg.bucket) {
    // 不带 bucket：服务级请求（ListBuckets）
    u.pathname = '/'
  } else if (cfg.pathStyle) {
    u.pathname = `/${cfg.bucket}/${encodeKey(key)}`.replace(/\/$/, key ? '' : '/')
  } else {
    u.hostname = `${cfg.bucket}.${u.hostname}`
    u.pathname = '/' + encodeKey(key)
  }
  u.search = query
  return u
}

async function request(cfg: S3Config, method: string, key: string, opts: { query?: Record<string, string>; body?: string; contentType?: string } = {}) {
  const query = Object.entries(opts.query || {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const url = endpointUrl(cfg, key, query)
  const body = opts.body ?? ''
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const region = cfg.region || 'us-east-1'
  const payloadHash = sha256(body)
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (opts.contentType) headers['content-type'] = opts.contentType
  const signedHeaders = Object.keys(headers).sort()
  const canonical = [
    method,
    url.pathname,
    query,
    signedHeaders.map((h) => `${h}:${headers[h]}\n`).join(''),
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${date}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  let k = hmac('AWS4' + cfg.secretAccessKey, date)
  k = hmac(k, region)
  k = hmac(k, 's3')
  k = hmac(k, 'aws4_request')
  const signature = createHmac('sha256', k).update(toSign).digest('hex')
  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
  const { host: _host, ...sendHeaders } = headers
  const res = await fetch(url, {
    method,
    headers: { ...sendHeaders, Authorization: auth },
    body: method === 'GET' || method === 'DELETE' ? undefined : body,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    const msg = text.match(/<Message>(.*?)<\/Message>/)?.[1] || text.slice(0, 200)
    throw new Error(`S3 ${res.status}: ${msg}`)
  }
  return text
}

export function s3Put(cfg: S3Config, key: string, body: string) {
  return request(cfg, 'PUT', key, { body, contentType: 'application/json' })
}

export function s3Get(cfg: S3Config, key: string) {
  return request(cfg, 'GET', key)
}

export function s3Delete(cfg: S3Config, key: string) {
  return request(cfg, 'DELETE', key)
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
}

export async function s3List(cfg: S3Config, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = []
  let token: string | undefined
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token) query['continuation-token'] = token
    const xml = await request(cfg, 'GET', '', { query })
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1]
      const tag = (t: string) => block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? ''
      out.push({
        key: tag('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
        size: Number(tag('Size')),
        lastModified: tag('LastModified'),
      })
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] : undefined
  } while (token)
  return out
}

/** 列出当前凭据可访问的全部 bucket（ListBuckets） */
export async function s3ListBuckets(cfg: S3Config): Promise<string[]> {
  const xml = await request({ ...cfg, bucket: '' }, 'GET', '')
  return [...xml.matchAll(/<Bucket>[\s\S]*?<Name>([\s\S]*?)<\/Name>[\s\S]*?<\/Bucket>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}
