import type { Prisma } from '@prisma/client'
import { normaliseReference, type LedgerItemInput } from '@bedbanks/money'

/** A supplier-month this large is not a statement; the run fails with a stable code rather than loading it. */
export const MAX_LEDGER_SCOPE = 20_000

export class ScopeTooLargeError extends Error {
  constructor() { super('SCOPE_TOO_LARGE'); this.name = 'ScopeTooLargeError' }
}

export interface LedgerScope {
  items: LedgerItemInput[]
  /** Bookings whose check-out falls inside the statement period: the population the supplier is expected to invoice. */
  inPeriod: ReadonlySet<string>
}

const caseVariants = (references: readonly string[]) => [...new Set(references.flatMap((r) => [r, r.toUpperCase(), r.toLowerCase()]))]
/** PostgreSQL allows 32,767 bind parameters per statement. A 5,000-line statement would bind about 30,000 in one IN list, so lookups run in chunks. */
const CHUNK = 400
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK))

/**
 * The booking-level ledger items of one supplier for one statement (ADR 0070): bookings with check-out inside the statement period, plus any booking the
 * statement quotes by reference (so a line for a stay outside the period still matches). Payable states are CONFIRMED and CHECKED_OUT (the same set as the
 * payables accrual view); CANCELLED bookings carry the credit expectation. Bookings with no supplier organization (connector and manual bookings) are out of scope.
 *
 * The expected supplier credit of a cancelled booking is derived only when its CANCELLED finance event records a zero penalty and the net is known: then the
 * whole net is expected back. Any penalty means the supplier-side amount is not recorded, so the expectation stays unknown (null), never an assumption.
 */
export async function loadLedgerScope(tx: Prisma.TransactionClient, a: {
  tenantId: string; supplierId: string; statementId: string; periodStart: Date; periodEnd: Date; references: readonly string[]
}): Promise<LedgerScope> {
  const select = { id: true, reference: true, supplierRef: true, currency: true, netMinor: true, status: true, checkOut: true, createdAt: true } as const
  const base = { tenantId: a.tenantId, supplierId: a.supplierId, status: { in: ['CONFIRMED', 'CHECKED_OUT', 'CANCELLED'] as Array<'CONFIRMED' | 'CHECKED_OUT' | 'CANCELLED'> } }
  type Row = Prisma.BookingGetPayload<{ select: typeof select }>
  const found = new Map<string, Row>()
  const remember = (rows: Row[]) => { for (const row of rows) found.set(row.id, row); if (found.size > MAX_LEDGER_SCOPE) throw new ScopeTooLargeError() }
  remember(await tx.booking.findMany({ where: { ...base, checkOut: { gte: a.periodStart, lte: a.periodEnd } }, select, take: MAX_LEDGER_SCOPE + 1 }))
  for (const part of chunks([...new Set(a.references)])) {
    const variants = caseVariants(part)
    remember(await tx.booking.findMany({ where: { ...base, OR: [{ reference: { in: variants } }, { supplierRef: { in: variants } }] }, select, take: MAX_LEDGER_SCOPE + 1 }))
  }
  const bookings = [...found.values()].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id))

  const cancelled = bookings.filter((b) => b.status === 'CANCELLED')
  const cancelledIds = cancelled.map((b) => b.id)
  const cancelledRefs = [...new Set(cancelled.flatMap((b) => [b.reference, ...(b.supplierRef ? [b.supplierRef] : [])]))]
  const events: Array<{ bookingId: string; penaltyMinor: bigint | null }> = []
  for (const part of chunks(cancelledIds)) events.push(...await tx.bookingFinanceEvent.findMany({ where: { tenantId: a.tenantId, bookingId: { in: part }, type: 'CANCELLED' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { bookingId: true, penaltyMinor: true } }))
  const earlier: Array<{ reference: string }> = []
  for (const part of chunks(cancelledRefs)) earlier.push(...await tx.supplierStatementLine.findMany({ where: { tenantId: a.tenantId, kind: 'CHARGE', statementId: { not: a.statementId }, statement: { supplierId: a.supplierId }, reference: { in: caseVariants(part) } }, select: { reference: true } }))
  const penaltyOf = new Map<string, bigint | null>()
  for (const e of events) if (!penaltyOf.has(e.bookingId)) penaltyOf.set(e.bookingId, e.penaltyMinor)
  const invoiced = new Set(earlier.map((l) => normaliseReference(l.reference)))

  const inPeriod = new Set<string>()
  const items = bookings.map((b): LedgerItemInput => {
    if (b.checkOut && b.checkOut >= a.periodStart && b.checkOut <= a.periodEnd) inPeriod.add(b.id)
    const references = [b.reference, ...(b.supplierRef ? [b.supplierRef] : [])]
    const isCancelled = b.status === 'CANCELLED'
    return {
      bookingId: b.id, references, currency: b.currency, netMinor: b.netMinor, state: isCancelled ? 'CANCELLED' : 'PAYABLE',
      expectedCreditMinor: isCancelled && b.netMinor !== null && penaltyOf.get(b.id) === 0n ? b.netMinor : null,
      previouslyInvoiced: isCancelled && references.some((r) => invoiced.has(normaliseReference(r))),
    }
  })
  return { items, inPeriod }
}
