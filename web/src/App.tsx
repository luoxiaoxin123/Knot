import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Server, Rss, ListTree, Share2, Settings as SettingsIcon, LogOut, Menu, X } from 'lucide-react'
import { api } from './lib/api'
import { Button, Field, Input, Spinner, cx, useToast } from './components/ui'
import NodesPage from './pages/Nodes'
import SubsPage from './pages/Subs'
import RulesPage from './pages/Rules'
import ProfilesPage from './pages/Profiles'
import ProfileEditPage from './pages/ProfileEdit'
import SettingsPage from './pages/Settings'

const NAV = [
  { to: '/nodes', label: '节点', icon: Server },
  { to: '/subs', label: '订阅源', icon: Rss },
  { to: '/rules', label: '规则', icon: ListTree },
  { to: '/profiles', label: '订阅输出', icon: Share2 },
  { to: '/settings', label: '设置', icon: SettingsIcon },
]

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/favicon.svg" className="size-6" alt="" />
      <span className="text-[15px] font-semibold tracking-tight">Switch</span>
    </div>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  const qc = useQueryClient()
  useEffect(() => setOpen(false), [loc.pathname])
  const logout = async () => {
    await api.post('/auth/logout')
    qc.invalidateQueries({ queryKey: ['auth'] })
  }
  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100',
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-4 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 px-2">
          <Logo />
        </div>
        {nav}
        <div className="mt-auto">
          <button onClick={logout} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            <LogOut className="size-4" />
            退出登录
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-zinc-200 bg-white/90 px-4 backdrop-blur md:hidden dark:border-zinc-800 dark:bg-zinc-900/90">
          <Logo />
          <button onClick={() => setOpen(!open)} className="p-1.5 text-zinc-600 dark:text-zinc-300" aria-label="菜单">
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </header>
        {open && (
          <div className="sticky top-12 z-20 border-b border-zinc-200 bg-white px-3 py-2 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
            {nav}
            <button onClick={logout} className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-zinc-500">
              <LogOut className="size-4" />
              退出登录
            </button>
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  )
}

function AuthScreen({ setup }: { setup: boolean }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [loading, setLoading] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!setup && pw !== pw2) return toast('两次输入的密码不一致', 'error')
    setLoading(true)
    try {
      await api.post(setup ? '/auth/login' : '/auth/setup', { password: pw })
      await qc.invalidateQueries({ queryKey: ['auth'] })
    } catch (err: any) {
      toast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Logo />
        <div>
          <h1 className="text-lg font-semibold">{setup ? '登录' : '初始化管理员密码'}</h1>
          {!setup && <p className="mt-1 text-sm text-zinc-500">首次使用，请设置一个管理密码（至少 6 位）。</p>}
        </div>
        <Field label="密码">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={setup ? 'current-password' : 'new-password'} />
        </Field>
        {!setup && (
          <Field label="确认密码">
            <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>
          {setup ? '登录' : '完成'}
        </Button>
      </form>
    </div>
  )
}

export default function App() {
  const qc = useQueryClient()
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api.get<{ setup: boolean; authed: boolean }>('/auth/status') })
  useEffect(() => {
    const fn = () => qc.invalidateQueries({ queryKey: ['auth'] })
    window.addEventListener('sw:unauthorized', fn)
    return () => window.removeEventListener('sw:unauthorized', fn)
  }, [qc])
  if (auth.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!auth.data?.authed) return <AuthScreen setup={!!auth.data?.setup} />
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/nodes" replace />} />
        <Route path="/nodes" element={<NodesPage />} />
        <Route path="/subs" element={<SubsPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/profiles/:id" element={<ProfileEditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/nodes" replace />} />
      </Routes>
    </Shell>
  )
}
