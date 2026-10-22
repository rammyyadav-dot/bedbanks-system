'use client'

import { useMemo, useRef, useState } from 'react'
import {
  LOCAL_CHARGE_BASES, LOCAL_CHARGE_BASIS_LABELS, LOCAL_CHARGE_KINDS, LOCAL_CHARGE_KIND_LABELS, LOCAL_CHARGE_LIMITS,
  type HotelLocalCharge, type HotelSetupView, type LocalChargeBasis, type LocalChargeKind,
} from '@bedbanks/contracts'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { saveHotelSetup } from '@/lib/data/hotel-setup'
import { minorToMajorInput, parseMajorToMinor } from '@/lib/minor-units'
import { useUnsavedChanges } from '../useUnsavedChanges'

interface Row { kind: LocalChargeKind; label: string; amount: string; currency: string; basis: LocalChargeBasis; maxNights: string }
const toRow = (c: HotelLocalCharge): Row => ({ kind: c.kind, label: c.label, amount: minorToMajorInput(c.amountMinor, c.currency), currency: c.currency, basis: c.basis, maxNights: c.maxNights === null ? '' : String(c.maxNights) })
const note = { color: 'var(--c-3f565c)', fontSize: 11, margin: 0 } as const

/**
 * Charges the guest pays the hotel directly (ADR 0067, F-04), such as the Dubai Tourism Dirham. Agents see them on every offer with an estimate,
 * and the voucher, invoice and confirmation email list them as payable at the hotel. They are never added to the price. Saved through Hotel Setup.
 */
export function LocalChargesEditor({ hotelId, setup, onSaved }: { hotelId: string; setup: HotelSetupView; onSaved: (text: string) => void }) {
  const canManage = useCan()('supply.hotels.manage')
  const initial = useMemo(() => setup.localCharges.map(toRow), [setup.localCharges])
  const [rows, setRows] = useState<Row[]>(initial)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const key = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null)
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial)
  useUnsavedChanges(dirty)
  const update = (i: number, patch: Partial<Row>) => { key.current = null; setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row))) }

  async function save() {
    if (inFlight.current || !dirty) return
    const localCharges: HotelLocalCharge[] = []
    for (const [i, row] of rows.entries()) {
      const amountMinor = parseMajorToMinor(row.amount, row.currency.toUpperCase())
      if (amountMinor === null) { setError({ message: `Charge ${i + 1}: enter the amount in ${row.currency || 'its currency'}.`, details: [] }); return }
      localCharges.push({ kind: row.kind, label: row.label.trim(), amountMinor, currency: row.currency.trim().toUpperCase(), basis: row.basis, maxNights: row.maxNights.trim() === '' ? null : Number(row.maxNights) })
    }
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const { data } = await saveHotelSetup(hotelId, { idempotencyKey: key.current, expectedToken: setup.concurrencyToken, localCharges })
      key.current = null; onSaved(`Local charges saved. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (e) { const p = apiErrorParts(e, 'save the local charges'); setError({ message: p.message, details: p.details }) } finally { inFlight.current = false; setBusy(false) }
  }

  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Local charges paid at the hotel" data-testid="local-charges" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Local charges paid at the hotel</h2>
      <p style={note}>Not included in the price. Agents see each charge on every offer with an estimate for the stay, and the voucher, invoice and confirmation email list them. In Dubai, record the Tourism Dirham for the hotel's category per room per night, capped at 30 nights.</p>
      {rows.length === 0 ? <p style={{ fontSize: 12, margin: 0 }}>No local charge recorded.</p> : rows.map((row, i) => (
        <div key={i} className="admin-filter-bar" data-testid="local-charge-row">
          <select aria-label={`Charge ${i + 1} kind`} value={row.kind} disabled={!canManage} onChange={(e) => update(i, { kind: e.target.value as LocalChargeKind, label: row.label || LOCAL_CHARGE_KIND_LABELS[e.target.value as LocalChargeKind] })}>{LOCAL_CHARGE_KINDS.map((k) => <option key={k} value={k}>{LOCAL_CHARGE_KIND_LABELS[k]}</option>)}</select>
          <input aria-label={`Charge ${i + 1} label shown to agents`} value={row.label} maxLength={LOCAL_CHARGE_LIMITS.labelMax} readOnly={!canManage} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label shown to agents" />
          <input aria-label={`Charge ${i + 1} amount`} inputMode="decimal" value={row.amount} readOnly={!canManage} onChange={(e) => update(i, { amount: e.target.value })} placeholder="Amount" style={{ width: 90 }} />
          <input aria-label={`Charge ${i + 1} currency`} value={row.currency} maxLength={3} readOnly={!canManage} onChange={(e) => update(i, { currency: e.target.value.toUpperCase() })} style={{ width: 56 }} />
          <select aria-label={`Charge ${i + 1} basis`} value={row.basis} disabled={!canManage} onChange={(e) => update(i, { basis: e.target.value as LocalChargeBasis, maxNights: e.target.value.endsWith('_PER_STAY') ? '' : row.maxNights })}>{LOCAL_CHARGE_BASES.map((b) => <option key={b} value={b}>{LOCAL_CHARGE_BASIS_LABELS[b]}</option>)}</select>
          <input aria-label={`Charge ${i + 1} night cap`} inputMode="numeric" value={row.maxNights} readOnly={!canManage || row.basis.endsWith('_PER_STAY')} onChange={(e) => update(i, { maxNights: e.target.value })} placeholder="Night cap" style={{ width: 80 }} />
          {canManage ? <button type="button" className="admin-btn" onClick={() => { key.current = null; setRows((r) => r.filter((_, j) => j !== i)) }}>Remove</button> : null}
        </div>
      ))}
      {canManage ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="admin-btn" disabled={rows.length >= LOCAL_CHARGE_LIMITS.charges} onClick={() => { key.current = null; setRows((r) => [...r, { kind: 'TOURISM_DIRHAM', label: LOCAL_CHARGE_KIND_LABELS.TOURISM_DIRHAM, amount: '', currency: 'AED', basis: 'PER_ROOM_PER_NIGHT', maxNights: '30' }]) }}>Add charge</button>
          <button type="submit" className="button primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save local charges'}</button>
          {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={() => setRows(initial)}>Discard edits</button>}
        </div>
      ) : <span style={note}>You can view these charges but not change them.</span>}
      {error && <div role="alert" className="admin-error" style={{ padding: 12 }}><strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </form>
  )
}
