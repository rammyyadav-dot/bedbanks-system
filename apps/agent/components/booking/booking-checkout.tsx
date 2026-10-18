'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BedDouble, CalendarDays, CheckCircle2, Clock, FileText, Globe, Mail, Printer, ShieldAlert, Tag, Users, Wallet } from 'lucide-react'
import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { AGENT_REF_MAX, GUEST_TITLES, SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_LABELS, SPECIAL_REQUEST_NOTE_MAX, type ConfirmationEmailState, type DuplicateBookingMatch, type GuestTitle, type SpecialRequestCode } from '@bedbanks/contracts'
import { BookingService, type BookingFailure, type DocumentType } from '@/services/booking-service'
import { formatCancellationDeadline, formatMinorAmount, formatStay } from '@/lib/format'
import { ARRIVAL_TIME_OPTIONS, buildRoster, isLead, parseCcEmails, rosterErrors, rosterPayload, stayNights, type GuestDraft } from '@/lib/checkout'
import { averageNightlyMinor } from '@/lib/listing'
import { guestMarketName } from '@/lib/guest-market'

type Phase = 'idle' | 'holding' | 'held' | 'booking' | 'done' | 'failed'
const newKey = () => `hold-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
const clock = (ms: number) => { const total = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` }
const HOLD_MESSAGES: Record<string, string> = {
  unavailable: 'This rate is no longer available. No inventory was held.', offer_expired: 'This offer expired. Search again for a current rate.', mapping_invalid: 'The hotel or room could not be verified. No inventory was held.',
  provider_unavailable: 'Inventory could not be checked safely. Nothing was held; try again.', rejected: 'The offer could not be verified. Nothing was held.', rechecked: 'The rate is valid but no hold was created.',
}
type Done = { bookingId: string; reference: string; documents: { voucher: string | null; invoice: string | null } | null; email: ConfirmationEmailState | null }

/**
 * Bedbank checkout (ADR 0066): hold → every guest by room → agent reference and special requests → confirmation email → terms → confirm,
 * then a confirmation page with the voucher, invoice and the email's true state. All state shown comes from the API; a failure never looks like success.
 */
export function BookingCheckout({ tenantId, hotelName, roomName, rate, searchId, request, onBooked, onViewBooking, service, agentEmail = null, timeZone }: {
  tenantId: string; hotelName: string; roomName: string; rate: SearchRateOffer; searchId: string; request: SearchCriteria
  onBooked: () => void; onViewBooking: (bookingId: string) => void; service?: BookingService
  /** The signed-in agent's account email: where the confirmation goes. */
  agentEmail?: string | null; timeZone?: string
}) {
  const api = useRef(service ?? new BookingService()).current
  const holdKey = useRef(newKey())
  const [phase, setPhase] = useState<Phase>('idle')
  const [hold, setHold] = useState<{ holdId: string; expiresAt: string } | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [roster, setRoster] = useState<GuestDraft[]>(() => buildRoster(request.rooms, request.adults, request.childAges))
  const [agentRef, setAgentRef] = useState('')
  const [requests, setRequests] = useState<SpecialRequestCode[]>([])
  const [note, setNote] = useState('')
  const [arrival, setArrival] = useState('')
  const [duplicates, setDuplicates] = useState<DuplicateBookingMatch[]>([])
  const [bookAnyway, setBookAnyway] = useState(false)
  const [cc, setCc] = useState('')
  const [terms, setTerms] = useState(false)
  const [touched, setTouched] = useState(false)
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (phase !== 'held') return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [phase])

  const total = formatMinorAmount(rate.total.amountMinor, rate.total.currency) ?? 'Price unavailable'
  const remaining = hold ? Date.parse(hold.expiresAt) - now : 0
  const expired = phase === 'held' && remaining <= 0
  const errors = useMemo(() => rosterErrors(roster), [roster])
  const ccParsed = parseCcEmails(cc, agentEmail)
  const deadline = rate.cancellation.refundable && rate.cancellation.deadline ? formatCancellationDeadline(rate.cancellation.deadline, timeZone || 'UTC') : null
  const conflict = requests.includes('TWIN_BEDS') && requests.includes('DOUBLE_BED')
  const nights = stayNights(request.checkIn, request.checkOut)
  const perNight = nights !== null && nights > 1 ? formatMinorAmount(averageNightlyMinor(rate.total.amountMinor, nights), rate.total.currency) : null
  const ready = Object.keys(errors).length === 0 && ccParsed.ok && terms && !conflict && note.length <= SPECIAL_REQUEST_NOTE_MAX && agentRef.length <= AGENT_REF_MAX && (duplicates.length === 0 || bookAnyway)
  const failure = (result: BookingFailure) => { setMessage(result.message); if (result.kind === 'auth' || result.kind === 'denied' || result.kind === 'unavailable') setPhase('failed') }
  const reset = () => { holdKey.current = newKey(); setHold(null); setBookingId(null); setPhase('idle'); setMessage('') }
  const update = (key: string, patch: Partial<GuestDraft>) => setRoster((current) => current.map((g) => g.key === key ? { ...g, ...patch } : g))
  const toggle = (code: SpecialRequestCode) => setRequests((current) => current.includes(code) ? current.filter((c) => c !== code) : [...current, code])

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
    reset(); setMessage('Hold released. The inventory is available again.')
  }

  async function book() {
    setTouched(true)
    if (!hold || !ready || !ccParsed.ok || phase === 'booking') return
    const lead = roster.find((g) => isLead(g, roster))!
    setPhase('booking'); setMessage('')
    let id = bookingId
    if (!id) {
      const pre = await api.prebook(hold.holdId, {
        adults: request.adults, children: request.children, childAges: request.childAges, firstName: lead.firstName, lastName: lead.lastName,
        guests: rosterPayload(roster), agentRef, specialRequests: { codes: requests, ...(note.trim() ? { note: note.trim() } : {}), ...(arrival ? { arrivalTime: arrival } : {}) }, termsAccepted: terms,
        ...(duplicates.length && bookAnyway ? { acknowledgeDuplicate: true } : {}),
      }, tenantId)
      if (!pre.ok) {
        if (/reconciliation/i.test(pre.message)) {
          setPhase('held')
          setMessage('Reconciliation required. This hold and any wallet reservation stay in place. Do not submit the booking again until the outcome is known.')
          return
        }
        if (pre.kind === 'invalid') { setPhase('held'); setMessage(pre.message); return }
        // Probable duplicate: nothing was booked and the hold stays; the agent decides.
        if (pre.duplicates?.length) { setDuplicates(pre.duplicates); setBookAnyway(false); setPhase('held'); return }
        holdKey.current = newKey(); setHold(null); failure(pre); setPhase('failed'); return
      }
      id = pre.data.bookingId; setBookingId(id)
    }
    const confirmed = await api.confirm(id, tenantId, ccParsed.emails)
    if (!confirmed.ok) { setMessage(`${confirmed.message} Your booking was reserved but not confirmed; you can retry confirmation.`); setPhase('held'); return }
    setDone({ bookingId: id, reference: confirmed.data.reference, documents: confirmed.data.documents ?? null, email: confirmed.data.email ?? null })
    setPhase('done'); onBooked()
  }

  async function openDocument(type: DocumentType) {
    if (!done) return
    const popup = window.open('', '_blank')
    const result = await api.documentHtml(done.bookingId, type, tenantId)
    if (result.ok && popup) popup.location.href = URL.createObjectURL(new Blob([result.data], { type: 'text/html' }))
    else { popup?.close(); setMessage(result.ok ? 'Allow pop-ups to open the document.' : result.message) }
  }

  if (phase === 'done' && done) return <section className="ck-done" role="status" aria-label="Booking confirmed">
    <div className="ck-done-hero"><CheckCircle2 size={34} aria-hidden="true" /><div><h3>Booking confirmed</h3><p>Reference <strong>{done.reference}</strong>{agentRef.trim() ? <> · your ref <strong>{agentRef.trim()}</strong></> : null}</p></div></div>
    <dl className="ck-done-facts">
      <div><dt>Hotel</dt><dd>{hotelName}</dd></div>
      <div><dt>Room</dt><dd>{roomName} · {rate.boardBasisName}</dd></div>
      <div><dt>Stay</dt><dd>{formatStay(request.checkIn, request.checkOut)} · {request.rooms} room{request.rooms === 1 ? '' : 's'}</dd></div>
      <div><dt>Lead guest</dt><dd>{(() => { const lead = roster.find((g) => isLead(g, roster)); return lead ? [lead.title, lead.firstName.trim(), lead.lastName.trim()].filter(Boolean).join(' ') : '—' })()}</dd></div>
      {arrival && <div><dt>Estimated arrival</dt><dd>{arrival} (hotel local time)</dd></div>}
      <div><dt>Total charged</dt><dd><strong>{total}</strong> · agency credit</dd></div>
      <div><dt>Cancellation</dt><dd>{deadline ? `Free cancellation until ${deadline}` : rate.cancellation.summary}</dd></div>
    </dl>
    <div className="ck-done-email"><Mail size={16} aria-hidden="true" />{done.email?.status === 'queued'
      ? <span>Confirmation email queued to <strong>{done.email.to}</strong>{done.email.cc.length ? <> (cc {done.email.cc.join(', ')})</> : null}. It is sent when email delivery is enabled for this workspace.</span>
      : <span>No confirmation email was queued{done.email?.status === 'not_queued' ? ' because your account has no valid email address' : ''}. Use the documents below.</span>}</div>
    <div className="ck-done-actions">
      <button type="button" className="portal-primary" onClick={() => void openDocument('voucher')}><FileText size={15} /> Voucher{done.documents?.voucher ? ` ${done.documents.voucher}` : ''}</button>
      <button type="button" className="portal-secondary" onClick={() => void openDocument('invoice')}><FileText size={15} /> Invoice{done.documents?.invoice ? ` ${done.documents.invoice}` : ''}</button>
      <button type="button" className="portal-secondary" onClick={() => void openDocument('voucher')}><Printer size={15} /> Print voucher</button>
      <button type="button" className="portal-link" onClick={() => onViewBooking(done.bookingId)}>View booking</button>
    </div>
    {message && <p className="portal-field-error" role="alert">{message}</p>}
  </section>

  const summary = <aside className="ck-summary" aria-label="Booking summary">
    <h4>Booking summary</h4>
    <p className="ck-summary-hotel">{hotelName}</p>
    <ul>
      <li><BedDouble size={14} aria-hidden="true" />{roomName} · {rate.boardBasisName}</li>
      <li><CalendarDays size={14} aria-hidden="true" />{formatStay(request.checkIn, request.checkOut)}</li>
      <li><Users size={14} aria-hidden="true" />{request.rooms} room{request.rooms === 1 ? '' : 's'} · {request.adults} adult{request.adults === 1 ? '' : 's'}{request.children ? ` + ${request.children} child${request.children === 1 ? '' : 'ren'}` : ''} per room</li>
      <li><Globe size={14} aria-hidden="true" />{guestMarketName(request.nationality)} guests · rate valid for this nationality</li>
      {rate.promotion && <li><Tag size={14} aria-hidden="true" />{rate.promotion.name} · included in the price</li>}
    </ul>
    <p className={`ck-summary-policy${rate.cancellation.refundable ? '' : ' is-nonref'}`}>{deadline ? `Free cancellation until ${deadline}` : rate.cancellation.summary || (rate.cancellation.refundable ? 'Refundable' : 'Non-refundable')}</p>
    <div className="ck-summary-total"><span>Total charged</span><strong>{total}</strong><small>{perNight ? `avg. ${perNight} / night · ` : ''}rechecked price</small></div>
    <p className="ck-summary-pay"><Wallet size={14} aria-hidden="true" />Charged to your agency credit at confirmation</p>
    {hold && (phase === 'held' || phase === 'booking') && <p className={`ck-summary-hold${remaining < 120_000 ? ' is-ending' : ''}`}><Clock size={14} aria-hidden="true" />{expired ? 'Hold expired' : <>Held for <b>{clock(remaining)}</b></>}</p>}
  </aside>

  return <div className="booking-checkout ck" aria-live="polite">
    {(phase === 'idle' || phase === 'holding') && <div className="ck-start">
      <button className="portal-primary" disabled={phase === 'holding'} onClick={() => void holdRate()}>{phase === 'holding' ? 'Holding inventory…' : `Hold this rate · ${total}`}</button>
      <p className="booking-note">Holding reserves the room for a few minutes while you enter guest details. It is not a booking.</p>
    </div>}
    {(phase === 'held' || phase === 'booking') && hold && <div className="ck-grid">
      <div className="ck-form">
        {expired ? <div className="ck-step"><p role="alert">The hold expired. Checkout is closed and nothing was booked.</p><button className="portal-primary" onClick={reset}>Hold again</button></div> : <>
          <section className="ck-step" aria-labelledby="ck-guests"><h4 id="ck-guests"><span>1</span>Guest details</h4>
            <p className="booking-note">Names exactly as on each guest's passport. The lead guest is the first adult in room 1.</p>
            {Array.from({ length: request.rooms }, (_, i) => i + 1).map((room) => <fieldset key={room} className="ck-room"><legend>Room {room} · {roomName}</legend>
              {roster.filter((g) => g.roomNumber === room).map((g) => <div key={g.key} className={`ck-guest${touched && errors[g.key] ? ' has-error' : ''}`}>
                <span className="ck-guest-kind">{g.type === 'CHILD' ? `Child · ${g.age} yrs` : isLead(g, roster) ? 'Lead guest' : 'Adult'}</span>
                <label><span>Title</span><select value={g.title} aria-label={`${g.key} title`} onChange={(e) => update(g.key, { title: e.target.value as GuestTitle | '' })}><option value="">—</option>{GUEST_TITLES.filter((t) => g.type === 'CHILD' ? ['Miss', 'Mstr'].includes(t) : t !== 'Mstr').map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                <label><span>First name</span><input value={g.firstName} maxLength={80} autoComplete="off" aria-label={`Room ${room} ${g.type === 'CHILD' ? 'child' : 'adult'} first name`} onChange={(e) => update(g.key, { firstName: e.target.value })} /></label>
                <label><span>Last name</span><input value={g.lastName} maxLength={80} autoComplete="off" aria-label={`Room ${room} ${g.type === 'CHILD' ? 'child' : 'adult'} last name`} onChange={(e) => update(g.key, { lastName: e.target.value })} /></label>
                {touched && errors[g.key] && <small role="alert">{errors[g.key]}</small>}
              </div>)}
            </fieldset>)}
          </section>
          <section className="ck-step" aria-labelledby="ck-extras"><h4 id="ck-extras"><span>2</span>Your reference and special requests</h4>
            <label className="ck-field"><span>Agent reference (optional)</span><input value={agentRef} maxLength={AGENT_REF_MAX} placeholder="Your file or booking number" onChange={(e) => setAgentRef(e.target.value)} /></label>
            <div className="ck-requests" role="group" aria-label="Special requests">{SPECIAL_REQUEST_CODES.map((code) => <label key={code} className={`ck-chip${requests.includes(code) ? ' is-on' : ''}`}><input type="checkbox" checked={requests.includes(code)} onChange={() => toggle(code)} />{SPECIAL_REQUEST_LABELS[code]}</label>)}</div>
            {conflict && <p className="portal-field-error" role="alert">Choose twin beds or a double bed, not both.</p>}
            <label className="ck-field"><span>Note to the hotel (optional)</span><textarea value={note} maxLength={SPECIAL_REQUEST_NOTE_MAX} rows={2} placeholder="e.g. arriving on a late flight" onChange={(e) => setNote(e.target.value)} /><small>{note.length}/{SPECIAL_REQUEST_NOTE_MAX} · requests are passed to the hotel and are not guaranteed</small></label>
            <label className="ck-field ck-arrival"><span>Estimated arrival (optional, hotel local time)</span><select value={arrival} onChange={(e) => setArrival(e.target.value)}><option value="">Not known</option>{ARRIVAL_TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          </section>
          <section className="ck-step" aria-labelledby="ck-email"><h4 id="ck-email"><span>3</span>Confirmation email</h4>
            <p className="booking-note">{agentEmail ? <>The voucher and invoice are emailed to <strong>{agentEmail}</strong>.</> : 'Your account has no email address, so no confirmation email can be sent. The documents stay available in My bookings.'}</p>
            {agentEmail && <label className="ck-field"><span>CC (optional, up to 3)</span><input value={cc} inputMode="email" placeholder="ops@youragency.com, colleague@youragency.com" onChange={(e) => setCc(e.target.value)} />{!ccParsed.ok && <small role="alert" className="is-error">{ccParsed.reason}</small>}</label>}
          </section>
          <section className="ck-step" aria-labelledby="ck-terms"><h4 id="ck-terms"><span>4</span>Review and confirm</h4>
            <p className="ck-policy">{deadline ? <>Free cancellation until <strong>{deadline}</strong>. After that, the cancellation policy of this rate applies.</> : rate.cancellation.refundable ? rate.cancellation.summary : <><strong>Non-refundable.</strong> The full amount is charged if this booking is cancelled or the guest does not arrive.</>}</p>
            {duplicates.length > 0 && <div className="ck-duplicate" role="alert"><p><AlertTriangle size={16} aria-hidden="true" /><strong>Possible duplicate booking.</strong> Your agency already has {duplicates.length === 1 ? 'a booking' : 'bookings'} for this lead guest, hotel and dates:</p>
              <ul>{duplicates.map((d) => <li key={d.reference}><b>{d.reference}</b> · {d.status.replace(/_/g, ' ').toLowerCase()} · booked {d.createdAt.slice(0, 10)}</li>)}</ul>
              <label><input type="checkbox" checked={bookAnyway} onChange={(e) => setBookAnyway(e.target.checked)} />This is a separate booking. Book it anyway.</label></div>}
            <label className={`ck-terms${touched && !terms ? ' has-error' : ''}`}><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />I accept the cancellation policy and the booking terms, and confirm the guest names are correct.</label>
            <div className="ck-actions">
              <button className="portal-primary" disabled={phase === 'booking' || /reconciliation/i.test(message)} onClick={() => void book()}>{phase === 'booking' ? 'Booking…' : bookingId ? 'Retry confirmation' : `Confirm & book · ${total}`}</button>
              {!bookingId && <button className="portal-link" disabled={phase === 'booking'} onClick={() => void releaseHold()}>Release hold</button>}
            </div>
            {touched && !ready && <p className="portal-field-error" role="alert">{Object.keys(errors).length ? 'Enter every guest name.' : !terms ? 'Accept the cancellation policy and booking terms.' : duplicates.length && !bookAnyway ? 'Confirm this is a separate booking, or release the hold.' : 'Check the highlighted fields.'}</p>}
          </section>
        </>}
      </div>
      {summary}
    </div>}
    {phase === 'failed' && <div className="portal-hold-outcome" role="alert"><ShieldAlert size={16} /><strong>Booking not completed</strong><span>{message || 'Nothing was charged.'}</span><button className="portal-link" onClick={reset}>Start over</button></div>}
    {message && phase !== 'failed' && <p className="portal-field-error" role="alert">{message}</p>}
  </div>
}
