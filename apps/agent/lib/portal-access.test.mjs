import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_CAPABILITY, portalAccess } from './portal-access.ts'

const off = { bookingEnabled: false, bookingServicingEnabled: false, fundingEnabled: false }
const on = { bookingEnabled: true, bookingServicingEnabled: true, fundingEnabled: true }
const owner = Object.values(AGENT_CAPABILITY)
const finance = [AGENT_CAPABILITY.viewFinance]
const searchOnly = [AGENT_CAPABILITY.search]
const bookingAgent = [AGENT_CAPABILITY.prebook, AGENT_CAPABILITY.createBooking, AGENT_CAPABILITY.viewBookings, AGENT_CAPABILITY.cancelBooking]
const conflicting = [AGENT_CAPABILITY.search, AGENT_CAPABILITY.createBooking, AGENT_CAPABILITY.viewFinance]

test('Given an owner and no certification, When the portal is presented, Then privileged actions are visible and disabled', () => {
  const access = portalAccess(owner, off)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.enabled, true)
  assert.equal(access.hold.shown, true)
  assert.equal(access.hold.enabled, false)
  assert.match(access.hold.message, /not certified/)
  assert.equal(access.createBooking.enabled, false)
  assert.equal(access.viewBookings.enabled, false)
  assert.equal(access.cancel.enabled, false)
  assert.equal(access.documents.enabled, false)
  assert.equal(access.funding.enabled, false)
})

test('Given certification and an owner, When the portal is presented, Then every gated action is enabled', () => {
  const access = portalAccess(owner, on)
  for (const action of Object.values(access)) assert.equal(action.enabled, true)
})

test('Given a finance membership, When the portal is presented, Then only the finance summary is shown', () => {
  const access = portalAccess(finance, on)
  assert.equal(access.finance.shown, true)
  assert.equal(access.search.shown, false)
  assert.equal(access.funding.shown, false)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
})

test('Given a search-only agent, When the portal is presented, Then booking and finance controls stay hidden', () => {
  const access = portalAccess(searchOnly, on)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.shown, false)
  assert.equal(access.hold.shown, false)
  assert.equal(access.createBooking.shown, false)
})

test('Given a booking agent, When booking is certified, Then hold, confirm, history, cancel and documents are enabled and finance stays hidden', () => {
  const access = portalAccess(bookingAgent, on)
  assert.equal(access.hold.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  assert.equal(access.viewBookings.enabled, true)
  assert.equal(access.cancel.enabled, true)
  assert.equal(access.documents.enabled, true)
  assert.equal(access.funding.enabled, true)
  assert.equal(access.finance.shown, false)
})

test('Given conflicting formal roles, When capabilities are combined, Then each control follows its own capability', () => {
  const access = portalAccess(conflicting, on)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
})

test('Given no capabilities, When bookingEnabled is true, Then booking controls stay hidden', () => {
  const access = portalAccess([], on)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
  assert.equal(access.search.shown, false)
})
