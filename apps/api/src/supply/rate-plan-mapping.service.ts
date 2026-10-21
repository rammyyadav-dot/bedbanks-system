import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type MappingStatus } from '@prisma/client'
import { SUPPLIER_RATE_PLAN_MAPPING_CONFLICT_CODE, type SupplierRatePlanMappingOption, type SupplierRatePlanMappingView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'

type Input = Record<string, unknown>
const readPermission = 'supply.mappings.read'
const managePermission = 'supply.mappings.manage'
const CODE = /^[A-Za-z0-9_.:/-]{1,64}$/

function keys(input: Input, allowed: string[], required: string[] = []) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((k) => !allowed.includes(k)) || required.some((k) => !(k in input))) throw new BadRequestException('Invalid rate plan mapping fields')
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new BadRequestException(`Invalid ${field}`)
  return value
}
function reasonOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) throw new BadRequestException('reason must be 3 to 500 characters')
  return value.trim()
}

const VIEW = { ratePlan: { select: { code: true, currency: true, contract: { select: { code: true } } } } } as const
type Row = Prisma.SupplierRatePlanMappingGetPayload<{ include: typeof VIEW }>
const toView = (r: Row): SupplierRatePlanMappingView => ({
  id: r.id, supplierRoomMappingId: r.supplierRoomMappingId, supplierRatePlanCode: r.supplierRatePlanCode, ratePlanId: r.ratePlanId, ratePlanCode: r.ratePlan.code,
  contractCode: r.ratePlan.contract.code, currency: r.ratePlan.currency, status: r.status, confidence: r.confidence, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
})

/**
 * Governance of supplier rate plan mappings (ADR 0081), the third level under hotel and room mappings (ADR 0004). A person creates a PENDING mapping from a supplier rate plan code to one
 * canonical contracted RatePlan and a person approves it. Nothing here infers a mapping from a name or a price, and approval is refused unless the room mapping above it is MAPPED.
 * Each successful mutation commits with its audit event; the audit payload carries ids and codes only.
 */
@Injectable()
export class RatePlanMappingService {
  constructor(private readonly prisma: PrismaService) {}

  private async authorize(tenantId: string, userId: string, permission: string) {
    const count = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.count({ where: { tenantId, userId, role: { tenantId, permissions: { some: { permission: { key: permission } } } } } }))
    if (!count) throw new ForbiddenException('Insufficient permission')
  }

  private async roomMapping(tx: Prisma.TransactionClient, tenantId: string, mappingId: string, roomMappingId: string) {
    const room = await tx.supplierRoomMapping.findFirst({ where: { id: roomMappingId, tenantId, supplierHotelMappingId: mappingId }, include: { supplierHotelMapping: { select: { supplierId: true, supplierHotelId: true } } } })
    if (!room) throw new NotFoundException('Mapping not found')
    return room
  }

  async list(tenantId: string, userId: string, mappingId: string, roomMappingId: string): Promise<SupplierRatePlanMappingView[]> {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.roomMapping(tx, tenantId, mappingId, roomMappingId)
      return (await tx.supplierRatePlanMapping.findMany({ where: { tenantId, supplierRoomMappingId: roomMappingId }, include: VIEW, orderBy: { createdAt: 'desc' } })).map(toView)
    })
  }

  /** Candidates a code may be mapped to. A derived plan has no nightly rates of its own, so it is never a target for supplier nightly rates. */
  async options(tenantId: string, userId: string, mappingId: string, roomMappingId: string): Promise<SupplierRatePlanMappingOption[]> {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const room = await this.roomMapping(tx, tenantId, mappingId, roomMappingId)
      const plans = await tx.ratePlan.findMany({
        where: { tenantId, roomTypeId: room.roomTypeId, derivedFromId: null, contract: { tenantId, supplierId: room.supplierHotelMapping.supplierId }, supplierMappings: { none: { tenantId } } },
        select: { id: true, code: true, currency: true, status: true, contract: { select: { code: true } } }, orderBy: [{ code: 'asc' }],
      })
      return plans.map((p) => ({ ratePlanId: p.id, code: p.code, contractCode: p.contract.code, currency: p.currency, status: p.status }))
    })
  }

  private async write<T>(tenantId: string, userId: string, requestId: string | undefined, action: string, work: (tx: Prisma.TransactionClient) => Promise<{ id: string; value: T; payload: Input }>): Promise<T> {
    await this.authorize(tenantId, userId, managePermission)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { id, value, payload } = await work(tx)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: `supply.rate_plan_mapping.${action}`, entityType: 'supplier_rate_plan_mapping', entityId: id, payload: { ...payload, outcome: 'allowed', requestId: requestId ?? null } as Prisma.InputJsonObject } })
      return value
    })
  }

  async create(tenantId: string, userId: string, mappingId: string, roomMappingId: string, input: Input, requestId?: string): Promise<SupplierRatePlanMappingView> {
    keys(input, ['supplierRatePlanCode', 'ratePlanId', 'confidence', 'sourceMetadata'], ['supplierRatePlanCode', 'ratePlanId'])
    const supplierRatePlanCode = text(input.supplierRatePlanCode, 'supplierRatePlanCode'), ratePlanId = text(input.ratePlanId, 'ratePlanId')
    if (!CODE.test(supplierRatePlanCode)) throw new BadRequestException('Invalid supplierRatePlanCode')
    const confidence = input.confidence === undefined ? null : input.confidence
    if (confidence !== null && (!Number.isInteger(confidence) || (confidence as number) < 0 || (confidence as number) > 100)) throw new BadRequestException('Invalid confidence')
    const sourceMetadata = input.sourceMetadata === undefined ? {} : input.sourceMetadata
    if (!sourceMetadata || Array.isArray(sourceMetadata) || typeof sourceMetadata !== 'object') throw new BadRequestException('Invalid sourceMetadata')
    try {
      return await this.write(tenantId, userId, requestId, 'created', async (tx) => {
        const room = await this.roomMapping(tx, tenantId, mappingId, roomMappingId)
        const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { roomTypeId: true, derivedFromId: true, contract: { select: { supplierId: true } } } })
        if (!plan || plan.roomTypeId !== room.roomTypeId || plan.contract.supplierId !== room.supplierHotelMapping.supplierId) throw new BadRequestException('The rate plan must be of the mapped room type and of a contract with the mapped supplier')
        if (plan.derivedFromId !== null) throw new BadRequestException('A derived rate plan has no nightly rates of its own and cannot be a mapping target')
        const created = await tx.supplierRatePlanMapping.create({ data: { tenantId, supplierRoomMappingId: roomMappingId, supplierRatePlanCode, ratePlanId, confidence: confidence as number | null, sourceMetadata: sourceMetadata as Prisma.InputJsonObject }, include: VIEW })
        return { id: created.id, value: toView(created), payload: { supplierId: room.supplierHotelMapping.supplierId, supplierHotelId: room.supplierHotelMapping.supplierHotelId, supplierRoomId: room.supplierRoomId, supplierRatePlanCode, ratePlanId, roomTypeId: room.roomTypeId, status: created.status, confidence } }
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ message: 'This supplier rate plan code, or this canonical rate plan, is already mapped. Reopen or reject that mapping instead of creating another.', code: SUPPLIER_RATE_PLAN_MAPPING_CONFLICT_CODE })
      throw error
    }
  }

  async decide(tenantId: string, userId: string, mappingId: string, roomMappingId: string, ratePlanMappingId: string, decision: 'approve' | 'reject' | 'reopen', reasonRaw?: unknown, requestId?: string): Promise<SupplierRatePlanMappingView> {
    const reason = reasonOf(reasonRaw)
    return this.write(tenantId, userId, requestId, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'reopened', async (tx) => {
      // Serialize with decisions on the room mapping above: it cannot be reopened while this one is being approved.
      await tx.$queryRaw`SELECT "id" FROM "SupplierRoomMapping" WHERE "id" = ${roomMappingId} AND "tenant_id" = ${tenantId} FOR UPDATE`
      const room = await this.roomMapping(tx, tenantId, mappingId, roomMappingId)
      const prior = await tx.supplierRatePlanMapping.findFirst({ where: { id: ratePlanMappingId, tenantId, supplierRoomMappingId: roomMappingId } })
      if (!prior) throw new NotFoundException('Mapping not found')
      if ((decision === 'reopen') === (prior.status === 'PENDING')) throw new BadRequestException('Invalid mapping transition')
      if (decision === 'approve' && room.status !== 'MAPPED') throw new BadRequestException('Approve the room mapping first')
      const status: MappingStatus = decision === 'approve' ? 'MAPPED' : decision === 'reject' ? 'REJECTED' : 'PENDING'
      const changed = await tx.supplierRatePlanMapping.updateMany({ where: { id: ratePlanMappingId, tenantId, supplierRoomMappingId: roomMappingId, status: prior.status }, data: { status } })
      if (changed.count !== 1) throw new BadRequestException('Mapping status changed; retry the decision')
      const value = await tx.supplierRatePlanMapping.findFirstOrThrow({ where: { id: ratePlanMappingId, tenantId }, include: VIEW })
      return { id: ratePlanMappingId, value: toView(value), payload: { supplierId: room.supplierHotelMapping.supplierId, supplierHotelId: room.supplierHotelMapping.supplierHotelId, supplierRoomId: room.supplierRoomId, supplierRatePlanCode: prior.supplierRatePlanCode, ratePlanId: prior.ratePlanId, previousStatus: prior.status, newStatus: status, confidence: prior.confidence, ...(reason ? { reason } : {}) } }
    })
  }
}
