import { BadRequestException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common'
import { SUPPLIER_TERMS_BASES, SUPPLIER_TERMS_MAX_DAYS, TERMS_FAILURE, type SupplierTermsBasis, type SupplierTermsListView, type SupplierTermsSetRequest, type SupplierTermsView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'

export const TERMS_LIST_LIMIT = 500
const bad = (message: string) => new BadRequestException({ message, code: TERMS_FAILURE.invalid })

export function parseTerms(body: unknown): { supplierId: string; basis: SupplierTermsBasis; days: number; note: string | null } {
  if (!body || typeof body !== 'object') throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const supplierId = typeof b.supplierId === 'string' ? b.supplierId.trim() : ''
  if (!supplierId) throw bad('supplierId is required')
  if (typeof b.basis !== 'string' || !(SUPPLIER_TERMS_BASES as readonly string[]).includes(b.basis)) throw bad(`basis must be one of ${SUPPLIER_TERMS_BASES.join(', ')}`)
  if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 0 || b.days > SUPPLIER_TERMS_MAX_DAYS) throw bad(`days must be a whole number from 0 to ${SUPPLIER_TERMS_MAX_DAYS}`)
  const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note.trim() : undefined
  if (note === undefined || (note !== null && note.length > 500)) throw bad('note must be text of at most 500 characters')
  return { supplierId, basis: b.basis as SupplierTermsBasis, days: b.days, note: note || null }
}

/**
 * Supplier payment terms (ADR 0078): the contracted number of days after check-out, check-in or confirmation. Append-only history; the latest row is current. Runs on the consumer's
 * own role (typed 503 when unavailable). Setting the terms already in force records nothing. Writes share the settlement switch (SUPPLIER_SETTLEMENT_ENABLED); reads always work.
 */
@Injectable()
export class SupplierTermsService {
  constructor(private readonly db: BookingFinancePostingDatabase, private readonly prisma: PrismaService, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  async set(tenantId: string, userId: string, body: SupplierTermsSetRequest, requestId: string): Promise<SupplierTermsView> {
    if (this.env.SUPPLIER_SETTLEMENT_ENABLED !== 'true') throw new ServiceUnavailableException({ message: 'Supplier payments are not enabled in this deployment', code: TERMS_FAILURE.disabled })
    const t = parseTerms(body)
    const supplier = await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findFirst({ where: { id: t.supplierId, tenantId }, select: { displayName: true } }))
    if (!supplier) throw new NotFoundException({ message: 'Supplier not found', code: TERMS_FAILURE.unknownSupplier })
    await this.db.withTenant(tenantId, async (tx) => {
      const current = await tx.supplierPaymentTerms.findFirst({ where: { tenantId, supplierId: t.supplierId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { basis: true, days: true, note: true } })
      if (current && current.basis === t.basis && current.days === t.days && current.note === t.note) return
      const created = await tx.supplierPaymentTerms.create({ data: { tenantId, supplierId: t.supplierId, basis: t.basis, days: t.days, note: t.note, setById: userId }, select: { id: true } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'finance.supplier_terms.set', entityType: 'supplier', entityId: t.supplierId, payload: { termsId: created.id, basis: t.basis, days: t.days, previousBasis: current?.basis ?? null, previousDays: current?.days ?? null, requestId } }] })
    })
    return (await this.list(tenantId, t.supplierId)).items.find((i) => i.supplierId === t.supplierId) as SupplierTermsView
  }

  /** Every supplier that is owed money or has terms, with its current terms (null when none) and what is outstanding per currency. */
  async list(tenantId: string, onlySupplierId?: string): Promise<SupplierTermsListView> {
    const raw = await this.db.withTenant(tenantId, async (tx) => {
      const [entries, paid, terms] = await Promise.all([
        tx.supplierPayableEntry.groupBy({ by: ['supplierId', 'currency'], where: { tenantId, ...(onlySupplierId ? { supplierId: onlySupplierId } : {}) }, _sum: { amountMinor: true } }),
        tx.supplierSettlement.groupBy({ by: ['supplierId', 'currency'], where: { tenantId, status: 'APPROVED', ...(onlySupplierId ? { supplierId: onlySupplierId } : {}) }, _sum: { amountMinor: true } }),
        tx.supplierPaymentTerms.findMany({ where: { tenantId, ...(onlySupplierId ? { supplierId: onlySupplierId } : {}) }, orderBy: [{ supplierId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }], distinct: ['supplierId'], select: { supplierId: true, basis: true, days: true, note: true, createdAt: true, setById: true } }),
      ])
      return { entries, paid, terms }
    })
    const paid = new Map(raw.paid.map((g) => [`${g.supplierId}\u0000${g.currency}`, g._sum.amountMinor ?? 0n]))
    const owed = new Map<string, Array<{ currency: string; outstandingMinor: string }>>()
    for (const g of raw.entries) {
      const outstanding = (g._sum.amountMinor ?? 0n) - (paid.get(`${g.supplierId}\u0000${g.currency}`) ?? 0n)
      owed.set(g.supplierId, [...(owed.get(g.supplierId) ?? []), { currency: g.currency, outstandingMinor: outstanding.toString() }])
    }
    const terms = new Map(raw.terms.map((t) => [t.supplierId, t]))
    const ids = [...new Set([...owed.keys(), ...terms.keys()])]
    const suppliers = ids.length ? await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })) : []
    const names = new Map(suppliers.map((s) => [s.id, s.displayName]))
    const all = ids.map((supplierId): SupplierTermsView => {
      const t = terms.get(supplierId)
      return { supplierId, name: names.get(supplierId) ?? null, basis: t?.basis ?? null, days: t?.days ?? null, note: t?.note ?? null, setAt: t?.createdAt.toISOString() ?? null, setById: t?.setById ?? null, owed: (owed.get(supplierId) ?? []).sort((a, b) => a.currency.localeCompare(b.currency)) }
    }).sort((a, b) => (a.name ?? a.supplierId).localeCompare(b.name ?? b.supplierId))
    return { items: all.slice(0, TERMS_LIST_LIMIT), listLimit: TERMS_LIST_LIMIT, truncated: all.length > TERMS_LIST_LIMIT }
  }
}
