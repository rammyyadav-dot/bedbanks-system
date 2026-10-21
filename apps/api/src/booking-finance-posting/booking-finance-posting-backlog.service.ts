import { Injectable } from '@nestjs/common'
import { POSTING_BACKLOG_LIST_LIMIT, type PostingBacklogItem, type PostingBacklogView, type PostingReviewItem } from '@bedbanks/contracts'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'

const EVENT = { id: true, bookingId: true, type: true, currency: true, sellMinor: true, createdAt: true } as const

/**
 * The read side of the booking Finance consumer (ADR 0076): complete counts, plus the oldest events that need a person and the oldest not yet attempted.
 * One read transaction on the consumer's own role (the API role has no grant on these tables), tenant RLS. Nothing is written. If the role is not
 * configured or lacks a grant the answer is the typed 503, never an empty backlog.
 */
@Injectable()
export class BookingFinancePostingBacklogService {
  constructor(private readonly db: BookingFinancePostingDatabase) {}

  async backlog(tenantId: string, now = new Date()): Promise<PostingBacklogView> {
    const take = POSTING_BACKLOG_LIST_LIMIT
    return this.db.withTenant(tenantId, async (tx): Promise<PostingBacklogView> => {
      const [byStatus, skipped, waitingCount, review, waiting] = await Promise.all([
        tx.bookingFinancePosting.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.bookingFinancePosting.groupBy({ by: ['reason'], where: { tenantId, status: 'SKIPPED' }, _count: { _all: true } }),
        tx.bookingFinanceEvent.count({ where: { tenantId, posting: { is: null } } }),
        tx.bookingFinancePosting.findMany({
          where: { tenantId, status: 'REVIEW_REQUIRED' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take,
          select: { reason: true, attempts: true, updatedAt: true, event: { select: EVENT } },
        }),
        tx.bookingFinanceEvent.findMany({ where: { tenantId, posting: { is: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: EVENT }),
      ])
      const count = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0
      const item = (e: { id: string; bookingId: string; type: string; currency: string; sellMinor: bigint; createdAt: Date }): PostingBacklogItem =>
        ({ eventId: e.id, bookingId: e.bookingId, eventType: e.type, currency: e.currency, sellMinor: e.sellMinor.toString(), recordedAt: e.createdAt.toISOString() })
      return {
        generatedAt: now.toISOString(),
        counts: { posted: count('POSTED'), skipped: count('SKIPPED'), reviewRequired: count('REVIEW_REQUIRED'), waiting: waitingCount },
        skippedByReason: skipped.map((g) => ({ reason: g.reason ?? 'UNKNOWN', count: g._count._all })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        review: review.map((r): PostingReviewItem => ({ ...item(r.event), reason: r.reason ?? 'UNKNOWN', attempts: r.attempts, lastAttemptAt: r.updatedAt.toISOString() })),
        waiting: waiting.map(item),
        listLimit: take,
      } satisfies PostingBacklogView
    })
  }
}
