import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  AGENCY_CODE_PATTERN, AGENCY_STATUSES,
  type AgencyCreate, type AgencyMemberCandidate, type AgencyMemberView, type AgencyPage, type AgencyUpdate, type AgencyView, type ClientsSummary,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { enumParam, idParam, likeLiteral, pageParams, textParam } from '../admin-operations/query-params'

const COUNTRY = /^[A-Z]{2}$/
type AgencyRow = Prisma.AgencyGetPayload<{ include: { _count: { select: { members: true } } } }>
const INCLUDE = { _count: { select: { members: true } } } as const

/**
 * Agencies and their members (ADR 0019). Record-keeping only: it never touches credit, wallets or pricing, and an INACTIVE
 * agency does not block sign-in or booking. Tenant comes from the session; every change is audited with identifiers, never free text.
 */
@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  private view(a: AgencyRow): AgencyView {
    return { id: a.id, code: a.code, name: a.name, countryCode: a.countryCode, status: a.status, notes: a.notes, memberCount: a._count.members, createdAt: a.createdAt.toISOString() }
  }

  private text(name: string, value: unknown, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null) { if (required) throw new BadRequestException(`${name} is required`); return undefined }
    if (typeof value !== 'string') throw new BadRequestException(`${name} must be text`)
    const t = value.trim()
    if (!t) { if (required) throw new BadRequestException(`${name} is required`); return undefined }
    if (t.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`)
    return t
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<AgencyPage> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, AGENCY_STATUSES)
    const search = textParam('search', query.search, 64)
    const where: Prisma.AgencyWhereInput = { tenantId, ...(status && { status }), ...(search && { OR: [{ name: { contains: likeLiteral(search), mode: 'insensitive' } }, { code: { contains: likeLiteral(search).toUpperCase() } }] }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.agency.findMany({ where, include: INCLUDE, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }),
      tx.agency.count({ where }),
    ]))
    return { items: rows.map((r) => this.view(r)), page: page.page, pageSize: page.pageSize, total }
  }

  async get(tenantId: string, agencyId: string): Promise<AgencyView> {
    return this.view(await this.row(tenantId, agencyId))
  }

  private async row(tenantId: string, agencyIdRaw: string): Promise<AgencyRow> {
    const id = idParam('agencyId', agencyIdRaw)
    if (!id) throw new BadRequestException('Invalid agencyId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.agency.findFirst({ where: { id, tenantId }, include: INCLUDE }))
    if (!row) throw new NotFoundException('Agency not found')
    return row
  }

  async create(tenantId: string, userId: string, body: AgencyCreate): Promise<AgencyView> {
    const code = this.text('code', body?.code, 40, true)!.toUpperCase()
    if (!AGENCY_CODE_PATTERN.test(code)) throw new BadRequestException('code must be 2 to 40 letters, digits or hyphens, starting and ending with a letter or digit')
    const name = this.text('name', body.name, 120, true)!
    const countryCode = this.text('countryCode', body.countryCode, 2, false)?.toUpperCase()
    if (countryCode && !COUNTRY.test(countryCode)) throw new BadRequestException('countryCode must be a two-letter ISO country code')
    const notes = this.text('notes', body.notes, 1000, false)
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) => tx.agency.create({ data: { tenantId, code, name, countryCode: countryCode ?? null, notes: notes ?? null, createdById: userId }, include: INCLUDE }))
      await this.audit.record({ tenantId, userId, action: 'agency.created', entityType: 'agency', entityId: row.id, payload: { code } })
      return this.view(row)
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('An agency with this code already exists')
      throw error
    }
  }

  async update(tenantId: string, userId: string, agencyId: string, body: AgencyUpdate): Promise<AgencyView> {
    const current = await this.row(tenantId, agencyId)
    const data: Prisma.AgencyUpdateInput = {}
    const changed: string[] = []
    if (body?.name !== undefined) { data.name = this.text('name', body.name, 120, true)!; changed.push('name') }
    if (body?.countryCode !== undefined) {
      const c = body.countryCode === null ? null : this.text('countryCode', body.countryCode, 2, false)?.toUpperCase() ?? null
      if (c && !COUNTRY.test(c)) throw new BadRequestException('countryCode must be a two-letter ISO country code')
      data.countryCode = c; changed.push('countryCode')
    }
    if (body?.notes !== undefined) { data.notes = body.notes === null ? null : this.text('notes', body.notes, 1000, false) ?? null; changed.push('notes') }
    if (body?.status !== undefined) {
      const status = enumParam('status', body.status, AGENCY_STATUSES)
      if (!status) throw new BadRequestException('status must be ACTIVE or INACTIVE')
      data.status = status; changed.push('status')
    }
    if (changed.length === 0) return this.view(current)
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.agency.update({ where: { id: current.id }, data, include: INCLUDE }))
    await this.audit.record({ tenantId, userId, action: 'agency.updated', entityType: 'agency', entityId: row.id, payload: { fields: changed, ...(changed.includes('status') ? { status: row.status } : {}) } })
    return this.view(row)
  }

  async members(tenantId: string, agencyId: string): Promise<AgencyMemberView[]> {
    const agency = await this.row(tenantId, agencyId)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.agencyMember.findMany({ where: { tenantId, agencyId: agency.id }, include: { user: { select: { id: true, email: true, name: true, status: true } } }, orderBy: { createdAt: 'asc' } }))
    return rows.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, userStatus: m.user.status, addedAt: m.createdAt.toISOString() }))
  }

  /** Tenant members that no agency includes yet, for the add-member picker. */
  async candidates(tenantId: string, query: Record<string, unknown>): Promise<AgencyMemberCandidate[]> {
    const search = textParam('search', query.search, 64)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findMany({
      where: { tenantId, user: { agencyMemberships: { none: { tenantId } }, ...(search && { OR: [{ email: { contains: likeLiteral(search), mode: 'insensitive' } }, { name: { contains: likeLiteral(search), mode: 'insensitive' } }] }) } },
      select: { user: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: 'asc' }, take: 50,
    }))
    return rows.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name }))
  }

  async addMember(tenantId: string, actorId: string, agencyId: string, userIdRaw: unknown): Promise<AgencyMemberView[]> {
    const agency = await this.row(tenantId, agencyId)
    const userId = idParam('userId', userIdRaw)
    if (!userId) throw new BadRequestException('userId is required')
    try {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const membership = await tx.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { id: true } })
        if (!membership) throw new NotFoundException('User is not a member of this tenant')
        await tx.agencyMember.create({ data: { agencyId: agency.id, tenantId, userId } })
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('This user already belongs to an agency')
      throw error
    }
    await this.audit.record({ tenantId, userId: actorId, action: 'agency.member.added', entityType: 'agency', entityId: agency.id, payload: { memberUserId: userId } })
    return this.members(tenantId, agency.id)
  }

  async removeMember(tenantId: string, actorId: string, agencyId: string, userIdRaw: string): Promise<AgencyMemberView[]> {
    const agency = await this.row(tenantId, agencyId)
    const userId = idParam('userId', userIdRaw)
    if (!userId) throw new BadRequestException('Invalid userId')
    const removed = await this.prisma.withTenant(tenantId, (tx) => tx.agencyMember.deleteMany({ where: { agencyId: agency.id, tenantId, userId } }))
    if (removed.count === 0) throw new NotFoundException('That user is not a member of this agency')
    await this.audit.record({ tenantId, userId: actorId, action: 'agency.member.removed', entityType: 'agency', entityId: agency.id, payload: { memberUserId: userId } })
    return this.members(tenantId, agency.id)
  }

  async summary(tenantId: string): Promise<ClientsSummary> {
    const [byStatus, totalMembers, inAgency] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.agency.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      tx.membership.count({ where: { tenantId } }),
      tx.agencyMember.count({ where: { tenantId } }),
    ]))
    const n = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0
    return {
      generatedAt: new Date().toISOString(),
      agencies: { total: n('ACTIVE') + n('INACTIVE'), active: n('ACTIVE'), inactive: n('INACTIVE') },
      members: { total: totalMembers, inAnAgency: inAgency, notInAnyAgency: Math.max(totalMembers - inAgency, 0) },
      definitions: {
        agencies: 'Agency records for this tenant. INACTIVE is a directory state only: it does not block sign-in, search or booking.',
        members: 'Tenant members, split by whether an agency record includes them. A user belongs to at most one agency.',
      },
    }
  }
}
