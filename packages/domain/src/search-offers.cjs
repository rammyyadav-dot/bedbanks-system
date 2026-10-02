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
const CITY_ID = /^city:([A-Z]{2}):([a-z0-9]+(?:-[a-z0-9]+)*)$/
const propertyTypeOk = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .&-]{0,39}$/.test(value)
const coordinateOk = (value) => typeof value === 'string' && /^-?\d{1,3}(\.\d{1,6})?$/.test(value)
const addressOk = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value && !/[\u0000-\u001f]/.test(value)
const timeZoneOk = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true } catch { return false }
}
function citySlug(name) {
  return String(name ?? '').trim().toLocaleLowerCase('en-US').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function cityDestinationId(countryCode, cityName) {
  const country = String(countryCode ?? '').trim().toUpperCase()
  const slug = citySlug(cityName)
  if (!/^[A-Z]{2}$/.test(country) || !slug) return ''
  return `city:${country}:${slug}`
}
function validDestinationRef(value) {
  if (value === undefined) return true
  if (!record(value)) return false
  if (value.type === 'city') {
    if (!allowedKeys(value, ['type', 'id', 'countryCode']) || typeof value.id !== 'string' || typeof value.countryCode !== 'string') return false
    if (!CITY_ID.test(value.id) || !value.id.startsWith(`city:${value.countryCode}:`)) return false
    const words = value.id.slice(value.countryCode.length + 6).replace(/-/g, ' ')
    return value.id === cityDestinationId(value.countryCode, words)
  }
  if (value.type === 'hotel') return allowedKeys(value, ['type', 'id']) && id(value.id)
  return false
}
function validRoomStay(stay) {
  return record(stay) && allowedKeys(stay, ['adults', 'children']) && natural(stay.adults, 1) && stay.adults <= 8 &&
    Array.isArray(stay.children) && stay.children.length <= 8 &&
    stay.children.every((child) => record(child) && allowedKeys(child, ['age']) && natural(child.age, 0) && child.age <= 17)
}
function roomStaysMatchAggregate(stays, criteria) {
  if (!stays.every(validRoomStay) || stays.length !== criteria.rooms) return false
  const uniform = stays.every((stay) => stay.adults === stays[0].adults && stay.children.length === stays[0].children.length &&
    stay.children.every((child, index) => child.age === stays[0].children[index].age))
  if (uniform) {
    return criteria.adults === stays[0].adults && criteria.children === stays[0].children.length &&
      criteria.childAges.length === stays[0].children.length &&
      stays[0].children.every((child, index) => child.age === criteria.childAges[index])
  }
  const adults = stays.reduce((sum, stay) => sum + stay.adults, 0)
  const ages = stays.flatMap((stay) => stay.children.map((child) => child.age))
  return criteria.adults === adults && criteria.children === ages.length &&
    criteria.childAges.length === ages.length && ages.every((age, index) => age === criteria.childAges[index])
}
function sameRoomStays(left, right) {
  if (left === undefined && right === undefined) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((stay, index) => stay.adults === right[index].adults && stay.children.length === right[index].children.length &&
    stay.children.every((child, childIndex) => child.age === right[index].children[childIndex].age))
}
function sameDestinationRef(left, right) {
  if (left === undefined && right === undefined) return true
  if (!left || !right || left.type !== right.type || left.id !== right.id) return false
  return left.type === 'hotel' || left.countryCode === right.countryCode
}
function filterKey(filters) {
  if (!filters) return ''
  return JSON.stringify({
    starRatings: filters.starRatings ?? null,
    boardBasisIds: filters.boardBasisIds ?? null,
    refundableOnly: filters.refundableOnly ?? null,
    minPriceMinor: filters.minPriceMinor ?? null,
    maxPriceMinor: filters.maxPriceMinor ?? null,
    propertyTypes: filters.propertyTypes ? [...filters.propertyTypes].slice().sort() : null,
  })
}
const sameDestination = (left, right) => left.destination === right.destination ||
  (sameDestinationRef(left.destinationRef, right.destinationRef) && left.destinationRef !== undefined &&
    left.destination.trim().toLocaleLowerCase('en-US') === right.destination.trim().toLocaleLowerCase('en-US'))
const sameCriteria = (left, right) => sameDestination(left, right) &&
  sameDestinationRef(left.destinationRef, right.destinationRef) &&
  left.checkIn === right.checkIn && left.checkOut === right.checkOut &&
  left.rooms === right.rooms && left.adults === right.adults &&
  left.children === right.children && left.nationality === right.nationality &&
  left.currency === right.currency &&
  (left.sort ?? 'default') === (right.sort ?? 'default') &&
  left.childAges.length === right.childAges.length &&
  left.childAges.every((age, i) => age === right.childAges[i]) &&
  sameRoomStays(left.roomStays, right.roomStays) &&
  JSON.stringify(left.canonicalHotelIds ?? []) === JSON.stringify(right.canonicalHotelIds ?? []) &&
  (left.limit ?? 50) === (right.limit ?? 50) && (left.offset ?? 0) === (right.offset ?? 0) &&
  filterKey(left.filters) === filterKey(right.filters)

const MAX_SEARCH_OFFSET = 10_000

function pageWindow(criteria) {
  return { limit: criteria.limit ?? 50, offset: criteria.offset ?? 0 }
}

function validSearchCriteria(c, now = Date.now()) {
  if (!record(c) || !allowedKeys(c, ['destination', 'destinationRef', 'canonicalHotelIds', 'checkIn', 'checkOut', 'rooms', 'adults', 'children', 'childAges', 'roomStays', 'nationality', 'currency', 'limit', 'offset', 'sort', 'filters'])) return false
  const today = new Date(now).toISOString().slice(0, 10)
  const nights = date(c.checkIn) && date(c.checkOut) ? Math.round((Date.parse(c.checkOut) - Date.parse(c.checkIn)) / 86400000) : 0
  const hotelsValid = c.canonicalHotelIds === undefined || (Array.isArray(c.canonicalHotelIds) && c.canonicalHotelIds.length > 0 && c.canonicalHotelIds.length <= 50 && c.canonicalHotelIds.every(id))
  const filters = c.filters
  const filtersValid = filters === undefined || (allowedKeys(filters, ['starRatings', 'boardBasisIds', 'refundableOnly', 'minPriceMinor', 'maxPriceMinor', 'propertyTypes']) &&
    (filters.starRatings === undefined || (Array.isArray(filters.starRatings) && filters.starRatings.every((v) => natural(v, 1) && v <= 5))) &&
    (filters.boardBasisIds === undefined || (Array.isArray(filters.boardBasisIds) && filters.boardBasisIds.length <= 20 && filters.boardBasisIds.every(id))) &&
    (filters.propertyTypes === undefined || (Array.isArray(filters.propertyTypes) && filters.propertyTypes.length > 0 && filters.propertyTypes.length <= 20 && filters.propertyTypes.every(propertyTypeOk))) &&
    (filters.refundableOnly === undefined || typeof filters.refundableOnly === 'boolean') &&
    (filters.minPriceMinor === undefined || natural(filters.minPriceMinor, 0)) &&
    (filters.maxPriceMinor === undefined || natural(filters.maxPriceMinor, 0)) &&
    (filters.minPriceMinor === undefined || filters.maxPriceMinor === undefined || filters.maxPriceMinor >= filters.minPriceMinor))
  const staysValid = c.roomStays === undefined || (Array.isArray(c.roomStays) && c.roomStays.length >= 1 && c.roomStays.length <= 8 && roomStaysMatchAggregate(c.roomStays, c))
  const sortValid = c.sort === undefined || c.sort === 'default' || c.sort === 'price' || c.sort === 'stars' || c.sort === 'name'
  return (id(c.destination) || hotelsValid) && hotelsValid && validDestinationRef(c.destinationRef) && date(c.checkIn) && date(c.checkOut) &&
    c.checkIn >= today && nights >= 1 && nights <= 30 && natural(c.rooms, 1) && c.rooms <= 8 &&
    natural(c.adults, 1) && c.adults <= 40 && natural(c.children, 0) && c.children <= 40 &&
    Array.isArray(c.childAges) && c.childAges.length === c.children &&
    c.childAges.every((age) => natural(age, 0) && age <= 17) &&
    staysValid && sortValid &&
    SUPPORTED_COUNTRIES.has(c.nationality) && SUPPORTED_CURRENCIES.has(c.currency) &&
    (c.limit === undefined || (natural(c.limit, 1) && c.limit <= 100)) &&
    (c.offset === undefined || (natural(c.offset, 0) && c.offset <= MAX_SEARCH_OFFSET)) && filtersValid
}

function declaredPagination(value, criteria, pageLength) {
  const { limit, offset } = pageWindow(criteria)
  if (value === undefined) return offset === 0 ? undefined : null
  if (!record(value) || !allowedKeys(value, ['limit', 'offset', 'total', 'hasMore', 'nextOffset'])) return null
  if (value.limit !== limit || value.offset !== offset || !natural(value.total, 0) || pageLength > limit) return null
  if (value.total < offset + pageLength) return null
  const hasMore = offset + pageLength < value.total
  if (value.hasMore !== hasMore) return null
  if (hasMore) {
    if (pageLength !== limit || value.nextOffset !== offset + limit) return null
  } else if (value.nextOffset !== undefined) return null
  return { limit, offset, total: value.total, hasMore, ...(hasMore ? { nextOffset: offset + limit } : {}) }
}

function validateSearchHotels(input, criteria, now = Date.now(), expectedTenantId, paginate = true) {
  if (!validSearchCriteria(criteria) || !Array.isArray(input)) return { ok: false, reason: 'mapping_unavailable' }
  const offerIds = new Set()
  const hotelIds = new Set()
  try {
    const hotels = input.map((hotel) => {
      if (!record(hotel) || !id(hotel.hotelId) || !id(hotel.name) || !id(hotel.destination) ||
          !natural(hotel.starRating, 1) || hotel.starRating > 5 ||
          (hotel.propertyType !== undefined && !propertyTypeOk(hotel.propertyType)) ||
          (hotel.address !== undefined && !addressOk(hotel.address)) ||
          ((hotel.latitude !== undefined) !== (hotel.longitude !== undefined)) ||
          (hotel.latitude !== undefined && (!coordinateOk(hotel.latitude) || !coordinateOk(hotel.longitude))) ||
          (hotel.timeZone !== undefined && !timeZoneOk(hotel.timeZone)) ||
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
              !id(rate.ratePlanId) || (rate.contractId !== undefined && !id(rate.contractId)) || !id(rate.ratePlanName) || !id(rate.boardBasisId) ||
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
            ratePlanId: rate.ratePlanId, ...(rate.contractId === undefined ? {} : { contractId: rate.contractId }), ratePlanName: rate.ratePlanName,
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
      return { hotelId: hotel.hotelId, name: hotel.name, destination: hotel.destination, starRating: hotel.starRating,
        ...(hotel.propertyType === undefined ? {} : { propertyType: hotel.propertyType }),
        ...(hotel.address === undefined ? {} : { address: hotel.address }),
        ...(hotel.latitude === undefined ? {} : { latitude: hotel.latitude, longitude: hotel.longitude }),
        ...(hotel.timeZone === undefined ? {} : { timeZone: hotel.timeZone }),
        supplierId: hotel.supplierId, supplierHotelId: hotel.supplierHotelId, rooms }
    })
    const requestedHotelIds = criteria.canonicalHotelIds === undefined ? undefined : new Set(criteria.canonicalHotelIds)
    const destination = criteria.destination.trim().toLocaleLowerCase('en-US')
    const cityExact = criteria.destinationRef?.type === 'city'
    const filtered = hotels.flatMap((hotel) => {
      if (requestedHotelIds) {
        if (!requestedHotelIds.has(hotel.hotelId)) return []
      } else if (cityExact) {
        if (hotel.destination.toLocaleLowerCase('en-US') !== destination) return []
      } else if (!hotel.destination.toLocaleLowerCase('en-US').includes(destination)) return []
      if (criteria.filters?.starRatings !== undefined && !criteria.filters.starRatings.includes(hotel.starRating)) return []
      if (criteria.filters?.propertyTypes !== undefined && (!hotel.propertyType || !criteria.filters.propertyTypes.includes(hotel.propertyType))) return []
      const rooms = hotel.rooms.flatMap((room) => {
        const rates = room.rates.filter((rate) => rate.available &&
          (criteria.filters?.boardBasisIds === undefined || criteria.filters.boardBasisIds.includes(rate.boardBasisId)) &&
          (!criteria.filters?.refundableOnly || rate.cancellation.refundable) &&
          (criteria.filters?.minPriceMinor === undefined || rate.sellAmountMinor >= criteria.filters.minPriceMinor) &&
          (criteria.filters?.maxPriceMinor === undefined || rate.sellAmountMinor <= criteria.filters.maxPriceMinor))
        return rates.length === 0 ? [] : [{ ...room, rates }]
      })
      return rooms.length === 0 ? [] : [{ ...hotel, rooms }]
    })
    const sort = criteria.sort ?? 'default'
    const leadPrice = (hotel) => hotel.rooms.reduce((min, room) => room.rates.reduce((roomMin, rate) => Math.min(roomMin, rate.sellAmountMinor), min), Number.MAX_SAFE_INTEGER)
    if (sort === 'price') filtered.sort((left, right) => leadPrice(left) - leadPrice(right) || left.name.localeCompare(right.name) || left.hotelId.localeCompare(right.hotelId))
    else if (sort === 'stars') filtered.sort((left, right) => right.starRating - left.starRating || left.name.localeCompare(right.name) || left.hotelId.localeCompare(right.hotelId))
    else if (sort === 'name') filtered.sort((left, right) => left.name.localeCompare(right.name) || left.hotelId.localeCompare(right.hotelId))
    const { limit, offset } = pageWindow(criteria)
    if (!paginate && filtered.length > limit) throw Error('page')
    const page = paginate ? filtered.slice(offset, offset + limit) : filtered
    return { ok: true, hotels: page, matchedTotal: paginate ? filtered.length : page.length }
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
  const result = validateSearchHotels(value.hotels, criteria, now, undefined, false)
  const pagination = result.ok ? declaredPagination(value.pagination, criteria, result.hotels.length) : null
  if (!result.ok || pagination === null || value.total !== result.hotels.length ||
      (!['available', 'partial'].includes(value.status) && result.hotels.length > 0) ||
      (['available', 'partial'].includes(value.status) && result.hotels.length === 0) ||
      (value.status === 'partial' && value.providerSummary.failed === 0))
    return { ok: false, reason: 'mapping_unavailable' }
  const roomStays = criteria.roomStays?.map((stay) => ({ adults: stay.adults, children: stay.children.map((child) => ({ age: child.age })) }))
  return { ok: true, response: { version: 1, searchId: value.searchId, requestId: value.requestId,
    generatedAt: value.generatedAt, status: value.status, request: { ...criteria, childAges: [...criteria.childAges], ...(roomStays ? { roomStays } : {}) },
    hotels: result.hotels, total: result.hotels.length,
    ...(pagination ? { pagination } : {}),
    providerSummary: { queried: value.providerSummary.queried, succeeded: value.providerSummary.succeeded, failed: value.providerSummary.failed } } }
}

module.exports = { validSearchCriteria, validateSearchHotels, validateAgentSearchResponse, cityDestinationId }
