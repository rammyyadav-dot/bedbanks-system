import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { TenantContextGuard } from './tenant-context.guard';
import type { PrismaService } from '../database/prisma.service';

function context(user: unknown, tenantId?: string): ExecutionContext {
  const request = { user, header: jest.fn((name: string) => name === 'x-fbeds-tenant-id' ? tenantId : undefined) };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('TenantContextGuard', () => {
  const findUnique = jest.fn();
  const guard = new TenantContextGuard({ membership: { findUnique } } as unknown as PrismaService);
  const identity = { user: { id: 'user-a' }, memberships: [] };

  beforeEach(() => jest.clearAllMocks());

  it('allows an active membership and attaches only the validated tenant', async () => {
    findUnique.mockResolvedValue({ tenant: { status: 'ACTIVE' } });
    const execution = context(identity, 'tenant-a');
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { userId_tenantId: { userId: 'user-a', tenantId: 'tenant-a' } }, include: { tenant: true } });
  });

  it('rejects a cross-tenant header without a membership', async () => {
    findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(context(identity, 'tenant-b'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects suspended tenant memberships', async () => {
    findUnique.mockResolvedValue({ tenant: { status: 'SUSPENDED' } });
    await expect(guard.canActivate(context(identity, 'tenant-a'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
