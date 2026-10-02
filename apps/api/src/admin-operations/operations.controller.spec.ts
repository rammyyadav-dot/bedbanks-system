import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { operationsPermissions } from '@bedbanks/contracts'
import { AgentRbacGuard, REQUIRED_PERMISSION } from '../agent/rbac.guard'
import { OperationsController } from './operations.controller'
import { REQUIRED_SUPPLY_PERMISSION, SupplyPermissionGuard } from './supply-permission.guard'

const proto = OperationsController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor' && typeof proto[name] === 'function')
const agentPermissions = new Set<string>(Object.values(operationsPermissions))
const meta = (key: string, name: string) => Reflect.getMetadata(key, proto[name] as object) as string | undefined
const guards = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ?? []) as unknown[]

describe('OperationsController authorization wiring', () => {
  it('has handlers', () => expect(handlers.length).toBeGreaterThan(20))

  it.each(handlers.filter(h => h !== 'capabilities'))('%s declares exactly one permission kind and runs the matching fail-closed guard', name => {
    const agent = meta(REQUIRED_PERMISSION, name)
    const supply = meta(REQUIRED_SUPPLY_PERMISSION, name)
    expect([agent, supply].filter(Boolean)).toHaveLength(1)
    if (agent) { expect(agentPermissions.has(agent)).toBe(true); expect(guards(name)).toContain(AgentRbacGuard) }
    if (supply) { expect(supply.startsWith('supply.')).toBe(true); expect(guards(name)).toContain(SupplyPermissionGuard) }
  })

  it('hotel commercial endpoints use only existing supply.* keys (no new permission names)', () => {
    const used = new Set(handlers.map(h => meta(REQUIRED_SUPPLY_PERMISSION, h)).filter(Boolean))
    expect([...used].sort()).toEqual(['supply.contracts.read', 'supply.hotels.read', 'supply.mappings.read', 'supply.rates.read'])
  })

  it('every handler sits behind session authentication and tenant context at controller level', () => {
    const names = (Reflect.getMetadata(GUARDS_METADATA, OperationsController) as Array<{ name: string }>).map(g => g.name)
    expect(names).toEqual(['SessionAuthGuard', 'TenantContextGuard'])
  })

  it('mutates only through reconciliation handlers, every one requiring booking.reconcile (the direct run plus the maker-checker path)', () => {
    const posts = handlers.filter(h => Reflect.getMetadata('method', proto[h] as object) === 1) // RequestMethod.POST
    expect(posts.sort()).toEqual(['approveReconciliation', 'cancelReconciliationApproval', 'executeReconciliationApproval', 'reconcile', 'rejectReconciliation', 'requestReconciliationApproval'])
    for (const h of posts) expect(meta(REQUIRED_PERMISSION, h)).toBe('booking.reconcile')
  })

  it('"hotels/summary" is declared before "hotels/:hotelId" so it is never read as an id', () => {
    expect(handlers.indexOf('hotelsSummary')).toBeLessThan(handlers.indexOf('hotel'))
  })
})
