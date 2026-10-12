import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, QrCode, RotateCcw, Share2, ExternalLink } from 'lucide-react'
import type { Profile } from '@shared/types'
import { api, fmtTime } from '../lib/api'
import { subBase, useNodes, useProfiles, useSettings, useSubs, useTemplates } from '../lib/hooks'
import { Badge, Button, Card, CopyButton, Empty, IconButton, PageHeader, Spinner, useConfirm, useToast } from '../components/ui'
import { QrModal } from '../components/Qr'
import { countNodes } from '../lib/select'

const TARGETS = [
  { key: '', label: '自动识别', hint: '根据客户端 UA 自动返回对应格式' },
  { key: 'clash', label: 'Clash / mihomo', hint: 'Clash Verge Rev、FlClash、Clash Meta for Android、Stash 等' },
  { key: 'singbox', label: 'sing-box', hint: 'sing-box 官方客户端（SFA / SFI / SFM）' },
  { key: 'v2ray', label: 'V2Ray (Base64)', hint: 'v2rayN、v2rayNG、Shadowrocket、NekoBox 等' },
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
            const last = p.access?.[0]
            return (
              <Card key={p.id}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      <Badge color="blue">{count} 节点</Badge>
                      <Badge>{tpl ? `模板：${tpl.name}` : `${p.modules.length} 个分流模块`}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {last ? `最近更新：${fmtTime(last.at)} · ${last.target} · ${last.ua || '未知客户端'}` : '尚未被客户端拉取'}
                    </div>
                  </div>
                  <div className="flex gap-0.5">
                    <IconButton title="编辑" onClick={() => nav(`/profiles/${p.id}`)}><Pencil className="size-4" /></IconButton>
                    <IconButton title="重置链接" onClick={() => resetToken(p)}><RotateCcw className="size-4" /></IconButton>
                    <IconButton title="删除" onClick={() => remove(p)} className="hover:text-red-600"><Trash2 className="size-4" /></IconButton>
                  </div>
                </div>
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {TARGETS.map((t) => {
                    const url = subUrl(base, p, t.key)
                    return (
                      <li key={t.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                        <div className="w-32 shrink-0 text-sm" title={t.hint}>{t.label}</div>
                        <code className="min-w-0 flex-1 truncate text-xs text-zinc-500">{url}</code>
                        <div className="flex items-center gap-1">
                          <CopyButton text={url} label="复制" />
                          <IconButton title="二维码" onClick={() => setQr({ title: `${p.name} · ${t.label}`, text: url })}><QrCode className="size-4" /></IconButton>
                          <a href={url} target="_blank" rel="noreferrer" title="在浏览器打开" className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800">
                            <ExternalLink className="size-4" />
                          </a>
                        </div>
                      </li>
                    )
                  })}
                  <OneClickImport base={base} p={p} />
                </ul>
              </Card>
            )
          })}
        </div>
      )}
      <QrModal open={!!qr} onClose={() => setQr(null)} title={qr?.title || ''} text={qr?.text || ''} />
    </div>
  )
}

/** 一键导入：Clash 系客户端的 URL Scheme */
function OneClickImport({ base, p }: { base: string; p: Profile }) {
  const url = encodeURIComponent(subUrl(base, p, 'clash'))
  const name = encodeURIComponent(p.name)
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-zinc-500">
      <span className="w-32 shrink-0">一键导入</span>
      <a className="text-blue-600 hover:underline" href={`clash://install-config?url=${url}&name=${name}`}>Clash Verge / FlClash</a>
      <a className="text-blue-600 hover:underline" href={`sing-box://import-remote-profile?url=${encodeURIComponent(subUrl(base, p, 'singbox'))}#${name}`}>sing-box</a>
      <a className="text-blue-600 hover:underline" href={`v2rayng://install-config?url=${encodeURIComponent(subUrl(base, p, 'v2ray'))}`}>v2rayNG</a>
    </li>
  )
}
