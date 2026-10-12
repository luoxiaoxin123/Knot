import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Button, Input, Modal, cx } from './ui'

// ISO 3166-1 alpha-2
const ALL =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')

const COMMON = ['HK', 'TW', 'JP', 'SG', 'US', 'KR', 'GB', 'DE', 'FR', 'NL', 'CA', 'AU', 'RU', 'IN', 'TR', 'MY', 'TH', 'VN', 'PH', 'AR', 'BR', 'CN', 'MO', 'AE']

export function flagOf(code?: string) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

const names = (() => {
  try {
    const zh = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
    const en = new Intl.DisplayNames(['en'], { type: 'region' })
    return (c: string) => ({ zh: zh.of(c) || c, en: en.of(c) || c })
  } catch {
    return (c: string) => ({ zh: c, en: c })
  }
})()

export function regionName(code: string) {
  return names(code).zh
}

export function Flag({ code, className }: { code?: string; className?: string }) {
  if (!code) return null
  return (
    <span className={cx('shrink-0 leading-none', className)} title={regionName(code)}>
      {flagOf(code)}
    </span>
  )
}

/** 选择国旗。value 为空表示未设置 */
export function FlagPicker({ value, title = '设置国旗', onClose, onChange }: { value?: string; title?: string; onClose: () => void; onChange: (code: string) => void }) {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return null
    return ALL.filter((c) => {
      const n = names(c)
      return c.toLowerCase() === kw || n.zh.toLowerCase().includes(kw) || n.en.toLowerCase().includes(kw)
    })
  }, [q])
  const item = (c: string) => (
    <button
      key={c}
      type="button"
      onClick={() => onChange(c)}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/30',
        value === c ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40' : 'border-zinc-200 dark:border-zinc-800',
      )}
    >
      <span className="text-lg leading-none">{flagOf(c)}</span>
      <span className="truncate">{regionName(c)}</span>
      <span className="ml-auto font-mono text-[10px] text-zinc-400">{c}</span>
    </button>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="max-w-xl"
      footer={
        <>
          {value && <Button onClick={() => onChange('')}>清除国旗</Button>}
          <Button onClick={onClose}>取消</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索国家或地区：日本 / japan / JP" className="pl-8" />
        </div>
        <p className="text-xs text-zinc-500">按节点实际的落地地区手动选择（经过中转时 IP 归属地不准）。订阅输出开启「节点名加国旗」时，会加在节点名前面。</p>
        {list ? (
          list.length ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{list.map(item)}</div>
          ) : (
            <div className="py-8 text-center text-sm text-zinc-500">没有找到</div>
          )
        ) : (
          <>
            <div className="text-xs font-medium text-zinc-500">常用</div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{COMMON.map(item)}</div>
            <div className="pt-1 text-xs font-medium text-zinc-500">全部</div>
            <div className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">{ALL.filter((c) => !COMMON.includes(c)).map(item)}</div>
          </>
        )}
      </div>
    </Modal>
  )
}
