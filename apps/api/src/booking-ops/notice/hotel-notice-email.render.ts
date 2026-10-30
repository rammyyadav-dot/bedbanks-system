import { assertHotelNotice, type HotelNoticeKind, type HotelReservationNotice } from '@bedbanks/connectors-core'
import { escapeHtml } from '../../agent/booking-document.render'

interface Catalogue {
  title: Record<HotelNoticeKind, string>
  intro: Record<HotelNoticeKind, string>
  reference: string; hotelConfirmation: string; checkIn: string; checkOut: string; room: string; board: string; guests: string; roomN: string
  adults: string; children: string; ages: string; requests: string; arrival: string; notGuaranteed: string; replyHint: string
}

const EN: Catalogue = { title: { NEW: 'New reservation', AMEND: 'Reservation amended', CANCEL: 'Reservation cancelled' },
    intro: { NEW: 'Please hold the following reservation.', AMEND: 'Please replace the earlier reservation with the details below.', CANCEL: 'Please cancel the following reservation.' },
    reference: 'Reference', hotelConfirmation: 'Your confirmation no.', checkIn: 'Check-in', checkOut: 'Check-out', room: 'Room', board: 'Board', guests: 'Guests', roomN: 'Room', adults: 'adults', children: 'children', ages: 'ages', requests: 'Special requests', arrival: 'Estimated arrival', notGuaranteed: 'not guaranteed', replyHint: 'Please reply with your confirmation number, quoting the reference.' }

/**
 * The reservation-notice email for a hotel's reservations desk. Escaped, no remote content, no price and no buying-agency name (ADR 0106). The subject carries the
 * reference and dates only: guest names appear in the body, never in the subject, which mail systems log more freely.
 */
export function renderHotelNoticeEmail(notice: HotelReservationNotice, hotelName: string): { subject: string; html: string; text: string } {
  assertHotelNotice(notice)
  const c = EN
  const roomLines = notice.rooms.map((r, i) => `${c.roomN} ${i + 1}: ${r.adults} ${c.adults}${r.childAges.length ? `, ${r.childAges.length} ${c.children} (${c.ages} ${r.childAges.join(', ')})` : ''}`)
  const facts: Array<[string, string]> = [
    [c.reference, notice.reference],
    ...(notice.hotelConfirmationNo ? [[c.hotelConfirmation, notice.hotelConfirmationNo] as [string, string]] : []),
    [c.checkIn, notice.checkIn], [c.checkOut, notice.checkOut],
    ...(notice.roomName ? [[c.room, notice.roomName] as [string, string]] : []),
    ...(notice.boardCode ? [[c.board, notice.boardCode] as [string, string]] : []),
    [c.guests, notice.guests.map((g) => `${g.firstName} ${g.lastName}`).join(', ')],
    ...roomLines.map((line) => ['', line] as [string, string]),
    ...(notice.specialRequests.length ? [[c.requests, `${notice.specialRequests.join(' · ')} (${c.notGuaranteed})`] as [string, string]] : []),
    ...(notice.arrivalTime ? [[c.arrival, `${notice.arrivalTime} (${c.notGuaranteed})`] as [string, string]] : []),
  ]
  const subject = `${c.title[notice.kind]} · ${notice.reference} · ${notice.checkIn}`
  const text = [`${c.title[notice.kind]} — ${hotelName}`, '', c.intro[notice.kind], '', ...facts.map(([k, v]) => (k ? `${k}: ${v}` : v)), '', c.replyHint].join('\n')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#0d2631">
<h2 style="margin:0 0 8px">${escapeHtml(c.title[notice.kind])} — ${escapeHtml(hotelName)}</h2><p>${escapeHtml(c.intro[notice.kind])}</p>
<table role="presentation" cellpadding="6" cellspacing="0" style="border-collapse:collapse">${facts.map(([k, v]) => `<tr><td style="color:#5d7882">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<p>${escapeHtml(c.replyHint)}</p></body></html>`
  return { subject, html, text }
}
