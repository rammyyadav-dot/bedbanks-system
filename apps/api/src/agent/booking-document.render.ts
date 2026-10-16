/**
 * Pure rendering of issued booking documents to a printable, self-contained HTML page (print to PDF from the browser).
 * Every dynamic value is escaped; amounts are integer minor units formatted with BigInt only; no scripts, no
 * external resources, so the page is safe to serve under a locked-down Content-Security-Policy.
 */
export type BookingDocumentKind = 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE' | 'CANCELLATION_NOTE'

export interface RenderableDocument {
  type: BookingDocumentKind
  number: string
  issuedAt: string
  bookingStatus: string
  payload: Record<string, any>
}

export const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function currencyDigits(currency: string): number {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { return 2 }
}

/** "125099","AED" -> "AED 1,250.99"; invalid input renders an em dash rather than a wrong number. */
export function formatMinor(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor) || !/^[A-Z]{3}$/.test(currency)) return '—'
  const digits = currencyDigits(currency)
  const value = BigInt(amountMinor)
  const negative = value < 0n
  const abs = negative ? -value : value
  const factor = 10n ** BigInt(digits)
  const whole = (abs / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = digits === 0 ? '' : `.${(abs % factor).toString().padStart(digits, '0')}`
  return `${negative ? '-' : ''}${currency} ${whole}${fraction}`
}

const TITLES: Record<BookingDocumentKind, string> = { VOUCHER: 'Hotel Voucher', INVOICE: 'Tax Invoice', CREDIT_NOTE: 'Credit Note', CANCELLATION_NOTE: 'Cancellation Note' }
const row = (label: string, value: unknown) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`

export function renderBookingDocument(doc: RenderableDocument): string {
  const p = doc.payload
  const stay = p.stay ?? {}
  const rows: string[] = [row('Booking reference', p.bookingReference)]
  if (p.agentRef) rows.push(row('Agent reference', p.agentRef))
  if (p.hotelConfirmationNo) rows.push(row('Hotel confirmation no.', p.hotelConfirmationNo))
  if (p.hotel) rows.push(row('Hotel', `${p.hotel.name}${p.hotel.city ? `, ${p.hotel.city}` : ''}${p.hotel.countryCode ? ` (${p.hotel.countryCode})` : ''}`))
  if (p.hotelDetails?.address) rows.push(row('Address', p.hotelDetails.address))
  if (p.agencyName && doc.type !== 'VOUCHER') rows.push(row('Billed to', p.agencyName))
  if (p.room) rows.push(row('Room', p.room.name), row('Board', `${p.board?.name ?? ''}${p.board?.code ? ` (${p.board.code})` : ''}`))
  if (stay.checkIn) rows.push(row('Check-in', `${stay.checkIn}${p.hotelDetails?.checkInTime ? ` from ${p.hotelDetails.checkInTime}` : ''}`), row('Check-out', `${stay.checkOut}${p.hotelDetails?.checkOutTime ? ` by ${p.hotelDetails.checkOutTime}` : ''}`), row('Nights', stay.nights), row('Rooms', stay.rooms),
    row('Guests', `${stay.adults} adult${stay.adults === 1 ? '' : 's'}${stay.children ? `, ${stay.children} child${stay.children === 1 ? '' : 'ren'} (ages ${(stay.childAges ?? []).join(', ')})` : ''}`))
  if (p.leadGuest) rows.push(row('Lead guest', `${p.leadGuest.firstName} ${p.leadGuest.lastName}`))
  if (Array.isArray(p.guests) && p.guests.length > 1) rows.push(row('All guests', p.guests.join(', ')))
  // ADR 0066: every guest by room, the lead guest marked.
  const rooming: Array<{ room: number; guests: Array<{ name: string; type: string; age: number | null; isLead: boolean }> }> = Array.isArray(p.guestsByRoom) ? p.guestsByRoom : []
  const roomingHtml = rooming.length && (doc.type === 'VOUCHER' || doc.type === 'INVOICE') ? `<h2>Rooming list</h2><table class="lines rooming"><thead><tr><th>Room</th><th>Guest</th><th>Type</th></tr></thead><tbody>${rooming.flatMap((r) => r.guests.map((g, i) =>
    `<tr><td>${i === 0 ? `Room ${escapeHtml(r.room)}` : ''}</td><td>${escapeHtml(g.name)}${g.isLead ? ' <span class="tag">Lead guest</span>' : ''}</td><td>${g.type === 'CHILD' ? `Child${g.age !== null && g.age !== undefined ? `, age ${escapeHtml(g.age)}` : ''}` : 'Adult'}</td></tr>`)).join('')}</tbody></table>` : ''

  let body = ''
  if (doc.type === 'VOUCHER') {
    const rules: Array<{ daysBeforeCheckin: number; penalty: string }> = p.cancellationPolicy ?? []
    body = `<h2>Cancellation policy</h2>${rules.length === 0 ? '<p>No cancellation penalty is defined for this contract.</p>'
      : `<ul>${rules.map((rule) => `<li>Within ${escapeHtml(rule.daysBeforeCheckin)} day(s) of check-in: ${escapeHtml(rule.penalty)}</li>`).join('')}</ul>`}
      ${p.nonRefundable ? '<p><strong>Non-refundable:</strong> the full amount is retained if this booking is cancelled.</p>' : ''}
      ${p.specialRequests ? `<h2>Special requests</h2><div class="box"><p><strong>Not guaranteed:</strong> subject to availability at check-in.</p>${Array.isArray(p.specialRequests.items) && p.specialRequests.items.length ? `<ul>${p.specialRequests.items.map((item: string) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}${p.specialRequests.note ? `<p>${escapeHtml(p.specialRequests.note)}</p>` : ''}</div>` : ''}
      <h2>Important information</h2><ul class="info"><li>Present this voucher and a valid photo ID for every guest at check-in.</li><li>The hotel may ask for a credit card or a deposit for incidentals.</li><li>Local taxes or fees payable at the hotel, if any, are the guest's responsibility.</li></ul>
      <p class="note">Present this voucher at check-in. It carries no rate information.</p>`
  } else if (doc.type === 'INVOICE') {
    const lines: Array<{ description: string; amountMinor: string }> = p.lines ?? []
    body = `<h2>Charges</h2><table class="lines">${lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td class="amt">${escapeHtml(formatMinor(line.amountMinor, p.currency))}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="amt">${escapeHtml(formatMinor(p.totalMinor, p.currency))}</td></tr></table>
      <p>${p.payment?.text ? escapeHtml(p.payment.text) : `Paid from wallet. Status: ${escapeHtml(p.payment?.status ?? '')}`}.</p>`
  } else if (doc.type === 'CANCELLATION_NOTE') {
    const basis = p.penaltyState === 'QUOTED' ? (p.basis === 'NON_REFUNDABLE' ? 'Non-refundable booking: the full amount is retained.' : p.ruleDaysBeforeCheckin === null ? 'Cancelled before any penalty applied.' : `Cancellation terms: within ${p.ruleDaysBeforeCheckin} day(s) of check-in.`) : p.penaltyState === 'WAIVED' ? `Penalty reduced by approval from ${formatMinor(p.quotedPenaltyMinor ?? '0', p.currency)}.` : 'Penalty decided by the operator.'
    body = `<h2>Cancellation</h2><table class="lines">
      <tr><td>Booking total (invoice ${escapeHtml(p.originalInvoiceNumber)})</td><td class="amt">${escapeHtml(formatMinor(p.totalMinor, p.currency))}</td></tr>
      <tr><td>Cancellation penalty</td><td class="amt">${escapeHtml(formatMinor(p.penaltyMinor, p.currency))}</td></tr>
      <tr class="total"><td>Refundable amount</td><td class="amt">${escapeHtml(formatMinor(p.refundMinor, p.currency))}</td></tr></table>
      <p>${escapeHtml(basis)}</p>${p.cancelledAt ? `<p class="note">Cancelled ${escapeHtml(String(p.cancelledAt).slice(0, 10))}</p>` : ''}`
  } else {
    body = `<h2>Adjustment</h2><table class="lines">
      <tr><td>Original charge (invoice ${escapeHtml(p.originalInvoiceNumber)})</td><td class="amt">${escapeHtml(formatMinor(p.totalMinor, p.currency))}</td></tr>
      <tr><td>Cancellation penalty retained</td><td class="amt">${escapeHtml(formatMinor(p.penaltyMinor, p.currency))}</td></tr>
      <tr class="total"><td>${p.creditedTo ? escapeHtml(p.creditedTo) : 'Credited to wallet'}</td><td class="amt">${escapeHtml(formatMinor(p.refundMinor, p.currency))}</td></tr></table>`
  }
  const cancelled = (doc.type === 'VOUCHER' || doc.type === 'INVOICE') && doc.bookingStatus === 'CANCELLED'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(TITLES[doc.type])} ${escapeHtml(doc.number)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0d2631;max-width:800px;margin:24px auto;padding:0 24px;background:#fff}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #0d2631;padding-bottom:12px;margin-bottom:18px}
h1{font-size:24px;margin:0;letter-spacing:-.2px}h2{font-size:13px;margin:22px 0 8px;letter-spacing:.08em;text-transform:uppercase;color:#3d5a64}
.brand{font-weight:800;font-size:18px;letter-spacing:.3px}.meta{color:#5d7882;font-size:12px}
table{border-collapse:collapse;width:100%}th{text-align:left;width:34%;color:#5d7882;font-weight:600;padding:6px 10px 6px 0;vertical-align:top}td{padding:6px 0}
.facts{border:1px solid #dbe6e9;border-radius:10px;padding:6px 16px;background:#f8fbfc}.facts tr+tr th,.facts tr+tr td{border-top:1px solid #e7eff1}
.lines td,.lines th{border-bottom:1px solid #dbe6e9;padding:7px 8px 7px 0}.lines thead th{width:auto;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.amt{text-align:right;white-space:nowrap}.total td{font-weight:700;border-top:2px solid #0d2631;border-bottom:0}
.tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#e6f4ef;color:#0b6b4f;font-size:11px;font-weight:700}
.box{border:1px dashed #c8d7db;border-radius:8px;padding:8px 14px}.box p{margin:6px 0}ul{margin:6px 0;padding-left:20px}.info li{margin:2px 0}
.banner{background:#fbe9e7;color:#b3261e;border:1px solid #f0b5ae;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-weight:700}.note{color:#5d7882;font-size:12px}
footer{margin-top:28px;padding-top:10px;border-top:1px solid #dbe6e9;color:#5d7882;font-size:11px}
@media print{body{margin:0;max-width:none}.facts{background:#fff}}</style></head><body>
<header><div><div class="brand">${escapeHtml(p.issuedFor ?? '')}</div><div class="meta">via FBEDS</div></div>
<div style="text-align:right"><h1>${escapeHtml(TITLES[doc.type])}</h1><div>No. ${escapeHtml(doc.number)}</div><div class="meta">Issued ${escapeHtml(doc.issuedAt.slice(0, 10))}</div></div></header>
${cancelled ? '<div class="banner">THIS BOOKING HAS BEEN CANCELLED — this document is no longer valid for check-in.</div>' : ''}
<section class="facts"><table>${rows.join('')}</table></section>${roomingHtml}${body}
<footer>Booking ${escapeHtml(p.bookingReference)}${p.agentRef ? ` · Agent ref ${escapeHtml(p.agentRef)}` : ''} · ${escapeHtml(TITLES[doc.type])} ${escapeHtml(doc.number)}</footer></body></html>`
}
