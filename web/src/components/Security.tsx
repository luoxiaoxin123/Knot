import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { KeyRound, ShieldCheck, Trash2, Plus } from 'lucide-react'
import { api, fmtDate, fmtTime } from '../lib/api'
import { Badge, Button, Card, CardHeader, CopyButton, Field, Input, Modal, Spinner, useConfirm, useToast } from './ui'

interface Security {
  totp: boolean
  recoveryLeft: number
  passkeys: { id: string; name: string; rpID: string; createdAt: number; lastUsedAt?: number }[]
}

export function SecurityCard() {
  const q = useQuery({ queryKey: ['security'], queryFn: () => api.get<Security>('/auth/security') })
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [setupOpen, setSetupOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const reload = () => qc.invalidateQueries({ queryKey: ['security'] })
  const secure = window.isSecureContext

  const addPasskey = async () => {
    const name = window.prompt('给这个通行密钥起个名字（例如：MacBook、iPhone）', '')
    if (name === null) return
    setAdding(true)
    try {
      const { startRegistration } = await import('@simplewebauthn/browser')
      const { options, challengeId } = await api.post<{ options: any; challengeId: string }>('/auth/passkey/register-options')
      const response = await startRegistration({ optionsJSON: options })
      await api.post('/auth/passkey/register', { challengeId, response, name })
      toast('已添加通行密钥')
      reload()
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') toast(e.message || '添加失败', 'error')
    } finally {
      setAdding(false)
    }
  }

  const removePasskey = async (id: string, name: string) => {
    if (!(await confirm({ title: `删除通行密钥「${name}」？`, danger: true, okText: '删除' }))) return
    await api.del(`/auth/passkey/${encodeURIComponent(id)}`)
    reload()
  }

  const s = q.data
  return (
    <Card>
      <CardHeader title="账户安全" desc="两步验证与通行密钥。面板能看到所有节点的密码，建议至少开启其中一项。" />
      {!s ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                两步验证（TOTP）
                {s.totp ? <Badge color="green">已开启</Badge> : <Badge>未开启</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                登录时除密码外还需输入验证器 App（Google Authenticator、1Password、Bitwarden 等）中的 6 位验证码
                {s.totp && ` · 剩余恢复码 ${s.recoveryLeft} 个`}
              </div>
            </div>
            {s.totp ? <Button variant="danger" onClick={() => setDisableOpen(true)}>关闭</Button> : <Button variant="primary" onClick={() => setSetupOpen(true)}>开启</Button>}
          </div>
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="size-4" />
                  通行密钥（Passkey）
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">用指纹 / 面容 / 设备密码 / 安全密钥直接登录，无需输入密码。需要通过 HTTPS 访问面板。</div>
              </div>
              <Button onClick={addPasskey} loading={adding} disabled={!secure} title={secure ? '' : '需要 HTTPS 或 localhost'}>
                <Plus className="size-4" />添加
              </Button>
            </div>
            {!secure && <p className="mt-2 text-xs text-amber-600">当前不是 HTTPS 连接，浏览器不允许使用通行密钥。</p>}
            {s.passkeys.length > 0 && (
              <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {s.passkeys.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                    <span className="hidden text-xs text-zinc-500 sm:inline">{p.rpID}</span>
                    <span className="text-xs text-zinc-500" title={fmtDate(p.createdAt)}>{p.lastUsedAt ? `${fmtTime(p.lastUsedAt)}使用` : '未使用'}</span>
                    <button onClick={() => removePasskey(p.id, p.name)} className="text-zinc-400 hover:text-red-600" title="删除"><Trash2 className="size-4" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {setupOpen && <TotpSetup onClose={() => { setSetupOpen(false); reload() }} />}
      {disableOpen && <TotpDisable onClose={() => { setDisableOpen(false); reload() }} />}
    </Card>
  )
}

function TotpSetup({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<{ secret: string; uri: string } | null>(null)
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    api.post<{ secret: string; uri: string }>('/auth/totp/setup').then(async (d) => {
      setData(d)
      setQr(await QRCode.toDataURL(d.uri, { margin: 1, width: 220 }))
    }, (e) => toast(e.message, 'error'))
  }, [toast])
  const enable = async () => {
    setLoading(true)
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/totp/enable', { code })
      setCodes(r.recoveryCodes)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }
  if (codes) {
    return (
      <Modal open onClose={onClose} title="两步验证已开启" width="max-w-md" footer={<Button variant="primary" onClick={onClose}>我已保存好</Button>}>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">请保存下面的恢复码。手机丢失时，每个恢复码可以代替验证码登录一次。<b>只显示这一次。</b></p>
        <div className="grid grid-cols-2 gap-2 rounded-md bg-zinc-50 p-3 font-mono text-sm dark:bg-zinc-800/60">
          {codes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="mt-3"><CopyButton text={codes.join('\n')} label="复制全部" /></div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="开启两步验证"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={enable} loading={loading} disabled={code.length < 6}>确认开启</Button>
        </>
      }
    >
      {!data ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">1. 用验证器 App 扫描二维码（或手动输入密钥）</p>
          <div className="flex justify-center">{qr && <img src={qr} alt="二维码" className="rounded bg-white p-2" />}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-zinc-50 px-2 py-1 text-xs dark:bg-zinc-800">{data.secret}</code>
            <CopyButton text={data.secret} />
          </div>
          <Field label="2. 输入 App 显示的 6 位验证码">
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="123456" className="font-mono tracking-widest" />
          </Field>
        </div>
      )}
    </Modal>
  )
}

function TotpDisable({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async () => {
    setLoading(true)
    try {
      await api.post('/auth/totp/disable', { password, code })
      toast('已关闭两步验证')
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
      title="关闭两步验证"
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" onClick={submit} loading={loading}>关闭两步验证</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="管理密码"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="验证码或恢复码"><Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" /></Field>
      </div>
    </Modal>
  )
}
