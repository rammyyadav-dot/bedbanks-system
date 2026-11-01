import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import type { Prisma } from '@prisma/client'
import {
  CASE_CATEGORIES, CASE_PRIORITIES, CASE_STATUSES, CASE_TRANSITIONS,
  type CaseAssign, type CaseAssignee, type CaseCreate, type CaseDetail, type CaseNoteCreate, type CasePage, type CaseStatus, type CaseTransition, type CaseView, type ServiceSummary,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { enumParam, idParam, likeLiteral, pageParams, textParam } from '../admin-operations/query-params'

const INCLUDE = {
  booking: { select: { id: true, reference: true } }, hotel: { select: { id: true, name: true } }, supplier: { select: { id: true, displayName: true } }, agency: { select: { id: true, name: true } },
  openedBy: { select: { email: true } }, assignee: { select: { id: true, email: true } },
} as const
type CaseRow = Prisma.ServiceCaseGetPayload<{ include: typeof INCLUDE }>
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ref = (): string => 'SC-' + Array.from(randomBytes(8), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')
const UNRESOLVED: CaseStatus[] = ['OPEN', 'IN_PROGRESS']

/**
 * Service cases (ADR 0019). A case observes other records through optional links and never changes them: no booking, hotel, supplier,
 * wallet or inventory is touched here. Status moves only along CASE_TRANSITIONS, with an optimistic update so two people cannot both
 * make the same move. Notes are append-only. Audit events carry identifiers and statuses, never the free text.
 */
@Injectable()
export class ServiceCasesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  private view(c: CaseRow): CaseView {
    return {
      id: c.id, reference: c.reference, subject: c.subject, description: c.description, category: c.category, priority: c.priority, status: c.status,
      booking: c.booking, hotel: c.hotel, supplier: c.supplier ? { id: c.supplier.id, name: c.supplier.displayName } : null, agency: c.agency,
      openedByEmail: c.openedBy.email, assignee: c.assignee, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null, closedAt: c.closedAt?.toISOString() ?? null, allowedTransitions: [...CASE_TRANSITIONS[c.status]],
    }
  }

  private text(name: string, value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} is required`)
    const t = value.trim()
    if (t.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`)
    return t
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<CasePage> {
    const page = pageParams(query)
    const statusRaw = typeof query.status === 'string' ? query.status : undefined
    const status = statusRaw === 'UNRESOLVED' ? undefined : enumParam('status', statusRaw, CASE_STATUSES)
    const priority = enumParam('priority', query.priority, CASE_PRIORITIES)
    const category = enumParam('category', query.category, CASE_CATEGORIES)
    const assignee = typeof query.assignee === 'string' ? query.assignee : undefined
    const search = textParam('search', query.search, 64)
    const bookingId = idParam('bookingId', query.bookingId)
    const where: Prisma.ServiceCaseWhereInput = {
      tenantId, ...(status && { status }), ...(statusRaw === 'UNRESOLVED' && { status: { in: UNRESOLVED } }), ...(priority && { priority }), ...(category && { category }), ...(bookingId && { bookingId }),
      ...(assignee === 'me' ? { assigneeId: me } : assignee === 'none' ? { assigneeId: null } : assignee ? { assigneeId: idParam('assignee', assignee) } : {}),
      ...(search && { OR: [{ reference: { startsWith: likeLiteral(search).toUpperCase() } }, { subject: { contains: likeLiteral(search), mode: 'insensitive' } }] }),
    }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.serviceCase.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
      tx.serviceCase.count({ where }),
    ]))
    return { items: rows.map((r) => this.view(r)), page: page.page, pageSize: page.pageSize, total }
  }

  private async load(tenantId: string, idRaw: string): Promise<CaseRow> {
    const id = idParam('caseId', idRaw)
    if (!id) throw new BadRequestException('Invalid caseId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.serviceCase.findFirst({ where: { id, tenantId }, include: INCLUDE }))
    if (!row) throw new NotFoundException('Case not found')
    return row
  }

  async detail(tenantId: string, caseId: string): Promise<CaseDetail> {
    const c = await this.load(tenantId, caseId)
    const notes = await this.prisma.withTenant(tenantId, (tx) => tx.serviceCaseNote.findMany({ where: { tenantId, caseId: c.id }, include: { author: { select: { email: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    return { ...this.view(c), notes: notes.map((n) => ({ id: n.id, authorEmail: n.author.email, body: n.body, createdAt: n.createdAt.toISOString() })) }
  }

  /** Members of the tenant who hold case.manage through a formal role: the people a case can be assigned to. */
  async assignees(tenantId: string): Promise<CaseAssignee[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { tenantId, role: { tenantId, permissions: { some: { permission: { key: 'case.manage' } } } } }, select: { user: { select: { id: true, email: true, name: true } } },
    }))
    const seen = new Map(rows.map((r) => [r.user.id, r.user]))
    return [...seen.values()].sort((a, b) => a.email.localeCompare(b.email))
  }

  private async assertAssignable(tenantId: string, assigneeId: string): Promise<void> {
    if (!(await this.assignees(tenantId)).some((a) => a.id === assigneeId)) throw new BadRequestException('The assignee must hold case.manage in this tenant')
  }

  async create(tenantId: string, userId: string, body: CaseCreate): Promise<CaseDetail> {
    const subject = this.text('subject', body?.subject, 200)
    const description = this.text('description', body.description, 2000)
    const category = enumParam('category', body.category, CASE_CATEGORIES)
    if (!category) throw new BadRequestException('category is required')
    const priority = enumParam('priority', body.priority, CASE_PRIORITIES) ?? 'NORMAL'
    const link = (name: string, v: unknown) => (v === undefined || v === null ? undefined : idParam(name, v) ?? (() => { throw new BadRequestException(`Invalid ${name}`) })())
    const bookingId = link('bookingId', body.bookingId); const hotelId = link('hotelId', body.hotelId); const supplierId = link('supplierId', body.supplierId); const agencyId = link('agencyId', body.agencyId); const assigneeId = link('assigneeId', body.assigneeId)
    if (assigneeId) await this.assertAssignable(tenantId, assigneeId)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.withTenant(tenantId, async (tx) => {
          if (bookingId && !(await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true } }))) throw new NotFoundException('Booking not found')
          if (hotelId && !(await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: { id: true } }))) throw new NotFoundException('Hotel not found')
          if (supplierId && !(await tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } }))) throw new NotFoundException('Supplier not found')
          if (agencyId && !(await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true } }))) throw new NotFoundException('Agency not found')
          return tx.serviceCase.create({ data: { tenantId, reference: ref(), subject, description, category, priority, bookingId: bookingId ?? null, hotelId: hotelId ?? null, supplierId: supplierId ?? null, agencyId: agencyId ?? null, openedById: userId, assigneeId: assigneeId ?? null }, include: INCLUDE })
        })
        await this.audit.record({ tenantId, userId, action: 'case.opened', entityType: 'service_case', entityId: row.id, payload: { reference: row.reference, category, priority, assigneeId: assigneeId ?? null } })
        return { ...this.view(row), notes: [] }
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') continue // reference collision: draw another
        throw error
      }
    }
    throw new ConflictException('Could not allocate a case reference; try again')
  }

  async transition(tenantId: string, userId: string, caseId: string, body: CaseTransition): Promise<CaseDetail> {
    const current = await this.load(tenantId, caseId)
    const to = enumParam('to', body?.to, CASE_STATUSES)
    if (!to) throw new BadRequestException('to is required')
    if (!CASE_TRANSITIONS[current.status].includes(to)) throw new ConflictException(`A ${current.status} case cannot move to ${to}`)
    const note = body.note === undefined || body.note === null || body.note === '' ? undefined : this.text('note', body.note, 2000)
    const now = new Date()
    const data: Prisma.ServiceCaseUpdateManyMutationInput = to === 'RESOLVED' ? { status: to, resolvedAt: now, closedAt: null } : to === 'CLOSED' ? { status: to, closedAt: now } : { status: to, resolvedAt: null, closedAt: null }
    const moved = await this.prisma.withTenant(tenantId, async (tx) => {
      const r = await tx.serviceCase.updateMany({ where: { id: current.id, tenantId, status: current.status }, data })
      if (r.count === 1 && note) await tx.serviceCaseNote.create({ data: { tenantId, caseId: current.id, authorId: userId, body: note } })
      return r.count
    })
    if (moved !== 1) throw new ConflictException('The case changed while you were updating it; reload and try again')
    await this.audit.record({ tenantId, userId, action: 'case.status_changed', entityType: 'service_case', entityId: current.id, payload: { from: current.status, to, noteAdded: Boolean(note) } })
    return this.detail(tenantId, current.id)
  }

  async assign(tenantId: string, userId: string, caseId: string, body: CaseAssign): Promise<CaseDetail> {
    const current = await this.load(tenantId, caseId)
    if (current.status === 'CLOSED') throw new ConflictException('A closed case cannot be reassigned')
    const assigneeId = body?.assigneeId === null || body?.assigneeId === undefined ? null : idParam('assigneeId', body.assigneeId) ?? (() => { throw new BadRequestException('Invalid assigneeId') })()
    if (assigneeId) await this.assertAssignable(tenantId, assigneeId)
    await this.prisma.withTenant(tenantId, (tx) => tx.serviceCase.updateMany({ where: { id: current.id, tenantId, status: { not: 'CLOSED' } }, data: { assigneeId } }))
    await this.audit.record({ tenantId, userId, action: 'case.assigned', entityType: 'service_case', entityId: current.id, payload: { from: current.assignee?.id ?? null, to: assigneeId } })
    return this.detail(tenantId, current.id)
  }

  async addNote(tenantId: string, userId: string, caseId: string, body: CaseNoteCreate): Promise<CaseDetail> {
    const current = await this.load(tenantId, caseId)
    if (current.status === 'CLOSED') throw new ConflictException('A closed case takes no more notes')
    const text = this.text('body', body?.body, 2000)
    const note = await this.prisma.withTenant(tenantId, (tx) => tx.serviceCaseNote.create({ data: { tenantId, caseId: current.id, authorId: userId, body: text } }))
    await this.audit.record({ tenantId, userId, action: 'case.note_added', entityType: 'service_case', entityId: current.id, payload: { noteId: note.id } })
    return this.detail(tenantId, current.id)
  }

  async summary(tenantId: string): Promise<ServiceSummary> {
    const [byStatus, unassigned, urgent, oldest] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.serviceCase.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      tx.serviceCase.count({ where: { tenantId, status: { in: UNRESOLVED }, assigneeId: null } }),
      tx.serviceCase.count({ where: { tenantId, status: { in: UNRESOLVED }, priority: 'URGENT' } }),
      tx.serviceCase.aggregate({ where: { tenantId, status: { in: UNRESOLVED } }, _min: { createdAt: true } }),
    ]))
    const n = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0
    return {
      generatedAt: new Date().toISOString(), byStatus: { open: n('OPEN'), inProgress: n('IN_PROGRESS'), resolved: n('RESOLVED'), closed: n('CLOSED') },
      unassigned, urgentUnresolved: urgent, oldestUnresolvedAt: oldest._min.createdAt?.toISOString() ?? null,
      definitions: {
        unresolved: 'OPEN or IN_PROGRESS. RESOLVED cases await closure; CLOSED is final.',
        unassigned: 'Unresolved cases with nobody assigned.',
        urgentUnresolved: 'Unresolved cases at URGENT priority.',
        cases: 'Cases observe bookings, hotels, suppliers and agencies through optional links; they never change them.',
      },
    }
  }
}
