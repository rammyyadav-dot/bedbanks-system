import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_CAPABILITY, accessForTenant, portalAccess } from './portal-access.ts'

const off = { bookingEnabled: false, bookingServicingEnabled: false, fundingEnabled: false }
const on = { bookingEnabled: true, bookingServicingEnabled: true, fundingEnabled: true }
const salesOnly = { bookingEnabled: true, bookingServicingEnabled: false, fundingEnabled: false }
const servicingOnly = { bookingEnabled: false, bookingServicingEnabled: true, fundingEnabled: true }
const owner = Object.values(AGENT_CAPABILITY)
const finance = [AGENT_CAPABILITY.viewFinance]
const searchOnly = [AGENT_CAPABILITY.search]
const bookingAgent = [AGENT_CAPABILITY.prebook, AGENT_CAPABILITY.createBooking, AGENT_CAPABILITY.viewBookings, AGENT_CAPABILITY.cancelBooking]
const conflicting = [AGENT_CAPABILITY.search, AGENT_CAPABILITY.createBooking, AGENT_CAPABILITY.viewFinance]

function hidden(action) {
  assert.equal(action.shown, false)
  assert.equal(action.enabled, false)
  assert.equal(action.message, null)
}

test('Given an owner and no certification, When the portal is presented, Then uncertified actions stay hidden and search stays available', () => {
  const access = portalAccess(owner, off)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.enabled, true)
  assert.equal(access.fundingReceipts.enabled, true)
  hidden(access.hold)
  hidden(access.createBooking)
  hidden(access.viewBookings)
  hidden(access.cancel)
  hidden(access.documents)
  hidden(access.funding)
  hidden(access.recover)
})

test('Given certification and an owner, When the portal is presented, Then every gated action is enabled', () => {
  const access = portalAccess(owner, on)
  for (const action of Object.values(access)) assert.equal(action.enabled, true)
})

test('Given sales certified without servicing, When the portal is presented, Then hold and confirm show and history stays hidden', () => {
  const access = portalAccess(owner, salesOnly)
  assert.equal(access.hold.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  hidden(access.viewBookings)
  hidden(access.cancel)
  hidden(access.documents)
  hidden(access.recover)
  hidden(access.funding)
})

test('Given servicing certified without new sales, When the portal is presented, Then history, cancel and documents show and hold stays hidden', () => {
  const access = portalAccess(owner, servicingOnly)
  hidden(access.hold)
  hidden(access.createBooking)
  assert.equal(access.viewBookings.enabled, true)
  assert.equal(access.cancel.enabled, true)
  assert.equal(access.documents.enabled, true)
  assert.equal(access.recover.enabled, true)
  assert.equal(access.funding.enabled, true)
})

test('Given a finance membership, When the portal is presented, Then only the finance summary is shown', () => {
  const access = portalAccess(finance, on)
  assert.equal(access.finance.shown, true)
  assert.equal(access.search.shown, false)
  assert.equal(access.funding.shown, false)
  assert.equal(access.fundingReceipts.shown, false)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
})

test('Given a search-only agent, When the portal is presented, Then booking and finance controls stay hidden', () => {
  const access = portalAccess(searchOnly, on)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.shown, false)
  assert.equal(access.hold.shown, false)
  assert.equal(access.createBooking.shown, false)
  assert.equal(access.fundingReceipts.shown, false)
})

test('Given a booking agent, When booking is certified, Then hold, confirm, history, cancel and documents are enabled and finance stays hidden', () => {
  const access = portalAccess(bookingAgent, on)
  assert.equal(access.hold.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  assert.equal(access.viewBookings.enabled, true)
  assert.equal(access.cancel.enabled, true)
  assert.equal(access.documents.enabled, true)
  assert.equal(access.funding.enabled, true)
  assert.equal(access.fundingReceipts.enabled, true)
  assert.equal(access.finance.shown, false)
  assert.equal(access.recover.shown, false)
})

test('Given conflicting formal roles, When capabilities are combined, Then each control follows its own capability', () => {
  const access = portalAccess(conflicting, on)
  assert.equal(access.search.enabled, true)
  assert.equal(access.finance.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
  assert.equal(access.funding.shown, false)
})

test('Given no capabilities, When bookingEnabled is true, Then booking controls stay hidden', () => {
  const access = portalAccess([], on)
  assert.equal(access.hold.shown, false)
  assert.equal(access.viewBookings.shown, false)
  assert.equal(access.search.shown, false)
})

test('Given another tenant\'s capabilities, When this workspace is selected, Then every action stays hidden', () => {
  const foreign = accessForTenant('tenant-a', 'tenant-a', { ...on, capabilityTenantId: 'tenant-b', capabilities: owner })
  for (const action of Object.values(foreign)) hidden(action)
  const stale = accessForTenant('tenant-a', 'tenant-b', { ...on, capabilityTenantId: 'tenant-a', capabilities: owner })
  for (const action of Object.values(stale)) hidden(action)
  const unnamed = accessForTenant('tenant-a', 'tenant-a', { ...on, capabilityTenantId: '', capabilities: owner })
  for (const action of Object.values(unnamed)) hidden(action)
})

test('Given the server names the selected tenant, When capabilities and gates match, Then only those actions show', () => {
  const access = accessForTenant('tenant-a', 'tenant-a', { ...salesOnly, capabilityTenantId: 'tenant-a', capabilities: bookingAgent })
  assert.equal(access.hold.enabled, true)
  assert.equal(access.createBooking.enabled, true)
  hidden(access.viewBookings)
  hidden(access.finance)
})
