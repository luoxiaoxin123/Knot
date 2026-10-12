import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Upload, CloudUpload, RotateCcw } from 'lucide-react'
import { api, fmtBytes, fmtDate } from '../lib/api'
import { useSettings, type SettingsView } from '../lib/hooks'
import { SecurityCard } from '../components/Security'
import { MigrateCard } from '../components/Migrate'
import { Button, Card, CardHeader, Field, Input, Select, Spinner, ToggleRow, useConfirm, useToast } from '../components/ui'

export default function SettingsPage() {
  const { data } = useSettings()
  if (!data) return <div className="flex justify-center py-14"><Spinner /></div>
  return <SettingsForm initial={data} />
}

function SettingsForm({ initial }: { initial: SettingsView }) {
  const [f, setF] = useState(initial)
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  useEffect(() => setF(initial), [initial])
  const set = (k: keyof SettingsView, v: any) => setF((x) => ({ ...x, [k]: v }))
  const setS3 = (k: string, v: any) => setF((x) => ({ ...x, s3: { ...x.s3, [k]: v } }))

  const save = async (silent = false) => {
    setSaving(true)
    try {
      const r = await api.put<SettingsView>('/settings', f)
      qc.setQueryData(['settings'], r)
      qc.invalidateQueries({ queryKey: ['core'] })
      if (!silent) toast('已保存')
    } catch (e: any) {
      toast(e.message, 'error')
      if (silent) throw e
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">设置</h1>
        <Button variant="primary" onClick={() => save()} loading={saving}>保存设置</Button>
      </div>

      <Card>
        <CardHeader title="常规" />
        <div className="space-y-4 p-4">
          <Field label="对外访问地址" hint={`用于生成订阅链接，例如 https://sub.example.com。留空则使用浏览器当前地址（${window.location.origin}）`}>
            <Input value={f.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://sub.example.com" />
          </Field>
          <Field label="测速地址" hint="自动选择 / 地区分组的 URL 测试地址">
            <Input value={f.testUrl} onChange={(e) => set('testUrl', e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="规则集下载源" hint="内置分流模块的规则集地址">
              <Select value={f.ruleMirror} onChange={(e) => set('ruleMirror', e.target.value)}>
                <option value="github">GitHub Raw（默认）</option>
                <option value="jsdelivr">jsDelivr CDN</option>
                <option value="custom">自定义加速前缀</option>
              </Select>
            </Field>
            {f.ruleMirror === 'custom' && (
              <Field label="加速前缀" hint="会拼接在 GitHub Raw 地址前，或使用 {url} 占位符">
                <Input value={f.ruleMirrorCustom} onChange={(e) => set('ruleMirrorCustom', e.target.value)} placeholder="https://ghfast.top/" />
              </Field>
            )}
          </div>
          <Field label="日志保留天数" hint="订阅拉取、登录与操作日志超过这个天数会自动清理">
            <Input type="number" min={1} value={f.logRetentionDays} onChange={(e) => set('logRetentionDays', Number(e.target.value))} className="w-32" />
          </Field>
          <ToggleRow
            label="规则集通过代理下载"
            hint="客户端经「🚀 节点选择」下载规则集，国内网络访问 GitHub 不稳定时建议开启"
            checked={f.ruleDownloadViaProxy}
            onChange={(v) => set('ruleDownloadViaProxy', v)}
          />
        </div>
      </Card>

      <CoreCard path={f.corePath} onChange={(v) => set('corePath', v)} />
      <S3Card f={f} setS3={setS3} save={save} />
      <LocalBackupCard />
      <MigrateCard />
      <SecurityCard />
      <PasswordCard />
    </div>
  )
}

function S3Card({ f, setS3, save }: { f: SettingsView; setS3: (k: string, v: any) => void; save: (silent?: boolean) => Promise<void> }) {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)
  const list = useQuery({
    queryKey: ['s3list'],
    queryFn: () => api.get<{ key: string; size: number; lastModified: string }[]>('/backup/s3/list'),
    enabled: showList,
  })
  const s3 = f.s3

  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key)
    try {
      await save(true)
      await fn()
      toast(ok)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
      qc.invalidateQueries({ queryKey: ['settings'] })
    }
  }

  const restore = async (key: string) => {
    if (!(await confirm({ title: '从该备份恢复？', body: '当前的节点、订阅、规则、输出配置会被备份内容覆盖。', danger: true, okText: '恢复' }))) return
    setBusy(key)
    try {
      await api.post('/backup/s3/restore', { key })
      toast('已恢复')
      qc.invalidateQueries()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="S3 对象存储备份"
        desc="兼容 AWS S3、Cloudflare R2、MinIO、阿里云 OSS、腾讯云 COS、Backblaze B2 等。备份内容：节点、订阅源、规则、模板、输出配置与设置（不含登录密码与 S3 密钥）。"
      />
      <div className="space-y-4 p-4">
        <ToggleRow label="启用自动备份" checked={s3.enabled} onChange={(v) => setS3('enabled', v)} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Endpoint" hint="例如 https://<account>.r2.cloudflarestorage.com、https://s3.us-east-1.amazonaws.com">
            <Input value={s3.endpoint} onChange={(e) => setS3('endpoint', e.target.value)} placeholder="https://..." />
          </Field>
          <Field label="Region" hint="R2 填 auto">
            <Input value={s3.region} onChange={(e) => setS3('region', e.target.value)} />
          </Field>
          <Field label="Bucket">
            <Input value={s3.bucket} onChange={(e) => setS3('bucket', e.target.value)} />
          </Field>
          <Field label="路径前缀">
            <Input value={s3.prefix} onChange={(e) => setS3('prefix', e.target.value)} placeholder="knot/" />
          </Field>
          <Field label="Access Key ID">
            <Input value={s3.accessKeyId} onChange={(e) => setS3('accessKeyId', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Secret Access Key" hint={s3.hasSecret ? '已保存，留空不修改' : undefined}>
            <Input type="password" value={s3.secretAccessKey} onChange={(e) => setS3('secretAccessKey', e.target.value)} autoComplete="new-password" placeholder={s3.hasSecret ? '••••••••' : ''} />
          </Field>
          <Field label="备份间隔（小时）">
            <Input type="number" min={1} value={s3.intervalHours} onChange={(e) => setS3('intervalHours', Number(e.target.value))} />
          </Field>
          <Field label="保留份数" hint="超出后自动删除最旧的备份，0 为不限制">
            <Input type="number" min={0} value={s3.keep} onChange={(e) => setS3('keep', Number(e.target.value))} />
          </Field>
        </div>
        <ToggleRow label="Path-style 访问" hint="MinIO 等自建服务通常需要开启；AWS / R2 保持关闭" checked={s3.pathStyle} onChange={(v) => setS3('pathStyle', v)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run('test', () => api.post('/backup/s3/test'), '连接成功')} loading={busy === 'test'}>测试连接</Button>
          <Button onClick={() => run('backup', () => api.post('/backup/s3/backup'), '备份已上传')} loading={busy === 'backup'}>
            <CloudUpload className="size-4" />
            立即备份
          </Button>
          <Button variant="ghost" onClick={() => setShowList(!showList)}>{showList ? '收起' : '查看'}备份列表</Button>
          <span className="text-xs text-zinc-500">
            上次备份：{fmtDate(s3.lastBackupAt)}
            {s3.lastError && <span className="text-red-600"> · 失败：{s3.lastError}</span>}
          </span>
        </div>
        {showList && (
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
            {list.isLoading ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : list.error ? (
              <div className="p-3 text-xs text-red-600">{(list.error as Error).message}</div>
            ) : !list.data?.length ? (
              <div className="p-3 text-center text-xs text-zinc-500">没有备份</div>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {list.data.map((o) => (
                  <li key={o.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{o.key}</span>
                    <span className="hidden text-xs text-zinc-500 sm:inline">{fmtBytes(o.size)}</span>
                    <span className="hidden text-xs text-zinc-500 sm:inline">{new Date(o.lastModified).toLocaleString()}</span>
                    <Button size="sm" onClick={() => restore(o.key)} loading={busy === o.key}><RotateCcw className="size-3.5" />恢复</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

function LocalBackupCard() {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const onFile = async (file: File) => {
    if (!(await confirm({ title: `从「${file.name}」恢复？`, body: '当前的节点、订阅、规则、输出配置会被覆盖。', danger: true, okText: '恢复' }))) return
    try {
      await api.post('/backup/import', JSON.parse(await file.text()))
      toast('已恢复')
      qc.invalidateQueries()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Card>
      <CardHeader title="本地备份" desc="下载 / 上传 JSON 备份文件" />
      <div className="flex flex-wrap gap-2 p-4">
        <a href="/api/backup/export" download>
          <Button><Download className="size-4" />下载备份</Button>
        </a>
        <Button onClick={() => fileRef.current?.click()}><Upload className="size-4" />从文件恢复</Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
            e.target.value = ''
          }}
        />
      </div>
    </Card>
  )
}

function PasswordCard() {
  const toast = useToast()
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async () => {
    setLoading(true)
    try {
      await api.post('/auth/password', { oldPassword, newPassword })
      toast('密码已修改，其他设备的登录已失效')
      setOld('')
      setNew('')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }
  return (
    <Card>
      <CardHeader title="修改密码" />
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <Field label="原密码"><Input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="新密码"><Input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" /></Field>
        <Button onClick={submit} loading={loading} disabled={!oldPassword || !newPassword}>修改</Button>
      </div>
    </Card>
  )
}

function CoreCard({ path, onChange }: { path: string; onChange: (v: string) => void }) {
  const st = useQuery({ queryKey: ['core'], queryFn: () => api.get<{ available: boolean; path: string | null; version: string }>('/core/status') })
  return (
    <Card>
      <CardHeader
        title="mihomo 内核"
        desc="用于真实延迟测试（支持 Hysteria2 / TUIC 等 UDP 协议与链式代理）和 AI / 流媒体解锁检测。Docker 镜像已内置。"
      />
      <div className="space-y-3 p-4">
        <div className="text-sm">
          {st.isLoading ? (
            <Spinner />
          ) : st.data?.available ? (
            <span className="text-emerald-600">已就绪 · {st.data.version || st.data.path}</span>
          ) : (
            <span className="text-amber-600">未找到内核，测速将退回 TCP 握手延迟</span>
          )}
        </div>
        <Field label="内核路径" hint="留空自动查找（MIHOMO_PATH 环境变量、PATH、/usr/local/bin/mihomo、数据目录 bin/mihomo）">
          <Input value={path} onChange={(e) => onChange(e.target.value)} placeholder={st.data?.path || '/usr/local/bin/mihomo'} className="font-mono" />
        </Field>
      </div>
    </Card>
  )
}
