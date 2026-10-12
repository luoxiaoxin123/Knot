import type { DbData } from '../../../shared/types.ts'
import { db, defaultSettings, migrate } from '../db.ts'
import { s3Delete, s3List, s3Put, s3Get } from './s3.ts'

export interface BackupFile {
  app: 'switch'
  version: number
  exportedAt: string
  data: Omit<DbData, 'auth' | 'version'>
}

/** 备份内容：节点、订阅、输出配置、规则、模板、设置（不含 S3 凭据与登录信息） */
export function exportBackup(): BackupFile {
  const d = db.data
  const { s3, ...settings } = d.settings
  return {
    app: 'switch',
    version: d.version,
    exportedAt: new Date().toISOString(),
    data: {
      settings: { ...settings, s3: { ...s3, accessKeyId: '', secretAccessKey: '' } },
      nodes: d.nodes,
      subscriptions: d.subscriptions,
      profiles: d.profiles,
      customRules: d.customRules,
      templates: d.templates,
      shares: d.shares,
    },
  }
}

export function importBackup(raw: any) {
  const b = raw?.app === 'switch' ? raw.data : raw
  if (!b || !Array.isArray(b.nodes) || !Array.isArray(b.profiles)) throw new Error('不是有效的备份文件')
  const keepS3 = db.data.settings.s3
  db.data.settings = { ...defaultSettings(), ...(b.settings || {}), s3: keepS3 }
  db.data.nodes = b.nodes
  db.data.subscriptions = b.subscriptions || []
  db.data.profiles = b.profiles
  db.data.customRules = b.customRules || []
  db.data.templates = b.templates || []
  db.data.shares = b.shares || []
  migrate(db.data)
  db.flush()
}

function prefix() {
  const p = db.data.settings.s3.prefix.trim().replace(/^\/+/, '')
  return p && !p.endsWith('/') ? p + '/' : p
}

export async function backupToS3(): Promise<string> {
  const cfg = db.data.settings.s3
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('S3 未配置完整')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const key = `${prefix()}switch-backup-${ts}.json`
  try {
    await s3Put(cfg, key, JSON.stringify(exportBackup()))
    cfg.lastBackupAt = Date.now()
    cfg.lastError = undefined
    // 清理旧备份
    if (cfg.keep > 0) {
      const list = (await listS3Backups()).slice(cfg.keep)
      for (const o of list) await s3Delete(cfg, o.key).catch(() => {})
    }
    return key
  } catch (e: any) {
    cfg.lastError = e.message
    throw e
  } finally {
    db.save()
  }
}

export async function listS3Backups() {
  const cfg = db.data.settings.s3
  const list = await s3List(cfg, prefix())
  return list.filter((o) => /switch-backup-.*\.json$/.test(o.key)).sort((a, b) => (a.key < b.key ? 1 : -1))
}

export async function restoreFromS3(key: string) {
  const text = await s3Get(db.data.settings.s3, key)
  importBackup(JSON.parse(text))
}
