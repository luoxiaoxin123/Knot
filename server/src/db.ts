import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AccessControl, DbData, Profile, Settings } from '../../shared/types.ts'
import { uid } from './core/util.ts'
import { MODULE_PRESETS } from './core/rules/modules.ts'

export const DATA_DIR = resolve(process.env.DATA_DIR || './data')
const FILE = join(DATA_DIR, 'db.json')

export function defaultSettings(): Settings {
  return {
    publicUrl: '',
    ruleMirror: 'github',
    ruleMirrorCustom: '',
    ruleDownloadViaProxy: true,
    testUrl: 'https://www.gstatic.com/generate_204',
    s3: {
      enabled: false,
      endpoint: '',
      region: 'auto',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: 'switch/',
      pathStyle: false,
      intervalHours: 24,
      keep: 14,
    },
    corePath: '',
  }
}

export function defaultAccess(): AccessControl {
  return { enabled: true, expiresAt: 0, maxUses: 0, uses: 0, rateLimitPerHour: 0, ipAllowlist: [] }
}

export function newProfile(name: string): Profile {
  return {
    id: uid(),
    name,
    token: randomBytes(16).toString('hex'),
    nodeMode: 'all',
    sources: [],
    nodeIds: [],
    includeRegex: '',
    excludeRegex: '',
    ruleMode: 'modules',
    modules: MODULE_PRESETS.find((p) => p.id === 'standard')!.modules,
    useCustomRules: true,
    regionGroups: true,
    groupsIncludeNodes: true,
    addFlags: true,
    trafficInfo: true,
    overrideYaml: '',
    groupMode: 'auto',
    customGroups: [],
    knownNodeIds: [],
    accessControl: defaultAccess(),
    createdAt: Date.now(),
  }
}

/** 补全旧版本数据缺少的字段 */
export function migrate(d: DbData) {
  for (const p of d.profiles) {
    p.groupMode ??= 'auto'
    p.customGroups ??= []
    p.knownNodeIds ??= []
    p.accessControl = { ...defaultAccess(), ...p.accessControl }
  }
  d.shares ??= []
  for (const s of d.shares) s.accessControl = { ...defaultAccess(), ...s.accessControl }
}

function defaults(): DbData {
  return {
    version: 1,
    auth: { secret: randomBytes(32).toString('hex') },
    settings: defaultSettings(),
    nodes: [],
    subscriptions: [],
    profiles: [newProfile('默认')],
    customRules: [],
    templates: [],
    shares: [],
  }
}

class Store {
  data: DbData
  private timer: NodeJS.Timeout | null = null

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'))
      const d = defaults()
      this.data = {
        ...d,
        ...raw,
        auth: { ...d.auth, ...raw.auth },
        settings: { ...d.settings, ...raw.settings, s3: { ...d.settings.s3, ...raw.settings?.s3 } },
      }
      migrate(this.data)
    } else {
      this.data = defaults()
      this.flush()
    }
  }

  /** 合并短时间内的多次写入 */
  save() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 200)
  }

  flush() {
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, FILE)
  }
}

export const db = new Store()

process.on('SIGINT', () => {
  db.flush()
  process.exit(0)
})
process.on('SIGTERM', () => {
  db.flush()
  process.exit(0)
})
