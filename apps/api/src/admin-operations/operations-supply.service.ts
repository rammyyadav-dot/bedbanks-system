import { ForbiddenException, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { OperationsReadiness, Paged, SupplierOperationsRow } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { DEFAULT_STALE_MINUTES } from './booking-attention'
import { OperationsHotelsService } from './operations-hotels.service'
import { sectionRead } from './operations-read'
import { enumParam, likeLiteral, pageParams, paged, textParam } from './query-params'

const SUPPLIER_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE'] as const

type Counts = { total: number; mapped: number; pending: number; rejected: number }
const emptyCounts = (): Counts => ({ total: 0, mapped: 0, pending: 0, rejected: 0 })
const addStatus = (c: Counts, status: string, n: number) => { c.total += n; if (status === 'MAPPED') c.mapped += n; else if (status === 'PENDING') c.pending += n; else if (status === 'REJECTED') c.rejected += n }

/** Read-only supplier views and the supply section of the operations dashboard. Hotel assessment lives in OperationsHotelsService. */
@Injectable()
export class OperationsSupplyService {
  constructor(private readonly prisma: PrismaService, private readonly hotels: OperationsHotelsService) {}

  /** Same fail-closed rule as SupplyService: formal role permissions only. */
  async require(tenantId: string, userId: string, permission: string) {
    const roles = await this.prisma.withTenant(tenantId, tx => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    const keys = roles.flatMap(r => r.role.permissions.map(p => p.permission.key))
    if (!keys.includes(permission)) throw new ForbiddenException('Insufficient permission')
  }

  async suppliers(tenantId: string, userId: string, query: Record<string, unknown>): Promise<Paged<SupplierOperationsRow>> {
    await this.require(tenantId, userId, 'supply.suppliers.read')
    const page = pageParams(query)
    const search = textParam('search', query.search, 64)
    const status = enumParam('status', query.status, SUPPLIER_STATUSES)
    const where: Prisma.SupplierWhereInput = { tenantId, ...(status && { status }), ...(search && { displayName: { startsWith: likeLiteral(search), mode: 'insensitive' } }) }
    return this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([tx.supplier.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }), tx.supplier.count({ where })])
      const ids = rows.map(r => r.id)
      const [hm, rm, contracts] = ids.length ? await Promise.all([
        tx.supplierHotelMapping.groupBy({ by: ['supplierId', 'status'], where: { tenantId, supplierId: { in: ids } }, _count: { _all: true } }),
        tx.supplierRoomMapping.findMany({ where: { tenantId, supplierHotelMapping: { supplierId: { in: ids } } }, select: { status: true, supplierHotelMapping: { select: { supplierId: true } } } }),
        tx.contract.groupBy({ by: ['supplierId', 'status'], where: { tenantId, supplierId: { in: ids } }, _count: { _all: true } }),
      ]) : [[], [], []]
      return paged(rows.map(s => {
        const h = emptyCounts(); for (const m of hm) if (m.supplierId === s.id) addStatus(h, m.status, m._count._all)
        const r = emptyCounts(); for (const m of rm) if (m.supplierHotelMapping.supplierId === s.id) addStatus(r, m.status, 1)
        const c = { total: 0, active: 0 }; for (const x of contracts) if (x.supplierId === s.id) { c.total += x._count._all; if (x.status === 'ACTIVE') c.active += x._count._all }
        return { id: s.id, displayName: s.displayName, legalName: s.legalName, type: s.type, status: s.status, countryCode: s.countryCode, defaultCurrency: s.defaultCurrency, hotelMappings: h, roomMappings: r, contracts: c, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }
      }), page, total)
    })
  }

  async readiness(tenantId: string, userId: string, query: Record<string, unknown>, transactions: () => Promise<OperationsReadiness['transactions']>, connectors: () => Promise<OperationsReadiness['connectors']>): Promise<OperationsReadiness> {
    await this.require(tenantId, userId, 'supply.hotels.read')
    const summary = await this.hotels.summary(tenantId, query)
    const supply = await sectionRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [suppliers, activeSuppliers, hm, rm] = await Promise.all([
        tx.supplier.count({ where: { tenantId } }), tx.supplier.count({ where: { tenantId, status: 'ACTIVE' } }),
        tx.supplierHotelMapping.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.supplierRoomMapping.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      ])
      const h = emptyCounts(); for (const m of hm) addStatus(h, m.status, m._count._all)
      const r = emptyCounts(); for (const m of rm) addStatus(r, m.status, m._count._all)
      return {
        suppliers: { total: suppliers, active: activeSuppliers },
        hotels: { total: summary.totalHotels, ready: summary.readiness.ready, partial: summary.readiness.partial, blocked: summary.readiness.blocked },
        hotelMappings: { mapped: h.mapped, pending: h.pending, rejected: h.rejected }, roomMappings: { mapped: r.mapped, pending: r.pending, rejected: r.rejected },
        rateGapHotels: summary.rateGapHotels, availabilityGapHotels: summary.availabilityGapHotels, stopSellHotels: summary.stopSellHotels, contractsExpiring: summary.contractsExpiring,
      }
    }))
    return {
      generatedAt: summary.generatedAt, window: summary.window,
      definitions: { ...summary.definitions, staleMinutes: `A claimed hold stuck in PROCESSING for ${DEFAULT_STALE_MINUTES} minutes or more needs reconciliation.` },
      supply, transactions: await transactions(), connectors: await connectors(),
    }
  }
}
