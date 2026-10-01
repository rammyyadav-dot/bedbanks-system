/**
 * Pure rendering of issued booking documents to a printable, self-contained HTML page (print to PDF from the browser).
 * Every dynamic value is escaped; amounts are integer minor units formatted with BigInt only; no scripts, no
 * external resources, so the page is safe to serve under a locked-down Content-Security-Policy.
 */
export type BookingDocumentKind = 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE'

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

const TITLES: Record<BookingDocumentKind, string> = { VOUCHER: 'Hotel Voucher', INVOICE: 'Tax Invoice', CREDIT_NOTE: 'Credit Note' }
const row = (label: string, value: unknown) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`

export function renderBookingDocument(doc: RenderableDocument): string {
  const p = doc.payload
  const stay = p.stay ?? {}
  const rows: string[] = [row('Booking reference', p.bookingReference)]
  if (p.hotel) rows.push(row('Hotel', `${p.hotel.name}${p.hotel.city ? `, ${p.hotel.city}` : ''}${p.hotel.countryCode ? ` (${p.hotel.countryCode})` : ''}`))
  if (p.room) rows.push(row('Room', p.room.name), row('Board', `${p.board?.name ?? ''}${p.board?.code ? ` (${p.board.code})` : ''}`))
  if (stay.checkIn) rows.push(row('Check-in', stay.checkIn), row('Check-out', stay.checkOut), row('Nights', stay.nights), row('Rooms', stay.rooms),
    row('Guests', `${stay.adults} adult${stay.adults === 1 ? '' : 's'}${stay.children ? `, ${stay.children} child${stay.children === 1 ? '' : 'ren'} (ages ${(stay.childAges ?? []).join(', ')})` : ''}`))
  if (p.leadGuest) rows.push(row('Lead guest', `${p.leadGuest.firstName} ${p.leadGuest.lastName}`))

  let body = ''
  if (doc.type === 'VOUCHER') {
    const rules: Array<{ daysBeforeCheckin: number; penalty: string }> = p.cancellationPolicy ?? []
    body = `<h2>Cancellation policy</h2>${rules.length === 0 ? '<p>No cancellation penalty is defined for this contract.</p>'
      : `<ul>${rules.map((rule) => `<li>Within ${escapeHtml(rule.daysBeforeCheckin)} day(s) of check-in: ${escapeHtml(rule.penalty)}</li>`).join('')}</ul>`}
      <p class="note">Present this voucher at check-in. It carries no rate information.</p>`
  } else if (doc.type === 'INVOICE') {
    const lines: Array<{ description: string; amountMinor: string }> = p.lines ?? []
    body = `<h2>Charges</h2><table class="lines">${lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td class="amt">${escapeHtml(formatMinor(line.amountMinor, p.currency))}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="amt">${escapeHtml(formatMinor(p.totalMinor, p.currency))}</td></tr></table>
      <p>Paid from wallet. Status: ${escapeHtml(p.payment?.status ?? '')}.</p>`
  } else {
    body = `<h2>Adjustment</h2><table class="lines">
      <tr><td>Original charge (invoice ${escapeHtml(p.originalInvoiceNumber)})</td><td class="amt">${escapeHtml(formatMinor(p.totalMinor, p.currency))}</td></tr>
      <tr><td>Cancellation penalty retained</td><td class="amt">${escapeHtml(formatMinor(p.penaltyMinor, p.currency))}</td></tr>
      <tr class="total"><td>Credited to wallet</td><td class="amt">${escapeHtml(formatMinor(p.refundMinor, p.currency))}</td></tr></table>`
  }
  const cancelled = doc.type !== 'CREDIT_NOTE' && doc.bookingStatus === 'CANCELLED'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(TITLES[doc.type])} ${escapeHtml(doc.number)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:14px/1.5 system-ui,sans-serif;color:#0d2631;max-width:760px;margin:24px auto;padding:0 20px}
header{display:flex;justify-content:space-between;border-bottom:3px solid #0d2631;padding-bottom:10px;margin-bottom:16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 6px}.brand{font-weight:700;letter-spacing:.5px}
table{border-collapse:collapse;width:100%}th{text-align:left;width:34%;color:#5d7882;font-weight:600;padding:4px 8px 4px 0;vertical-align:top}td{padding:4px 0}
.lines td{border-bottom:1px solid #dbe6e9}.amt{text-align:right}.total td{font-weight:700;border-top:2px solid #0d2631}
.banner{background:#fbe9e7;color:#b3261e;border:1px solid #f0b5ae;padding:8px 12px;margin-bottom:12px;font-weight:700}.note{color:#5d7882;font-size:12px}
@media print{body{margin:0}}</style></head><body>
<header><div><div class="brand">${escapeHtml(p.issuedFor ?? '')}</div><div class="note">via FBEDS</div></div>
<div style="text-align:right"><h1>${escapeHtml(TITLES[doc.type])}</h1><div>No. ${escapeHtml(doc.number)}</div><div class="note">Issued ${escapeHtml(doc.issuedAt.slice(0, 10))}</div></div></header>
${cancelled ? '<div class="banner">THIS BOOKING HAS BEEN CANCELLED — this document is no longer valid for check-in.</div>' : ''}
<table>${rows.join('')}</table>${body}</body></html>`
}
