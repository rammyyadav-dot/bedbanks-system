import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { SupplyService } from './supply.service'

const at = new Date('2030-01-01T10:00:00.000Z')
const future = (n: number) => new Date(Date.UTC(2099, 0, n))
const planRow = (extra: Record<string, unknown> = {}) => ({
  id: 'plan', tenantId: 'tenant', status: 'DRAFT', currency: 'AED', occupancy: 2, refundable: true, minStay: 1, maxStay: null, inventoryPoolId: null, cancellationPolicySet: null, guestPrices: [], promotions: [], derivedProblem: null, derivedFromId: null, derivedMode: null, derivedAdjustment: null, derivedFrom: null, updatedAt: at,
  contractId: 'contract', roomTypeId: 'room', boardBasisId: 'board', taxesIncluded: false, feesIncluded: false, releaseDays: 0, releaseTimeLocal: '00:00',
  roomType: { hotelId: 'h1', maxOccupancy: 3, isActive: true, hotel: { id: 'h1', timeZone: 'Asia/Dubai' } },
  boardBasis: { isActive: true },
  contract: { status: 'ACTIVE', validFrom: new Date('2020-01-01'), validTo: new Date('2100-12-31'), settlementCurrency: 'AED', supplierHotelMapping: { hotelId: 'h1' }, cancellationPolicies: [{ policySet: null }] },
  ...extra,
})
function setup(plan: Record<string, unknown> = planRow(), perms = ['supply.rates.manage', 'supply.rates.read']) {
  const rates = [1, 2, 3].map(n => ({ stayDate: future(n), amountBasis: 'NET', currency: 'AED', amountMinor: 45000n }))
  const tx = {
    userRole: { findMany: jest.fn().mockResolvedValue([{ role: { permissions: perms.map(key => ({ permission: { key } })) } }]) },
    ratePlan: { findFirst: jest.fn().mockResolvedValue(plan), findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'plan', status: 'ACTIVE' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'clone', ...data })) },
    dailyRate: { findMany: jest.fn().mockResolvedValue(rates) },
    dailyAvailability: { findMany: jest.fn().mockResolvedValue([{ stayDate: future(1) }]) },
    roomType: { findFirst: jest.fn().mockResolvedValue({ id: 'room', hotelId: 'h1', maxOccupancy: 3 }) },
    contract: { findFirst: jest.fn().mockResolvedValue({ id: 'contract' }) },
    auditEvent: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  const audit = { record: jest.fn().mockResolvedValue(undefined) }
  const service = new SupplyService({ withTenant: jest.fn(async (_t, work) => work(tx)) } as never, audit as never)
  return { tx, service, audit }
}

describe('rate plan readiness and lifecycle', () => {
  it('reports a ready plan with its version', async () => {
    const { service } = setup()
    expect(await service.ratePlanReadiness('tenant', 'user', 'plan')).toMatchObject({ ready: true, status: 'DRAFT', updatedAt: at.toISOString() })
  })

  it('reads rates only for the plan occupancy and tenant', async () => {
    const { service, tx } = setup()
    await service.ratePlanReadiness('tenant', 'user', 'plan')
    expect(tx.dailyRate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant', ratePlanId: 'plan', occupancy: 2 }) }))
    expect(tx.ratePlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'plan', tenantId: 'tenant' } }))
  })

  it('does not reveal another tenant plan', async () => {
    const { service } = setup(null as never)
    await expect(service.ratePlanReadiness('tenant', 'user', 'other')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('activates a ready plan with a version-checked write and a before/after audit event', async () => {
    const { service, tx } = setup()
    await service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() }, 'req-1')
    expect(tx.ratePlan.updateMany).toHaveBeenCalledWith({ where: { id: 'plan', tenantId: 'tenant', status: 'DRAFT', updatedAt: at }, data: { status: 'ACTIVE' } })
    expect(tx.auditEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ action: 'supply.rate_plan.status_changed', payload: expect.objectContaining({ requestId: 'req-1', before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } }) })] })
  })

  it('refuses activation when a check fails and writes nothing', async () => {
    const { service, tx } = setup(planRow({ contract: { ...planRow().contract, status: 'DRAFT' } }))
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_NOT_READY', details: [expect.objectContaining({ code: 'CONTRACT_ACTIVE' })] } })
    expect(tx.ratePlan.updateMany).not.toHaveBeenCalled()
    expect(tx.auditEvent.createMany).not.toHaveBeenCalled()
  })

  it('rejects a stale version without writing', async () => {
    const { service, tx } = setup()
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: '2029-01-01T00:00:00.000Z' })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_CHANGED' } })
    expect(tx.ratePlan.updateMany).not.toHaveBeenCalled()
  })

  it('maps a lost race on the conditional update to a conflict', async () => {
    const { service, tx } = setup(); tx.ratePlan.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toBeInstanceOf(ConflictException)
    expect(tx.auditEvent.createMany).not.toHaveBeenCalled()
  })

  it('requires a version and, for suspension, a reason', async () => {
    const { service } = setup(planRow({ status: 'ACTIVE' }))
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', {})).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'suspend', { expectedUpdatedAt: at.toISOString() })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('suspends an active plan with the reason in the audit event', async () => {
    const { service, tx } = setup(planRow({ status: 'ACTIVE' }))
    await service.transitionRatePlan('tenant', 'user', 'plan', 'suspend', { expectedUpdatedAt: at.toISOString(), reason: 'Contract renegotiation' })
    expect(tx.ratePlan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUSPENDED' } }))
    expect(tx.auditEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ payload: expect.objectContaining({ reason: 'Contract renegotiation', after: { status: 'SUSPENDED' } }) })] })
  })

  it('never reactivates an expired plan', async () => {
    const { service, tx } = setup(planRow({ status: 'EXPIRED' }))
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_TRANSITION_NOT_ALLOWED' } })
    expect(tx.ratePlan.updateMany).not.toHaveBeenCalled()
  })

  it('requires the manage permission to change status', async () => {
    const { service, tx, audit } = setup(planRow(), ['supply.rates.read'])
    await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toBeInstanceOf(ForbiddenException)
    expect(tx.ratePlan.updateMany).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'permission.denied' }))
  })
})

describe('rate plan clone', () => {
  it('creates a DRAFT with the new code and no rates or pool', async () => {
    const { service, tx } = setup(planRow({ status: 'ACTIVE', inventoryPoolId: 'pool' }))
    tx.ratePlan.findFirst.mockResolvedValueOnce(planRow({ status: 'ACTIVE', inventoryPoolId: 'pool' })).mockResolvedValueOnce(null)
    await service.cloneRatePlan('tenant', 'user', 'plan', { code: 'FLEX-BB' })
    const data = tx.ratePlan.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ tenantId: 'tenant', code: 'FLEX-BB', status: 'DRAFT', contractId: 'contract' })
    expect(data).not.toHaveProperty('inventoryPoolId')
  })

  it('rejects a duplicate code on the same contract', async () => {
    const { service, tx } = setup()
    tx.ratePlan.findFirst.mockResolvedValueOnce(planRow()).mockResolvedValueOnce({ id: 'existing' })
    await expect(service.cloneRatePlan('tenant', 'user', 'plan', { code: 'DUP-1' })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_CODE_EXISTS' } })
    expect(tx.ratePlan.create).not.toHaveBeenCalled()
  })

  it('rejects an invalid code, another hotel room, and an over-capacity room', async () => {
    const { service, tx } = setup()
    await expect(service.cloneRatePlan('tenant', 'user', 'plan', { code: ' ' })).rejects.toBeInstanceOf(BadRequestException)
    tx.roomType.findFirst.mockResolvedValueOnce({ id: 'room', hotelId: 'h1', maxOccupancy: 3 }).mockResolvedValueOnce({ id: 'r2', hotelId: 'h2', maxOccupancy: 3 })
    await expect(service.cloneRatePlan('tenant', 'user', 'plan', { code: 'OK-1', roomTypeId: 'r2' })).rejects.toBeInstanceOf(BadRequestException)
    tx.roomType.findFirst.mockResolvedValueOnce({ id: 'room', hotelId: 'h1', maxOccupancy: 3 }).mockResolvedValueOnce({ id: 'r3', hotelId: 'h1', maxOccupancy: 1 })
    await expect(service.cloneRatePlan('tenant', 'user', 'plan', { code: 'OK-2', roomTypeId: 'r3' })).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.ratePlan.create).not.toHaveBeenCalled()
  })

  describe('activation approval required (ADR 0057, S5)', () => {
    const withMode = async (mode: string | undefined, run: () => Promise<void>) => {
      const previous = process.env.RATE_PLAN_ACTIVATION_APPROVAL
      if (mode === undefined) delete process.env.RATE_PLAN_ACTIVATION_APPROVAL; else process.env.RATE_PLAN_ACTIVATION_APPROVAL = mode
      try { await run() } finally { if (previous === undefined) delete process.env.RATE_PLAN_ACTIVATION_APPROVAL; else process.env.RATE_PLAN_ACTIVATION_APPROVAL = previous }
    }
    it('refuses a direct activation with a typed 409 and writes nothing, by default', async () => {
      await withMode(undefined, async () => {
        const { service, tx } = setup()
        await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_APPROVAL_REQUIRED' } })
        expect(tx.ratePlan.updateMany).not.toHaveBeenCalled()
        expect(tx.auditEvent.createMany).not.toHaveBeenCalled()
      })
    })
    it('checks permission first: an unauthorised caller gets 403, not the policy message', async () => {
      await withMode('required', async () => {
        const { service } = setup(planRow(), ['supply.rates.read'])
        await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toBeInstanceOf(ForbiddenException)
      })
    })
    it('a misspelt value fails closed to required', async () => {
      await withMode('disabled', async () => {
        const { service } = setup()
        await expect(service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() })).rejects.toMatchObject({ response: { code: 'RATE_PLAN_APPROVAL_REQUIRED' } })
      })
    })
    it('suspension stays single-actor', async () => {
      await withMode('required', async () => {
        const { service, tx } = setup(planRow({ status: 'ACTIVE' }))
        await service.transitionRatePlan('tenant', 'user', 'plan', 'suspend', { expectedUpdatedAt: at.toISOString(), reason: 'supplier request' })
        expect(tx.ratePlan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUSPENDED' } }))
      })
    })
    it('off activates directly and the audit event records that no approval was involved', async () => {
      await withMode('off', async () => {
        const { service, tx } = setup()
        await service.transitionRatePlan('tenant', 'user', 'plan', 'activate', { expectedUpdatedAt: at.toISOString() }, 'req-1')
        expect(tx.auditEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ payload: expect.objectContaining({ activation: { mode: 'off' } }) })] })
      })
    })
  })
})
