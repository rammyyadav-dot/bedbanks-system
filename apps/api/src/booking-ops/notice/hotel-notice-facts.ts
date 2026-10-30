import type { HotelReservationNotice } from '@bedbanks/connectors-core'

/** What the dispatcher reads about a booking to build its notice. Everything comes from the booking tables the booking role may read. */
export interface HotelNoticeBookingFacts {
  reference: string; hotelId: string; createdAt: Date; checkIn: Date | null; checkOut: Date | null; hotelConfirmationNo: string | null; specialRequests: unknown
  rooms: Array<{ position: number; roomName: string | null; boardCode: string | null; adults: number; childAges: number[] }>
  guests: Array<{ firstName: string; lastName: string; isLead: boolean }>
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '')
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** A stored request code ("HIGH_FLOOR") as a hotel reads it ("high floor"). */
const readable = (code: string) => code.replace(/[_-]+/g, ' ').trim().toLowerCase()

/** Maps the booking to the canonical notice. Returns data only; validation happens in the renderer (`assertHotelNotice`), which fails closed. */
export function buildHotelNotice(kind: HotelReservationNotice['kind'], f: HotelNoticeBookingFacts): HotelReservationNotice {
  const rooms = [...f.rooms].sort((a, b) => a.position - b.position)
  const req = f.specialRequests && typeof f.specialRequests === 'object' && !Array.isArray(f.specialRequests) ? (f.specialRequests as { codes?: unknown; note?: unknown; arrivalTime?: unknown }) : {}
  const codes = Array.isArray(req.codes) ? req.codes.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(readable) : []
  const note = typeof req.note === 'string' && req.note.trim() ? [req.note.trim()] : []
  return {
    kind, reference: f.reference, hotelCode: f.hotelId, createdAt: f.createdAt.toISOString(), checkIn: day(f.checkIn), checkOut: day(f.checkOut),
    roomName: rooms[0]?.roomName ?? null, boardCode: rooms[0]?.boardCode ?? null,
    rooms: rooms.map((r) => ({ adults: r.adults, childAges: [...r.childAges] })),
    guests: f.guests.map((g) => ({ firstName: g.firstName.trim(), lastName: g.lastName.trim(), isLead: g.isLead })),
    hotelConfirmationNo: f.hotelConfirmationNo, specialRequests: [...codes, ...note],
    arrivalTime: typeof req.arrivalTime === 'string' && TIME.test(req.arrivalTime) ? req.arrivalTime : null,
  }
}
