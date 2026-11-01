import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { DISTRIBUTION_SCOPES, DISTRIBUTION_STATUSES, type DistributionSummary, type RestrictionCreate, type RestrictionPage, type RestrictionView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { enumParam, idParam, pageParams } from '../admin-operations/query-params'

const INCLUDE = { agency: { select: { id: true, name: true, code: true } }, hotel: { select: { id: true, name: true } }, supplier: { select: { id: true, displayName: true } } } as const
type Row = Prisma.DistributionRestrictionGetPayload<{ include: typeof INCLUDE }>

/**
 * Distribution restrictions (ADR 0019): hide one hotel, or all of one supplier's inventory, from the members of one agency in
 * Agent search, recheck and hold. A restriction narrows what an agency sees; it never grants access, changes a price or moves money.
 * At most one ACTIVE restriction exists per agency and target (partial unique index). Retiring re-exposes the inventory.
 */
@Injectable()
export class DistributionService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  private view(r: Row): RestrictionView {
    return {
      id: r.id, agency: r.agency, scope: r.scope, hotel: r.hotel, supplier: r.supplier ? { id: r.supplier.id, name: r.supplier.displayName } : null,
      status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString(), retiredAt: r.retiredAt?.toISOString() ?? null,
    }
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<RestrictionPage> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, DISTRIBUTION_STATUSES)
    const agencyId = idParam('agencyId', query.agencyId)
    const where: Prisma.DistributionRestrictionWhereInput = { tenantId, ...(status && { status }), ...(agencyId && { agencyId }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.distributionRestriction.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
      tx.distributionRestriction.count({ where }),
    ]))
    return { items: rows.map((r) => this.view(r)), page: page.page, pageSize: page.pageSize, total }
  }

  async create(tenantId: string, userId: string, body: RestrictionCreate): Promise<RestrictionView> {
    const agencyId = idParam('agencyId', body?.agencyId)
    if (!agencyId) throw new BadRequestException('agencyId is required')
    const scope = enumParam('scope', body.scope, DISTRIBUTION_SCOPES)
    if (!scope) throw new BadRequestException('scope is required')
    const hotelId = body.hotelId === undefined ? undefined : idParam('hotelId', body.hotelId)
    const supplierId = body.supplierId === undefined ? undefined : idParam('supplierId', body.supplierId)
    if (scope === 'HOTEL' && (!hotelId || supplierId)) throw new BadRequestException('A hotel restriction needs a hotel and no supplier')
    if (scope === 'SUPPLIER' && (!supplierId || hotelId)) throw new BadRequestException('A supplier restriction needs a supplier and no hotel')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason || reason.length > 500) throw new BadRequestException('A reason of 1 to 500 characters is required')
    try {
      const row = await this.prisma.withTenant(tenantId, async (tx) => {
        if (!(await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true } }))) throw new NotFoundException('Agency not found')
        if (hotelId && !(await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: { id: true } }))) throw new NotFoundException('Hotel not found')
        if (supplierId && !(await tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } }))) throw new NotFoundException('Supplier not found')
        return tx.distributionRestriction.create({ data: { tenantId, agencyId, scope, hotelId: hotelId ?? null, supplierId: supplierId ?? null, reason, createdById: userId }, include: INCLUDE })
      })
      await this.audit.record({ tenantId, userId, action: 'distribution.restriction.created', entityType: 'distribution_restriction', entityId: row.id, payload: { agencyId, scope, hotelId: hotelId ?? null, supplierId: supplierId ?? null } })
      return this.view(row)
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('This agency is already restricted from that target')
      throw error
    }
  }

  async retire(tenantId: string, userId: string, restrictionIdRaw: string): Promise<RestrictionView> {
    const id = idParam('restrictionId', restrictionIdRaw)
    if (!id) throw new BadRequestException('Invalid restrictionId')
    const current = await this.prisma.withTenant(tenantId, (tx) => tx.distributionRestriction.findFirst({ where: { id, tenantId }, include: INCLUDE }))
    if (!current) throw new NotFoundException('Restriction not found')
    if (current.status === 'RETIRED') return this.view(current)
    const done = await this.prisma.withTenant(tenantId, (tx) => tx.distributionRestriction.updateMany({ where: { id, tenantId, status: 'ACTIVE' }, data: { status: 'RETIRED', retiredAt: new Date() } }))
    if (done.count === 1) await this.audit.record({ tenantId, userId, action: 'distribution.restriction.retired', entityType: 'distribution_restriction', entityId: id, payload: { agencyId: current.agency.id, scope: current.scope } })
    const after = await this.prisma.withTenant(tenantId, (tx) => tx.distributionRestriction.findFirstOrThrow({ where: { id, tenantId }, include: INCLUDE }))
    return this.view(after)
  }

  async summary(tenantId: string): Promise<DistributionSummary> {
    const [active, byScope, agencies, members] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.distributionRestriction.count({ where: { tenantId, status: 'ACTIVE' } }),
      tx.distributionRestriction.groupBy({ by: ['scope'], where: { tenantId, status: 'ACTIVE' }, _count: { _all: true } }),
      tx.distributionRestriction.groupBy({ by: ['agencyId'], where: { tenantId, status: 'ACTIVE' } }),
      tx.agencyMember.count({ where: { tenantId, agency: { restrictions: { some: { status: 'ACTIVE' } } } } }),
    ]))
    const n = (s: string) => byScope.find((x) => x.scope === s)?._count._all ?? 0
    return {
      generatedAt: new Date().toISOString(), active, agenciesRestricted: agencies.length, byScope: { hotel: n('HOTEL'), supplier: n('SUPPLIER') }, membersAffected: members,
      definitions: {
        restriction: 'Hides one hotel, or all of one supplier\'s inventory, from the members of one agency in Agent search, recheck and hold. It never grants access or changes a price.',
        membersAffected: 'Members of an agency that has at least one ACTIVE restriction.',
        enforcement: 'Applied to contracted inventory. If the API database role cannot read restrictions, none are applied and the adapter logs it.',
      },
    }
  }
}
