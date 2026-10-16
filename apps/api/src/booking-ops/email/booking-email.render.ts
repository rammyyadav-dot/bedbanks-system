import { escapeHtml, formatMinor, renderBookingDocument } from '../../agent/booking-document.render'
import type { MimeAttachment } from './mime'

export interface IssuedDocumentInput { number: string; issuedAt: string; payload: Record<string, any> }

/**
 * The booking confirmation email (ADR 0066), built only from the issued, immutable voucher and invoice: what the agent receives is exactly
 * what the documents say. Every value is escaped; no remote image, script or tracking pixel. A portal link is included only when it is https.
 */
export function renderConfirmationEmail(input: { voucher: IssuedDocumentInput; invoice: IssuedDocumentInput; bookingStatus: string; portalUrl?: string }): { subject: string; html: string; text: string; attachments: MimeAttachment[] } {
  const v = input.voucher.payload
  const i = input.invoice.payload
  const stay = v.stay ?? {}
  const hotel = v.hotel ?? {}
  const guestsLine = `${stay.adults} adult${stay.adults === 1 ? '' : 's'}${stay.children ? `, ${stay.children} child${stay.children === 1 ? '' : 'ren'} (ages ${(stay.childAges ?? []).join(', ')})` : ''} per room`
  const lead = v.leadGuest ? `${v.leadGuest.firstName} ${v.leadGuest.lastName}` : ''
  const total = typeof i.totalMinor === 'string' && typeof i.currency === 'string' ? formatMinor(i.totalMinor, i.currency) : '—'
  const policy: Array<{ daysBeforeCheckin: number; penalty: string }> = Array.isArray(v.cancellationPolicy) ? v.cancellationPolicy : []
  const requests: string[] = Array.isArray(v.specialRequests?.items) ? v.specialRequests.items : []
  const portal = input.portalUrl && /^https:\/\/[^\s"'<>]+$/.test(input.portalUrl) ? input.portalUrl.replace(/\/+$/, '') : null

  const facts: Array<[string, string]> = [
    ['Booking reference', v.bookingReference],
    ...(v.hotelConfirmationNo ? [['Hotel confirmation no.', v.hotelConfirmationNo] as [string, string]] : []),
    ...(v.agentRef ? [['Your reference', v.agentRef] as [string, string]] : []),
    ['Hotel', `${hotel.name ?? ''}${hotel.city ? `, ${hotel.city}` : ''}`],
    ...(v.hotelDetails?.address ? [['Address', v.hotelDetails.address] as [string, string]] : []),
    ['Check-in', `${stay.checkIn ?? ''}${v.hotelDetails?.checkInTime ? ` from ${v.hotelDetails.checkInTime}` : ''}`],
    ['Check-out', `${stay.checkOut ?? ''}${v.hotelDetails?.checkOutTime ? ` by ${v.hotelDetails.checkOutTime}` : ''}`],
    ['Stay', `${stay.nights} night${stay.nights === 1 ? '' : 's'} · ${stay.rooms} room${stay.rooms === 1 ? '' : 's'}`],
    ['Room', `${v.room?.name ?? ''} · ${v.board?.name ?? ''}`],
    ['Guests', guestsLine],
    ...(lead ? [['Lead guest', lead] as [string, string]] : []),
    ['Total charged', total],
  ]
  const policyLines = policy.length === 0 ? ['No cancellation penalty is defined for this contract.'] : policy.map((rule) => `Within ${rule.daysBeforeCheckin} day(s) of check-in: ${rule.penalty}`)

  const subject = `Booking confirmed: ${hotel.name ?? 'Hotel'} · ${stay.checkIn ?? ''} · ${v.bookingReference}`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f6f7;font-family:Arial,Helvetica,sans-serif;color:#0d2631">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0d2631;color:#ffffff;padding:20px 28px"><div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.8">${escapeHtml(v.issuedFor ?? '')}</div><div style="font-size:22px;font-weight:bold;margin-top:4px">Booking confirmed</div></td></tr>
<tr><td style="padding:24px 28px 8px"><p style="margin:0 0 12px;font-size:15px">Your booking <strong>${escapeHtml(v.bookingReference)}</strong> at <strong>${escapeHtml(hotel.name ?? '')}</strong> is confirmed. The hotel voucher and the invoice are attached.</p></td></tr>
<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe6e9;border-radius:10px;border-collapse:separate">
${facts.map(([label, value], index) => `<tr><td style="padding:9px 14px;color:#5d7882;font-size:13px;width:38%;${index ? 'border-top:1px solid #e7eff1;' : ''}">${escapeHtml(label)}</td><td style="padding:9px 14px;font-size:14px;${index ? 'border-top:1px solid #e7eff1;' : ''}${label === 'Total charged' ? 'font-weight:bold;' : ''}">${escapeHtml(value)}</td></tr>`).join('')}
</table></td></tr>
<tr><td style="padding:18px 28px 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#3d5a64;font-weight:bold">Cancellation policy</div><ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${policyLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></td></tr>
${requests.length || v.specialRequests?.note ? `<tr><td style="padding:14px 28px 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#3d5a64;font-weight:bold">Special requests (not guaranteed)</div><p style="margin:6px 0 0;font-size:14px">${escapeHtml([...requests, ...(v.specialRequests?.note ? [v.specialRequests.note] : [])].join(' · '))}</p></td></tr>` : ''}
${portal ? `<tr><td style="padding:20px 28px 0"><a href="${escapeHtml(portal)}" style="display:inline-block;background:#d90429;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">Open My bookings</a></td></tr>` : ''}
<tr><td style="padding:22px 28px 26px;color:#5d7882;font-size:12px">Voucher ${escapeHtml(input.voucher.number)} · Invoice ${escapeHtml(input.invoice.number)}. Present the voucher and photo ID at check-in. This message was sent to the booking agent's account address.</td></tr>
</table></td></tr></table></body></html>`

  const text = [
    `Booking confirmed: ${v.bookingReference}`,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    'Cancellation policy:',
    ...policyLines.map((line) => `- ${line}`),
    ...(requests.length || v.specialRequests?.note ? ['', `Special requests (not guaranteed): ${[...requests, ...(v.specialRequests?.note ? [v.specialRequests.note] : [])].join(' · ')}`] : []),
    ...(portal ? ['', `My bookings: ${portal}`] : []),
    '',
    `Attached: voucher ${input.voucher.number}, invoice ${input.invoice.number}.`,
  ].join('\n')

  const attachments: MimeAttachment[] = [
    { filename: `Voucher-${input.voucher.number}.html`, contentType: 'text/html; charset=UTF-8', content: renderBookingDocument({ type: 'VOUCHER', number: input.voucher.number, issuedAt: input.voucher.issuedAt, bookingStatus: input.bookingStatus, payload: v }) },
    { filename: `Invoice-${input.invoice.number}.html`, contentType: 'text/html; charset=UTF-8', content: renderBookingDocument({ type: 'INVOICE', number: input.invoice.number, issuedAt: input.invoice.issuedAt, bookingStatus: input.bookingStatus, payload: i }) },
  ]
  return { subject, html, text, attachments }
}
