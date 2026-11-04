import { AGENT_PERMISSION_KEYS, effectiveAgentPermissions, membershipGrantsPermission } from './agent-permissions'
import { PERMISSIONS } from './supplier.port'

describe('effective agent permissions', () => {
  it('returns only the formal agent grant and omits the rest of the catalogue', () => {
    expect(effectiveAgentPermissions('agent', [PERMISSIONS.search])).toEqual([PERMISSIONS.search])
    expect(effectiveAgentPermissions('agent', [PERMISSIONS.search, 'supply.hotels.manage', 'platform.access.read'])).toEqual([PERMISSIONS.search])
  })

  it('gives an owner every agent permission and a finance membership only finance.read', () => {
    expect(effectiveAgentPermissions('owner', [])).toEqual(AGENT_PERMISSION_KEYS)
    expect(effectiveAgentPermissions('finance', [])).toEqual([PERMISSIONS.viewFinance])
    expect(membershipGrantsPermission('finance', [], PERMISSIONS.createBooking)).toBe(false)
    expect(membershipGrantsPermission('staff', [], PERMISSIONS.search)).toBe(false)
  })

  it('Given a search-only agent, a booking agent, or conflicting formal roles, When grants are resolved, Then each capability stays independent', () => {
    expect(effectiveAgentPermissions('agent', [PERMISSIONS.search])).toEqual([PERMISSIONS.search])
    expect(effectiveAgentPermissions('agent', [PERMISSIONS.prebook, PERMISSIONS.createBooking, PERMISSIONS.viewBookings, PERMISSIONS.cancelBooking])).toEqual([
      PERMISSIONS.prebook, PERMISSIONS.createBooking, PERMISSIONS.cancelBooking, PERMISSIONS.viewBookings,
    ])
    expect(effectiveAgentPermissions('finance', [PERMISSIONS.search, PERMISSIONS.createBooking])).toEqual([
      PERMISSIONS.search, PERMISSIONS.createBooking, PERMISSIONS.viewFinance,
    ])
    expect(membershipGrantsPermission('finance', [PERMISSIONS.search], PERMISSIONS.prebook)).toBe(false)
    expect(membershipGrantsPermission('owner', [PERMISSIONS.search], PERMISSIONS.cancelBooking)).toBe(true)
  })
})
