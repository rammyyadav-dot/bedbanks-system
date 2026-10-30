import { assertHotelNotice, type HotelNoticeKind, type HotelReservationNotice } from '@bedbanks/connectors-core'
import { escapeHtml } from '../../agent/booking-document.render'

/** Locales a hotel can be addressed in (ADR 0106). The wording is operational, not legal; it still needs native-speaker review before production use. */
export const HOTEL_NOTICE_LOCALES = ['en', 'ar', 'fr', 'es'] as const
export type HotelNoticeLocale = (typeof HOTEL_NOTICE_LOCALES)[number]
export const isHotelNoticeLocale = (v: unknown): v is HotelNoticeLocale => (HOTEL_NOTICE_LOCALES as readonly unknown[]).includes(v)

interface Catalogue {
  dir: 'ltr' | 'rtl'
  title: Record<HotelNoticeKind, string>
  intro: Record<HotelNoticeKind, string>
  reference: string; hotelConfirmation: string; checkIn: string; checkOut: string; room: string; board: string; guests: string; roomN: string
  adults: string; children: string; ages: string; requests: string; arrival: string; notGuaranteed: string; replyHint: string
}

const CATALOGUE: Record<HotelNoticeLocale, Catalogue> = {
  en: { dir: 'ltr', title: { NEW: 'New reservation', AMEND: 'Reservation amended', CANCEL: 'Reservation cancelled' },
    intro: { NEW: 'Please hold the following reservation.', AMEND: 'Please replace the earlier reservation with the details below.', CANCEL: 'Please cancel the following reservation.' },
    reference: 'Reference', hotelConfirmation: 'Your confirmation no.', checkIn: 'Check-in', checkOut: 'Check-out', room: 'Room', board: 'Board', guests: 'Guests', roomN: 'Room', adults: 'adults', children: 'children', ages: 'ages', requests: 'Special requests', arrival: 'Estimated arrival', notGuaranteed: 'not guaranteed', replyHint: 'Please reply with your confirmation number, quoting the reference.' },
  ar: { dir: 'rtl', title: { NEW: 'حجز جديد', AMEND: 'تعديل حجز', CANCEL: 'إلغاء حجز' },
    intro: { NEW: 'يرجى تأكيد الحجز التالي.', AMEND: 'يرجى استبدال الحجز السابق بالتفاصيل التالية.', CANCEL: 'يرجى إلغاء الحجز التالي.' },
    reference: 'المرجع', hotelConfirmation: 'رقم التأكيد لديكم', checkIn: 'تسجيل الوصول', checkOut: 'تسجيل المغادرة', room: 'الغرفة', board: 'الوجبات', guests: 'النزلاء', roomN: 'غرفة', adults: 'بالغين', children: 'أطفال', ages: 'الأعمار', requests: 'طلبات خاصة', arrival: 'وقت الوصول المتوقع', notGuaranteed: 'غير مضمون', replyHint: 'يرجى الرد برقم التأكيد مع ذكر المرجع.' },
  fr: { dir: 'ltr', title: { NEW: 'Nouvelle réservation', AMEND: 'Réservation modifiée', CANCEL: 'Réservation annulée' },
    intro: { NEW: 'Merci de bloquer la réservation suivante.', AMEND: 'Merci de remplacer la réservation précédente par les informations ci-dessous.', CANCEL: 'Merci d’annuler la réservation suivante.' },
    reference: 'Référence', hotelConfirmation: 'Votre n° de confirmation', checkIn: 'Arrivée', checkOut: 'Départ', room: 'Chambre', board: 'Formule', guests: 'Clients', roomN: 'Chambre', adults: 'adultes', children: 'enfants', ages: 'âges', requests: 'Demandes spéciales', arrival: 'Arrivée estimée', notGuaranteed: 'non garanti', replyHint: 'Merci de répondre avec votre numéro de confirmation en citant la référence.' },
  es: { dir: 'ltr', title: { NEW: 'Nueva reserva', AMEND: 'Reserva modificada', CANCEL: 'Reserva cancelada' },
    intro: { NEW: 'Por favor, retenga la siguiente reserva.', AMEND: 'Por favor, sustituya la reserva anterior por los datos siguientes.', CANCEL: 'Por favor, cancele la siguiente reserva.' },
    reference: 'Referencia', hotelConfirmation: 'Su n.º de confirmación', checkIn: 'Entrada', checkOut: 'Salida', room: 'Habitación', board: 'Régimen', guests: 'Huéspedes', roomN: 'Habitación', adults: 'adultos', children: 'niños', ages: 'edades', requests: 'Peticiones especiales', arrival: 'Llegada estimada', notGuaranteed: 'no garantizado', replyHint: 'Por favor, responda con su número de confirmación citando la referencia.' },
}

/**
 * The reservation-notice email for a hotel's reservations desk. Escaped, no remote content, no price and no buying-agency name (ADR 0106). The subject carries the
 * reference and dates only: guest names appear in the body, never in the subject, which mail systems log more freely.
 */
export function renderHotelNoticeEmail(notice: HotelReservationNotice, hotelName: string, locale: HotelNoticeLocale): { subject: string; html: string; text: string } {
  assertHotelNotice(notice)
  const c = CATALOGUE[locale]
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
  const html = `<!doctype html><html lang="${locale}" dir="${c.dir}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#0d2631">
<h2 style="margin:0 0 8px">${escapeHtml(c.title[notice.kind])} — ${escapeHtml(hotelName)}</h2><p>${escapeHtml(c.intro[notice.kind])}</p>
<table role="presentation" cellpadding="6" cellspacing="0" style="border-collapse:collapse">${facts.map(([k, v]) => `<tr><td style="color:#5d7882">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<p>${escapeHtml(c.replyHint)}</p></body></html>`
  return { subject, html, text }
}
