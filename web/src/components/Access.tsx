import { useState } from 'react'
import type { AccessControl, AccessLog } from '@shared/types'
import { fmtDate, fmtTime } from '../lib/api'
import { Badge, Button, Field, Input, Modal, Textarea, ToggleRow, cx, type BadgeColor } from './ui'

const HOUR = 3600_000
const QUICK_EXPIRE = [
  { label: '不限', ms: 0 },
  { label: '1 小时', ms: HOUR },
  { label: '1 天', ms: 24 * HOUR },
  { label: '7 天', ms: 7 * 24 * HOUR },
  { label: '30 天', ms: 30 * 24 * HOUR },
]

function toLocalInput(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 链接当前状态 */
export function accessStatus(ac: AccessControl): { label: string; color: BadgeColor; ok: boolean } {
  if (!ac.enabled) return { label: '已停用', color: 'zinc', ok: false }
  if (ac.expiresAt && Date.now() > ac.expiresAt) return { label: '已过期', color: 'red', ok: false }
  if (ac.maxUses && ac.uses >= ac.maxUses) return { label: '次数已用完', color: 'red', ok: false }
  return { label: '有效', color: 'green', ok: true }
}

export function accessSummary(ac: AccessControl): string[] {
  const out: string[] = []
  if (ac.expiresAt) {
    const left = ac.expiresAt - Date.now()
    out.push(left > 0 ? `${left < 2 * HOUR ? `${Math.max(1, Math.round(left / 60_000))} 分钟` : left < 48 * HOUR ? `${Math.round(left / HOUR)} 小时` : `${Math.round(left / 24 / HOUR)} 天`}后过期` : '已过期')
  }
  if (ac.maxUses) out.push(`已用 ${ac.uses}/${ac.maxUses} 次`)
  if (ac.rateLimitPerHour) out.push(`每小时 ≤${ac.rateLimitPerHour} 次`)
  if (ac.ipAllowlist.length) out.push(`IP 白名单 ${ac.ipAllowlist.length} 条`)
  return out
}

/** 访问控制设置表单（输出配置与临时分享共用） */
export function AccessEditor({ value, onChange }: { value: AccessControl; onChange: (v: AccessControl) => void }) {
  const set = <K extends keyof AccessControl>(k: K, v: AccessControl[K]) => onChange({ ...value, [k]: v })
  const [ipText, setIpText] = useState(value.ipAllowlist.join('\n'))
  return (
    <div className="space-y-4">
      <ToggleRow label="启用链接" hint="关闭后链接立即失效，客户端更新订阅会失败" checked={value.enabled} onChange={(v) => set('enabled', v)} />
      <Field label="有效期" hint={value.expiresAt ? `到期时间：${fmtDate(value.expiresAt)}` : '不限制'}>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_EXPIRE.map((q) => (
            <Button key={q.label} size="sm" type="button" onClick={() => set('expiresAt', q.ms ? Date.now() + q.ms : 0)}>{q.label}</Button>
          ))}
          <Input
            type="datetime-local"
            className="h-7 w-auto text-xs"
            value={toLocalInput(value.expiresAt)}
            onChange={(e) => set('expiresAt', e.target.value ? new Date(e.target.value).getTime() : 0)}
          />
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="最多拉取次数" hint="0 为不限。客户端每次更新订阅算一次">
          <div className="flex items-center gap-2">
            <Input type="number" min={0} value={value.maxUses} onChange={(e) => set('maxUses', Math.max(0, Number(e.target.value) || 0))} />
            <span className="shrink-0 text-xs text-zinc-500">已用 {value.uses}</span>
            {value.uses > 0 && <Button size="sm" type="button" onClick={() => set('uses', 0)}>清零</Button>}
          </div>
        </Field>
        <Field label="频率限制（次 / 小时）" hint="0 为不限，防止链接被滥用">
          <Input type="number" min={0} value={value.rateLimitPerHour} onChange={(e) => set('rateLimitPerHour', Math.max(0, Number(e.target.value) || 0))} />
        </Field>
      </div>
      <Field label="IP 白名单" hint="每行一个 IP 或网段（如 1.2.3.4、10.0.0.0/8、2001:db8::/32），留空不限制。经反向代理访问时会读取 X-Forwarded-For。">
        <Textarea
          rows={3}
          value={ipText}
          onChange={(e) => {
            setIpText(e.target.value)
            set('ipAllowlist', e.target.value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))
          }}
          placeholder="留空表示不限制"
        />
      </Field>
    </div>
  )
}

export function AccessLogModal({ open, onClose, title, logs }: { open: boolean; onClose: () => void; title: string; logs?: AccessLog[] }) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-2xl">
      {!logs?.length ? (
        <div className="py-8 text-center text-sm text-zinc-500">暂无访问记录</div>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {logs.map((l, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="w-24 shrink-0 text-xs text-zinc-500" title={fmtDate(l.at)}>{fmtTime(l.at)}</span>
              <span className="w-32 shrink-0 font-mono text-xs">{l.ip}</span>
              <Badge>{l.target}</Badge>
              <span className={cx('min-w-0 flex-1 truncate text-xs', l.denied ? 'text-red-600' : 'text-zinc-500')} title={l.ua}>
                {l.denied ? `拒绝：${l.denied}` : l.ua || '未知客户端'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
