'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { OpsState } from '@/components/ops/OpsState'
import { getAgencies } from '@/lib/data/departments'
import { getHotelsCommercial } from '@/lib/data/hotel-commercial'
import { createManualBooking, getOpsBookings } from '@/lib/data/operations'
import { buildManualRequest, describeActionError, emptyManualForm, newIdempotencyKey, type ManualForm } from '@/lib/booking-actions-ui'

const field: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit', minWidth: 0 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }

/** Manual (offline or phone) booking entry (ADR 0039, Phase 2). Shown only when the API says this caller may use it; the API refuses it otherwise. */
export default function NewManualBookingPage() {
  const router = useRouter()
  const gate = useOpsQuery(() => getOpsBookings({ pageSize: 25, chip: 'latest' }).then((p) => p.access), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKINGS" title="Enter a booking manually" description="For a phone or offline booking. It is recorded as Pending supplier. No supplier is called, no inventory is held and no credit is used; record the supplier’s answer afterwards." />
      <OpsState state={gate.state} onRetry={gate.reload}>
        {(access) => access.manualEntry
          ? <ManualForm canSend={access.supplierDispatch} onCreated={(id) => router.push(`/bookings/${encodeURIComponent(id)}`)} />
          : <div className="workspace-panel" role="status" data-state="forbidden" data-testid="manual-unavailable" style={{ padding: 18 }}><strong>Manual entry is not available to you here.</strong><p style={{ margin: '6px 0 0' }}>It needs the “manual booking” permission and is switched off in some environments. <Link href="/bookings">Back to bookings</Link></p></div>}
      </OpsState>
    </div>
  )
}

function ManualForm({ onCreated, canSend }: { onCreated: (bookingId: string) => void; canSend: boolean }) {
  const [form, setForm] = useState<ManualForm>(emptyManualForm())
  const [key] = useState(newIdempotencyKey)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<ReturnType<typeof describeActionError> | null>(null)
  const [busy, setBusy] = useState(false)
  const agencies = useOpsQuery(() => getAgencies({ pageSize: 100 }).then((p) => p.items.filter((a) => a.status === 'ACTIVE').map((a) => ({ id: a.id, name: a.name }))), [])
  const hotels = useOpsQuery(() => getHotelsCommercial({ pageSize: 100 }).then((p) => p.items.map((h) => ({ id: h.id, name: `${h.name} — ${h.city}` }))), [])
  const set = (patch: Partial<ManualForm>) => setForm((f) => ({ ...f, ...patch }))
  const err = (k: string) => errors[k] ? <span role="alert" style={{ color: '#a11d1d', fontSize: 11 }}>{errors[k]}</span> : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const built = buildManualRequest(form)
    if ('errors' in built) { setErrors(built.errors); setFailure(null); return }
    setErrors({}); setFailure(null); setBusy(true)
    try { const { data } = await createManualBooking(built.request, key); onCreated(data.bookingId) } catch (error) { setFailure(describeActionError(error)); setBusy(false) }
  }
  const select = (label: string, k: 'agencyId' | 'hotelId', state: typeof agencies.state) => (
    <label style={field}><span>{label} (required)</span>
      <select value={form[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<ManualForm>)} style={input} aria-invalid={Boolean(errors[k])} disabled={state.status !== 'ready'}>
        <option value="">{state.status === 'loading' ? 'Loading…' : state.status === 'failed' ? 'Could not load' : 'Choose…'}</option>
        {state.status === 'ready' && state.data.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>{err(k)}</label>
  )

  return (
    <form onSubmit={submit} noValidate className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 14 }} data-testid="manual-booking-form" aria-label="Manual booking">
      <div style={grid}>
        {select('Agency', 'agencyId', agencies.state)}
        {select('Hotel', 'hotelId', hotels.state)}
        <label style={field}><span>Supplier (required)</span><input value={form.supplier} maxLength={80} onChange={(e) => set({ supplier: e.target.value })} style={input} aria-invalid={Boolean(errors.supplier)} />{err('supplier')}</label>
        <label style={field}><span>Agency’s own reference</span><input value={form.agentRef} maxLength={64} onChange={(e) => set({ agentRef: e.target.value })} style={input} /></label>
      </div>
      <div style={grid}>
        <label style={field}><span>Check-in (required)</span><input type="date" value={form.checkIn} onChange={(e) => set({ checkIn: e.target.value })} style={input} aria-invalid={Boolean(errors.checkIn)} />{err('checkIn')}</label>
        <label style={field}><span>Check-out (required)</span><input type="date" value={form.checkOut} onChange={(e) => set({ checkOut: e.target.value })} style={input} aria-invalid={Boolean(errors.checkOut)} />{err('checkOut')}</label>
        <label style={field}><span>Free cancellation until</span><input type="datetime-local" value={form.cancelDeadline} onChange={(e) => set({ cancelDeadline: e.target.value })} style={input} /></label>
        <label style={field}><span>Refundable</span><select value={form.refundable} onChange={(e) => set({ refundable: e.target.value as ManualForm['refundable'] })} style={input}><option value="">Not known</option><option value="yes">Yes</option><option value="no">No</option></select></label>
      </div>
      <div style={grid}>
        <label style={field}><span>Currency</span><input value={form.currency} readOnly style={{ ...input, background: '#f1f6f7' }} /></label>
        <label style={field}><span>Sell amount (required)</span><input inputMode="decimal" value={form.sell} onChange={(e) => set({ sell: e.target.value })} style={input} aria-invalid={Boolean(errors.sell)} placeholder="2500.00" />{err('sell')}</label>
        <label style={field}><span>Net amount</span><input inputMode="decimal" value={form.net} onChange={(e) => set({ net: e.target.value })} style={input} aria-invalid={Boolean(errors.net)} placeholder="optional" />{err('net')}</label>
        <label style={field}><span>Payment mode</span><select value={form.paymentMode} onChange={(e) => set({ paymentMode: e.target.value as ManualForm['paymentMode'] })} style={input}><option value="">Not recorded</option><option value="CREDIT">Credit</option><option value="PREPAID">Prepaid</option><option value="PAY_AT_HOTEL">Pay at hotel</option></select></label>
      </div>
      <fieldset style={{ border: '1px solid #dbe6e9', borderRadius: 6, padding: 12, display: 'grid', gap: 10 }}>
        <legend style={{ fontSize: 12 }}>Rooms</legend>
        {form.rooms.map((r, i) => (
          <div key={i} style={grid} role="group" aria-label={`Room ${i + 1}`}>
            <label style={field}><span>Room name (required)</span><input value={r.roomName} onChange={(e) => set({ rooms: form.rooms.map((x, j) => (j === i ? { ...x, roomName: e.target.value } : x)) })} style={input} aria-invalid={Boolean(errors[`rooms.${i}.roomName`])} />{err(`rooms.${i}.roomName`)}</label>
            <label style={field}><span>Board</span><input value={r.boardCode} maxLength={8} onChange={(e) => set({ rooms: form.rooms.map((x, j) => (j === i ? { ...x, boardCode: e.target.value } : x)) })} style={input} placeholder="BB" /></label>
            <label style={field}><span>Adults</span><input inputMode="numeric" value={r.adults} onChange={(e) => set({ rooms: form.rooms.map((x, j) => (j === i ? { ...x, adults: e.target.value } : x)) })} style={input} aria-invalid={Boolean(errors[`rooms.${i}.adults`])} />{err(`rooms.${i}.adults`)}</label>
            <label style={field}><span>Children</span><input inputMode="numeric" value={r.children} onChange={(e) => set({ rooms: form.rooms.map((x, j) => (j === i ? { ...x, children: e.target.value } : x)) })} style={input} />{err(`rooms.${i}.children`)}</label>
            <label style={field}><span>Child ages</span><input value={r.childAges} onChange={(e) => set({ rooms: form.rooms.map((x, j) => (j === i ? { ...x, childAges: e.target.value } : x)) })} style={input} placeholder="6, 9" />{err(`rooms.${i}.childAges`)}</label>
            {form.rooms.length > 1 && <button type="button" className="admin-btn" onClick={() => set({ rooms: form.rooms.filter((_, j) => j !== i) })}>Remove room {i + 1}</button>}
          </div>
        ))}
        {form.rooms.length < 9 && <div><button type="button" className="admin-btn" onClick={() => set({ rooms: [...form.rooms, { roomName: '', boardCode: '', adults: '2', children: '0', childAges: '' }] })}>Add a room</button></div>}
      </fieldset>
      <fieldset style={{ border: '1px solid #dbe6e9', borderRadius: 6, padding: 12, display: 'grid', gap: 10 }}>
        <legend style={{ fontSize: 12 }}>Guests (personal data: masked from users without permission)</legend>
        {form.guests.map((g, i) => (
          <div key={i} style={grid} role="group" aria-label={`Guest ${i + 1}`}>
            <label style={field}><span>Title</span><input value={g.title} maxLength={12} onChange={(e) => set({ guests: form.guests.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} style={input} autoComplete="off" /></label>
            <label style={field}><span>First name (required)</span><input value={g.firstName} maxLength={80} onChange={(e) => set({ guests: form.guests.map((x, j) => (j === i ? { ...x, firstName: e.target.value } : x)) })} style={input} aria-invalid={Boolean(errors[`guests.${i}.firstName`])} autoComplete="off" />{err(`guests.${i}.firstName`)}</label>
            <label style={field}><span>Last name (required)</span><input value={g.lastName} maxLength={80} onChange={(e) => set({ guests: form.guests.map((x, j) => (j === i ? { ...x, lastName: e.target.value } : x)) })} style={input} aria-invalid={Boolean(errors[`guests.${i}.lastName`])} autoComplete="off" />{err(`guests.${i}.lastName`)}</label>
            <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'center', gap: 6 }}><input type="radio" name="lead" checked={g.isLead} onChange={() => set({ guests: form.guests.map((x, j) => ({ ...x, isLead: j === i })) })} /><span>Lead guest</span></label>
            {form.guests.length > 1 && <button type="button" className="admin-btn" onClick={() => set({ guests: form.guests.filter((_, j) => j !== i).map((x, j, all) => (all.some((y) => y.isLead) ? x : { ...x, isLead: j === 0 })) })}>Remove guest {i + 1}</button>}
          </div>
        ))}
        {err('guests')}
        {form.guests.length < 40 && <div><button type="button" className="admin-btn" onClick={() => set({ guests: [...form.guests, { title: '', firstName: '', lastName: '', isLead: false }] })}>Add a guest</button></div>}
      </fieldset>
      {canSend && (
        <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'start', gap: 8 }}>
          <input type="checkbox" checked={form.sendToSupplier} onChange={(e) => set({ sendToSupplier: e.target.checked })} />
          <span>Send to the supplier now. It is queued and the result appears on the booking; if no supplier connection exists for this supplier name, nothing is created.</span>
        </label>
      )}
      {Object.keys(errors).length > 0 && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }}>Fix the highlighted fields and try again.</p>}
      {failure && <div role="alert" data-testid="manual-error" style={{ color: '#a11d1d', fontSize: 12 }}>{failure.message}{failure.requestId ? <div style={{ fontSize: 11, color: '#3f565c' }}>Reference: request {failure.requestId}</div> : null}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Link href="/bookings" className="admin-btn">Cancel</Link>
        <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Creating…' : 'Create booking'}</button>
      </div>
    </form>
  )
}
