import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { PlatformRbacGuard } from './platform-rbac.guard'
import type { PrismaService } from '../database/prisma.service'
import type { TenantControlDatabase } from './tenant-control.database'

function context(): ExecutionContext {
  const request = { user: { user: { id: 'user-a' }, memberships: [] } }
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext
}

describe('PlatformRbacGuard', () => {
  const findFirst = jest.fn()
  const auditCreate = jest.fn().mockResolvedValue(undefined)
  const withPlatform = jest.fn(async (_u: string, work: (tx: unknown) => Promise<unknown>) => work({ platformRoleAssignment: { findFirst }, auditEvent: { create: auditCreate } }))
  const reflected = jest.fn()
  const guard = new PlatformRbacGuard(
    { getAllAndOverride: reflected } as unknown as Reflector,
    { withPlatform } as unknown as PrismaService,
    { configured: () => false } as unknown as TenantControlDatabase,
  )

  beforeEach(() => jest.clearAllMocks())

  it('fails closed when a guarded handler declares no permission', async () => {
    reflected.mockReturnValue(undefined)
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('denies and audits a caller without an assignment granting the permission', async () => {
    reflected.mockReturnValue('platform.tenants.read')
    findFirst.mockResolvedValue(null)
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException)
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'platform.access.denied', entityId: 'platform.tenants.read' }) }))
  })

  it('allows a caller whose platform role grants the permission', async () => {
    reflected.mockReturnValue('platform.tenants.read')
    findFirst.mockResolvedValue({ roleId: 'role-1' })
    await expect(guard.canActivate(context())).resolves.toBe(true)
  })
})
