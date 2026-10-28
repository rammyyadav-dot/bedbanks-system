'use client'

import { useMemo, useRef, useState } from 'react'
import {
  LOCAL_CHARGE_BASES, LOCAL_CHARGE_BASIS_LABELS, LOCAL_CHARGE_KINDS, LOCAL_CHARGE_KIND_LABELS, LOCAL_CHARGE_LIMITS,
  type HotelLocalCharge, type HotelSetupView, type LocalChargeBasis, type LocalChargeKind,
} from '@bedbanks/contracts'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { getHotelSetup, saveHotelSetup } from '@/lib/data/hotel-setup'
import { minorToMajorInput, parseMajorToMinor } from '@/lib/minor-units'
import { DraftStatus, SaveFailureNotice, type SaveFailure } from '../DraftNotices'
import { useDraftRecovery } from '../useDraftRecovery'
import { useDraftState } from '../useDraftState'
import { useUnsavedChanges } from '../useUnsavedChanges'

interface Row { kind: LocalChargeKind; label: string; amount: string; currency: string; basis: LocalChargeBasis; maxNights: string }
const toRow = (c: HotelLocalCharge): Row => ({ kind: c.kind, label: c.label, amount: minorToMajorInput(c.amountMinor, c.currency), currency: c.currency, basis: c.basis, maxNights: c.maxNights === null ? '' : String(c.maxNights) })
const note = { color: 'var(--c-444444)', fontSize: 11, margin: 0 } as const

type ChargeDraft = { rows: Row[] }
const isRow = (r: unknown): r is Row => !!r && typeof r === 'object' && ['kind', 'label', 'amount', 'currency', 'basis', 'maxNights'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string')
const isChargeDraft = (v: unknown): v is ChargeDraft => !!v && typeof v === 'object' && Array.isArray((v as ChargeDraft).rows) && (v as ChargeDraft).rows.every(isRow)

/**
 * Charges the guest pays the hotel directly (ADR 0067, F-04), such as the Dubai Tourism Dirham. Agents see them on every offer with an estimate,
 * and the voucher, invoice and confirmation email list them as payable at the hotel. They are never added to the price. Saved through Hotel Setup.
 * The draft is independent of the Hotel policies editor beside it: see PoliciesPanel for how the shared stored version is kept in step.
 */
export function LocalChargesEditor({ hotelId, setup, otherSaving, onSaving, onSaved, onLoadLatest }: {
  hotelId: string; setup: HotelSetupView; otherSaving: boolean
  onSaving: (on: boolean) => void; onSaved: (text: string, next: HotelSetupView) => void; onLoadLatest: (latest: HotelSetupView) => void
}) {
  const canManage = useCan()('supply.hotels.manage')
  const baseline = useMemo<ChargeDraft>(() => ({ rows: setup.localCharges.map(toRow) }), [setup.localCharges])
  const state = useDraftState<ChargeDraft>(baseline)
  const rows = state.draft.rows
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const key = useRef<string | null>(null)
  const [error, setError] = useState<SaveFailure | null>(null)
  useUnsavedChanges(state.dirty)
  const recovery = useDraftRecovery<ChargeDraft>({ scope: 'local-charges', hotelId, base: baseline, value: state.draft, dirty: state.dirty, valid: isChargeDraft, onRestore: (r) => state.restore(r.base, r.value) })
  const setRows = (change: (r: Row[]) => Row[]) => { key.current = null; state.setDraft((d) => ({ rows: change(d.rows) })) }
  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  const discard = () => { key.current = null; setError(null); recovery.dismiss(); state.reset() }

  async function save() {
    if (inFlight.current || !state.dirty || otherSaving) return
    const submitted = state.draft
    const localCharges: HotelLocalCharge[] = []
    for (const [i, row] of submitted.rows.entries()) {
      const amountMinor = parseMajorToMinor(row.amount, row.currency.toUpperCase())
      if (amountMinor === null) { setError({ message: `Charge ${i + 1}: enter the amount in ${row.currency || 'its currency'}.`, details: [], requestId: null, stale: false }); return }
      localCharges.push({ kind: row.kind, label: row.label.trim(), amountMinor, currency: row.currency.trim().toUpperCase(), basis: row.basis, maxNights: row.maxNights.trim() === '' ? null : Number(row.maxNights) })
    }
    inFlight.current = true; setBusy(true); onSaving(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const { data } = await saveHotelSetup(hotelId, { idempotencyKey: key.current, expectedToken: setup.concurrencyToken, localCharges })
      key.current = null; recovery.dismiss()
      state.markSaved(submitted, { rows: data.setup.localCharges.map(toRow) })
      onSaved(`Local charges saved. Request id ${data.auditRequestId || 'not recorded'}.`, data.setup)
    } catch (e) {
      const p = apiErrorParts(e, 'save the local charges') // the draft and its idempotency key are kept, so retrying the same content is a safe replay
      setError({ message: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'HOTEL_SETUP_STALE' })
    } finally { inFlight.current = false; setBusy(false); onSaving(false) }
  }
  async function loadLatest(keepEdits: boolean) {
    setBusy(true)
    try {
      const latest = await getHotelSetup(hotelId)
      key.current = null; setError(null)
      if (!keepEdits) state.reset({ rows: latest.localCharges.map(toRow) })
      onLoadLatest(latest)
    } catch (e) { const p = apiErrorParts(e, 'load the latest hotel version'); setError({ message: p.message, details: p.details, requestId: p.requestId, stale: true }) } finally { setBusy(false) }
  }

  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Local charges paid at the hotel" aria-busy={busy} data-testid="local-charges" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Local charges paid at the hotel</h2>
      <DraftStatus recoveredAt={recovery.recovered?.savedAt ?? null} conflicts={state.conflicts.length ? ['local charges'] : []} busy={busy} onDiscard={discard} onDismiss={() => { recovery.dismiss(); state.clearConflicts() }} />
      <p style={note}>Not included in the price. Agents see each charge on every offer with an estimate for the stay, and the voucher, invoice and confirmation email list them. In Dubai, record the Tourism Dirham for the hotel's category per room per night, capped at 30 nights.</p>
      {rows.length === 0 ? <p style={{ fontSize: 12, margin: 0 }}>No local charge recorded.</p> : rows.map((row, i) => (
        <div key={i} className="admin-filter-bar" data-testid="local-charge-row">
          <select aria-label={`Charge ${i + 1} kind`} value={row.kind} disabled={!canManage} onChange={(e) => update(i, { kind: e.target.value as LocalChargeKind, label: row.label || LOCAL_CHARGE_KIND_LABELS[e.target.value as LocalChargeKind] })}>{LOCAL_CHARGE_KINDS.map((k) => <option key={k} value={k}>{LOCAL_CHARGE_KIND_LABELS[k]}</option>)}</select>
          <input aria-label={`Charge ${i + 1} label shown to agents`} value={row.label} maxLength={LOCAL_CHARGE_LIMITS.labelMax} readOnly={!canManage} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label shown to agents" />
          <input aria-label={`Charge ${i + 1} amount`} inputMode="decimal" value={row.amount} readOnly={!canManage} onChange={(e) => update(i, { amount: e.target.value })} placeholder="Amount" style={{ width: 90 }} />
          <input aria-label={`Charge ${i + 1} currency`} value={row.currency} maxLength={3} readOnly={!canManage} onChange={(e) => update(i, { currency: e.target.value.toUpperCase() })} style={{ width: 56 }} />
          <select aria-label={`Charge ${i + 1} basis`} value={row.basis} disabled={!canManage} onChange={(e) => update(i, { basis: e.target.value as LocalChargeBasis, maxNights: e.target.value.endsWith('_PER_STAY') ? '' : row.maxNights })}>{LOCAL_CHARGE_BASES.map((b) => <option key={b} value={b}>{LOCAL_CHARGE_BASIS_LABELS[b]}</option>)}</select>
          <input aria-label={`Charge ${i + 1} night cap`} inputMode="numeric" value={row.maxNights} readOnly={!canManage || row.basis.endsWith('_PER_STAY')} onChange={(e) => update(i, { maxNights: e.target.value })} placeholder="Night cap" style={{ width: 80 }} />
          {canManage ? <button type="button" className="admin-btn" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>Remove</button> : null}
        </div>
      ))}
      {canManage ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="admin-btn" disabled={rows.length >= LOCAL_CHARGE_LIMITS.charges} onClick={() => { setRows((r) => [...r, { kind: 'TOURISM_DIRHAM', label: LOCAL_CHARGE_KIND_LABELS.TOURISM_DIRHAM, amount: '', currency: 'AED', basis: 'PER_ROOM_PER_NIGHT', maxNights: '30' }]) }}>Add charge</button>
          <button type="submit" className="button primary" disabled={busy || otherSaving || !state.dirty} data-testid="local-charges-save">{busy ? 'Saving…' : 'Save local charges'}</button>
          {state.dirty && <button type="button" className="admin-btn" disabled={busy} onClick={discard}>Discard edits</button>}
          {otherSaving && <span style={note} role="status">Waiting for the policies save to finish…</span>}
        </div>
      ) : <span style={note}>You can view these charges but not change them.</span>}
      {error && <SaveFailureNotice failure={error} testId="local-charges-error" busy={busy} onKeepMine={() => void loadLatest(true)} onDiscardMine={() => void loadLatest(false)} />}
    </form>
  )
}
