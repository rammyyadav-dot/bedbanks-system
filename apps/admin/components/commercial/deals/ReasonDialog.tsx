'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * A modal that asks for the reason an action needs, and says what the action will do before it is confirmed. Native <dialog>: focus is trapped,
 * Escape cancels, and the confirm button stays disabled until a reason of at least `minLength` characters is given (or `reasonOptional`).
 */
export function ReasonDialog({ open, title, children, confirmLabel, tone = 'primary', minLength = 3, reasonOptional = false, busy = false, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; minLength?: number; reasonOptional?: boolean; busy?: boolean
  onConfirm: (reason: string) => void; onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [reason, setReason] = useState('')
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) { setReason(''); dialog.showModal() }
    if (!open && dialog.open) dialog.close()
  }, [open])
  const ok = reasonOptional || reason.trim().length >= minLength
  return (
    <dialog ref={ref} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); if (!busy) onCancel() }} style={{ border: '1px solid var(--c-d3e0e3)', borderRadius: 8, padding: 20, maxWidth: 'min(480px, calc(100vw - 32px))', width: '100%', color: 'var(--c-17333e)' }}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (ok && !busy) onConfirm(reason.trim()) }} style={{ display: 'grid', gap: 12 }}>
        <h2 id={`${id}-title`} style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        {children ? <div style={{ fontSize: 12, color: 'var(--c-3f565c)' }}>{children}</div> : null}
        <label htmlFor={`${id}-reason`} style={{ display: 'grid', gap: 4, fontSize: 11, color: 'var(--c-3f565c)' }}>
          Reason{reasonOptional ? ' (optional)' : ` (at least ${minLength} characters)`}
          <textarea id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} required={!reasonOptional} style={{ color: 'var(--c-17333e)', font: 'inherit', padding: 8 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="admin-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className={`admin-btn ${tone === 'danger' ? 'admin-btn-danger' : 'admin-btn-primary'}`} disabled={!ok || busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </dialog>
  )
}
