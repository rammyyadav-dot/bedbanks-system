import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { operationsPermissions } from '@bedbanks/contracts'
import { AgentRbacGuard, REQUIRED_PERMISSION } from '../agent/rbac.guard'
import { OperationsController } from './operations.controller'
import { BookingAccessGuard, REQUIRED_BOOKING_ACTION } from '../booking-ops/booking-access.guard'
import { REQUIRED_SUPPLY_PERMISSION, SupplyPermissionGuard } from './supply-permission.guard'

/** The booking list, detail and export (ADR 0039, Phase 6D) resolve operator-level `booking.read` or agency-scoped `booking.view.agency` inside one fail-closed guard. */
const BOOKING_ACCESS_HANDLERS = ['bookings', 'booking', 'exportBookings']

const proto = OperationsController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor' && typeof proto[name] === 'function')
const agentPermissions = new Set<string>(Object.values(operationsPermissions))
const meta = (key: string, name: string) => Reflect.getMetadata(key, proto[name] as object) as string | undefined
const guards = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ?? []) as unknown[]

describe('OperationsController authorization wiring', () => {
  it('has handlers', () => expect(handlers.length).toBeGreaterThan(20))

  it.each(handlers.filter(h => h !== 'capabilities' && !BOOKING_ACCESS_HANDLERS.includes(h)))('%s declares exactly one permission kind and runs the matching fail-closed guard', name => {
    const agent = meta(REQUIRED_PERMISSION, name)
    const supply = meta(REQUIRED_SUPPLY_PERMISSION, name)
    expect([agent, supply].filter(Boolean)).toHaveLength(1)
    if (agent) { expect(agentPermissions.has(agent)).toBe(true); expect(guards(name)).toContain(AgentRbacGuard) }
    if (supply) { expect(supply.startsWith('supply.')).toBe(true); expect(guards(name)).toContain(SupplyPermissionGuard) }
  })

  it.each(BOOKING_ACCESS_HANDLERS)('%s runs the booking access guard, and declares no other permission kind', name => {
    expect(guards(name)).toEqual([BookingAccessGuard])
    expect(meta(REQUIRED_PERMISSION, name)).toBeUndefined()
    expect(meta(REQUIRED_SUPPLY_PERMISSION, name)).toBeUndefined()
  })

  it('the booking export additionally requires a formal export permission (operator or agency), declared on the route', () => {
    expect(Reflect.getMetadata(REQUIRED_BOOKING_ACTION, proto.exportBookings as object)).toEqual(['booking.export', 'booking.export.agency'])
  })

  it('hotel commercial endpoints use only the documented supply.* keys (export added by ADR 0051)', () => {
    const used = new Set(handlers.map(h => meta(REQUIRED_SUPPLY_PERMISSION, h)).filter(Boolean))
    expect([...used].sort()).toEqual(['supply.contracts.read', 'supply.hotels.export', 'supply.hotels.read', 'supply.mappings.read', 'supply.rates.read'])
  })

  it('every handler sits behind session authentication and tenant context at controller level', () => {
    const names = (Reflect.getMetadata(GUARDS_METADATA, OperationsController) as Array<{ name: string }>).map(g => g.name)
    expect(names).toEqual(['SessionAuthGuard', 'TenantContextGuard'])
  })

  it('mutates only through reconciliation handlers, every one requiring booking.reconcile (the direct run, the maker-checker path and the cancellation settlement sweep, ADR 0069)', () => {
    const posts = handlers.filter(h => Reflect.getMetadata('method', proto[h] as object) === 1) // RequestMethod.POST
    expect(posts.sort()).toEqual(['approveReconciliation', 'cancelReconciliationApproval', 'cancellationSettlements', 'executeReconciliationApproval', 'reconcile', 'rejectReconciliation', 'requestReconciliationApproval'])
    for (const h of posts) expect(meta(REQUIRED_PERMISSION, h)).toBe('booking.reconcile')
  })

  it('"hotels/summary" is declared before "hotels/:hotelId" so it is never read as an id', () => {
    expect(handlers.indexOf('hotelsSummary')).toBeLessThan(handlers.indexOf('hotel'))
  })
})
