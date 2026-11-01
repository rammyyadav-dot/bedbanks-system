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
})
