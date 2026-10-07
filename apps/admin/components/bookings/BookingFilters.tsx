'use client'

import { useEffect, useState } from 'react'
import { BOOKING_DATE_TYPES, BOOKING_PAYMENT_MODES, BOOKING_PAYMENT_STATUSES, BOOKING_STATUSES, BOOKING_UNASSIGNED_AGENCY, type BookingAccessView, type BookingListQuery } from '@bedbanks/contracts'
import { statusLabel } from '@/lib/booking-ui'
import { minorToMajorInput, parseMajorToMinor } from '@/lib/minor-units'

const label: React.CSSProperties = { display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }
const DATE_LABEL: Record<(typeof BOOKING_DATE_TYPES)[number] | 'updated', string> = { created: 'Booking date', updated: 'Last updated', checkIn: 'Check-in', checkOut: 'Check-out', cancelDeadline: 'Cancellation deadline' }
const PAYMENT_STATUS_LABEL: Record<string, string> = { PAID: 'Paid', UNPAID: 'Unpaid', OVERDUE: 'Overdue' }

/**
 * The filter bar. Every filter is applied together and lives in the URL; the API validates and applies them. Fields the caller cannot use are not shown:
 * agency is operator-level only, guest search needs the guest-data permission.
 */
export function BookingFilters({ query, access, agencies, onApply, onClear }: {
  query: BookingListQuery
  /** Null until the first successful response says what the caller may do. */
  access: BookingAccessView | null
  agencies: Array<{ id: string; name: string }> | null
  onApply: (next: Partial<BookingListQuery>) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState<BookingListQuery>(query)
  useEffect(() => setDraft(query), [query])
  const set = (change: Partial<BookingListQuery>) => setDraft((d) => ({ ...d, ...change }))
  const statuses = new Set((draft.status ?? '').split(',').filter(Boolean))
  const toggleStatus = (s: string) => { const next = new Set(statuses); if (next.has(s)) next.delete(s); else next.add(s); set({ status: [...next].join(',') || undefined }) }
  const agencySelected = new Set((draft.agencyId ?? '').split(',').filter(Boolean))
  const toggleAgency = (id: string) => { const next = new Set(agencySelected); if (next.has(id)) next.delete(id); else next.add(id); set({ agencyId: [...next].join(',') || undefined }) }
  const operator = access?.level !== 'AGENCY'
  // Amounts are typed in major units and sent as integer minor units; a bad number blocks Apply instead of being guessed.
  const [amountText, setAmountText] = useState({ min: '', max: '' })
  useEffect(() => setAmountText({ min: query.amountMin && query.currency ? minorToMajorInput(query.amountMin, query.currency) : '', max: query.amountMax && query.currency ? minorToMajorInput(query.amountMax, query.currency) : '' }), [query.amountMin, query.amountMax, query.currency])
  const parsedMin = amountText.min.trim() ? parseMajorToMinor(amountText.min, draft.currency ?? '') : undefined
  const parsedMax = amountText.max.trim() ? parseMajorToMinor(amountText.max, draft.currency ?? '') : undefined
  const amountError = (parsedMin === null || parsedMax === null) ? 'Enter amounts as plain numbers with at most the currency\u2019s decimals.' : parsedMin && parsedMax && BigInt(parsedMin) > BigInt(parsedMax) ? 'Amount from must not exceed amount to.' : null

  return (
    <form aria-label="Booking filters" className="workspace-panel" style={{ padding: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}
      onSubmit={(e) => { e.preventDefault(); if (amountError) return; onApply({ ...draft, amountMin: draft.currency ? parsedMin ?? undefined : undefined, amountMax: draft.currency ? parsedMax ?? undefined : undefined, currency: draft.currency || undefined, chip: query.chip, sort: query.sort, dir: query.dir }) }}>
      <label style={label}><span>Reference</span><input type="search" maxLength={64} placeholder="FB-…, supplier ref, hotel conf., agent ref" value={draft.reference ?? ''} onChange={(e) => set({ reference: e.target.value || undefined })} style={{ width: 230 }} /></label>
      {access?.canViewPii && <label style={label}><span>Guest name</span><input type="search" maxLength={60} value={draft.guest ?? ''} onChange={(e) => set({ guest: e.target.value || undefined })} style={{ width: 150 }} /></label>}
      {operator && (
        <details style={{ ...label, position: 'relative' }}>
          <summary style={{ cursor: 'pointer' }}>Agency{agencySelected.size ? ` (${agencySelected.size})` : ''}</summary>
          <fieldset style={{ position: 'absolute', zIndex: 3, background: '#fff', border: '1px solid #dbe6e9', borderRadius: 6, padding: 8, minWidth: 200, maxHeight: 240, overflow: 'auto' }}>
            <legend className="sr-only">Agency</legend>
            <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={agencySelected.has(BOOKING_UNASSIGNED_AGENCY)} onChange={() => toggleAgency(BOOKING_UNASSIGNED_AGENCY)} />Unassigned</label>
            {(agencies ?? []).map((a) => <label key={a.id} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={agencySelected.has(a.id)} onChange={() => toggleAgency(a.id)} />{a.name}</label>)}
            {agencies === null && <small style={{ color: '#3f565c' }}>The agency list needs the agency permission.</small>}
          </fieldset>
        </details>
      )}
      <label style={label}><span>Supplier</span><input type="search" maxLength={64} value={draft.supplier ?? ''} onChange={(e) => set({ supplier: e.target.value || undefined })} style={{ width: 140 }} /></label>
      <label style={label}><span>Hotel / city / country</span><input type="search" maxLength={60} value={draft.hotel ?? ''} onChange={(e) => set({ hotel: e.target.value || undefined })} style={{ width: 160 }} /></label>
      <details style={{ ...label, position: 'relative' }}>
        <summary style={{ cursor: 'pointer' }}>Status{statuses.size ? ` (${statuses.size})` : ''}</summary>
        <fieldset style={{ position: 'absolute', zIndex: 3, background: '#fff', border: '1px solid #dbe6e9', borderRadius: 6, padding: 8, minWidth: 190 }}>
          <legend className="sr-only">Booking status</legend>
          {BOOKING_STATUSES.map((s) => <label key={s} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={statuses.has(s)} onChange={() => toggleStatus(s)} />{statusLabel(s)}</label>)}
        </fieldset>
      </details>
      <label style={label}><span>Supplier status</span><input type="search" maxLength={40} value={draft.supplierStatus ?? ''} onChange={(e) => set({ supplierStatus: e.target.value || undefined })} style={{ width: 120 }} /></label>
      <label style={label}><span>Date type</span><select value={draft.dateType ?? ''} onChange={(e) => set({ dateType: (e.target.value || undefined) as BookingListQuery['dateType'] })}><option value="">Booking date</option>{[...BOOKING_DATE_TYPES, 'updated' as const].map((t) => <option key={t} value={t}>{DATE_LABEL[t]}</option>)}</select></label>
      <label style={label}><span>From</span><input type="date" value={draft.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /></label>
      <label style={label}><span>To</span><input type="date" value={draft.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} /></label>
      <label style={label}><span>Payment mode</span><select value={draft.paymentMode ?? ''} onChange={(e) => set({ paymentMode: (e.target.value || undefined) as BookingListQuery['paymentMode'] })}><option value="">Any</option>{BOOKING_PAYMENT_MODES.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase()}</option>)}</select></label>
      <label style={label}><span>Payment status</span><select value={draft.paymentStatus ?? ''} onChange={(e) => set({ paymentStatus: (e.target.value || undefined) as BookingListQuery['paymentStatus'] })}><option value="">Any</option>{BOOKING_PAYMENT_STATUSES.map((m) => <option key={m} value={m}>{PAYMENT_STATUS_LABEL[m]}</option>)}</select></label>
      <label style={label}><span>Destination (city / country)</span><input type="search" maxLength={60} value={draft.destination ?? ''} onChange={(e) => set({ destination: e.target.value || undefined })} style={{ width: 150 }} /></label>
      <label style={label}><span>Source</span><select value={draft.source ?? ''} onChange={(e) => set({ source: (e.target.value || undefined) as BookingListQuery['source'] })}><option value="">Any</option><option value="PORTAL">Agent portal</option><option value="API">API</option><option value="MANUAL">Entered manually</option></select></label>
      <label style={label}><span>Currency</span><input maxLength={3} value={draft.currency ?? ''} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} style={{ width: 54 }} placeholder="AED" aria-describedby="amount-note" /></label>
      <label style={label}><span>Amount from</span><input inputMode="decimal" disabled={!draft.currency} value={amountText.min} onChange={(e) => setAmountText((a) => ({ ...a, min: e.target.value }))} style={{ width: 90 }} aria-invalid={amountError !== null} /></label>
      <label style={label}><span>Amount to</span><input inputMode="decimal" disabled={!draft.currency} value={amountText.max} onChange={(e) => setAmountText((a) => ({ ...a, max: e.target.value }))} style={{ width: 90 }} aria-invalid={amountError !== null} /></label>
      <span id="amount-note" style={{ fontSize: 10, color: amountError ? '#a11d1d' : '#3f565c', alignSelf: 'center' }} role={amountError ? 'alert' : undefined}>{amountError ?? 'Amounts need a currency: sell amounts in different currencies are not comparable.'}</span>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
        <legend className="sr-only">Toggles</legend>
        <label style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={draft.missingSupplierRef === true} onChange={(e) => set({ missingSupplierRef: e.target.checked || undefined })} />Only missing supplier ref</label>
        <label style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={draft.nonRefundable === true} onChange={(e) => set({ nonRefundable: e.target.checked || undefined })} />Only non-refundable</label>
        <label style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={draft.amended === true} onChange={(e) => set({ amended: e.target.checked || undefined })} />Only amended</label>
        {operator && <label style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={draft.attention === true} onChange={(e) => set({ attention: e.target.checked || undefined })} />Only with reconciliation flags</label>}
      </fieldset>
      <button type="submit" className="admin-btn admin-btn-primary">Apply</button>
      <button type="button" className="admin-btn" onClick={onClear}>Clear filters</button>
    </form>
  )
}
