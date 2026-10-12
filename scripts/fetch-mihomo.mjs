// 下载 mihomo 内核（Docker 构建时使用）：node scripts/fetch-mihomo.mjs <版本> <输出路径>
import { chmodSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const [version = 'v1.19.32', out = '/mihomo'] = process.argv.slice(2)
const archMap = { amd64: 'amd64-compatible', x64: 'amd64-compatible', arm64: 'arm64' }
const arch = archMap[process.env.TARGETARCH || process.arch] || process.env.TARGETARCH || process.arch
const url = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/mihomo-linux-${arch}-${version}.gz`
const res = await fetch(url)
if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
writeFileSync(out, gunzipSync(Buffer.from(await res.arrayBuffer())))
chmodSync(out, 0o755)
console.log(`mihomo ${version} (${arch}) -> ${out}`)
