import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EyeOff, Eye, GripVertical, Plus, Search, Settings2, X, Layers, ArrowLeftRight } from 'lucide-react'
import type { CustomGroup, NodeSource, ProxyGroupType } from '@shared/types'
import { useSubs } from '../lib/hooks'
import { Button, Field, Input, Modal, Select, Spinner, ToggleRow, cx, useToast } from './ui'
import { TypeBadge } from '../pages/Nodes'

export interface EditorNode {
  id: string
  name: string
  type: string
  source: NodeSource
}

const TYPE_LABEL: Record<ProxyGroupType, string> = {
  select: 'select 手动选择',
  'url-test': 'url-test 自动测速',
  fallback: 'fallback 故障转移',
  'load-balance': 'load-balance 负载均衡',
}
const TYPES = Object.keys(TYPE_LABEL) as ProxyGroupType[]
const BUILTINS = ['DIRECT', 'REJECT']

function newId() {
  return Math.random().toString(36).slice(2, 12)
}

/** 分组 target 是否可以加入成员 ref（避免自身引用和循环引用） */
function canContain(groups: CustomGroup[], target: string, ref: string): boolean {
  if (ref === target) return false
  const byName = new Map(groups.map((g) => [g.name, g]))
  if (!byName.has(ref)) return true
  const seen = new Set<string>()
  const stack = [ref]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === target) return false
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const m of byName.get(cur)?.members || []) if (byName.has(m)) stack.push(m)
  }
  return true
}

function useIsWide() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const fn = () => setWide(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return wide
}

export function GroupEditor({
  title,
  initial,
  nodes,
  loading,
  onClose,
  onApply,
}: {
  title: string
  initial: CustomGroup[] | null
  nodes: EditorNode[]
  loading?: boolean
  onClose: () => void
  onApply: (groups: CustomGroup[]) => Promise<void> | void
}) {
  const toast = useToast()
  const { data: subs } = useSubs()
  const [groups, setGroups] = useState<CustomGroup[]>(initial || [])
  const [cols, setCols] = useState(() => Number(localStorage.getItem('sw:groupCols')) || 4)
  const [hideAdded, setHideAdded] = useState(false)
  const [q, setQ] = useState('')
  const [src, setSrc] = useState('all')
  const [active, setActive] = useState<{ label: ReactNode; count?: number } | null>(null)
  const [settingsOf, setSettingsOf] = useState<CustomGroup | null>(null)
  const [saving, setSaving] = useState(false)
  const wide = useIsWide()

  useEffect(() => {
    if (initial) setGroups(initial)
  }, [initial])
  useEffect(() => {
    try {
      localStorage.setItem('sw:groupCols', String(cols))
    } catch {}
  }, [cols])

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const used = useMemo(() => new Set(groups.flatMap((g) => g.members)), [groups])

  const available = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return nodes.filter((n) => {
      if (hideAdded && used.has(`node:${n.id}`)) return false
      if (kw && !n.name.toLowerCase().includes(kw)) return false
      if (src === 'all') return true
      const key = n.source.kind === 'sub' ? n.source.subId : n.source.kind
      return key === src
    })
  }, [nodes, q, src, hideAdded, used])

  const label = (ref: string): ReactNode => {
    if (ref.startsWith('node:')) {
      const n = nodeById.get(ref.slice(5))
      return n ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <TypeBadge type={n.type} />
          <span className="truncate">{n.name}</span>
        </span>
      ) : (
        <span className="truncate italic text-zinc-400">已不在此配置中的节点</span>
      )
    }
    if (BUILTINS.includes(ref)) return <span className={cx('font-mono text-xs', ref === 'DIRECT' ? 'text-emerald-600' : 'text-red-600')}>{ref}</span>
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Layers className="size-3.5 shrink-0 text-violet-500" />
        <span className="truncate">{ref}</span>
      </span>
    )
  }

  // ------------------------------------------------------------ 操作

  const update = (fn: (gs: CustomGroup[]) => CustomGroup[]) => setGroups((gs) => fn(gs.map((g) => ({ ...g, members: [...g.members] }))))

  const addRefs = (gid: string, refs: string[], index?: number) =>
    update((gs) => {
      const g = gs.find((x) => x.id === gid)!
      const fresh = refs.filter((r) => !g.members.includes(r) && canContain(gs, g.name, r))
      g.members.splice(index ?? g.members.length, 0, ...fresh)
      return gs
    })

  const removeEverywhere = (refs: string[]) =>
    update((gs) => {
      for (const g of gs) g.members = g.members.filter((m) => !refs.includes(m))
      return gs
    })

  const addEverywhere = (refs: string[]) =>
    update((gs) => {
      for (const g of gs) for (const r of refs) if (!g.members.includes(r) && canContain(gs, g.name, r)) g.members.push(r)
      return gs
    })

  const renameGroup = (id: string, name: string) => {
    const n = name.trim()
    if (!n) return
    if (groups.some((g) => g.id !== id && g.name === n)) return toast('分组名已存在', 'error')
    if (BUILTINS.includes(n)) return toast('不能使用该名称', 'error')
    update((gs) => {
      const g = gs.find((x) => x.id === id)!
      const old = g.name
      g.name = n
      for (const x of gs) x.members = x.members.map((m) => (m === old ? n : m))
      return gs
    })
  }

  const deleteGroup = (id: string) =>
    update((gs) => {
      const g = gs.find((x) => x.id === id)!
      return gs.filter((x) => x.id !== id).map((x) => ({ ...x, members: x.members.filter((m) => m !== g.name) }))
    })

  const addGroup = () => {
    let i = 1
    while (groups.some((g) => g.name === `新分组 ${i}`)) i++
    setGroups([...groups, { id: newId(), name: `新分组 ${i}`, type: 'select', members: [], autoNew: false, filter: '' }])
  }

  // ------------------------------------------------------------ 拖拽

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const collision: CollisionDetection = (args) => {
    const type = args.active.data.current?.type
    if (type === 'col') {
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === 'col') })
    }
    const containers = args.droppableContainers.filter((c) => c.data.current?.type !== 'col')
    const rank = (t: string) => (t === 'zone' ? 0 : t === 'member' ? 1 : 2)
    const within = pointerWithin({ ...args, droppableContainers: containers })
    if (within.length) {
      return [...within].sort((a, b) => {
        const ta = containers.find((c) => c.id === a.id)?.data.current?.type
        const tb = containers.find((c) => c.id === b.id)?.data.current?.type
        return rank(ta) - rank(tb)
      })
    }
    return rectIntersection({ ...args, droppableContainers: containers })
  }

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as any
    if (d?.type === 'col') setActive({ label: groups.find((g) => g.id === d.gid)?.name })
    else if (d?.type === 'avail') setActive({ label: d.refs.length === 1 ? label(d.refs[0]) : `${d.refs.length} 个节点`, count: d.refs.length })
    else if (d?.type === 'member') setActive({ label: label(d.ref) })
  }

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    const a = e.active.data.current as any
    const o = e.over?.data.current as any
    if (!a || !o) return
    if (a.type === 'col') {
      if (o.type !== 'col' || a.gid === o.gid) return
      const from = groups.findIndex((g) => g.id === a.gid)
      const to = groups.findIndex((g) => g.id === o.gid)
      setGroups(arrayMove(groups, from, to))
      return
    }
    const refs: string[] = a.type === 'avail' ? a.refs : [a.ref]
    if (o.type === 'zone') {
      if (o.zone === 'remove') removeEverywhere(refs)
      else addEverywhere(refs)
      return
    }
    const target = groups.find((g) => g.id === o.gid)
    if (!target) return
    const overIndex = o.type === 'member' ? target.members.indexOf(o.ref) : target.members.length
    if (a.type === 'member') {
      if (a.gid === o.gid) {
        const from = target.members.indexOf(a.ref)
        if (from < 0 || overIndex < 0 || from === overIndex) return
        update((gs) => {
          const g = gs.find((x) => x.id === o.gid)!
          g.members = arrayMove(g.members, from, Math.min(overIndex, g.members.length - 1))
          return gs
        })
      } else {
        // 跨分组拖动 = 移动
        if (target.members.includes(a.ref) || !canContain(groups, target.name, a.ref)) return
        update((gs) => {
          const s = gs.find((x) => x.id === a.gid)!
          s.members = s.members.filter((m) => m !== a.ref)
          const g = gs.find((x) => x.id === o.gid)!
          g.members.splice(overIndex < 0 ? g.members.length : overIndex, 0, a.ref)
          return gs
        })
      }
      return
    }
    addRefs(o.gid, refs, overIndex < 0 ? undefined : overIndex)
  }

  const apply = async () => {
    setSaving(true)
    try {
      await onApply(groups)
    } finally {
      setSaving(false)
    }
  }

  const special = [...BUILTINS, ...groups.map((g) => g.name)]
  const sources = [
    { key: 'all', label: '所有来源' },
    { key: 'manual', label: '自建' },
    { key: 'chain', label: '链式' },
    ...(subs || []).map((s) => ({ key: s.id, label: s.name })),
  ]

  return (
    <Modal open onClose={onClose} title={title} width="max-w-[min(1440px,98vw)]">
      {loading || !initial ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="text-xs leading-relaxed text-zinc-500">
              <p>把右侧节点拖进分组；分组内拖动可排序，拖到另一个分组为移动。拖动「可用节点」标题会拖入当前筛选出的全部节点。</p>
              <p>双击分组名改名，<Settings2 className="inline size-3" /> 设置类型与“自动加入新节点”。规则中引用的分组被改名后，规则会自动跟随。</p>
            </div>
            <div className="flex gap-2">
              <DropZone id="remove" label="从所有分组移除" />
              <DropZone id="add" label="添加到所有分组" />
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              {wide && (
                <div className="mb-2 flex items-center justify-end gap-1 text-xs text-zinc-500">
                  列数
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} onClick={() => setCols(n)} className={cx('size-6 rounded', cols === n ? 'bg-blue-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
              <div className="max-h-[68vh] overflow-y-auto pr-1">
                <SortableContext items={groups.map((g) => `col:${g.id}`)} strategy={rectSortingStrategy}>
                  <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${wide ? cols : 1}, minmax(0, 1fr))` }}>
                    {groups.map((g) => (
                      <GroupColumn
                        key={g.id}
                        group={g}
                        label={label}
                        onRename={(n) => renameGroup(g.id, n)}
                        onRemoveMember={(ref) =>
                          update((gs) => {
                            const x = gs.find((y) => y.id === g.id)!
                            x.members = x.members.filter((m) => m !== ref)
                            return gs
                          })
                        }
                        onDelete={() => deleteGroup(g.id)}
                        onSettings={() => setSettingsOf(g)}
                      />
                    ))}
                  </div>
                </SortableContext>
                {!groups.length && <div className="py-16 text-center text-sm text-zinc-500">还没有分组，点击右侧「添加分组」</div>}
              </div>
            </div>

            <aside className="w-full shrink-0 space-y-3 lg:w-72">
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={addGroup}><Plus className="size-4" />添加分组</Button>
                <Button variant="primary" onClick={apply} loading={saving}>应用并保存</Button>
              </div>
              <Button className="w-full" onClick={() => setHideAdded(!hideAdded)}>
                {hideAdded ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                {hideAdded ? '显示已添加节点' : '隐藏已添加节点'}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按名称筛选" className="h-8 pl-7 text-xs" />
                </div>
                <Select value={src} onChange={(e) => setSrc(e.target.value)} className="h-8 text-xs">
                  {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </Select>
              </div>
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                <AvailHeader refs={available.map((n) => `node:${n.id}`)} total={nodes.length} />
                <div className="max-h-[38vh] space-y-1 overflow-y-auto p-2">
                  {available.map((n) => (
                    <AvailItem key={n.id} refKey={`node:${n.id}`} added={used.has(`node:${n.id}`)}>{label(`node:${n.id}`)}</AvailItem>
                  ))}
                  {!available.length && <div className="py-4 text-center text-xs text-zinc-500">没有节点</div>}
                </div>
                <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="mb-1 px-1 text-xs text-zinc-500">特殊节点 / 分组</div>
                  <div className="space-y-1">
                    {special.map((r) => <AvailItem key={r} refKey={r}>{label(r)}</AvailItem>)}
                  </div>
                </div>
              </div>
            </aside>
          </div>

          <DragOverlay dropAnimation={null}>
            {active && (
              <div className="flex max-w-64 items-center gap-2 rounded-md border border-blue-400 bg-white px-2.5 py-1.5 text-sm shadow-lg dark:bg-zinc-900">
                {active.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {settingsOf && (
        <GroupSettings
          group={settingsOf}
          onClose={() => setSettingsOf(null)}
          onSave={(g) => {
            if (g.name !== settingsOf.name) renameGroup(g.id, g.name)
            update((gs) => gs.map((x) => (x.id === g.id ? { ...x, type: g.type, autoNew: g.autoNew, filter: g.filter } : x)))
            setSettingsOf(null)
          }}
        />
      )}
    </Modal>
  )
}

function DropZone({ id, label }: { id: 'remove' | 'add'; label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${id}`, data: { type: 'zone', zone: id } })
  return (
    <div
      ref={setNodeRef}
      className={cx(
        'flex h-14 w-36 items-center justify-center rounded-lg border-2 border-dashed px-2 text-center text-xs transition-colors',
        isOver
          ? id === 'remove'
            ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40'
            : 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950/40'
          : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
      )}
    >
      {label}
    </div>
  )
}

function AvailHeader({ refs, total }: { refs: string[]; total: number }) {
  const { setNodeRef, listeners, attributes } = useDraggable({ id: 'avail-all', data: { type: 'avail', refs } })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="flex cursor-grab items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800" title="拖动以添加全部筛选出的节点">
      <GripVertical className="size-4 text-zinc-400" />
      <div>
        <div className="text-sm font-semibold">可用节点</div>
        <div className="text-xs text-zinc-500">{refs.length} / {total} 个节点</div>
      </div>
    </div>
  )
}

function AvailItem({ refKey, added, children }: { refKey: string; added?: boolean; children: ReactNode }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `avail:${refKey}`, data: { type: 'avail', refs: [refKey] } })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cx(
        'flex cursor-grab touch-none items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900',
        isDragging && 'opacity-40',
        added && 'text-zinc-500',
      )}
    >
      <GripVertical className="size-3.5 shrink-0 text-zinc-400" />
      {children}
    </div>
  )
}

function GroupColumn({
  group,
  label,
  onRename,
  onRemoveMember,
  onDelete,
  onSettings,
}: {
  group: CustomGroup
  label: (ref: string) => ReactNode
  onRename: (name: string) => void
  onRemoveMember: (ref: string) => void
  onDelete: () => void
  onSettings: () => void
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: `col:${group.id}`,
    data: { type: 'col', gid: group.id },
  })
  const drop = useDroppable({ id: `drop:${group.id}`, data: { type: 'drop', gid: group.id } })
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  useEffect(() => setName(group.name), [group.name])
  const nodeCount = group.members.filter((m) => m.startsWith('node:')).length
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('flex flex-col rounded-lg border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/60', isDragging && 'z-10 opacity-60')}
    >
      <div className="flex items-start gap-1 border-b border-zinc-200 px-2 py-2 dark:border-zinc-800">
        <button ref={setActivatorNodeRef} {...listeners} {...attributes} className="mt-0.5 cursor-grab touch-none text-zinc-400 hover:text-zinc-700" title="拖动排序分组">
          <GripVertical className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setEditing(false)
                onRename(name)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setName(group.name)
                  setEditing(false)
                }
              }}
              className="h-7 text-sm"
            />
          ) : (
            <div className="truncate text-sm font-semibold" onDoubleClick={() => setEditing(true)} title="双击改名">
              {group.name}
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
            <span>{group.type}</span>
            <span>· {nodeCount} 个节点</span>
            {group.autoNew && <span className="text-blue-600" title={group.filter ? `新节点名称匹配 ${group.filter} 时自动加入` : '订阅新增的节点自动加入'}>· 自动加入新节点</span>}
          </div>
        </div>
        <button onClick={onSettings} className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800" title="分组设置">
          <Settings2 className="size-3.5" />
        </button>
        <button onClick={onDelete} className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-800" title="删除分组">
          <X className="size-3.5" />
        </button>
      </div>
      <div ref={drop.setNodeRef} className={cx('min-h-16 flex-1 space-y-1 p-2 transition-colors', drop.isOver && 'bg-blue-50/70 dark:bg-blue-950/30')}>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          <SortableContext items={group.members.map((m) => `m:${group.id}:${m}`)} strategy={verticalListSortingStrategy}>
            {group.members.map((m) => (
              <MemberItem key={m} gid={group.id} refKey={m} onRemove={() => onRemoveMember(m)}>
                {label(m)}
              </MemberItem>
            ))}
          </SortableContext>
        </div>
        {!group.members.length && <div className="py-4 text-center text-xs text-zinc-400">拖入节点</div>}
      </div>
    </div>
  )
}

function MemberItem({ gid, refKey, children, onRemove }: { gid: string; refKey: string; children: ReactNode; onRemove: () => void }) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: `m:${gid}:${refKey}`,
    data: { type: 'member', gid, ref: refKey },
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('group flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900', isDragging && 'opacity-40')}
    >
      <span {...listeners} {...attributes} className="cursor-grab touch-none text-zinc-400">
        <GripVertical className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      <button onClick={onRemove} className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-red-600" title="移除">
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function GroupSettings({ group, onClose, onSave }: { group: CustomGroup; onClose: () => void; onSave: (g: CustomGroup) => void }) {
  const [g, setG] = useState(group)
  return (
    <Modal
      open
      onClose={onClose}
      title="分组设置"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onSave(g)}>确定</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="名称">
          <Input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
        </Field>
        <Field label="类型">
          <Select value={g.type} onChange={(e) => setG({ ...g, type: e.target.value as ProxyGroupType })}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <ToggleRow
          label="自动加入新节点"
          hint="之后订阅里新增的节点自动加入本组（已手动移除的节点不会被加回）"
          checked={g.autoNew}
          onChange={(v) => setG({ ...g, autoNew: v })}
        />
        {g.autoNew && (
          <Field label="新节点名称筛选（正则）" hint="留空表示全部新节点">
            <Input value={g.filter} onChange={(e) => setG({ ...g, filter: e.target.value })} placeholder="港|HK" className="font-mono" />
          </Field>
        )}
        {group.origin && (
          <p className="flex items-start gap-1.5 text-xs text-zinc-500">
            <ArrowLeftRight className="mt-0.5 size-3.5 shrink-0" />
            规则中原本指向「{group.origin}」的流量会使用本组。
          </p>
        )}
      </div>
    </Modal>
  )
}
