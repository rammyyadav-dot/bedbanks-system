import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { ApprovalService } from '../src/approvals/approval.service'

describe('maker-checker approval foundation (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const approvals = new ApprovalService(prisma, new AgentAuditService(prisma))
  const suffix = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let tenantA: string, tenantB: string, maker: string, checker: string, outsider: string
  let seq = 0
  const base = () => ({ tenantId: tenantA, requesterId: maker, action: 'refund.approve', entityType: 'refund', entityId: 'refund-1', requestId: `${suffix}-${++seq}`, reason: 'Duplicate charge' })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    maker = (await prisma.user.create({ data: { email: `maker-${suffix}@example.test` } })).id
    checker = (await prisma.user.create({ data: { email: `checker-${suffix}@example.test` } })).id
    outsider = (await prisma.user.create({ data: { email: `outsider-${suffix}@example.test` } })).id
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.user.deleteMany({ where: { id: { in: [maker, checker, outsider] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  const auditActions = async (entityId: string) => (await prisma.auditEvent.findMany({ where: { entityType: 'approval_request', entityId }, orderBy: { createdAt: 'asc' } })).map((e) => e.action)

  it('records a pending request with its audit event', async () => {
    const r = await approvals.request({ ...base(), beforeState: { limitMinor: 500000, currency: 'AED' }, proposedState: { limitMinor: 750000, currency: 'AED' } })
    expect(r).toMatchObject({ status: 'PENDING', requestedById: maker, decidedById: null, action: 'refund.approve' })
    expect(r.proposedState).toEqual({ limitMinor: 750000, currency: 'AED' })
    expect(await auditActions(r.id)).toEqual(['approval.requested'])
  })

  it('is idempotent for the same key and refuses a conflicting reuse', async () => {
    const input = base()
    const first = await approvals.request(input)
    expect((await approvals.request(input)).id).toBe(first.id)
    expect(await prisma.approvalRequest.count({ where: { tenantId: tenantA, requestId: input.requestId } })).toBe(1)
    await expect(approvals.request({ ...input, entityId: 'refund-2' })).rejects.toBeInstanceOf(ConflictException)
    await expect(approvals.request({ ...input, requesterId: checker })).rejects.toBeInstanceOf(ConflictException)
  })

  it('only accepts catalogued sensitive actions', async () => {
    await expect(approvals.request({ ...base(), action: 'hotel.read' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(approvals.request({ ...base(), action: 'supply.hotels.read' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(approvals.request({ ...base(), action: 'not.a.permission' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(approvals.request({ ...base(), action: 'inventory.held.update' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(approvals.request({ ...base(), reason: '   ' })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects fractional money, redacts sensitive keys and refuses oversized state', async () => {
    await expect(approvals.request({ ...base(), proposedState: { amount: 12.5 } })).rejects.toBeInstanceOf(BadRequestException)
    const r = await approvals.request({ ...base(), proposedState: { amountMinor: 1250, email: 'guest@example.com', apiKey: 'k' } })
    expect(r.proposedState).toEqual({ amountMinor: 1250, email: '[REDACTED]', apiKey: '[REDACTED]' })
    await expect(approvals.request({ ...base(), proposedState: { note: 'x'.repeat(5000) } })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('lets a different user approve, once, with audit', async () => {
    const r = await approvals.request(base())
    const approved = await approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: r.id, decision: 'APPROVED', reason: 'Verified with ledger' })
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: checker, decisionReason: 'Verified with ledger' })
    expect(approved.decidedAt).toBeInstanceOf(Date)
    expect(await auditActions(r.id)).toEqual(['approval.requested', 'approval.approved'])
    // the same decision by the same checker is a safe retry, not a second audit event
    expect((await approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: r.id, decision: 'APPROVED', reason: 'again' })).id).toBe(r.id)
    expect(await auditActions(r.id)).toEqual(['approval.requested', 'approval.approved'])
    // a decided request cannot be flipped
    await expect(approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: r.id, decision: 'REJECTED', reason: 'changed mind' })).rejects.toBeInstanceOf(ConflictException)
    await expect(approvals.decide({ tenantId: tenantA, approverId: outsider, approvalId: r.id, decision: 'APPROVED', reason: 'me too' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('denies self-approval, audits the denial and leaves the request pending', async () => {
    const r = await approvals.request(base())
    await expect(approvals.decide({ tenantId: tenantA, approverId: maker, approvalId: r.id, decision: 'APPROVED', reason: 'self' })).rejects.toBeInstanceOf(ForbiddenException)
    expect((await approvals.get(tenantA, r.id)).status).toBe('PENDING')
    expect(await auditActions(r.id)).toEqual(['approval.requested', 'approval.denied'])
  })

  it('exactly one of two concurrent decisions wins', async () => {
    const r = await approvals.request(base())
    const results = await Promise.allSettled([
      approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: r.id, decision: 'APPROVED', reason: 'ok' }),
      approvals.decide({ tenantId: tenantA, approverId: outsider, approvalId: r.id, decision: 'REJECTED', reason: 'no' }),
    ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1)
    const final = await approvals.get(tenantA, r.id)
    expect(['APPROVED', 'REJECTED']).toContain(final.status)
    expect((await auditActions(r.id)).filter((a) => a === 'approval.approved' || a === 'approval.rejected')).toHaveLength(1)
  })

  it('lets only the maker cancel a pending request', async () => {
    const r = await approvals.request(base())
    await expect(approvals.cancel({ tenantId: tenantA, requesterId: checker, approvalId: r.id })).rejects.toBeInstanceOf(ForbiddenException)
    expect((await approvals.cancel({ tenantId: tenantA, requesterId: maker, approvalId: r.id })).status).toBe('CANCELLED')
    await expect(approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: r.id, decision: 'APPROVED', reason: 'late' })).rejects.toBeInstanceOf(ConflictException)
    const decided = await approvals.request(base())
    await approvals.decide({ tenantId: tenantA, approverId: checker, approvalId: decided.id, decision: 'REJECTED', reason: 'no' })
    await expect(approvals.cancel({ tenantId: tenantA, requesterId: maker, approvalId: decided.id })).rejects.toBeInstanceOf(ConflictException)
  })

  it('isolates tenants: another tenant cannot read, decide or list a request', async () => {
    const r = await approvals.request(base())
    await expect(approvals.get(tenantB, r.id)).rejects.toBeInstanceOf(NotFoundException)
    await expect(approvals.decide({ tenantId: tenantB, approverId: checker, approvalId: r.id, decision: 'APPROVED', reason: 'x' })).rejects.toBeInstanceOf(NotFoundException)
    expect((await approvals.list(tenantB)).map((x) => x.id)).not.toContain(r.id)
    expect((await approvals.list(tenantA, { status: 'PENDING', entityType: 'refund' })).map((x) => x.id)).toContain(r.id)
    // the same idempotency key is independent per tenant
    const other = await approvals.request({ ...base(), tenantId: tenantB, requestId: r.requestId })
    expect(other.id).not.toBe(r.id)
  })

  it('the database itself refuses self-approval and incomplete decisions', async () => {
    const r = await approvals.request(base())
    await expect(prisma.$executeRaw`UPDATE "ApprovalRequest" SET status = 'APPROVED', decided_by_id = requested_by_id, decided_at = now() WHERE id = ${r.id}`).rejects.toThrow(/separation_of_duties/)
    await expect(prisma.$executeRaw`UPDATE "ApprovalRequest" SET status = 'APPROVED' WHERE id = ${r.id}`).rejects.toThrow(/decision_complete/)
    expect((await approvals.get(tenantA, r.id)).status).toBe('PENDING')
  })
})
