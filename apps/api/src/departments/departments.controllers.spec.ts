import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { departmentPermissions } from '@bedbanks/contracts'
import { REQUIRED_SUPPLY_PERMISSION, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { AgencyCreditController } from './agency-credit.controller'
import { ClientsController } from './clients.controller'
import { ServiceCasesController } from './service-cases.controller'
import { DistributionController } from './distribution.controller'

const allowed = new Set<string>(Object.values(departmentPermissions))
const suites: Array<[string, new (...a: never[]) => unknown, 'agency' | 'case' | 'distribution']> = [
  ['ClientsController', ClientsController, 'agency'], ['ServiceCasesController', ServiceCasesController, 'case'], ['DistributionController', DistributionController, 'distribution'],
]

describe.each(suites)('%s authorization wiring (ADR 0019)', (_name, Ctrl, domain) => {
  const proto = Ctrl.prototype as unknown as Record<string, unknown>
  const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
  const method = (n: string) => Reflect.getMetadata('method', proto[n] as object) as number // 0 GET, 1 POST, 3 DELETE, 4 PATCH
  const needs = (n: string) => Reflect.getMetadata(REQUIRED_SUPPLY_PERMISSION, proto[n] as object) as string | undefined
  const guards = (n: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[n] as object) ?? []) as unknown[]

  it('has handlers', () => expect(handlers.length).toBeGreaterThan(2))
  it.each(handlers)('%s declares one department permission of its own domain and runs the fail-closed guard', (name) => {
    const key = needs(name)!
    expect(allowed.has(key)).toBe(true)
    expect(key.startsWith(`${domain}.`)).toBe(true)
    expect(guards(name)).toContain(SupplyPermissionGuard)
  })
  it('reads need the read permission and every change needs the manage permission', () => {
    for (const n of handlers) expect(needs(n)).toBe(method(n) === 0 ? `${domain}.read` : `${domain}.manage`)
  })
  it('sits behind session authentication and tenant context', () => {
    const names = (Reflect.getMetadata(GUARDS_METADATA, Ctrl) as Array<{ name: string }>).map((g) => g.name)
    expect(names).toEqual(['SessionAuthGuard', 'TenantContextGuard'])
  })
})

describe('no cross-domain or money authority', () => {
  it('none of the department handlers is named for credit, wallet, refund, price or booking mutation', () => {
    for (const Ctrl of [ClientsController, ServiceCasesController, DistributionController]) {
      const names = Object.getOwnPropertyNames(Ctrl.prototype)
      for (const n of names) expect(n).not.toMatch(/credit|wallet|ledger|refund|price|markup|book|cancel|confirm/i)
    }
  })
})

describe('credit limit authority (ADR 0024)', () => {
  it('lives only in its own controller, and offers exactly request, approve, reject, withdraw and execute', () => {
    const handlers = Object.getOwnPropertyNames(AgencyCreditController.prototype).filter((n) => n !== 'constructor').sort()
    expect(handlers).toEqual(['approveCredit', 'executeCredit', 'rejectCredit', 'requestCredit', 'withdrawCredit'])
  })
})
