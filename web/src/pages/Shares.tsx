import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2, QrCode, History, Send, Ban, Info } from 'lucide-react'
import type { Share } from '@shared/types'
import { api, fmtTime } from '../lib/api'
import { subBase, useNodes, useSettings, useShares } from '../lib/hooks'
import { Badge, Card, CopyButton, Empty, IconButton, PageHeader, Spinner, cx, useConfirm, useToast } from '../components/ui'
import { QrModal } from '../components/Qr'
import { AccessLogModal, accessStatus, accessSummary } from '../components/Access'
import { ShareModal } from '../components/ShareModal'

export default function SharesPage() {
  const { data: shares, isLoading } = useShares()
  const { data: nodes } = useNodes()
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [qr, setQr] = useState<{ title: string; text: string } | null>(null)
  const [logsOf, setLogsOf] = useState<Share | null>(null)
  const [editing, setEditing] = useState<Share | null>(null)
  const base = subBase(settings)
  const nodeName = new Map((nodes || []).map((n) => [n.id, n.name]))
  const reload = () => qc.invalidateQueries({ queryKey: ['shares'] })

  const revoke = async (s: Share) => {
    await api.put(`/shares/${s.id}`, { accessControl: { enabled: false } })
    toast('已作废')
    reload()
  }
  const remove = async (s: Share) => {
    if (!(await confirm({ title: `删除分享「${s.name}」？`, danger: true, okText: '删除' }))) return
    await api.del(`/shares/${s.id}`)
    reload()
  }

  return (
    <div>
      <PageHeader title="临时分享" desc="把少量节点临时给别人用：限制拉取次数和有效期，随时作废。在「节点」页勾选节点后点「临时分享」创建。" />
      <Card className="mb-4 flex gap-3 p-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        <Info className="mt-0.5 size-4 shrink-0 text-blue-600" />
        <div>
          <p>分享链接失效后，对方无法再更新订阅；但已导入的节点仍包含连接密码，在你修改该节点的密码 / UUID 之前依然可以连接。</p>
          <p className="mt-1">如果需要“到期立刻断开”，需要让对方使用独立的凭据：在节点服务端（如 3x-ui 面板）为分享单独创建一个带到期时间 / 流量上限的用户，或者由本服务转发流量并在到期时删除该用户。</p>
        </div>
      </Card>
      {isLoading ? (
        <div className="flex justify-center py-14"><Spinner /></div>
      ) : !shares?.length ? (
        <Card><Empty icon={<Send className="size-8" />} title="还没有分享" desc="在「节点」页勾选要分享的节点，点击上方操作栏里的「临时分享」。" /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {shares.map((s) => {
              const url = `${base}/s/${s.token}`
              const st = accessStatus(s.accessControl)
              const names = s.nodeIds.map((id) => nodeName.get(id) ?? '（已删除）')
              return (
                <li key={s.id} className={cx('px-4 py-3', !st.ok && 'opacity-60')}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 max-w-full">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 font-medium wrap-anywhere">{s.name}</span>
                        <Badge color={st.color}>{st.label}</Badge>
                        {s.withRules && <Badge>含分流规则</Badge>}
                      </div>
                      <div className="mt-1 truncate text-xs text-zinc-500" title={names.join('、')}>
                        {names.join('、')}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {fmtTime(s.createdAt)}创建{accessSummary(s.accessControl).map((x) => ` · ${x}`)}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5">
                      {st.ok && <CopyButton text={url} label="复制链接" />}
                      {st.ok && <IconButton title="二维码" onClick={() => setQr({ title: s.name, text: url })}><QrCode className="size-4" /></IconButton>}
                      <IconButton title="访问记录" onClick={() => setLogsOf(s)}><History className="size-4" /></IconButton>
                      <IconButton title="编辑 / 续期" onClick={() => setEditing(s)}><Pencil className="size-4" /></IconButton>
                      {s.accessControl.enabled && <IconButton title="立即作废" onClick={() => revoke(s)}><Ban className="size-4" /></IconButton>}
                      <IconButton title="删除" onClick={() => remove(s)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
      <QrModal open={!!qr} onClose={() => setQr(null)} title={qr?.title || ''} text={qr?.text || ''} />
      <AccessLogModal open={!!logsOf} onClose={() => setLogsOf(null)} title={`访问记录 · ${logsOf?.name || ''}`} logs={logsOf?.access} />
      {editing && <ShareModal share={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
