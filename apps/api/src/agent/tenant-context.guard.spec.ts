import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ACTIVE_TENANT_REQUEST_KEY, TenantContextGuard } from './tenant-context.guard';
import type { PrismaService } from '../database/prisma.service';

function context(user: unknown, tenantHeader?: string | string[]): ExecutionContext {
  const headers: Record<string, string | string[] | undefined> = {};
  if (tenantHeader !== undefined) headers['x-fbeds-tenant-id'] = tenantHeader;
  const request: Record<string, unknown> = { user, headers };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const membership = (tenantId: string, role = 'agent') => ({ tenantId, tenantName: 'Agency', role });

describe('TenantContextGuard', () => {
  const findUnique = jest.fn();
  const auditCreate = jest.fn().mockResolvedValue(undefined);
  const withTenant = jest.fn(async (_tenantId: string, work: (tx: unknown) => Promise<unknown>) => work({ membership: { findUnique }, auditEvent: { create: auditCreate } }));
  const guard = new TenantContextGuard({ withTenant } as unknown as PrismaService);
  const identity = { user: { id: 'user-a' }, memberships: [membership('tenant-a')] };

  beforeEach(() => jest.clearAllMocks());

  it('stores the database membership id, not the raw header', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } });
    const execution = context(identity, 'tenant-a');
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    const request = execution.switchToHttp().getRequest<Record<string, unknown>>();
    expect(request[ACTIVE_TENANT_REQUEST_KEY]).toBe('tenant-a');
    expect(findUnique).toHaveBeenCalledWith({ where: { userId_tenantId: { userId: 'user-a', tenantId: 'tenant-a' } }, include: { tenant: true } });
    expect(withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
  });

  it('uses the only session membership when the header is omitted', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } });
    const execution = context(identity);
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(execution.switchToHttp().getRequest<Record<string, string>>()[ACTIVE_TENANT_REQUEST_KEY]).toBe('tenant-a');
  });

  it('rejects a header that is not one of the session memberships without querying that tenant', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-b', tenant: { status: 'ACTIVE' } });
    await expect(guard.canActivate(context(identity, 'tenant-b'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects a repeated tenant header', async () => {
    await expect(guard.canActivate(context(identity, ['tenant-a', 'tenant-b']))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects a padded header that is not the exact membership id', async () => {
    await expect(guard.canActivate(context(identity, ' tenant-a'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('requires an explicit membership when the session has more than one', async () => {
    const multi = { user: { id: 'user-a' }, memberships: [membership('tenant-a'), membership('tenant-b')] };
    await expect(guard.canActivate(context(multi))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects a session with no memberships even when the database would return one', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } });
    await expect(guard.canActivate(context({ user: { id: 'user-a' }, memberships: [] }, 'tenant-a'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects a database row whose tenant id does not match the session membership', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-b', tenant: { status: 'ACTIVE' } });
    await expect(guard.canActivate(context(identity, 'tenant-a'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(withTenant.mock.calls.every(([tenant]) => tenant === 'tenant-a')).toBe(true);
  });

  it('rejects suspended tenant memberships', async () => {
    findUnique.mockResolvedValue({ tenantId: 'tenant-a', tenant: { status: 'SUSPENDED' } });
    await expect(guard.canActivate(context(identity, 'tenant-a'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('agent controller tenant handling', () => {
  it('never reads the raw tenant header in a handler', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'agent.controller.ts'), 'utf8') as string
    expect(source).not.toMatch(/@Headers\(\s*['"]x-fbeds-tenant-id/)
  })
})
