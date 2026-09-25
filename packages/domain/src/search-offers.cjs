'use strict'

// Validate at the supplier/API and API/browser boundaries. Return only known fields.
// One invalid offer rejects the whole response: no partially mapped rate is shown.
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const id = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 512
const date = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const instant = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v)
const natural = (v, min) => Number.isSafeInteger(v) && v >= min
const SUPPORTED_CURRENCIES = new Set(['AED', 'USD', 'EUR', 'INR', 'GBP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY'])
const SUPPORTED_COUNTRIES = new Set(['AE', 'IN', 'GB', 'US', 'CA', 'AU', 'SG', 'SA', 'QA', 'OM', 'KW', 'BH', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT', 'IE', 'PT', 'GR', 'TR', 'CN', 'JP', 'KR', 'ID', 'MY', 'TH', 'VN', 'PH', 'ZA', 'NZ'])
const allowedKeys = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key))
const sameCriteria = (left, right) => left.destination === right.destination &&
  left.checkIn === right.checkIn && left.checkOut === right.checkOut &&
  left.rooms === right.rooms && left.adults === right.adults &&
  left.children === right.children && left.nationality === right.nationality &&
  left.currency === right.currency &&
  left.childAges.length === right.childAges.length &&
  left.childAges.every((age, i) => age === right.childAges[i]) &&
  JSON.stringify(left.canonicalHotelIds ?? []) === JSON.stringify(right.canonicalHotelIds ?? []) &&
  (left.limit ?? 50) === (right.limit ?? 50) && JSON.stringify(left.filters ?? {}) === JSON.stringify(right.filters ?? {})

function validSearchCriteria(c, now = Date.now()) {
  if (!record(c) || !allowedKeys(c, ['destination', 'canonicalHotelIds', 'checkIn', 'checkOut', 'rooms', 'adults', 'children', 'childAges', 'nationality', 'currency', 'limit', 'filters'])) return false
  const today = new Date(now).toISOString().slice(0, 10)
  const nights = date(c.checkIn) && date(c.checkOut) ? Math.round((Date.parse(c.checkOut) - Date.parse(c.checkIn)) / 86400000) : 0
  const hotelsValid = c.canonicalHotelIds === undefined || (Array.isArray(c.canonicalHotelIds) && c.canonicalHotelIds.length > 0 && c.canonicalHotelIds.length <= 50 && c.canonicalHotelIds.every(id))
  const filters = c.filters
  const filtersValid = filters === undefined || (allowedKeys(filters, ['starRatings', 'boardBasisIds', 'refundableOnly', 'minPriceMinor', 'maxPriceMinor']) &&
    (filters.starRatings === undefined || (Array.isArray(filters.starRatings) && filters.starRatings.every((v) => natural(v, 1) && v <= 5))) &&
    (filters.boardBasisIds === undefined || (Array.isArray(filters.boardBasisIds) && filters.boardBasisIds.length <= 20 && filters.boardBasisIds.every(id))) &&
    (filters.refundableOnly === undefined || typeof filters.refundableOnly === 'boolean') &&
    (filters.minPriceMinor === undefined || natural(filters.minPriceMinor, 0)) &&
    (filters.maxPriceMinor === undefined || natural(filters.maxPriceMinor, 0)) &&
    (filters.minPriceMinor === undefined || filters.maxPriceMinor === undefined || filters.maxPriceMinor >= filters.minPriceMinor))
  return (id(c.destination) || hotelsValid) && hotelsValid && date(c.checkIn) && date(c.checkOut) &&
    c.checkIn >= today && nights >= 1 && nights <= 30 && natural(c.rooms, 1) && c.rooms <= 8 &&
    natural(c.adults, 1) && c.adults <= 40 && natural(c.children, 0) && c.children <= 40 &&
    Array.isArray(c.childAges) && c.childAges.length === c.children &&
    c.childAges.every((age) => natural(age, 0) && age <= 17) &&
    SUPPORTED_COUNTRIES.has(c.nationality) && SUPPORTED_CURRENCIES.has(c.currency) &&
    (c.limit === undefined || (natural(c.limit, 1) && c.limit <= 100)) && filtersValid
}

function validateSearchHotels(input, criteria, now = Date.now(), expectedTenantId) {
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
              !id(rate.tenantId) || (expectedTenantId !== undefined && rate.tenantId !== expectedTenantId) ||
              !id(rate.providerId) || !id(rate.canonicalHotelId) ||
              rate.canonicalHotelId !== hotel.hotelId || !id(rate.canonicalRoomTypeId) ||
              rate.canonicalRoomTypeId !== room.roomTypeId ||
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
              typeof rate.available !== 'boolean' || rate.available !== (rate.availability !== 'sold_out') ||
              !record(rate.total) || rate.total.currency !== criteria.currency || !natural(rate.total.amountMinor, 0) ||
              !natural(rate.netAmountMinor, 0) || !natural(rate.taxAmountMinor, 0) || !natural(rate.feeAmountMinor, 0) ||
              !natural(rate.totalAmountMinor, 0) || !natural(rate.markupAmountMinor, 0) || !natural(rate.sellAmountMinor, 0) ||
              rate.totalAmountMinor !== rate.netAmountMinor + rate.taxAmountMinor + rate.feeAmountMinor ||
              rate.sellAmountMinor !== rate.totalAmountMinor + rate.markupAmountMinor ||
              rate.total.amountMinor !== rate.sellAmountMinor ||
              !['prepaid', 'pay_at_hotel', 'credit'].includes(rate.paymentType) ||
              !['hotel_direct', 'dmc', 'bedbank', 'channel_manager', 'gds'].includes(rate.source)) throw Error('rate')
          offerIds.add(rate.offerId)
          return {
            offerId: rate.offerId, tenantId: rate.tenantId, providerId: rate.providerId,
            hotelId: rate.hotelId, canonicalHotelId: rate.canonicalHotelId,
            roomTypeId: rate.roomTypeId, canonicalRoomTypeId: rate.canonicalRoomTypeId,
            supplierId: rate.supplierId, supplierRoomId: rate.supplierRoomId,
            ratePlanId: rate.ratePlanId, ratePlanName: rate.ratePlanName,
            boardBasisId: rate.boardBasisId, boardBasisName: rate.boardBasisName,
            supplierRateId: rate.supplierRateId,
            ...(rate.offerToken === undefined ? {} : { offerToken: rate.offerToken }),
            expiresAt: rate.expiresAt,
            occupancy: { rooms: rate.occupancy.rooms, adults: rate.occupancy.adults,
              children: rate.occupancy.children, childAges: [...rate.occupancy.childAges] },
            availability: rate.availability, available: rate.available,
            cancellation: { refundable: rate.cancellation.refundable, summary: rate.cancellation.summary,
              ...(rate.cancellation.deadline === undefined ? {} : { deadline: rate.cancellation.deadline }) },
            total: { amountMinor: rate.total.amountMinor, currency: rate.total.currency },
            netAmountMinor: rate.netAmountMinor, taxAmountMinor: rate.taxAmountMinor,
            feeAmountMinor: rate.feeAmountMinor, totalAmountMinor: rate.totalAmountMinor,
            markupAmountMinor: rate.markupAmountMinor, sellAmountMinor: rate.sellAmountMinor,
            paymentType: rate.paymentType, source: rate.source,
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
  if (!record(value) || value.version !== 1 || !id(value.searchId) || !id(value.requestId) || !instant(value.generatedAt) || !record(value.request) ||
      !validSearchCriteria(value.request) || !validSearchCriteria(criteria) ||
      !sameCriteria(value.request, criteria) ||
      !['available', 'partial', 'no_availability', 'provider_unavailable', 'mapping_unavailable'].includes(value.status) ||
      !natural(value.total, 0) || !record(value.providerSummary) ||
      !natural(value.providerSummary.queried, 0) || !natural(value.providerSummary.succeeded, 0) || !natural(value.providerSummary.failed, 0) ||
      value.providerSummary.succeeded + value.providerSummary.failed > value.providerSummary.queried)
    return { ok: false, reason: 'mapping_unavailable' }
  const result = validateSearchHotels(value.hotels, criteria, now)
  if (!result.ok || value.total !== result.hotels.length ||
      (!['available', 'partial'].includes(value.status) && result.hotels.length > 0) ||
      (['available', 'partial'].includes(value.status) && result.hotels.length === 0) ||
      (value.status === 'partial' && value.providerSummary.failed === 0))
    return { ok: false, reason: 'mapping_unavailable' }
  return { ok: true, response: { version: 1, searchId: value.searchId, requestId: value.requestId,
    generatedAt: value.generatedAt, status: value.status, request: { ...criteria, childAges: [...criteria.childAges] },
    hotels: result.hotels, total: result.hotels.length,
    providerSummary: { queried: value.providerSummary.queried, succeeded: value.providerSummary.succeeded, failed: value.providerSummary.failed } } }
}

module.exports = { validSearchCriteria, validateSearchHotels, validateAgentSearchResponse }
