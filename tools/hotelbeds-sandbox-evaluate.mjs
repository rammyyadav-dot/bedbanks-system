#!/usr/bin/env node
// Explicit operator-only evaluation. No API/Agent route, DB access or persistent role.
import { randomBytes } from 'node:crypto'
import { HotelbedsSandboxTransport, normalizeHotelbedsResponse } from '../packages/connectors/core/src/hotelbeds-sandbox.ts'
import { buildHotelbedsBookBody, findHotelbedsBooking, hotelbedsClientReference, normalizeHotelbedsBooking } from '../packages/connectors/core/src/hotelbeds-booking.ts'

const allowed = new Set(['status', 'search-recheck', 'content', 'book-cycle'])
const operation = process.argv[2]
const identity = ['FBEDS_SANDBOX_TENANT_ID', 'FBEDS_SANDBOX_SUPPLIER_ID', 'FBEDS_SANDBOX_CONNECTOR_ID']
if (process.env.HOTELBEDS_SANDBOX_ENABLED !== 'true' || !allowed.has(operation) ||
    !identity.every(k => /^[a-zA-Z0-9_-]{1,100}$/.test(process.env[k] ?? '')) ||
    !process.env.HOTELBEDS_SANDBOX_API_KEY || !process.env.HOTELBEDS_SANDBOX_SECRET) {
  console.error('SANDBOX_ACCESS=BLOCKED; explicit enablement, scope and sandbox secret references required')
  process.exitCode = 1
} else {
  const scope = { tenantId: process.env.FBEDS_SANDBOX_TENANT_ID, supplierId: process.env.FBEDS_SANDBOX_SUPPLIER_ID, connectorId: process.env.FBEDS_SANDBOX_CONNECTOR_ID }
  const context = { ...scope, correlationId: 'operator-evaluation' }
  const transport = new HotelbedsSandboxTransport({ ...scope, enabled: true, secretRef: 'operator-environment' }, {
    resolveSecret: async () => ({ apiKey: process.env.HOTELBEDS_SANDBOX_API_KEY, secret: process.env.HOTELBEDS_SANDBOX_SECRET }),
    event: event => console.log(JSON.stringify({ evidence: 'REAL_SANDBOX_ATTEMPT', ...event })),
  })
  try {
    if (operation === 'status') {
      await transport.status(context)
      console.log('REAL_SANDBOX_STATUS_RESPONSE=RECEIVED; supplier health semantics not certified')
    } else if (operation === 'content') {
      const page = await transport.contentPage(1, 100, context)
      if (!Array.isArray(page.hotels)) throw new Error('Malformed content')
      console.log(JSON.stringify({ evidence: 'REAL_SANDBOX', contentRecordsReceived: page.hotels.length, canonicalMappingsCreated: 0, inventoryWrites: 0 }))
    } else if (operation === 'book-cycle') {
      // search -> (recheck) -> book -> lookup by reference -> cancel -> lookup. Uses about seven of the 50 daily evaluation attempts. Prints counts and states only.
      const guest = { name: process.env.FBEDS_SANDBOX_GUEST_NAME, surname: process.env.FBEDS_SANDBOX_GUEST_SURNAME }
      if (process.env.HOTELBEDS_SANDBOX_BOOKING_ENABLED !== 'true' || !guest.name || !guest.surname) throw Object.assign(new Error('blocked'), { code: 'disabled' })
      const code = Number(process.env.HOTELBEDS_SANDBOX_TEST_HOTEL_CODE)
      const found = normalizeHotelbedsResponse(await transport.search({ checkIn: process.env.FBEDS_SANDBOX_CHECK_IN, checkOut: process.env.FBEDS_SANDBOX_CHECK_OUT, rooms: 1, adults: 2, children: 0, hotelCodes: [code] }, context), new Date().toISOString())
      let rate = found.find(o => o.rateType === 'BOOKABLE') ?? found.find(o => o.rateType === 'RECHECK')
      if (!rate) throw Object.assign(new Error('blocked'), { code: 'unsupported' })
      if (rate.rateType === 'RECHECK') {
        const updated = normalizeHotelbedsResponse(await transport.checkRate(rate.rateKey, 'RECHECK', context), new Date().toISOString())
        rate = updated.find(o => o.supplierRoomId === rate.supplierRoomId && o.supplierBoardCode === rate.supplierBoardCode)
        if (!rate) throw Object.assign(new Error('blocked'), { code: 'unsupported' })
      }
      const reference = `FB-${randomBytes(10).toString('hex').toUpperCase()}`
      const clientReference = hotelbedsClientReference(reference)
      const body = buildHotelbedsBookBody(reference, { rateKey: rate.rateKey, holder: guest, guests: [{ type: 'AD', ...guest }, { type: 'AD', ...guest }] })
      const booked = normalizeHotelbedsBooking(await transport.book(body, context))
      const day = new Date().toISOString().slice(0, 10)
      const held = findHotelbedsBooking(await transport.findBookings(clientReference, day, day, context), clientReference)
      const cancelled = normalizeHotelbedsBooking(await transport.cancelBooking(booked.supplierRef, context))
      const after = findHotelbedsBooking(await transport.findBookings(clientReference, day, day, context), clientReference)
      console.log(JSON.stringify({ evidence: 'REAL_SANDBOX', booked: booked.state, priceMatchedRecheck: booked.totalNetMinor === rate.netAmountMinor, foundByReference: held?.state ?? null, cancelled: cancelled.state, afterCancel: after?.state ?? null, liveHost: false }))
    } else {
      const code = Number(process.env.HOTELBEDS_SANDBOX_TEST_HOTEL_CODE)
      const payload = await transport.search({ checkIn: process.env.FBEDS_SANDBOX_CHECK_IN, checkOut: process.env.FBEDS_SANDBOX_CHECK_OUT, rooms: 1, adults: 2, children: 0, hotelCodes: [code] }, context)
      const observations = normalizeHotelbedsResponse(payload, new Date().toISOString())
      console.log(JSON.stringify({ evidence: 'REAL_SANDBOX', searchObservations: observations.length, selectableOffers: 0 }))
      const candidate = observations.find(o => o.rateType === 'RECHECK')
      if (!candidate) {
        console.log('REAL_SANDBOX_RECHECK=BLOCKED_NO_RECHECK_RATE; no BOOKABLE rate automatically rechecked')
      } else {
        const raw = await transport.checkRate(candidate.rateKey, 'RECHECK', context)
        const updated = normalizeHotelbedsResponse(raw, new Date().toISOString())
        const match = updated.find(o => o.supplierHotelId === candidate.supplierHotelId && o.supplierRoomId === candidate.supplierRoomId && o.supplierBoardCode === candidate.supplierBoardCode)
        console.log(JSON.stringify({ evidence: 'REAL_SANDBOX', recheckObservationMatched: Boolean(match), priceChanged: match ? match.netAmountMinor !== candidate.netAmountMinor : null, agentAuthorityEstablished: false }))
      }
    }
    console.log('REAL_SANDBOX_CERTIFICATION=INCOMPLETE; approved mappings, pricing/expiry authority and database-backed synchronization are separate gates')
  } catch (error) {
    console.error(JSON.stringify({ evidence: 'REAL_SANDBOX_ATTEMPT', outcome: 'blocked', errorClassification: typeof error?.code === 'string' ? error.code : 'malformed_response' }))
    process.exitCode = 1
  }
}

