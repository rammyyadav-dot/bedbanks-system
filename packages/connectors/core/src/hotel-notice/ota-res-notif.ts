import { el, xmlDocument, type XmlRaw } from '../xml/xml-parser'

/**
 * The reservation notice a bedbank sends a hotel (or its channel manager) when a contracted booking is made, amended or cancelled (ADR 0106).
 * Transport-agnostic and PII-minimal: it carries what a front desk needs to hold the room and nothing about price, net rate, markup or the buying agency.
 * Callers must never log an instance or its rendered body (CLAUDE.md invariant 7).
 */
export type HotelNoticeKind = 'NEW' | 'AMEND' | 'CANCEL'
export interface HotelNoticeGuest { firstName: string; lastName: string; isLead: boolean }
export interface HotelNoticeRoom { adults: number; childAges: number[] }
export interface HotelReservationNotice {
  kind: HotelNoticeKind
  /** Our `FB-` reference. Together with `kind` it is the notice's identity: a retry sends the same EchoToken so the receiver can de-duplicate. */
  reference: string
  /** The code the hotel or channel manager knows this property by (never our internal id). */
  hotelCode: string
  createdAt: string
  checkIn: string
  checkOut: string
  roomName: string | null
  boardCode: string | null
  rooms: HotelNoticeRoom[]
  guests: HotelNoticeGuest[]
  hotelConfirmationNo: string | null
  specialRequests: string[]
  arrivalTime: string | null
}

export class HotelNoticeInvalid extends Error {
  constructor(readonly field: string) { super(`Invalid hotel notice field: ${field}`); this.name = 'HotelNoticeInvalid' }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const REFERENCE = /^[A-Za-z0-9._-]{3,64}$/
const HOTEL_CODE = /^[A-Za-z0-9._:-]{1,64}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Fails closed: a notice that cannot be validated is never sent. */
export function assertHotelNotice(n: HotelReservationNotice): void {
  if (!['NEW', 'AMEND', 'CANCEL'].includes(n.kind)) throw new HotelNoticeInvalid('kind')
  if (!REFERENCE.test(n.reference)) throw new HotelNoticeInvalid('reference')
  if (!HOTEL_CODE.test(n.hotelCode)) throw new HotelNoticeInvalid('hotelCode')
  if (!ISO_INSTANT.test(n.createdAt)) throw new HotelNoticeInvalid('createdAt')
  if (!ISO_DAY.test(n.checkIn) || !ISO_DAY.test(n.checkOut) || n.checkOut <= n.checkIn) throw new HotelNoticeInvalid('stay')
  if (n.rooms.length < 1 || n.rooms.length > 9) throw new HotelNoticeInvalid('rooms')
  for (const r of n.rooms) {
    if (!Number.isInteger(r.adults) || r.adults < 1 || r.adults > 12) throw new HotelNoticeInvalid('adults')
    if (r.childAges.length > 8 || r.childAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) throw new HotelNoticeInvalid('childAges')
  }
  if (n.guests.length < 1 || n.guests.some((g) => !g.firstName.trim() || !g.lastName.trim())) throw new HotelNoticeInvalid('guests')
  if (n.arrivalTime !== null && !TIME.test(n.arrivalTime)) throw new HotelNoticeInvalid('arrivalTime')
}

const RES_STATUS: Record<HotelNoticeKind, string> = { NEW: 'Commit', AMEND: 'Modify', CANCEL: 'Cancel' }
/** OpenTravel AgeQualifyingCode: 10 = adult, 8 = child. */
const ADULT = 10
const CHILD = 8
/** OpenTravel UniqueID Type 14 = reservation. */
const RESERVATION_ID_TYPE = 14

/** The notice's identity, also the OTA EchoToken: the same logical notice always has the same token, so a retry is recognisable as a retry. */
export const hotelNoticeEchoToken = (n: Pick<HotelReservationNotice, 'reference' | 'kind'>) => `${n.reference}-${n.kind}`

/**
 * Builds an OpenTravel 2003/05 `OTA_HotelResNotifRQ`, the message most channel managers accept for reservation delivery. Every value is escaped by `el`.
 * Prices are deliberately absent. One `RoomStay` per room, in room order.
 */
export function buildOtaHotelResNotif(n: HotelReservationNotice): string {
  assertHotelNotice(n)
  const lead = n.guests.find((g) => g.isLead) ?? n.guests[0]
  const roomStays = n.rooms.map((room, index) => {
    const counts: XmlRaw[] = [el('GuestCount', { AgeQualifyingCode: ADULT, Count: room.adults })]
    for (const age of room.childAges) counts.push(el('GuestCount', { AgeQualifyingCode: CHILD, Count: 1, Age: age }))
    return el('RoomStay', { RPH: index + 1 },
      el('RoomTypes', null, el('RoomType', { RoomTypeCode: n.roomName ?? undefined }, n.roomName ? el('RoomDescription', { Name: n.roomName }) : undefined)),
      n.boardCode ? el('RatePlans', null, el('RatePlan', { MealsIncluded: n.boardCode })) : undefined,
      el('GuestCounts', null, ...counts),
      el('TimeSpan', { Start: n.checkIn, End: n.checkOut }),
      el('BasicPropertyInfo', { HotelCode: n.hotelCode }),
      n.specialRequests.length || n.arrivalTime
        ? el('SpecialRequests', null, ...n.specialRequests.map((r) => el('SpecialRequest', null, el('Text', null, r))), n.arrivalTime ? el('SpecialRequest', { Name: 'EstimatedArrival' }, el('Text', null, `${n.arrivalTime} (not guaranteed)`)) : undefined)
        : undefined)
  })
  const resGuests = n.guests.map((g, index) => el('ResGuest', { ResGuestRPH: index + 1, PrimaryIndicator: g === lead ? 'true' : 'false' },
    el('Profiles', null, el('ProfileInfo', null, el('Profile', { ProfileType: 1 }, el('Customer', null, el('PersonName', null, el('GivenName', null, g.firstName), el('Surname', null, g.lastName))))))))
  const root = el('OTA_HotelResNotifRQ', { xmlns: 'http://www.opentravel.org/OTA/2003/05', Version: '1.0', ResStatus: RES_STATUS[n.kind], TimeStamp: n.createdAt, EchoToken: hotelNoticeEchoToken(n) },
    el('HotelReservations', null, el('HotelReservation', { CreateDateTime: n.createdAt, ResStatus: RES_STATUS[n.kind] },
      el('UniqueID', { Type: RESERVATION_ID_TYPE, ID: n.reference }),
      el('RoomStays', null, ...roomStays),
      el('ResGuests', null, ...resGuests),
      el('ResGlobalInfo', null, el('HotelReservationIDs', null,
        el('HotelReservationID', { ResID_Type: RESERVATION_ID_TYPE, ResID_Value: n.reference, ResID_Source: 'FBEDS' }),
        n.hotelConfirmationNo ? el('HotelReservationID', { ResID_Type: 10, ResID_Value: n.hotelConfirmationNo }) : undefined)))))
  return xmlDocument(root)
}
