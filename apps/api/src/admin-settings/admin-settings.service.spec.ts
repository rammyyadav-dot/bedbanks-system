import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { AdminSettingsService } from './admin-settings.service'
import type { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import type { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto'

const identity = {
  user: { id: 'user-a', email: 'a@example.test', name: null, status: 'ACTIVE' },
  memberships: [{ tenantId: 'tenant-member', tenantName: 'Member', role: 'member' }, { tenantId: 'tenant-a', tenantName: 'A', role: 'owner' }],
} as unknown as AuthenticatedUser

const body: UpdateTenantSettingsDto = {
  name: ' Acme Travel ', supportEmail: 'ops@acme.test', defaultLanguage: 'en', timeZone: 'Asia/Dubai', defaultCurrency: 'AED',
  lowBalanceThreshold: { amountMinor: '150000', currency: 'AED' },
}

function fixture(overrides: Partial<{ lastIdempotencyKey: string | null; lastMutationFingerprint: string | null }> = {}) {
  let row = {
    id: 'settings-a', tenantId: 'tenant-a', supportEmail: null as string | null, defaultLanguage: 'en', timeZone: 'UTC', defaultCurrency: 'USD',
    lowBalanceThresholdMinor: 0n, lowBalanceCurrency: 'USD', lastIdempotencyKey: null as string | null, lastMutationFingerprint: null as string | null,
    updatedAt: new Date('2026-10-01T00:00:00Z'), tenant: { id: 'tenant-a', name: 'Old', slug: 'acme', status: 'ACTIVE' }, ...overrides,
  }
  const tx = {
    tenant: { update: jest.fn(async ({ data }: { data: { name: string } }) => { row = { ...row, tenant: { ...row.tenant, name: data.name } }; return row.tenant }) },
    tenantSettings: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUniqueOrThrow: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue(undefined) },
  }
  const withTenant = jest.fn(async (_tenantId: string, work: (client: typeof tx) => Promise<unknown>) => work(tx))
  const service = new AdminSettingsService({ withTenant } as unknown as PrismaService)
  return { service, tx, withTenant }
}

describe('AdminSettingsService', () => {
  it('reads settings for the server-selected owner membership and serializes money as strings', async () => {
    const { service, withTenant, tx } = fixture()
    const view = await service.getSettings(identity)
    expect(withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function))
    expect(tx.tenantSettings.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(view).toMatchObject({ tenantId: 'tenant-a', slug: 'acme', lowBalanceThreshold: { amountMinor: '0', currency: 'USD' } })
  })

  it('rejects users without a tenant membership', async () => {
    const { service } = fixture()
    await expect(service.getSettings({ ...identity, memberships: [] } as AuthenticatedUser)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('requires a well-formed idempotency key', async () => {
    const { service, tx } = fixture()
    await expect(service.updateSettings(identity, body, undefined, 'req-1')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.updateSettings(identity, body, 'short', 'req-1')).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.tenantSettings.update).not.toHaveBeenCalled()
  })

  it('rejects fractional or negative minor units', async () => {
    const { service } = fixture()
    for (const amountMinor of ['10.5', '-1', '1e3']) {
      await expect(service.updateSettings(identity, { ...body, lowBalanceThreshold: { amountMinor, currency: 'AED' } }, 'key-12345678', undefined)).rejects.toBeInstanceOf(BadRequestException)
    }
  })

  it('updates settings, writes one audit event and replays the same key without a second write', async () => {
    const { service, tx } = fixture()
    const view = await service.updateSettings(identity, body, 'key-12345678', 'req-1')
    expect(view).toMatchObject({ name: 'Acme Travel', timeZone: 'Asia/Dubai', lowBalanceThreshold: { amountMinor: '150000', currency: 'AED' } })
    expect(tx.tenantSettings.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lowBalanceThresholdMinor: 150000n }) }))
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: 'tenant-a', userId: 'user-a', action: 'settings.updated', entityType: 'tenant_settings',
      payload: expect.objectContaining({ requestId: 'req-1', before: expect.objectContaining({ name: 'Old' }), after: expect.objectContaining({ name: 'Acme Travel' }) }),
    }) })

    await service.updateSettings(identity, body, 'key-12345678', 'req-2')
    expect(tx.tenantSettings.update).toHaveBeenCalledTimes(1)
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1)
  })

  it('returns 409 when a key is reused with a different payload', async () => {
    const { service } = fixture()
    await service.updateSettings(identity, body, 'key-12345678', undefined)
    await expect(service.updateSettings(identity, { ...body, timeZone: 'UTC' }, 'key-12345678', undefined)).rejects.toBeInstanceOf(ConflictException)
  })
})
