import { useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'

function useDark() {
  const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  const [dark, setDark] = useState(!!mq?.matches)
  useEffect(() => {
    if (!mq) return
    const fn = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [mq])
  return dark
}

export function CodeEditor({
  value,
  onChange,
  lang = 'yaml',
  height = '320px',
  readOnly,
}: {
  value: string
  onChange?: (v: string) => void
  lang?: 'yaml' | 'json' | 'text'
  height?: string
  readOnly?: boolean
}) {
  const dark = useDark()
  const exts = [EditorView.lineWrapping]
  if (lang === 'yaml') exts.push(yaml())
  if (lang === 'json') exts.push(json())
  return (
    <div className="overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
      <CodeMirror
        value={value}
        onChange={onChange}
        height={height}
        theme={dark ? 'dark' : 'light'}
        extensions={exts}
        readOnly={readOnly}
        editable={!readOnly}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: false }}
      />
    </div>
  )
}
