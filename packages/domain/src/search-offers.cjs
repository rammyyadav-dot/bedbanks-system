'use strict'

// Validate at the supplier/API and API/browser boundaries. Return only known fields.
// One invalid offer rejects the whole response: no partially mapped rate is shown.
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const id = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 512
const date = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const instant = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v)
const natural = (v, min) => Number.isSafeInteger(v) && v >= min
const sameCriteria = (left, right) => left.destination === right.destination &&
  left.checkIn === right.checkIn && left.checkOut === right.checkOut &&
  left.rooms === right.rooms && left.adults === right.adults &&
  left.children === right.children && left.nationality === right.nationality &&
  left.currency === right.currency &&
  left.childAges.length === right.childAges.length &&
  left.childAges.every((age, i) => age === right.childAges[i])

function validSearchCriteria(c) {
  return record(c) && id(c.destination) && date(c.checkIn) && date(c.checkOut) &&
    c.checkOut > c.checkIn && natural(c.rooms, 1) && c.rooms <= 20 &&
    natural(c.adults, 1) && c.adults <= 40 && natural(c.children, 0) && c.children <= 40 &&
    Array.isArray(c.childAges) && c.childAges.length === c.children &&
    c.childAges.every((age) => natural(age, 0) && age <= 17) &&
    typeof c.nationality === 'string' && /^[A-Z]{2}$/.test(c.nationality) &&
    typeof c.currency === 'string' && /^[A-Z]{3}$/.test(c.currency)
}

function validateSearchHotels(input, criteria, now = Date.now()) {
  if (!validSearchCriteria(criteria) || !Array.isArray(input)) return { ok: false, reason: 'mapping_unavailable' }
  const offerIds = new Set()
  const hotelIds = new Set()
  try {
    const hotels = input.map((hotel) => {
      if (!record(hotel) || !id(hotel.hotelId) || !id(hotel.name) || !id(hotel.destination) ||
          !id(hotel.supplierId) || !id(hotel.supplierHotelId) ||
          !Array.isArray(hotel.rooms) || hotel.rooms.length === 0 ||
          hotelIds.has(hotel.hotelId))
        throw Error('hotel')
      hotelIds.add(hotel.hotelId)
      const roomIds = new Set()
      const rooms = hotel.rooms.map((room) => {
        if (!record(room) || !id(room.roomTypeId) || !id(room.name) || !id(room.supplierRoomId) ||
            !Array.isArray(room.rates) || room.rates.length === 0 ||
            roomIds.has(room.roomTypeId)) throw Error('room')
        roomIds.add(room.roomTypeId)
        const rates = room.rates.map((rate) => {
          if (!record(rate) || !id(rate.offerId) || offerIds.has(rate.offerId) ||
              rate.hotelId !== hotel.hotelId || rate.roomTypeId !== room.roomTypeId ||
              rate.supplierId !== hotel.supplierId || rate.supplierRoomId !== room.supplierRoomId ||
              !id(rate.ratePlanId) || !id(rate.ratePlanName) || !id(rate.boardBasisId) ||
              !id(rate.boardBasisName) || !id(rate.supplierRateId) ||
              (rate.offerToken !== undefined && !id(rate.offerToken)) ||
              !instant(rate.expiresAt) || Date.parse(rate.expiresAt) <= now ||
              !['available', 'limited', 'sold_out'].includes(rate.availability) ||
              !record(rate.occupancy) || rate.occupancy.rooms !== criteria.rooms ||
              rate.occupancy.adults !== criteria.adults || rate.occupancy.children !== criteria.children ||
              !Array.isArray(rate.occupancy.childAges) ||
              rate.occupancy.childAges.length !== criteria.childAges.length ||
              rate.occupancy.childAges.some((age, i) => age !== criteria.childAges[i]) ||
              !record(rate.cancellation) || typeof rate.cancellation.refundable !== 'boolean' ||
              !id(rate.cancellation.summary) ||
              (rate.cancellation.deadline !== undefined && !instant(rate.cancellation.deadline)) ||
              !record(rate.total) || rate.total.currency !== criteria.currency ||
              !natural(rate.total.amountMinor, 0)) throw Error('rate')
          offerIds.add(rate.offerId)
          return {
            offerId: rate.offerId, hotelId: rate.hotelId, roomTypeId: rate.roomTypeId,
            supplierId: rate.supplierId, supplierRoomId: rate.supplierRoomId,
            ratePlanId: rate.ratePlanId, ratePlanName: rate.ratePlanName,
            boardBasisId: rate.boardBasisId, boardBasisName: rate.boardBasisName,
            supplierRateId: rate.supplierRateId,
            ...(rate.offerToken === undefined ? {} : { offerToken: rate.offerToken }),
            expiresAt: rate.expiresAt,
            occupancy: { rooms: rate.occupancy.rooms, adults: rate.occupancy.adults,
              children: rate.occupancy.children, childAges: [...rate.occupancy.childAges] },
            availability: rate.availability,
            cancellation: { refundable: rate.cancellation.refundable, summary: rate.cancellation.summary,
              ...(rate.cancellation.deadline === undefined ? {} : { deadline: rate.cancellation.deadline }) },
            total: { amountMinor: rate.total.amountMinor, currency: rate.total.currency },
          }
        })
        return { roomTypeId: room.roomTypeId, name: room.name, supplierRoomId: room.supplierRoomId, rates }
      })
      return { hotelId: hotel.hotelId, name: hotel.name, destination: hotel.destination,
        supplierId: hotel.supplierId, supplierHotelId: hotel.supplierHotelId, rooms }
    })
    return { ok: true, hotels }
  } catch {
    return { ok: false, reason: 'mapping_unavailable' }
  }
}

function validateAgentSearchResponse(value, criteria, now = Date.now()) {
  if (!record(value) || value.version !== 1 || !record(value.request) ||
      !validSearchCriteria(value.request) || !validSearchCriteria(criteria) ||
      !sameCriteria(value.request, criteria) ||
      !['available', 'no_availability', 'provider_unavailable', 'mapping_unavailable'].includes(value.status) ||
      !natural(value.total, 0)) return { ok: false, reason: 'mapping_unavailable' }
  const result = validateSearchHotels(value.hotels, criteria, now)
  if (!result.ok || value.total !== result.hotels.length ||
      (value.status === 'available') !== (result.hotels.length > 0) ||
      (value.status !== 'available' && result.hotels.length > 0))
    return { ok: false, reason: 'mapping_unavailable' }
  return { ok: true, response: { version: 1, status: value.status, request: { ...criteria, childAges: [...criteria.childAges] },
    hotels: result.hotels, total: result.hotels.length } }
}

module.exports = { validSearchCriteria, validateSearchHotels, validateAgentSearchResponse }
