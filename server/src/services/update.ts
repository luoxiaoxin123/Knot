/** 检查新版本：读取 GitHub Releases 的最新正式版，结果缓存，避免频繁请求 */

const REPO = 'luoxiaoxin123/Knot'
const TTL = 6 * 3600_000
const FAIL_TTL = 30 * 60_000

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
  hasUpdate: boolean
}

let cache: { at: number; ttl: number; latest: string | null; url: string | null } | null = null

/** 解析 v1.2.3 / 1.2.3-beta.1；非版本号（dev、ci-xxx）返回 null */
export function parseVersion(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

/** a 比 b 新返回正数；预发布版本低于同号正式版 */
export function compareVersion(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

async function fetchLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Knot' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const r = (await res.json()) as { tag_name?: string; html_url?: string }
  if (!r.tag_name) throw new Error('无版本号')
  return { latest: r.tag_name, url: r.html_url || `https://github.com/${REPO}/releases` }
}

export async function checkUpdate(current: string, force = false): Promise<UpdateInfo> {
  // 开发版 / CI 构建没有可比较的版本号，不检查
  if (!parseVersion(current)) return { current, latest: null, url: null, hasUpdate: false }
  if (force || !cache || Date.now() - cache.at > cache.ttl) {
    try {
      cache = { at: Date.now(), ttl: TTL, ...(await fetchLatest()) }
    } catch (e: any) {
      console.warn(`检查新版本失败：${e?.cause?.message || e?.message || e}`)
      cache = { at: Date.now(), ttl: FAIL_TTL, latest: cache?.latest ?? null, url: cache?.url ?? null }
    }
  }
  const { latest, url } = cache
  return { current, latest, url, hasUpdate: !!latest && compareVersion(latest, current) > 0 }
}
