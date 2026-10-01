'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, ShieldAlert } from 'lucide-react'
import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { BookingService, type BookingFailure } from '@/services/booking-service'
import { formatMinorAmount } from '@/lib/format'

type Phase = 'idle' | 'holding' | 'held' | 'booking' | 'done' | 'failed'
const newKey = () => `hold-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
const clock = (ms: number) => { const total = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` }
const HOLD_MESSAGES: Record<string, string> = {
  unavailable: 'This rate is no longer available. No inventory was held.', offer_expired: 'This offer expired. Search again for a current rate.', mapping_invalid: 'The hotel or room could not be verified. No inventory was held.',
  provider_unavailable: 'Inventory could not be checked safely. Nothing was held; try again.', rejected: 'The offer could not be verified. Nothing was held.', rechecked: 'The rate is valid but no hold was created.',
}

/** Hold → guest details → prebook → confirm for one rechecked offer. All state shown comes from the API; a failure never looks like success. */
export function BookingCheckout({ tenantId, hotelName, roomName, rate, searchId, request, onBooked, onViewBooking, service }: {
  tenantId: string; hotelName: string; roomName: string; rate: SearchRateOffer; searchId: string; request: SearchCriteria
  onBooked: () => void; onViewBooking: (bookingId: string) => void; service?: BookingService
}) {
  const api = useRef(service ?? new BookingService()).current
  const holdKey = useRef(newKey())
  const [phase, setPhase] = useState<Phase>('idle')
  const [hold, setHold] = useState<{ holdId: string; expiresAt: string } | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [guest, setGuest] = useState({ firstName: '', lastName: '' })
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (phase !== 'held') return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [phase])

  const total = formatMinorAmount(rate.total.amountMinor, rate.total.currency) ?? 'Price unavailable'
  const remaining = hold ? Date.parse(hold.expiresAt) - now : 0
  const expired = phase === 'held' && remaining <= 0
  const failure = (result: BookingFailure) => { setMessage(result.message); if (result.kind === 'auth' || result.kind === 'denied' || result.kind === 'unavailable') setPhase('failed') }
  const validGuest = guest.firstName.trim().length > 0 && guest.lastName.trim().length > 0 && guest.firstName.length <= 80 && guest.lastName.length <= 80

  async function holdRate() {
    setPhase('holding'); setMessage('')
    const result = await api.hold(rate.offerId, searchId, rate.total.currency, rate.sellAmountMinor, holdKey.current, tenantId)
    if (!result.ok) { failure(result); if (result.kind !== 'auth' && result.kind !== 'denied' && result.kind !== 'unavailable') setPhase('idle'); return }
    const out = result.data
    if (out.status === 'held' && out.holdId && out.expiresAt) { setHold({ holdId: out.holdId, expiresAt: out.expiresAt }); setNow(Date.now()); setPhase('held'); return }
    setPhase('idle')
    setMessage(out.status === 'price_changed' ? `The price changed${out.currency && out.sellAmountMinor !== undefined ? ` to ${formatMinorAmount(out.sellAmountMinor, out.currency)}` : ''}. Recheck the rate to accept the new total.` : (HOLD_MESSAGES[out.status] ?? 'The rate could not be held.'))
  }

  async function releaseHold() {
    if (!hold || phase === 'booking') return
    setMessage('')
    const result = await api.releaseHold(hold.holdId, tenantId)
    if (!result.ok) { setMessage(result.message); return }
    holdKey.current = newKey(); setHold(null); setBookingId(null); setPhase('idle'); setMessage('Hold released. The inventory is available again.')
  }

  async function book() {
    if (!hold || !validGuest || phase === 'booking') return
    setPhase('booking'); setMessage('')
    let id = bookingId
    if (!id) {
      const pre = await api.prebook(hold.holdId, { adults: request.adults, children: request.children, childAges: request.childAges, firstName: guest.firstName, lastName: guest.lastName }, tenantId)
      if (!pre.ok) { holdKey.current = newKey(); setHold(null); failure(pre); setPhase('failed'); return }
      id = pre.data.bookingId; setBookingId(id); setReference(pre.data.bookingReference)
    }
    const done = await api.confirm(id, tenantId)
    if (!done.ok) { setMessage(`${done.message} Your booking was reserved but not confirmed; you can retry confirmation.`); setPhase('held'); return }
    setReference(done.data.reference); setPhase('done'); onBooked()
  }

  if (phase === 'done' && bookingId) return <div className="portal-hold-outcome is-rechecked booking-done" role="status"><CheckCircle2 size={18} /><strong>Booking confirmed · {reference}</strong><span>{hotelName} · {roomName} · {total}. Your voucher and invoice are in My bookings.</span><button className="portal-primary" onClick={() => onViewBooking(bookingId)}>View booking</button></div>

  return <div className="booking-checkout" aria-live="polite">
    {phase === 'idle' || phase === 'holding' ? <button className="portal-primary" disabled={phase === 'holding'} onClick={() => void holdRate()}>{phase === 'holding' ? 'Holding inventory…' : `Hold this rate · ${total}`}</button> : null}
    {(phase === 'held' || phase === 'booking') && hold && <div className="portal-hold-panel">
      <div><Clock size={16} /><span>{expired ? 'Hold expired.' : <>Inventory held for <b>{clock(remaining)}</b>.</>} {hotelName} · {roomName} · {request.checkIn} → {request.checkOut} · {total}</span></div>
      {expired ? <button className="portal-primary" onClick={() => { holdKey.current = newKey(); setHold(null); setBookingId(null); setPhase('idle'); setMessage('') }}>Hold again</button> : <>
        <div className="booking-guest-form"><label className="portal-field"><span>LEAD GUEST FIRST NAME</span><div><input value={guest.firstName} maxLength={80} onChange={(event) => setGuest({ ...guest, firstName: event.target.value })} aria-label="Lead guest first name" /></div></label>
          <label className="portal-field"><span>LEAD GUEST LAST NAME</span><div><input value={guest.lastName} maxLength={80} onChange={(event) => setGuest({ ...guest, lastName: event.target.value })} aria-label="Lead guest last name" /></div></label></div>
        <p className="booking-note">{request.adults} adult{request.adults === 1 ? '' : 's'}{request.children ? `, ${request.children} child${request.children === 1 ? '' : 'ren'} (ages ${request.childAges.join(', ')})` : ''} · {request.rooms} room · charged to agency credit · {rate.cancellation.summary}</p>
        <button className="portal-primary" disabled={!validGuest || phase === 'booking'} onClick={() => void book()}>{phase === 'booking' ? 'Booking…' : bookingId ? 'Retry confirmation' : `Confirm & book · ${total}`}</button>
        {!bookingId && <button className="portal-link" disabled={phase === 'booking'} onClick={() => void releaseHold()}>Release hold</button>}</>}
    </div>}
    {phase === 'failed' && <div className="portal-hold-outcome" role="alert"><ShieldAlert size={16} /><strong>Booking not completed</strong><span>{message || 'Nothing was charged.'}</span><button className="portal-link" onClick={() => { holdKey.current = newKey(); setHold(null); setBookingId(null); setPhase('idle'); setMessage('') }}>Start over</button></div>}
    {message && phase !== 'failed' && <p className="portal-field-error" role="alert">{message}</p>}
  </div>
}
