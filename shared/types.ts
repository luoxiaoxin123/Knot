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
  /** 手动设置的旗帜（ISO 3166 两位代码，如 JP）。输出时加在节点名前，地区分组也以它为准 */
  flag?: string
  /** 最近一次测速结果（ms），-1 表示失败 */
  latency?: number
  latencyAt?: number
  /** 测速方式：tcp 握手 / 内核真实延迟 */
  latencyKind?: 'tcp' | 'real'
  /** 最近一次可用性与解锁检测 */
  check?: NodeCheck
}

export type UnlockStatus = 'yes' | 'no' | 'partial' | 'error'

export interface NodeCheck {
  at: number
  /** 内核真实延迟（ms），-1 不可用 */
  delay: number
  /** 落地出口 IP / 地区 */
  ip?: string
  country?: string
  unlock?: Partial<Record<UnlockService, { status: UnlockStatus; region?: string; note?: string }>>
  error?: string
}

export const UNLOCK_SERVICES = ['chatgpt', 'claude', 'gemini', 'netflix', 'youtube'] as const
export type UnlockService = (typeof UNLOCK_SERVICES)[number]

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

/** mihomo 支持的规则类型（MATCH 由分流模块生成，SUB-RULE 需要 sub-rules 配置，不在此列） */
export const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'GEOIP',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'SRC-GEOIP',
  'SRC-IP-ASN',
  'SRC-IP-CIDR',
  'SRC-IP-SUFFIX',
  'DST-PORT',
  'SRC-PORT',
  'IN-PORT',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'PROCESS-NAME',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH',
  'PROCESS-PATH-WILDCARD',
  'PROCESS-PATH-REGEX',
  'UID',
  'NETWORK',
  'DSCP',
  'RULE-SET',
  'AND',
  'OR',
  'NOT',
] as const
/** 可以加 no-resolve 的类型 */
export const NO_RESOLVE_TYPES: ReadonlySet<string> = new Set(['IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP', 'SRC-IP-CIDR', 'RULE-SET'])
export type RuleType = (typeof RULE_TYPES)[number]

export type RulePosition = 'head' | 'tail'

/** 自定义规则：一条普通规则 / 一组规则（规则集）/ 一个远程规则集(rule-provider) */
export interface CustomRule {
  id: string
  enabled: boolean
  position: RulePosition
  /** 备注 */
  remark: string
  kind: 'rule' | 'set' | 'ruleset'
  // kind = set：多行规则，每行「类型,值[,策略][,no-resolve]」，省略策略时使用 policy
  rules?: string
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

/** 订阅访问控制（输出配置与临时分享共用） */
export interface AccessControl {
  /** 停用后链接立即失效 */
  enabled: boolean
  /** 到期时间（ms 时间戳），0 为不限 */
  expiresAt: number
  /** 最多被拉取次数，0 为不限 */
  maxUses: number
  /** 已拉取次数 */
  uses: number
  /** 每小时最多拉取次数，0 为不限 */
  rateLimitPerHour: number
  /** IP 白名单（IP 或 CIDR），为空不限制 */
  ipAllowlist: string[]
}

export interface AccessLog {
  at: number
  ip: string
  ua: string
  target: string
  /** 被拒绝的原因 */
  denied?: string
}

export type ProxyGroupType = 'select' | 'url-test' | 'fallback' | 'load-balance'

/** 自定义代理组。成员：`node:<节点id>` / 其他分组名 / DIRECT / REJECT */
export interface CustomGroup {
  id: string
  name: string
  type: ProxyGroupType
  members: string[]
  /** 订阅新增的节点自动加入（受 filter 约束） */
  autoNew: boolean
  /** 自动加入新节点时的名称正则 */
  filter: string
  /** 来自自动生成分组时的原名：规则里引用原名的会改指向本组 */
  origin?: string
}

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
  /** 节点名前加上节点页手动设置的旗帜 */
  addFlags: boolean
  /** 下发 subscription-userinfo：汇总所选外部订阅的流量信息 */
  trafficInfo: boolean
  /** 合并进生成配置的 YAML（dns / tun / 端口等） */
  overrideYaml: string
  /** 代理组：auto 按规则自动生成；custom 使用拖拽编辑的分组 */
  groupMode: 'auto' | 'custom'
  customGroups: CustomGroup[]
  /** 保存自定义分组时已存在的节点 id，用于识别之后新增的节点 */
  knownNodeIds: string[]
  accessControl: AccessControl
  /** 短链代码：/x/<code>，未生成时为空 */
  shortCode?: string
  createdAt: number
  /** 最近访问记录 */
  access?: AccessLog[]
}

/** 临时分享：把少量节点临时给别人用，可限制次数 / 时间，随时作废 */
export interface Share {
  id: string
  name: string
  token: string
  nodeIds: string[]
  /** 附带分流规则（Clash / sing-box 客户端）；关闭时只有节点 */
  withRules: boolean
  accessControl: AccessControl
  createdAt: number
  access?: AccessLog[]
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
  /** mihomo 内核路径（真实测速 / 解锁检测），留空自动查找 */
  corePath: string
  /** 日志保留天数 */
  logRetentionDays: number
}

export interface Passkey {
  /** credential id（base64url） */
  id: string
  /** 公钥（base64url） */
  publicKey: string
  counter: number
  transports?: string[]
  name: string
  rpID: string
  createdAt: number
  lastUsedAt?: number
}

export interface AuthData {
  passwordHash?: string
  secret: string
  totp?: { secret: string; enabled: boolean; lastStep?: number; recoveryHashes: string[] }
  passkeys?: Passkey[]
}

export interface DbData {
  version: number
  auth: AuthData
  settings: Settings
  nodes: Node[]
  subscriptions: Subscription[]
  profiles: Profile[]
  customRules: CustomRule[]
  templates: RuleTemplate[]
  shares: Share[]
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

export type OutputTarget = 'clash' | 'stash' | 'singbox' | 'surge' | 'loon' | 'qx' | 'v2ray'

// ---------------- 日志 ----------------

export type LogType = 'sub' | 'login' | 'admin'

export interface LogEntry {
  id: string
  at: number
  type: LogType
  /** sub: profile / short / share；login: password / passkey / logout；admin: 具体操作 */
  action: string
  ok: boolean
  ip: string
  ua?: string
  /** 订阅格式 / 操作对象 */
  target?: string
  /** 名称、失败原因等 */
  detail?: string
}
