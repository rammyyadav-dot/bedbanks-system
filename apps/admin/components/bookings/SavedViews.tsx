'use client'

import { useEffect, useRef, useState } from 'react'
import { SAVED_VIEW_DESCRIPTION_MAX, SAVED_VIEW_NAME_MAX, type BookingAccessView, type BookingListQuery, type BookingSavedViewView } from '@bedbanks/contracts'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { describeActionError } from '@/lib/booking-actions-ui'
import { currentViewPayload, isModified, viewHref, viewProblem } from '@/lib/booking-views-ui'
import { clearDefaultBookingView, createBookingView, deleteBookingView, getBookingViews, setDefaultBookingView, updateBookingView } from '@/lib/data/operations'
import { Modal } from './Modal'

const field: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit' }

type Dialog = { kind: 'save' } | { kind: 'rename' } | { kind: 'delete' } | null

function NameDialog({ title, initial, includeColumns, onClose, onSubmit }: { title: string; initial?: { name: string; description: string | null }; includeColumns?: boolean; onClose: () => void; onSubmit: (v: { name: string; description: string | null; withColumns: boolean }) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? ''); const [description, setDescription] = useState(initial?.description ?? ''); const [withColumns, setWithColumns] = useState(false)
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return
    if (!name.trim()) { setError('A name is required.'); return }
    setBusy(true); setError(null)
    try { await onSubmit({ name: name.trim(), description: description.trim() || null, withColumns }) } catch (err) { setError(describeActionError(err).message); setBusy(false) }
  }
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="view-form">
        <label style={field}><span>Name (required)</span><input value={name} maxLength={SAVED_VIEW_NAME_MAX} onChange={(e) => setName(e.target.value)} style={input} autoComplete="off" aria-invalid={error !== null && !name.trim()} /></label>
        <label style={field}><span>Description (optional)</span><textarea rows={2} maxLength={SAVED_VIEW_DESCRIPTION_MAX} value={description} onChange={(e) => setDescription(e.target.value)} style={input} /></label>
        {includeColumns && <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={withColumns} onChange={(e) => setWithColumns(e.target.checked)} /><span>Also remember the columns I am showing</span></label>}
        <p style={{ margin: 0, fontSize: 11, color: '#3f565c' }}>A view remembers filters, sort order and (optionally) columns. It is private to you and never widens what you are allowed to see.</p>
        {error && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }}>{error}</p>}
        <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Working…' : 'Save'}</button></div>
      </form>
    </Modal>
  )
}

/**
 * Saved views of the booking list (ADR 0039, Phase 6B). Choosing a view only navigates to the normal booking-query URL: the list is fetched through the same
 * canonical query as always, so the server validates it again for you. Views are private to the signed-in person; nothing here names an owner or a tenant.
 */
export function SavedViews({ access, query, columns, activeId, urlIsBlank, onOpen, onActive, onReset }: {
  access: BookingAccessView | null
  /** The effective list query in force (with its quick search). */
  query: BookingListQuery
  columns: readonly string[]
  activeId: string | null
  /** True when the URL carries no filters at all (the only time a default view is applied automatically). */
  urlIsBlank: boolean
  onOpen: (view: BookingSavedViewView) => void
  onActive: (id: string | null) => void
  /** Back to the system default list (Needs action), with no view. */
  onReset: () => void
}) {
  const allowed = access?.permissions.includes('booking.savedview.read') === true
  const can = (k: string) => access?.permissions.includes(k) === true
  const views = useOpsQuery(() => (allowed ? getBookingViews() : Promise.resolve(null)), [allowed])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const applied = useRef(false)
  const items = views.state.status === 'ready' && views.state.data ? views.state.data.items : []
  const active = items.find((v) => v.id === activeId) ?? null
  const modified = active ? isModified(query, active) : false

  // A default view is applied once, and only when the person arrives with no filters of their own.
  useEffect(() => {
    if (applied.current || !urlIsBlank || views.state.status !== 'ready' || !views.state.data) return
    applied.current = true
    const d = views.state.data.items.find((v) => v.isDefault)
    if (d && viewHref(d)) onOpen(d)
  }, [views.state, urlIsBlank, onOpen])

  if (!allowed) return null
  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return
    setBusy(true); setNote(null)
    try { await work(); setNote({ tone: 'ok', text: success }); views.reload() } catch (err) { setNote({ tone: 'bad', text: describeActionError(err).message }) } finally { setBusy(false) }
  }
  const payload = () => currentViewPayload(query, null)

  return (
    <section aria-label="Saved views" data-testid="saved-views" className="workspace-panel" style={{ padding: 10, margin: '0 0 10px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ fontSize: 11, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span>Saved view</span>
        <select data-testid="view-select" value={active?.id ?? ''} onChange={(e) => { const v = items.find((i) => i.id === e.target.value); if (v) onOpen(v); else onActive(null) }}>
          <option value="">{views.state.status === 'loading' ? 'Loading…' : 'Current filters (not saved)'}</option>
          {items.map((v) => <option key={v.id} value={v.id} disabled={v.resolution.status !== 'ok'}>{v.isDefault ? '★ ' : ''}{v.name}{v.resolution.status !== 'ok' ? ' (cannot be applied)' : ''}</option>)}
        </select>
      </label>
      {can('booking.savedview.create') && <button type="button" className="admin-btn" data-action="save-view" onClick={() => setDialog({ kind: 'save' })}>{active ? 'Save as new view…' : 'Save current view…'}</button>}
      {active && can('booking.savedview.update.own') && <>
        <button type="button" className="admin-btn" data-action="update-view" disabled={busy || !modified || active.resolution.status !== 'ok'} onClick={() => void run(() => updateBookingView(active.id, { expectedVersion: active.version, filters: payload().filters, sort: payload().sort }), 'View updated.')}>Update view</button>
        <button type="button" className="admin-btn" data-action="rename-view" onClick={() => setDialog({ kind: 'rename' })}>Rename…</button>
        <button type="button" className="admin-btn" data-action="default-view" disabled={busy} onClick={() => void run(() => (active.isDefault ? clearDefaultBookingView() : setDefaultBookingView(active.id)), active.isDefault ? 'No default view now.' : 'Default view set.')}>{active.isDefault ? 'Remove default' : 'Set as default'}</button>
      </>}
      {active && can('booking.savedview.delete.own') && <button type="button" className="admin-btn" data-action="delete-view" onClick={() => setDialog({ kind: 'delete' })}>Delete…</button>}
      {can('booking.savedview.update.own') && items.some((v) => v.isDefault) && <button type="button" className="admin-btn" data-action="reset-default" disabled={busy} onClick={() => void run(async () => { await clearDefaultBookingView(); onReset() }, 'Reset to the system default.')}>Reset to system default</button>}
      {active && modified && active.resolution.status === 'ok' && <span data-testid="view-modified" style={{ fontSize: 11, color: '#8a5a00' }}>Changed since saved</span>}
      <span role="status" aria-live="polite" data-testid="view-note" style={{ fontSize: 11, color: note?.tone === 'bad' ? '#a11d1d' : '#3f565c' }}>{note?.text ?? ''}</span>
      {views.state.status === 'failed' && <span role="alert" style={{ fontSize: 11, color: '#a11d1d' }}>Saved views could not be loaded.</span>}
      {active && viewProblem(active) && <p role="alert" data-testid="view-problem" style={{ flexBasis: '100%', margin: 0, fontSize: 12, color: '#a11d1d' }}>{viewProblem(active)}</p>}
      {items.length > 0 && items.some((v) => v.resolution.status !== 'ok') && !active && <small style={{ flexBasis: '100%', color: '#3f565c' }}>Some views cannot be applied (their filters changed or are no longer allowed to you); choose one and rename or delete it.</small>}

      {dialog?.kind === 'save' && <NameDialog title="Save current view" includeColumns onClose={() => setDialog(null)} onSubmit={async (v) => {
        const body = { name: v.name, description: v.description, ...currentViewPayload(query, v.withColumns ? columns : null) }
        const { data } = await createBookingView(body); setDialog(null); setNote({ tone: 'ok', text: `View “${v.name}” saved.` }); views.reload(); onActive(data.id)
      }} />}
      {dialog?.kind === 'rename' && active && <NameDialog title="Rename view" initial={{ name: active.name, description: active.description }} onClose={() => setDialog(null)} onSubmit={async (v) => {
        await updateBookingView(active.id, { expectedVersion: active.version, name: v.name, description: v.description }); setDialog(null); setNote({ tone: 'ok', text: 'View renamed.' }); views.reload()
      }} />}
      {dialog?.kind === 'delete' && active && (
        <Modal title="Delete view" onClose={() => setDialog(null)}>
          <div style={{ display: 'grid', gap: 10 }} data-testid="view-delete">
            <p style={{ margin: 0, fontSize: 12 }}>Delete “{active.name}”? This only removes your saved filters. No booking is affected.</p>
            <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="admin-btn admin-btn-primary" onClick={() => void run(async () => { await deleteBookingView(active.id); setDialog(null); onActive(null) }, 'View deleted.')}>Delete</button></div>
          </div>
        </Modal>
      )}
    </section>
  )
}
