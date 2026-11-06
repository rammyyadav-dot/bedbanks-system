import { LedgerAdjustmentService } from './ledger-adjustment.service'

/**
 * Refusal audits are written after the money transaction rolls back (ADR 0113).
 * The happy path, caps and database guards are covered by ledger-adjustments.e2e-spec.ts.
 */
describe('LedgerAdjustmentService audit of refusals', () => {
  const original = process.env.LEDGER_ADJUSTMENTS_ENABLED
  beforeAll(() => { process.env.LEDGER_ADJUSTMENTS_ENABLED = 'true' })
  afterAll(() => { if (original === undefined) delete process.env.LEDGER_ADJUSTMENTS_ENABLED; else process.env.LEDGER_ADJUSTMENTS_ENABLED = original })

  const proposed = {
    id: 'adj_1', tenantId: 'ten_1', status: 'PROPOSED', proposedById: 'alice', kind: 'ADJUSTMENT', agencyId: 'agy_1', currency: 'AED',
    amountMinor: -2500n, reason: 'BANK_FEE', note: 'Incoming transfer fee', fundingReceiptId: null, walletId: 'wal_1', requestId: 'req-adjust-1',
    createdAt: new Date('2026-11-01T00:00:00.000Z'), decidedById: null, decidedAt: null, decisionReason: null, ledgerEntryId: null,
  }

  function setup() {
    const audits: Array<Record<string, unknown>> = []
    const tx = {
      ledgerAdjustment: { findFirst: jest.fn().mockResolvedValue(proposed) },
      auditEvent: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data }) },
    }
    const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (client: { ledgerAdjustment: typeof tx.ledgerAdjustment; auditEvent: typeof tx.auditEvent }) => Promise<unknown>) => fn(tx)) }
    return { service: new LedgerAdjustmentService(prisma as never), audits, tx }
  }

  it('records a self-approval after the deciding transaction rolls back, and posts nothing', async () => {
    const { service, audits, tx } = setup()
    await expect(service.approve('ten_1', 'alice', 'adj_1')).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_OWN_PROPOSAL' } })
    expect(tx.ledgerAdjustment.findFirst).toHaveBeenCalled()
    expect(audits).toEqual([expect.objectContaining({
      action: 'approval.denied', entityType: 'ledger_adjustment', entityId: 'adj_1', userId: 'alice',
      payload: expect.objectContaining({ outcome: 'denied', reason: 'SELF_APPROVAL', approvalAction: 'finance.adjustment.approve', kind: 'ADJUSTMENT', direction: 'DEBIT', amountMinor: '2500', currency: 'AED' }),
    })])
  })

  it('records a replay of the same proposal and does not insert a second row', async () => {
    const { service, audits, tx } = setup()
    tx.ledgerAdjustment.findFirst.mockResolvedValue({ ...proposed, agency: { name: 'Northwind' } })
    const body = { requestId: 'req-adjust-1', kind: 'ADJUSTMENT', agencyId: 'agy_1', currency: 'AED', direction: 'DEBIT', amountMinor: '2500', reason: 'BANK_FEE', note: 'Incoming transfer fee' }
    const view = await service.propose('ten_1', 'alice', body)
    expect(view.id).toBe('adj_1')
    expect(audits.map((a) => a.action)).toEqual(['finance.ledger_adjustment.replayed'])
    expect(audits[0].payload).toMatchObject({ outcome: 'replayed', requestId: 'req-adjust-1', amountMinor: '2500' })
  })

  it('records a requestId reused for a different amount against the original adjustment', async () => {
    const { service, audits, tx } = setup()
    tx.ledgerAdjustment.findFirst.mockResolvedValue({ ...proposed, agency: { name: 'Northwind' } })
    const body = { requestId: 'req-adjust-1', kind: 'ADJUSTMENT', agencyId: 'agy_1', currency: 'AED', direction: 'DEBIT', amountMinor: '2600', reason: 'BANK_FEE', note: 'Incoming transfer fee' }
    await expect(service.propose('ten_1', 'alice', body)).rejects.toMatchObject({ response: { code: 'LEDGER_ADJUSTMENT_REQUEST_REUSED' } })
    expect(audits.map((a) => a.action)).toEqual(['finance.ledger_adjustment.denied'])
    expect(audits[0].payload).toMatchObject({ code: 'LEDGER_ADJUSTMENT_REQUEST_REUSED', outcome: 'denied', amountMinor: '2600' })
  })
})
