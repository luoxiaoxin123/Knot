import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, QrCode, RotateCcw, Share2, ExternalLink, History, Link2, X } from 'lucide-react'
import type { Profile } from '@shared/types'
import { api, fmtTime } from '../lib/api'
import { subBase, useNodes, useProfiles, useSettings, useSubs, useTemplates } from '../lib/hooks'
import { Badge, Button, Card, CopyButton, Empty, Field, IconButton, Input, Modal, PageHeader, Spinner, cx, useConfirm, useToast } from '../components/ui'
import { AccessLogModal, accessStatus, accessSummary } from '../components/Access'
import { QrModal } from '../components/Qr'
import { countNodes } from '../lib/select'

const TARGETS = [
  { key: '', label: '自动识别', hint: '根据客户端 UA 自动返回对应格式（推荐）' },
  { key: 'clash', label: 'Clash', hint: 'Clash Verge Rev、FlClash、Clash Meta for Android 等 mihomo 内核客户端' },
  { key: 'stash', label: 'Stash', hint: 'Stash（iOS / macOS）' },
  { key: 'singbox', label: 'sing-box', hint: 'sing-box 官方客户端（SFA / SFI / SFM）' },
  { key: 'surge', label: 'Surge', hint: 'Surge（不支持 VLESS；支持链式代理）' },
  { key: 'loon', label: 'Loon', hint: 'Loon（不支持 TUIC 与链式代理）' },
  { key: 'qx', label: 'Quantumult X', hint: 'Quantumult X（不支持 Hysteria2 / TUIC 与链式代理）' },
  { key: 'v2ray', label: 'V2Ray', hint: 'v2rayN、v2rayNG、Shadowrocket、NekoBox 等（Base64 分享链接）' },
]

export function subUrl(base: string, p: Profile, target = '') {
  return `${base}/sub/${p.token}${target ? `?target=${target}` : ''}`
}

export default function ProfilesPage() {
  const { data: profiles, isLoading } = useProfiles()
  const { data: settings } = useSettings()
  const { data: nodes } = useNodes()
  const { data: subs } = useSubs()
  const { data: templates } = useTemplates()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [qr, setQr] = useState<{ title: string; text: string } | null>(null)
  const [logsOf, setLogsOf] = useState<Profile | null>(null)
  const [aliasOf, setAliasOf] = useState<Profile | null>(null)
  const base = subBase(settings)
  const reload = () => qc.invalidateQueries({ queryKey: ['profiles'] })

  const create = async () => {
    const p = await api.post<Profile>('/profiles', { name: `配置 ${(profiles?.length || 0) + 1}` })
    await reload()
    nav(`/profiles/${p.id}`)
  }
  const remove = async (p: Profile) => {
    if (!(await confirm({ title: `删除「${p.name}」？`, body: '已导入该订阅的客户端将无法再更新。', danger: true, okText: '删除' }))) return
    await api.del(`/profiles/${p.id}`)
    reload()
  }
  const resetToken = async (p: Profile) => {
    if (!(await confirm({ title: '重置订阅链接？', body: '旧链接会立即失效，需要在客户端重新导入新链接。适用于链接泄露的情况。', okText: '重置' }))) return
    await api.post(`/profiles/${p.id}/reset-token`)
    toast('已重置')
    reload()
  }
  const genShort = async (p: Profile) => {
    await api.post(`/profiles/${p.id}/short`).catch((e) => toast(e.message, 'error'))
    reload()
  }
  const delShort = async (p: Profile) => {
    if (!(await confirm({ title: '删除短链？', body: '使用短链导入的客户端将无法再更新。', danger: true, okText: '删除' }))) return
    await api.del(`/profiles/${p.id}/short`)
    reload()
  }

  return (
    <div>
      <PageHeader
        title="订阅输出"
        desc="每个输出配置生成一个订阅链接，可分别选择节点与规则，导入 Clash / sing-box / V2Ray 客户端"
        actions={<Button variant="primary" onClick={create}><Plus className="size-4" />新建</Button>}
      />
      {!settings?.publicUrl && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
          尚未设置对外访问地址，订阅链接使用当前浏览器地址 <code>{window.location.origin}</code>。如果你通过反向代理 / 域名访问，请到「设置」中填写。
        </div>
      )}
      {isLoading ? (
        <div className="flex justify-center py-14"><Spinner /></div>
      ) : !profiles?.length ? (
        <Card><Empty icon={<Share2 className="size-8" />} title="还没有订阅输出" action={<Button variant="primary" onClick={create}><Plus className="size-4" />新建</Button>} /></Card>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => {
            const count = countNodes(p, nodes || [], subs || [])
            const tpl = p.ruleMode === 'template' ? templates?.find((t) => t.id === p.templateId) : null
            const last = p.access?.find((a) => !a.denied)
            const st = accessStatus(p.accessControl)
            const limits = accessSummary(p.accessControl)
            return (
              <Card key={p.id}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                  <div className="min-w-0 max-w-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 font-medium wrap-anywhere">{p.name}</span>
                      <Badge color="blue">{count} 节点</Badge>
                      <Badge>{tpl ? `模板：${tpl.name}` : `${p.modules.length} 个分流模块`}</Badge>
                      {p.groupMode === 'custom' && <Badge color="violet">自定义分组</Badge>}
                      <Badge color={st.color}>{st.label}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {last ? `最近更新：${fmtTime(last.at)} · ${last.target} · ${last.ua || '未知客户端'}` : '尚未被客户端拉取'}
                      {limits.length > 0 && <span> · {limits.join(' · ')}</span>}
                    </div>
                  </div>
                  <div className="flex gap-0.5">
                    <IconButton title="编辑" onClick={() => nav(`/profiles/${p.id}`)}><Pencil className="size-4" /></IconButton>
                    <IconButton title="访问记录" onClick={() => setLogsOf(p)}><History className="size-4" /></IconButton>
                    <IconButton title="重置链接" onClick={() => resetToken(p)}><RotateCcw className="size-4" /></IconButton>
                    <IconButton title="删除" onClick={() => remove(p)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
                  </div>
                </div>
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  <ProfileLinks
                    base={base}
                    p={p}
                    onQr={(title, text) => setQr({ title, text })}
                    onGenShort={() => genShort(p)}
                    onDelShort={() => delShort(p)}
                    onAlias={() => setAliasOf(p)}
                  />
                </ul>
              </Card>
            )
          })}
        </div>
      )}
      <QrModal open={!!qr} onClose={() => setQr(null)} title={qr?.title || ''} text={qr?.text || ''} />
      <AccessLogModal open={!!logsOf} onClose={() => setLogsOf(null)} title={`访问记录 · ${logsOf?.name || ''}`} logs={logsOf?.access} />
      {aliasOf && <AliasModal p={aliasOf} onClose={() => setAliasOf(null)} onDone={reload} />}
    </div>
  )
}

function ProfileLinks({
  base,
  p,
  onQr,
  onGenShort,
  onDelShort,
  onAlias,
}: {
  base: string
  p: Profile
  onQr: (title: string, text: string) => void
  onGenShort: () => void
  onDelShort: () => void
  onAlias: () => void
}) {
  const [fmt, setFmt] = useState('')
  const t = TARGETS.find((x) => x.key === fmt)!
  const url = subUrl(base, p, fmt)
  const shortUrl = p.shortCode ? `${base}/x/${p.shortCode}${fmt ? `?t=${fmt}` : ''}` : ''
  const ios = ['surge', 'loon', 'qx'].includes(fmt)
  const enc = encodeURIComponent
  const name = enc(p.name)
  const linkCls = 'text-blue-600 hover:underline'
  return (
    <>
      <li className="px-4 py-2.5">
        <div className="flex flex-wrap gap-1">
          {TARGETS.map((x) => (
            <button
              key={x.key}
              onClick={() => setFmt(x.key)}
              title={x.hint}
              className={cx(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                fmt === x.key ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300',
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-zinc-500">
          {t.hint}
          {ios && '。完整配置可直接导入；只想要节点时在链接后加 &list=1'}
        </p>
      </li>
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <div className="w-20 shrink-0 text-sm">订阅链接</div>
        <code className="min-w-0 flex-1 truncate text-xs text-zinc-500">{url}</code>
        <div className="flex items-center gap-1">
          <CopyButton text={url} label="复制" />
          <IconButton title="二维码" onClick={() => onQr(`${p.name} · ${t.label}`, url)}><QrCode className="size-4" /></IconButton>
          <a href={url} target="_blank" rel="noreferrer" title="在浏览器打开" className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800">
            <ExternalLink className="size-4" />
          </a>
        </div>
      </li>
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <div className="w-20 shrink-0 text-sm">短链</div>
        {shortUrl ? (
          <>
            <code className="min-w-0 flex-1 truncate text-xs text-zinc-500">{shortUrl}</code>
            <div className="flex items-center gap-1">
              <CopyButton text={shortUrl} label="复制" />
              <IconButton title="二维码" onClick={() => onQr(`${p.name} · 短链`, shortUrl)}><QrCode className="size-4" /></IconButton>
              <IconButton title="自定义短链" onClick={onAlias}><Pencil className="size-4" /></IconButton>
              <IconButton title="删除短链" onClick={onDelShort} className="hover:text-red-600"><X className="size-4" /></IconButton>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center gap-2">
            <Button size="sm" onClick={onGenShort}><Link2 className="size-3.5" />生成短链</Button>
            <Button size="sm" variant="ghost" onClick={onAlias}>自定义</Button>
          </div>
        )}
      </li>
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-zinc-500">
        <span className="w-20 shrink-0">一键导入</span>
        <a className={linkCls} href={`clash://install-config?url=${enc(subUrl(base, p, 'clash'))}&name=${name}`}>Clash Verge / FlClash</a>
        <a className={linkCls} href={`stash://install-config?url=${enc(subUrl(base, p, 'stash'))}`}>Stash</a>
        <a className={linkCls} href={`sing-box://import-remote-profile?url=${enc(subUrl(base, p, 'singbox'))}#${name}`}>sing-box</a>
        <a className={linkCls} href={`surge:///install-config?url=${enc(subUrl(base, p, 'surge'))}`}>Surge</a>
        <a className={linkCls} href={`shadowrocket://add/sub://${btoa(subUrl(base, p, 'v2ray'))}?remark=${name}`}>Shadowrocket</a>
        <a className={linkCls} href={`v2rayng://install-config?url=${enc(subUrl(base, p, 'v2ray'))}`}>v2rayNG</a>
      </li>
    </>
  )
}

function AliasModal({ p, onClose, onDone }: { p: Profile; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [code, setCode] = useState(p.shortCode || '')
  const [loading, setLoading] = useState(false)
  const save = async () => {
    setLoading(true)
    try {
      await api.post(`/profiles/${p.id}/short`, { code })
      onDone()
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="自定义短链"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={loading} disabled={!code}>保存</Button>
        </>
      }
    >
      <Field label="短链代码" hint="字母、数字、- 和 _，4-32 位。短链越短越容易被猜到，建议配合访问控制使用。">
        <div className="flex items-center gap-1 text-sm">
          <span className="shrink-0 text-zinc-500">/x/</span>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="phone" autoFocus />
        </div>
      </Field>
    </Modal>
  )
}
