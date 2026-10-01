import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentRbacGuard } from './rbac.guard';
import { PERMISSIONS } from './supplier.port';
import { ACTIVE_TENANT_REQUEST_KEY } from './tenant-context.guard';
import type { PrismaService } from '../database/prisma.service';

function context(activeTenant = 'tenant-a'): ExecutionContext {
  const request = {
    user: { user: { id: 'user-a' }, memberships: [{ tenantId: 'tenant-a', tenantName: 'Agency', role: 'agent' }] },
    headers: { 'x-fbeds-tenant-id': 'tenant-b' },
    header: () => 'tenant-b',
    [ACTIVE_TENANT_REQUEST_KEY]: activeTenant,
  };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext;
}

describe('AgentRbacGuard', () => {
  const membershipFindUnique = jest.fn();
  const userRoleFindMany = jest.fn();
  const auditCreate = jest.fn().mockResolvedValue(undefined);
  const withTenant = jest.fn(async (_t: string, work: (tx: unknown) => Promise<unknown>) => work({ membership: { findUnique: membershipFindUnique }, userRole: { findMany: userRoleFindMany }, auditEvent: { create: auditCreate } }));
  const reflected = jest.fn();
  const guard = new AgentRbacGuard({ getAllAndOverride: reflected } as unknown as Reflector, { withTenant } as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    membershipFindUnique.mockResolvedValue({ tenantId: 'tenant-a', role: 'agent', tenant: { status: 'ACTIVE' } });
    userRoleFindMany.mockResolvedValue([]);
  });

  it('fails closed when a guarded handler declares no permission', async () => {
    reflected.mockReturnValue(undefined);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an active member who lacks the required permission and audits the denial', async () => {
    reflected.mockReturnValue(PERMISSIONS.auditRead);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
  });

  it('allows a formal role permission for the server tenant and ignores a different header', async () => {
    reflected.mockReturnValue(PERMISSIONS.search);
    userRoleFindMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: PERMISSIONS.search } }] } }]);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(withTenant.mock.calls.every(([tenant]) => tenant === 'tenant-a')).toBe(true);
  });

  it('rejects a client header when the server has not attached a membership tenant', async () => {
    reflected.mockReturnValue(PERMISSIONS.search);
    const request = { user: { user: { id: 'user-a' }, memberships: [{ tenantId: 'tenant-a', tenantName: 'Agency', role: 'agent' }] }, headers: { 'x-fbeds-tenant-id': 'tenant-a' }, header: () => 'tenant-a' };
    const execution = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext;
    await expect(guard.canActivate(execution)).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });
});
