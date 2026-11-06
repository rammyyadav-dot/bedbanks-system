import { ForbiddenException } from '@nestjs/common'
import type { Request } from 'express'
import { AgentController } from './agent.controller'
import { portalCertification } from './portal-certification'
import type { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'

const API = 'postgresql://fbeds_api_login:secret@127.0.0.1:5432/app'
const BOOK = 'postgresql://fbeds_booktx_ops:secret@127.0.0.1:5432/app'

describe('portal certification', () => {
  const previous = {
    BOOKING_ENABLED: process.env.BOOKING_ENABLED,
    BOOKING_SERVICING_ENABLED: process.env.BOOKING_SERVICING_ENABLED,
    BOOKING_TRANSACTION_DATABASE_URL: process.env.BOOKING_TRANSACTION_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    FUNDING_ENABLED: process.env.FUNDING_ENABLED,
  }
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('opens sales only when booking is enabled and the transaction credential is distinct', () => {
    process.env.DATABASE_URL = API
    delete process.env.BOOKING_SERVICING_ENABLED
    delete process.env.FUNDING_ENABLED
    delete process.env.BOOKING_ENABLED
    delete process.env.BOOKING_TRANSACTION_DATABASE_URL
    expect(portalCertification()).toEqual({ bookingEnabled: false, bookingServicingEnabled: false, fundingEnabled: false })
    process.env.BOOKING_ENABLED = 'true'
    expect(portalCertification().bookingEnabled).toBe(false)
    process.env.BOOKING_TRANSACTION_DATABASE_URL = API
    expect(portalCertification().bookingEnabled).toBe(false)
    process.env.BOOKING_TRANSACTION_DATABASE_URL = BOOK
    expect(portalCertification()).toMatchObject({ bookingEnabled: true, bookingServicingEnabled: true, fundingEnabled: false })
  })

  it('lets servicing open without opening new sales, and never through a lookalike flag', () => {
    process.env.DATABASE_URL = API
    process.env.BOOKING_TRANSACTION_DATABASE_URL = BOOK
    delete process.env.BOOKING_ENABLED
    process.env.BOOKING_SERVICING_ENABLED = 'yes'
    expect(portalCertification()).toMatchObject({ bookingEnabled: false, bookingServicingEnabled: false })
    process.env.BOOKING_SERVICING_ENABLED = 'true'
    expect(portalCertification()).toMatchObject({ bookingEnabled: false, bookingServicingEnabled: true })
    delete process.env.BOOKING_TRANSACTION_DATABASE_URL
    expect(portalCertification().bookingServicingEnabled).toBe(false)
  })

  it('opens funding declarations only for the exact string true', () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.FUNDING_ENABLED
      else process.env.FUNDING_ENABLED = value
      expect(portalCertification().fundingEnabled).toBe(false)
    }
    process.env.FUNDING_ENABLED = 'true'
    expect(portalCertification().fundingEnabled).toBe(true)
  })
})

describe('agent context isolation', () => {
  const user = { id: 'user-a', email: 'a@example.test', name: null, status: 'ACTIVE' as const }
  const identity = { user, memberships: [{ tenantId: 'tenant-a', tenantName: 'Agency', role: 'agent' }] }
  const findUnique = jest.fn()
  const findMany = jest.fn()
  const auditCreate = jest.fn().mockResolvedValue(undefined)
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, work: (tx: unknown) => Promise<unknown>) => work({
      membership: { findUnique },
      userRole: { findMany },
      auditEvent: { create: auditCreate },
    })),
  } as unknown as PrismaService
  const controller = new AgentController(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, prisma, {} as never,
  )

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.BOOKING_ENABLED
    delete process.env.BOOKING_SERVICING_ENABLED
    delete process.env.FUNDING_ENABLED
    delete process.env.BOOKING_TRANSACTION_DATABASE_URL
  })

  it('names no tenant and returns no capabilities until a membership is selected', async () => {
    const body = await controller.context(identity, { headers: {} } as Request)
    expect(body).toMatchObject({ capabilities: [], capabilityTenantId: '', bookingEnabled: false, user })
    expect(prisma.withTenant).not.toHaveBeenCalled()
  })

  it('returns only the selected tenant grants, and hides actions the routes would refuse', async () => {
    findUnique.mockResolvedValue({ role: 'agent', revokedAt: null, tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } })
    findMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: 'hotel.search' } }, { permission: { key: 'booking.prebook' } }, { permission: { key: 'supply.hotels.manage' } }] } }])
    process.env.BOOKING_ENABLED = 'true'
    const body = await controller.context(identity, { headers: { 'x-fbeds-tenant-id': 'tenant-a' } } as unknown as Request)
    expect(body.capabilityTenantId).toBe('tenant-a')
    expect(body.capabilities).toEqual(['hotel.search', 'booking.prebook'])
    expect(body.bookingEnabled).toBe(false)
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function))
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a', tenantId: 'tenant-a', role: { tenantId: 'tenant-a' } } }))
  })

  it('refuses a revoked membership and a tenant the session does not belong to', async () => {
    findUnique.mockResolvedValue({ role: 'owner', revokedAt: new Date(), tenantId: 'tenant-a', tenant: { status: 'ACTIVE' } })
    await expect(controller.context(identity, { headers: { 'x-fbeds-tenant-id': 'tenant-a' } } as unknown as Request)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(controller.context(identity as AuthenticatedUser, { headers: { 'x-fbeds-tenant-id': 'tenant-b' } } as unknown as Request)).rejects.toBeInstanceOf(ForbiddenException)
    expect(findMany).not.toHaveBeenCalled()
  })
})
