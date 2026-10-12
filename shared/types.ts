// 前后端共享的数据结构。节点内部统一使用 mihomo(Clash.Meta) 的 proxy 字段格式存储，
// 导出时再转换为 V2Ray 分享链接 / sing-box outbound。

export type ProxyType =
  | 'ss'
  | 'ssr'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria'
  | 'hysteria2'
  | 'tuic'
  | 'anytls'
  | 'wireguard'
  | 'socks5'
  | 'http'
  | (string & {})

/** mihomo proxy 对象（name/type/server/port 必填，其余字段按协议） */
export interface Proxy {
  name: string
  type: ProxyType
  server: string
  port: number
  [key: string]: any
}

export type NodeSource =
  | { kind: 'manual' }
  | { kind: 'sub'; subId: string }
  | { kind: 'chain'; targetId: string; relayId: string }

export interface Node {
  id: string
  name: string
  /** 链式节点的 proxy 在导出时由目标节点动态派生，这里存的是创建时的快照 */
  proxy: Proxy
  source: NodeSource
  enabled: boolean
  tags: string[]
  createdAt: number
  /** 最近一次 TCP 测速结果（ms），-1 表示失败 */
  latency?: number
  latencyAt?: number
}

export interface SubTraffic {
  upload: number
  download: number
  total: number
  /** unix 秒 */
  expire?: number
}

export interface Subscription {
  id: string
  name: string
  url: string
  userAgent: string
  /** 自动更新间隔（小时），0 为不自动更新 */
  intervalHours: number
  /** 节点名正则过滤 */
  includeRegex: string
  excludeRegex: string
  /** 给节点名加的前缀 */
  namePrefix: string
  enabled: boolean
  createdAt: number
  updatedAt?: number
  lastError?: string
  traffic?: SubTraffic
  nodeCount?: number
}

// ---------------- 规则 ----------------

export type RulePolicy = string // 代理组名 / DIRECT / REJECT / 节点名

export const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'GEOIP',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'SRC-IP-CIDR',
  'DST-PORT',
  'SRC-PORT',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'NETWORK',
  'RULE-SET',
] as const
export type RuleType = (typeof RULE_TYPES)[number]

export type RulePosition = 'head' | 'tail'

/** 自定义规则：一条普通规则，或一个规则集(rule-provider) */
export interface CustomRule {
  id: string
  enabled: boolean
  position: RulePosition
  /** 备注 */
  remark: string
  kind: 'rule' | 'ruleset'
  // kind = rule
  type?: RuleType
  value?: string
  noResolve?: boolean
  // kind = ruleset
  url?: string
  behavior?: 'domain' | 'ipcidr' | 'classical'
  format?: 'yaml' | 'text' | 'mrs'
  interval?: number
  /** 目标策略：代理组 / DIRECT / REJECT / 节点名 / 或 "new:组名" 新建分组 */
  policy: RulePolicy
  order: number
}

/** 导入的外部规则模板 */
export interface RuleTemplate {
  id: string
  name: string
  /** clash: 完整的 Clash/mihomo YAML；ini: subconverter / ACL4SSR 格式 */
  kind: 'clash' | 'ini'
  url?: string
  content: string
  updatedAt: number
  lastError?: string
}

// ---------------- 输出订阅 ----------------

export type NodeSelectMode = 'all' | 'sources' | 'pick'

export interface Profile {
  id: string
  name: string
  token: string
  nodeMode: NodeSelectMode
  /** nodeMode = sources 时：'manual' | 'chain' | subId */
  sources: string[]
  /** nodeMode = pick 时 */
  nodeIds: string[]
  includeRegex: string
  excludeRegex: string
  /** 规则来源：内置模块 或 导入的模板 */
  ruleMode: 'modules' | 'template'
  modules: string[]
  templateId?: string
  useCustomRules: boolean
  /** 自动生成地区分组(香港/日本/美国…) */
  regionGroups: boolean
  /** 分流组里是否列出全部节点（可单独指定节点） */
  groupsIncludeNodes: boolean
  /** 节点名前自动加国旗 */
  addFlags: boolean
  /** 下发 subscription-userinfo：汇总所选外部订阅的流量信息 */
  trafficInfo: boolean
  /** 合并进生成配置的 YAML（dns / tun / 端口等） */
  overrideYaml: string
  createdAt: number
  /** 最近访问记录 */
  access?: { at: number; ip: string; ua: string; target: string }[]
}

export interface S3Config {
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  pathStyle: boolean
  /** 自动备份间隔（小时），0 为关闭 */
  intervalHours: number
  /** 保留份数 */
  keep: number
  lastBackupAt?: number
  lastError?: string
}

export interface Settings {
  /** 对外访问地址，用于生成订阅链接，例如 https://sub.example.com */
  publicUrl: string
  /** 规则集下载镜像 */
  ruleMirror: 'github' | 'jsdelivr' | 'custom'
  ruleMirrorCustom: string
  /** 规则集通过代理下载 */
  ruleDownloadViaProxy: boolean
  testUrl: string
  s3: S3Config
}

export interface DbData {
  version: number
  auth: { passwordHash?: string; secret: string }
  settings: Settings
  nodes: Node[]
  subscriptions: Subscription[]
  profiles: Profile[]
  customRules: CustomRule[]
  templates: RuleTemplate[]
}

/** 内置分流模块（只读描述，用于前端展示） */
export interface RuleModuleInfo {
  id: string
  name: string
  description: string
  /** 固定模块不生成代理组（如局域网直连） */
  fixed?: boolean
  defaultPolicy: 'proxy' | 'direct' | 'reject'
}

export type OutputTarget = 'clash' | 'singbox' | 'v2ray'
