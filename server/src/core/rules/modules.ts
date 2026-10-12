// 内置分流模块。规则源统一使用 MetaCubeX/meta-rules-dat：
// - 基于 v2fly/domain-list-community 与 Loyalsoldier geoip，每日自动更新
// - mihomo 使用 .mrs 二进制格式（体积小、加载快），sing-box 使用同源的 .srs
// 模块顺序即规则顺序：局域网 → 广告 → 各服务 → 国外 → 国内 → 兜底。

export interface ModuleRule {
  geosite?: string
  geoip?: string
}

export interface RuleModule {
  id: string
  /** 代理组名 */
  name: string
  description: string
  /** 固定策略：不生成代理组，直接指向 DIRECT / 节点选择 */
  fixed?: 'DIRECT' | 'PROXY'
  /** 组内第一个（默认）选项 */
  defaultPolicy: 'proxy' | 'direct' | 'reject'
  rules: ModuleRule[]
  /** 必选模块 */
  required?: boolean
}

export const PROXY_GROUP = '🚀 节点选择'
export const AUTO_GROUP = '♻️ 自动选择'

export const MODULES: RuleModule[] = [
  {
    id: 'private',
    name: '🏠 局域网',
    description: '局域网、私有地址直连',
    fixed: 'DIRECT',
    defaultPolicy: 'direct',
    rules: [{ geosite: 'private' }, { geoip: 'private' }],
  },
  {
    id: 'ads',
    name: '🛑 广告拦截',
    description: '常见广告与追踪域名（category-ads-all），可在客户端切换为直连',
    defaultPolicy: 'reject',
    rules: [{ geosite: 'category-ads-all' }],
  },
  {
    id: 'ai',
    name: '🤖 AI 服务',
    description: 'ChatGPT / Claude / Gemini / Copilot / Perplexity 等（category-ai-!cn），建议固定美国节点',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'category-ai-!cn' }],
  },
  {
    id: 'telegram',
    name: '📲 Telegram',
    description: 'Telegram 域名与 IP 段',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'telegram' }, { geoip: 'telegram' }],
  },
  {
    id: 'youtube',
    name: '📹 YouTube',
    description: 'YouTube',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'youtube' }],
  },
  {
    id: 'google',
    name: '🔍 Google',
    description: 'Google 全家桶（不含 YouTube）',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'google' }, { geoip: 'google' }],
  },
  {
    id: 'github',
    name: '🐱 GitHub',
    description: 'GitHub 及其 CDN',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'github' }],
  },
  {
    id: 'twitter',
    name: '🐦 X / Twitter',
    description: 'X (Twitter)',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'twitter' }, { geoip: 'twitter' }],
  },
  {
    id: 'meta',
    name: '📘 Meta',
    description: 'Facebook / Instagram / WhatsApp',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'facebook' }, { geosite: 'instagram' }, { geosite: 'whatsapp' }, { geoip: 'facebook' }],
  },
  {
    id: 'discord',
    name: '🎧 Discord',
    description: 'Discord',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'discord' }],
  },
  {
    id: 'netflix',
    name: '🎥 Netflix',
    description: 'Netflix（需要解锁节点）',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'netflix' }, { geoip: 'netflix' }],
  },
  {
    id: 'disney',
    name: '🏰 Disney+',
    description: 'Disney+',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'disney' }],
  },
  {
    id: 'media',
    name: '🌍 国外媒体',
    description: 'Spotify / HBO / Prime Video / TikTok / Twitch',
    defaultPolicy: 'proxy',
    rules: [
      { geosite: 'spotify' },
      { geosite: 'hbo' },
      { geosite: 'primevideo' },
      { geosite: 'tiktok' },
      { geosite: 'twitch' },
    ],
  },
  {
    id: 'games',
    name: '🎮 游戏平台',
    description: 'Steam / Epic / PlayStation / Nintendo（国内 CDN 下载走直连）',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'steam' }, { geosite: 'epicgames' }, { geosite: 'playstation' }, { geosite: 'nintendo' }],
  },
  {
    id: 'microsoft',
    name: 'Ⓜ️ 微软服务',
    description: 'Microsoft / OneDrive / Bing，默认直连',
    defaultPolicy: 'direct',
    rules: [{ geosite: 'microsoft' }, { geosite: 'onedrive' }, { geosite: 'bing' }],
  },
  {
    id: 'apple',
    name: '🍎 苹果服务',
    description: 'Apple，默认直连',
    defaultPolicy: 'direct',
    rules: [{ geosite: 'apple' }],
  },
  {
    id: 'bilibili',
    name: '📺 哔哩哔哩',
    description: 'B 站，默认直连，看港澳台番剧时可切换',
    defaultPolicy: 'direct',
    rules: [{ geosite: 'bilibili' }],
  },
  {
    id: 'gfw',
    name: '🌐 国外网站',
    description: '其余非中国大陆域名（geolocation-!cn）走节点选择',
    fixed: 'PROXY',
    defaultPolicy: 'proxy',
    rules: [{ geosite: 'geolocation-!cn' }],
  },
  {
    id: 'cn',
    name: '🎯 国内直连',
    description: '中国大陆域名与 IP（cn），默认直连',
    defaultPolicy: 'direct',
    rules: [{ geosite: 'cn' }, { geoip: 'cn' }],
  },
  {
    id: 'final',
    name: '🐟 漏网之鱼',
    description: '未命中任何规则的流量',
    defaultPolicy: 'proxy',
    rules: [],
    required: true,
  },
]

export const MODULE_MAP = new Map(MODULES.map((m) => [m.id, m]))

export const MODULE_PRESETS: { id: string; name: string; description: string; modules: string[] }[] = [
  {
    id: 'minimal',
    name: '极简',
    description: '只区分国内/国外，适合不想折腾的场景',
    modules: ['private', 'ads', 'gfw', 'cn', 'final'],
  },
  {
    id: 'standard',
    name: '推荐',
    description: '常用服务单独分组，日常使用够用',
    modules: ['private', 'ads', 'ai', 'telegram', 'youtube', 'google', 'github', 'twitter', 'netflix', 'microsoft', 'apple', 'gfw', 'cn', 'final'],
  },
  {
    id: 'full',
    name: '完整',
    description: '全部模块',
    modules: MODULES.map((m) => m.id),
  },
]

/** 按模块顺序排序并补全必选模块 */
export function normalizeModules(ids: string[]): RuleModule[] {
  const set = new Set(ids)
  return MODULES.filter((m) => m.required || set.has(m.id))
}

export type MirrorKind = 'github' | 'jsdelivr' | 'custom'

export function geoUrl(
  kind: 'geosite' | 'geoip',
  name: string,
  target: 'mihomo' | 'singbox',
  mirror: MirrorKind,
  custom = '',
): string {
  const branch = target === 'mihomo' ? 'meta' : 'sing'
  const ext = target === 'mihomo' ? 'mrs' : 'srs'
  const file = `geo/${kind}/${name}.${ext}`
  const raw = `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/${branch}/${file}`
  if (mirror === 'jsdelivr') return `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@${branch}/${file}`
  if (mirror === 'custom' && custom) {
    const c = custom.trim()
    // {url} 占位符或直接作为前缀（如 https://ghfast.top/）
    return c.includes('{url}') ? c.replace('{url}', raw) : c.replace(/\/?$/, '/') + raw
  }
  return raw
}
