import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentRbacGuard } from './rbac.guard';
import { PERMISSIONS } from './supplier.port';
import type { PrismaService } from '../database/prisma.service';

function context(): ExecutionContext {
  const request = { user: { user: { id: 'user-a' } }, header: (name: string) => (name === 'x-fbeds-tenant-id' ? 'tenant-forged' : undefined), activeTenantId: 'tenant-a' };
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
    membershipFindUnique.mockResolvedValue({ role: 'agent', tenant: { status: 'ACTIVE' } });
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
  });

  it('allows a formal role permission', async () => {
    reflected.mockReturnValue(PERMISSIONS.search);
    userRoleFindMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: PERMISSIONS.search } }] } }]);
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('trusts only the guard-validated tenant, never the raw header, and fails closed without it', async () => {
    reflected.mockReturnValue(PERMISSIONS.search);
    userRoleFindMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: PERMISSIONS.search } }] } }]);
    await guard.canActivate(context());
    expect(withTenant.mock.calls.every(([tenant]) => tenant === 'tenant-a')).toBe(true);
    const unvalidated = { user: { user: { id: 'user-a' } }, header: () => 'tenant-forged' };
    const ctx = { switchToHttp: () => ({ getRequest: () => unvalidated }), getHandler: () => undefined, getClass: () => undefined } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
