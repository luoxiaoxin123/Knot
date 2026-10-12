import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { CopyButton, Modal } from './ui'

export function QrModal({ open, onClose, title, text }: { open: boolean; onClose: () => void; title: string; text: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!open || !text) return
    QRCode.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: 'M' }).then(setSrc, () => setSrc(''))
  }, [open, text])
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-sm">
      <div className="flex flex-col items-center gap-3">
        {src ? <img src={src} alt="二维码" className="size-64 rounded bg-white p-2" /> : <div className="text-sm text-zinc-500">内容过长，无法生成二维码</div>}
        <div className="w-full break-all rounded bg-zinc-50 p-2 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
          {text.length > 300 ? text.slice(0, 300) + '…' : text}
        </div>
        <CopyButton text={text} label="复制" />
      </div>
    </Modal>
  )
}
