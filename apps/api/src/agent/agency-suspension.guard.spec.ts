import { ForbiddenException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ACTIVE_TENANT_REQUEST_KEY } from './tenant-context.guard'
import { AgencySuspensionGuard, AllowWhenAgencySuspended } from './agency-suspension.guard'

class Probe {
  blocked() { return undefined }
  @AllowWhenAgencySuspended() allowed() { return undefined }
}

function ctx(handler: () => unknown, user: unknown = { user: { id: 'u1' }, memberships: [{ tenantId: 't1' }] }): ExecutionContext {
  const request = { user, [ACTIVE_TENANT_REQUEST_KEY]: 't1' }
  return { getHandler: () => handler, getClass: () => Probe, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
}
const prisma = (find: () => Promise<unknown>) => ({ withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn({ agencyMember: { findFirst: find } }) }) as never

describe('AgencySuspensionGuard (ADR 0020)', () => {
  const reflector = new Reflector()
  const probe = new Probe()

  it('blocks a member of a SUSPENDED agency on a handler that did not opt out', async () => {
    const guard = new AgencySuspensionGuard(reflector, prisma(async () => ({ agency: { status: 'SUSPENDED' } })))
    const error = await guard.canActivate(ctx(probe.blocked)).catch((e) => e)
    expect(error).toBeInstanceOf(ForbiddenException)
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'AGENCY_SUSPENDED' })
  })

  it('lets a handler that opted out through, without reading the agency', async () => {
    const find = jest.fn()
    await expect(new AgencySuspensionGuard(reflector, prisma(find)).canActivate(ctx(probe.allowed))).resolves.toBe(true)
    expect(find).not.toHaveBeenCalled()
  })

  it.each([['ACTIVE'], ['INACTIVE']])('lets a member of a %s agency through', async (status) => {
    await expect(new AgencySuspensionGuard(reflector, prisma(async () => ({ agency: { status } }))).canActivate(ctx(probe.blocked))).resolves.toBe(true)
  })

  it('does not affect a user who belongs to no agency', async () => {
    await expect(new AgencySuspensionGuard(reflector, prisma(async () => null)).canActivate(ctx(probe.blocked))).resolves.toBe(true)
  })

  it.each([['denied', Object.assign(new Error('permission denied for table "Agency"'), { meta: { code: '42501' } })], ['failed', new Error('connection lost')]])(
    'fails closed with 503 COMMERCIAL_CONTROL_UNAVAILABLE when the agency tables are %s (ADR 0031), exposing nothing from the database', async (_name, failure) => {
      const guard = new AgencySuspensionGuard(reflector, prisma(async () => { throw failure }))
      const error = await guard.canActivate(ctx(probe.blocked)).catch((e) => e)
      expect(error).toBeInstanceOf(ServiceUnavailableException)
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'COMMERCIAL_CONTROL_UNAVAILABLE' })
      expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toMatch(/Agency|42501|connection/)
    })

  it('refuses a request with no authenticated user', async () => {
    await expect(new AgencySuspensionGuard(reflector, prisma(async () => null)).canActivate(ctx(probe.blocked, null))).rejects.toBeInstanceOf(ForbiddenException)
  })
})
