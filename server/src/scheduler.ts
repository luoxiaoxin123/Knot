import { db } from './db.ts'
import { refreshSubscription, refreshTemplate } from './services/subscription.ts'
import { backupToS3 } from './services/backup.ts'
import { pruneLogs } from './logs.ts'

const HOUR = 3600_000
let running = false
let lastBackupAttempt = 0

async function tick() {
  if (running) return
  running = true
  const now = Date.now()
  try {
    pruneLogs()
    for (const s of db.data.subscriptions) {
      if (!s.enabled || !s.intervalHours) continue
      if (now - (s.updatedAt || 0) < s.intervalHours * HOUR) continue
      await refreshSubscription(s).catch((e) => console.warn(`[订阅] ${s.name} 更新失败: ${e.message}`))
    }
    for (const t of db.data.templates) {
      if (t.url && now - t.updatedAt > 24 * HOUR) {
        await refreshTemplate(t.id).catch((e) => console.warn(`[模板] ${t.name} 更新失败: ${e.message}`))
      }
    }
    const s3 = db.data.settings.s3
    if (s3.enabled && s3.intervalHours > 0 && now - (s3.lastBackupAt || 0) >= s3.intervalHours * HOUR) {
      // 失败后至少间隔 1 小时再重试
      if (now - lastBackupAttempt >= HOUR) {
        lastBackupAttempt = now
        await backupToS3()
          .then((k) => console.log(`[备份] 已上传 ${k}`))
          .catch((e) => console.warn(`[备份] 失败: ${e.message}`))
      }
    }
  } finally {
    running = false
  }
}

export function startScheduler() {
  setTimeout(tick, 10_000)
  setInterval(tick, 60_000)
}
