import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Loader2, X } from 'lucide-react'
import { copyText } from '../lib/api'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- Button

type BtnVariant = 'primary' | 'default' | 'ghost' | 'danger'
const btnBase =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500'
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  default:
    'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:bg-zinc-900 dark:hover:bg-red-950/40',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'icon'; loading?: boolean }
>(function Button({ variant = 'default', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  const sz = size === 'sm' ? 'h-7 px-2.5 text-xs' : size === 'icon' ? 'h-8 w-8 text-sm' : 'h-9 px-3.5 text-sm'
  return (
    <button ref={ref} className={cx(btnBase, btnVariants[variant], sz, className)} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  )
})

export function IconButton({
  title,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      className={cx(
        'inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- Inputs

/** 传入了宽度类名（w-*）时不再默认 w-full，避免类名冲突 */
const widthOf = (className?: string) => (/(^|\s)(sm:|md:|lg:)?w-/.test(className || '') ? '' : 'w-full')

const inputCls =
  'rounded-md border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputCls, 'h-9', widthOf(className), className)} {...rest} />
})

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputCls, 'py-2 font-mono text-xs leading-relaxed', widthOf(className), className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, 'h-9 pr-8', widthOf(className), className)} {...rest}>
      {children}
    </select>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  )
}

export function Checkbox({
  checked,
  onChange,
  indeterminate,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  indeterminate?: boolean
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={cx('size-4 cursor-pointer rounded border-zinc-300 accent-blue-600', className)}
    />
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

/** 带说明的开关行 */
export function ToggleRow({ label, hint, checked, onChange }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  )
}

// ---------------------------------------------------------------- Display

const badgeColors = {
  zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
}
export type BadgeColor = keyof typeof badgeColors

export function Badge({ children, color = 'zinc', className, title }: { children: ReactNode; color?: BadgeColor; className?: string; title?: string }) {
  return (
    <span title={title ?? (typeof children === 'string' ? children : undefined)} className={cx('inline-flex max-w-full shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-none', badgeColors[color], className)}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', className)}>{children}</div>
}

export function CardHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 text-sm text-zinc-500">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Empty({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-zinc-400">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {desc && <div className="mt-1 max-w-sm text-xs text-zinc-500">{desc}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-zinc-400', className)} />
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded px-3 font-medium transition-colors',
            size === 'sm' ? 'h-6 text-xs' : 'h-8 text-sm',
            value === o.value
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.value
              ? 'border-blue-600 text-zinc-900 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function CopyButton({ text, label, size = 'sm', variant = 'default' }: { text: string; label?: string; size?: 'sm' | 'md' | 'icon'; variant?: BtnVariant }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size={size}
      variant={variant}
      title="复制"
      onClick={async (e) => {
        e.stopPropagation()
        await copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {label}
    </Button>
  )
}

// ---------------------------------------------------------------- Modal

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
  panelClass,
  bodyClass,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
  panelClass?: string
  bodyClass?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className={cx(
          'relative flex max-h-[92vh] w-full flex-col rounded-t-xl border border-zinc-200 bg-white shadow-xl sm:rounded-xl dark:border-zinc-800 dark:bg-zinc-900',
          width,
          panelClass,
        )}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <IconButton title="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className={cx('min-h-0 flex-1 overflow-y-auto px-4 py-4', bodyClass)}>{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- Toast & Confirm

type ToastKind = 'ok' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}
interface ConfirmOpts {
  title: string
  body?: ReactNode
  okText?: string
  danger?: boolean
}

const FeedbackCtx = createContext<{
  toast: (text: string, kind?: ToastKind) => void
  confirm: (o: ConfirmOpts) => Promise<boolean>
}>({ toast: () => {}, confirm: async () => false })

export function useToast() {
  return useContext(FeedbackCtx).toast
}
export function useConfirm() {
  return useContext(FeedbackCtx).confirm
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)
  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : 2500)
  }, [])
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })), [])
  const close = (v: boolean) => {
    confirmState?.resolve(v)
    setConfirmState(null)
  }
  return (
    <FeedbackCtx.Provider value={{ toast, confirm }}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto max-w-md rounded-md px-3.5 py-2 text-sm shadow-lg',
                t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
              )}
            >
              {t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
      <Modal
        open={!!confirmState}
        onClose={() => close(false)}
        title={confirmState?.title}
        width="max-w-sm"
        footer={
          <>
            <Button onClick={() => close(false)}>取消</Button>
            <Button variant={confirmState?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {confirmState?.okText || '确定'}
            </Button>
          </>
        }
      >
        <div className="text-sm text-zinc-600 dark:text-zinc-400">{confirmState?.body}</div>
      </Modal>
    </FeedbackCtx.Provider>
  )
}
