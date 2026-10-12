import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Trash2, RefreshCw } from 'lucide-react'
import type { LogEntry } from '@shared/types'
import { api, fmtDate, fmtTime } from '../lib/api'
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Spinner, Tabs, cx, useConfirm } from '../components/ui'

const ACTION: Record<string, string> = {
  profile: '订阅链接',
  short: '短链',
  share: '临时分享',
  password: '密码登录',
  passkey: '通行密钥登录',
  totp: '两步验证',
  logout: '退出登录',
  setup: '初始化密码',
  password_change: '修改密码',
  token_reset: '重置订阅链接',
  backup_restore: '恢复备份',
  backup_export: '下载备份',
  logs_clear: '清空日志',
  totp_enable: '开启两步验证',
  totp_disable: '关闭两步验证',
  passkey_add: '添加通行密钥',
  passkey_remove: '删除通行密钥',
  history_restore: '恢复历史版本',
  migration: '迁移导入',
}

/** 从 UA 识别客户端，方便一眼看出是谁在拉取 */
export function clientName(ua?: string): string {
  if (!ua) return '未知'
  const rules: [RegExp, string][] = [
    [/clash-verge|verge/i, 'Clash Verge'],
    [/flclash/i, 'FlClash'],
    [/nyanpasu/i, 'Clash Nyanpasu'],
    [/stash/i, 'Stash'],
    [/mihomo|clash\.meta|clashmeta/i, 'mihomo'],
    [/clash/i, 'Clash'],
    [/surge/i, 'Surge'],
    [/loon/i, 'Loon'],
    [/quantumult/i, 'Quantumult X'],
    [/shadowrocket/i, 'Shadowrocket'],
    [/v2rayng/i, 'v2rayNG'],
    [/v2rayn/i, 'v2rayN'],
    [/nekobox|nekoray/i, 'NekoBox'],
    [/hiddify/i, 'Hiddify'],
    [/sing-box|sfa|sfi|sfm/i, 'sing-box'],
    [/curl/i, 'curl'],
    [/edg\//i, 'Edge 浏览器'],
    [/chrome/i, 'Chrome 浏览器'],
    [/firefox/i, 'Firefox 浏览器'],
    [/safari/i, 'Safari 浏览器'],
  ]
  return rules.find(([re]) => re.test(ua))?.[1] || ua.slice(0, 30)
}

interface Stats {
  subPulls: number
  subDenied: number
  subIps: number
  loginOk: number
  loginFailed: number
  topFailedIps: [string, number][]
}

export default function LogsPage() {
  const [type, setType] = useState<'sub' | 'login' | 'admin' | 'all'>('sub')
  const [ok, setOk] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(100)
  const qc = useQueryClient()
  const confirm = useConfirm()
  const params = new URLSearchParams({ type, ok, q, limit: String(limit) })
  const logs = useQuery({ queryKey: ['logs', type, ok, q, limit], queryFn: () => api.get<{ items: LogEntry[]; total: number }>(`/logs?${params}`), refetchInterval: 15_000 })
  const stats = useQuery({ queryKey: ['logStats'], queryFn: () => api.get<Stats>('/logs/stats'), refetchInterval: 15_000 })

  const clear = async () => {
    const name = { sub: '订阅拉取', login: '面板登录', admin: '管理操作', all: '全部' }[type]
    if (!(await confirm({ title: `清空「${name}」日志？`, danger: true, okText: '清空' }))) return
    await api.del(`/logs?type=${type}`)
    qc.invalidateQueries({ queryKey: ['logs'] })
    qc.invalidateQueries({ queryKey: ['logStats'] })
  }

  const s = stats.data
  return (
    <div>
      <PageHeader
        title="日志"
        desc="谁拉取了订阅、谁尝试登录面板，以及敏感操作记录"
        actions={
          <>
            <Button onClick={() => { logs.refetch(); stats.refetch() }}><RefreshCw className={cx('size-4', logs.isFetching && 'animate-spin')} />刷新</Button>
            <Button variant="danger" onClick={clear}><Trash2 className="size-4" />清空</Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="24 小时订阅拉取" value={s?.subPulls} hint={s ? `${s.subIps} 个来源 IP` : ''} />
        <Stat label="24 小时被拒绝" value={s?.subDenied} warn={!!s?.subDenied} hint="过期 / 超次数 / 不在白名单 / 无效链接" />
        <Stat label="24 小时登录成功" value={s?.loginOk} />
        <Stat
          label="24 小时登录失败"
          value={s?.loginFailed}
          warn={!!s?.loginFailed}
          hint={s?.topFailedIps.length ? s.topFailedIps.map(([ip, n]) => `${ip} ×${n}`).join('，') : '无'}
        />
      </div>
      <Tabs
        value={type}
        onChange={(v) => { setType(v); setLimit(100) }}
        tabs={[
          { value: 'sub', label: '订阅拉取' },
          { value: 'login', label: '面板登录' },
          { value: 'admin', label: '管理操作' },
          { value: 'all', label: '全部' },
        ]}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 IP / 客户端 / 名称" className="pl-8" />
        </div>
        <Select value={ok} onChange={(e) => setOk(e.target.value)} className="w-32">
          <option value="">全部结果</option>
          <option value="true">成功</option>
          <option value="false">失败 / 拒绝</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {logs.isLoading ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : !logs.data?.items.length ? (
          <Empty title="暂无日志" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                  <th className="whitespace-nowrap px-2 py-2 font-medium">事件</th>
                  <th className="whitespace-nowrap px-2 py-2 font-medium">IP</th>
                  <th className="whitespace-nowrap px-2 py-2 font-medium">客户端</th>
                  <th className="px-2 py-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.items.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500" title={fmtDate(e.at)}>{fmtTime(e.at)}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className={cx('size-1.5 shrink-0 rounded-full', e.ok ? 'bg-emerald-500' : 'bg-red-500')} />
                        {ACTION[e.action] || e.action}
                        {e.target && <Badge>{e.target}</Badge>}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">
                      <button className="hover:text-blue-600" title="按此 IP 筛选" onClick={() => setQ(e.ip)}>{e.ip}</button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-zinc-600 dark:text-zinc-400" title={e.ua}>{clientName(e.ua)}</td>
                    <td className={cx('px-2 py-2 text-xs', e.ok ? 'text-zinc-600 dark:text-zinc-400' : 'text-red-600')}>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {logs.data && logs.data.total > logs.data.items.length && (
        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-zinc-500">
          显示 {logs.data.items.length} / {logs.data.total} 条
          <Button size="sm" onClick={() => setLimit(limit + 200)}>加载更多</Button>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint, warn }: { label: string; value?: number; hint?: string; warn?: boolean }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', warn && 'text-red-600')}>{value ?? '—'}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={hint}>{hint}</div>}
    </Card>
  )
}
