import { ConflictException, ForbiddenException } from '@nestjs/common'
import { ApprovalService, approvalTtlMs } from './approval.service'

const HOUR = 3_600_000
type Row = { id: string; tenantId: string; action: string; entityType: string; entityId: string; requestId: string; status: string; requestedById: string; reason: string; beforeState: null; proposedState: null; decidedById: string | null; decidedAt: Date | null; decisionReason: string | null; executedById: string | null; executedAt: Date | null; createdAt: Date }

/** In-memory stand-in for the one Prisma delegate the service uses; it applies the same conditional `where` the real updates rely on. */
function harness(rows: Row[]) {
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = []
  const match = (r: Row, w: Record<string, any>): boolean => Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Array<Record<string, any>>).some((c) => match(r, c))
    const val = (r as any)[k]
    if (v && typeof v === 'object' && 'lt' in v) return val !== null && val < v.lt
    return val === v
  })
  const delegate = {
    findFirst: async ({ where }: any) => { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null },
    findMany: async ({ where, take }: any) => rows.filter((r) => match(r, where)).slice(0, take ?? 1000).map((r) => ({ ...r })), // snapshots, like Prisma
    updateMany: async ({ where, data }: any) => { const hit = rows.filter((r) => match(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length } },
  }
  const prisma = { withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn({ approvalRequest: delegate }) }
  const audit = { record: async (e: { action: string; payload: Record<string, unknown> }) => { audits.push(e) } }
  return { service: new ApprovalService(prisma as never, audit as never), rows, audits }
}
const row = (over: Partial<Row> = {}): Row => ({ id: 'a1', tenantId: 't1', action: 'markup.activate', entityType: 'markup_rule', entityId: 'r1', requestId: 'req-1', status: 'PENDING', requestedById: 'maker', reason: 'because', beforeState: null, proposedState: null, decidedById: null, decidedAt: null, decisionReason: null, executedById: null, executedAt: null, createdAt: new Date(), ...over })

describe('approvalTtlMs', () => {
  it('defaults to 72 hours', () => expect(approvalTtlMs({})).toBe(72 * HOUR))
  it('reads whole hours from APPROVAL_TTL_HOURS', () => expect(approvalTtlMs({ APPROVAL_TTL_HOURS: '24' })).toBe(24 * HOUR))
  it.each(['0', '-5', '1.5', 'abc', '721'])('ignores an invalid value (%s)', (v) => expect(approvalTtlMs({ APPROVAL_TTL_HOURS: v })).toBe(72 * HOUR))
})

describe('ApprovalService separation of duties', () => {
  it('refuses the maker as the checker and audits the attempt with both ids', async () => {
    const h = harness([row()])
    await expect(h.service.decide({ tenantId: 't1', approverId: 'maker', approvalId: 'a1', decision: 'APPROVED', reason: 'ok' })).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.rows[0].status).toBe('PENDING')
    expect(h.audits.map((a) => a.action)).toEqual(['approval.denied'])
  })

  it('lets a different person approve, and records both ids', async () => {
    const h = harness([row()])
    const out = await h.service.decide({ tenantId: 't1', approverId: 'checker', approvalId: 'a1', decision: 'APPROVED', reason: 'ok' })
    expect(out.status).toBe('APPROVED')
    expect(h.audits[0]).toMatchObject({ action: 'approval.approved', payload: { requestedById: 'maker', decidedById: 'checker' } })
  })
})

describe('ApprovalService expiry (ADR 0095)', () => {
  const old = (hours: number) => new Date(Date.now() - hours * HOUR)

  it('expires a PENDING request older than the TTL instead of letting it be decided', async () => {
    const h = harness([row({ createdAt: old(73) })])
    await expect(h.service.decide({ tenantId: 't1', approverId: 'checker', approvalId: 'a1', decision: 'APPROVED', reason: 'ok' })).rejects.toMatchObject({ response: { code: 'APPROVAL_EXPIRED' } })
    expect(h.rows[0].status).toBe('EXPIRED')
    expect(h.audits.find((a) => a.action === 'approval.expired')?.payload).toMatchObject({ previousStatus: 'PENDING', requestedById: 'maker' })
  })

  it('keeps a PENDING request inside the TTL', async () => {
    const h = harness([row({ createdAt: old(71) })])
    expect((await h.service.get('t1', 'a1')).status).toBe('PENDING')
  })

  it('expires an APPROVED request that was not executed within the TTL of its decision, so it cannot run', async () => {
    const h = harness([row({ status: 'APPROVED', decidedById: 'checker', decidedAt: old(80), createdAt: old(90) })])
    await expect(h.service.execute({ tenantId: 't1', executorId: 'maker', approvalId: 'a1', expectedAction: 'markup.activate' }, async () => 'ran')).rejects.toBeInstanceOf(ConflictException)
    expect(h.rows[0].status).toBe('EXPIRED')
    expect(h.audits.some((a) => a.action === 'approval.executed')).toBe(false)
  })

  it('measures an approval from its decision, not from the request', async () => {
    const h = harness([row({ status: 'APPROVED', decidedById: 'checker', decidedAt: old(1), createdAt: old(100) })])
    const out = await h.service.execute({ tenantId: 't1', executorId: 'maker', approvalId: 'a1', expectedAction: 'markup.activate' }, async () => 'ran')
    expect(out.result).toBe('ran')
  })

  it('does not overwrite a request that was decided while the sweep ran', async () => {
    const h = harness([row({ createdAt: old(100), status: 'REJECTED', decidedById: 'checker', decidedAt: new Date() })])
    expect((await h.service.get('t1', 'a1')).status).toBe('REJECTED')
  })

  it('list hides nothing but shows lapsed requests as EXPIRED', async () => {
    const h = harness([row({ createdAt: old(100) })])
    expect((await h.service.list('t1')).map((r) => r.status)).toEqual(['EXPIRED'])
  })
})
