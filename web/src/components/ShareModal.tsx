import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccessControl, Share } from '@shared/types'
import { api } from '../lib/api'
import { Button, Field, Input, Modal, ToggleRow, useToast } from './ui'
import { AccessEditor } from './Access'

const ONE_DAY = 24 * 3600_000

/** 新建 / 编辑临时分享 */
export function ShareModal({
  share,
  nodeIds,
  nodeNames,
  onClose,
  onCreated,
}: {
  share?: Share
  nodeIds?: string[]
  nodeNames?: string[]
  onClose: () => void
  onCreated?: (s: Share) => void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const [name, setName] = useState(share?.name || (nodeNames?.length === 1 ? `分享 · ${nodeNames[0]}` : '临时分享'))
  const [withRules, setWithRules] = useState(share?.withRules ?? true)
  const [ac, setAc] = useState<AccessControl>(
    share?.accessControl || { enabled: true, expiresAt: Date.now() + ONE_DAY, maxUses: 1, uses: 0, rateLimitPerHour: 0, ipAllowlist: [] },
  )
  const [loading, setLoading] = useState(false)
  const save = async () => {
    setLoading(true)
    try {
      const s = share
        ? await api.put<Share>(`/shares/${share.id}`, { name, withRules, accessControl: ac })
        : await api.post<Share>('/shares', { name, withRules, nodeIds, accessControl: ac })
      qc.invalidateQueries({ queryKey: ['shares'] })
      onCreated?.(s)
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
      title={share ? '编辑分享' : '临时分享节点'}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={loading}>{share ? '保存' : '生成分享链接'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {!share && nodeNames && (
          <div className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
            分享 {nodeNames.length} 个节点：{nodeNames.slice(0, 6).join('、')}{nodeNames.length > 6 ? ' …' : ''}
          </div>
        )}
        <Field label="名称" hint="只有你自己能看到，方便区分分享给了谁">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ToggleRow label="附带分流规则" hint="对方用 Clash / sing-box 时附带推荐分流规则；关闭则只有节点（国内流量也会走代理）" checked={withRules} onChange={setWithRules} />
        <AccessEditor value={ac} onChange={setAc} />
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          链接失效只能阻止对方<b>再次拉取</b>。对方已经导入的节点配置里包含连接密码，在你更换该节点的密码 / UUID 之前仍然可以使用。
          如需到期后立刻断开，请看分享页顶部的说明。
        </p>
      </div>
    </Modal>
  )
}
