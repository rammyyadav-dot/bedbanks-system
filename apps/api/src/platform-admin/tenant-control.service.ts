import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { tenantControlPermissions, TENANT_SETTING_CURRENCIES, type TenantBusiness, type TenantControlDetail, type TenantControlPermission } from '@bedbanks/contracts'
import { TenantControlDatabase } from './tenant-control.database'
import { PrismaService } from '../database/prisma.service'
import { ApprovalService } from '../approvals/approval.service'
import type { ComplianceDecisionDto, CreateTenantDto, LifecycleDecisionDto, LifecycleRequestDto, MembershipChangeDto, TenantAuditDto, TenantDirectoryDto, UpdateTenantProfileDto } from './tenant-control.dto'

const ACTION = 'tenant.lifecycle.manage'
const safeUser = { id: true, email: true, name: true, lastLoginAt: true, status: true } as const
const tenantSelect = { id: true, name: true, slug: true, status: true, createdAt: true } as const
const registrationKey = (b: TenantBusiness) => `${b.country}:${b.registrationNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`
const inclusiveDate = (value: string) => new Date(new Date(value).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(value) ? 86_400_000 - 1 : 0))
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

export function tenantReadiness(profile: { business: Prisma.JsonValue; complianceStatus: string } | null, owners: number) {
  const business = profile?.business as unknown as TenantBusiness | undefined
  return [
    { key: 'identity', label: 'Business identity complete', ready: Boolean(business?.name && business.country && business.address && business.city && business.businessEmail && business.registrationNumber), remediation: 'profile' },
    { key: 'administrator', label: 'Verified tenant administrator', ready: owners > 0, remediation: 'members' },
    { key: 'compliance', label: 'Independent compliance review approved', ready: profile?.complianceStatus === 'APPROVED', remediation: 'compliance' },
    { key: 'commercial', label: 'Commercial preferences recorded', ready: Boolean(business?.currency && business.markets?.length && business.channels?.length), remediation: 'commercial' },
    { key: 'finance', label: 'Finance eligibility reviewed', ready: business?.financeReviewed === true, remediation: 'profile' },
    // Supplier access must be provisioned through its existing owner workflow; metadata cannot enable it.
    { key: 'distribution', label: 'Distribution eligibility reviewed', ready: business?.classification === 'BUYER', remediation: 'commercial' },
  ]
}

@Injectable()
export class TenantControlService {
  constructor(private readonly db: TenantControlDatabase, private readonly prisma: PrismaService, private readonly approvals: ApprovalService) {}
  async permissions(operator: string, tx?: Prisma.TransactionClient): Promise<TenantControlPermission[]> {
    const read = async (client: Prisma.TransactionClient) => {
      const assignments = await client.platformRoleAssignment.findMany({ where: { userId: operator }, include: { role: { include: { permissions: { include: { permission: true } } } } } })
      const keys = new Set(assignments.flatMap(a => a.role.permissions.map(p => p.permission.key)))
      return tenantControlPermissions.filter(p => keys.has(p))
    }
    return tx ? read(tx) : this.db.configured() ? this.db.withPlatform(operator, read) : this.prisma.withPlatform(operator, read)
  }
  private async authorize(tx: Prisma.TransactionClient, operator: string, permission: TenantControlPermission) {
    if (!(await this.permissions(operator, tx)).includes(permission)) throw new ForbiddenException('Platform access denied')
  }
  private audit(tx: Prisma.TransactionClient, operator: string, tenantId: string | null, action: string, entityId: string, payload: Prisma.InputJsonObject = {}) {
    return tx.auditEvent.create({ data: { tenantId, userId: operator, actorType: 'USER', action, entityType: action === 'platform.tenants.directory.read' ? 'platform_tenant_directory' : 'tenant', entityId, payload } })
  }
  private key(value: string | undefined) {
    if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new BadRequestException('A valid Idempotency-Key is required')
    return value
  }
  private business(input: TenantBusiness): TenantBusiness {
    const b = { ...input, name: input.name.trim(), country: input.country.toUpperCase(), registrationNumber: input.registrationNumber.trim(), businessEmail: input.businessEmail.trim().toLowerCase(), markets: [...new Set(input.markets)].sort(), channels: [...new Set(input.channels)].sort() }
    if (!b.name || !/[A-Za-z0-9]/.test(b.registrationNumber) || !b.address.trim() || !b.city.trim()) throw new BadRequestException('Business identity and legal registration are required')
    if (!(TENANT_SETTING_CURRENCIES as readonly string[]).includes(b.currency)) throw new BadRequestException('Unsupported selling currency')
    return b
  }
  private async lock(tx: Prisma.TransactionClient, tenantId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`
    if (!rows.length) throw new NotFoundException('Tenant not found')
  }
  private async version(tx: Prisma.TransactionClient, tenantId: string, expected: number) {
    const current = await tx.tenantControlProfile.findUnique({ where: { tenantId } })
    if ((current?.version ?? 0) !== expected) throw new ConflictException('Tenant changed. Reload before trying again.')
    return current
  }
  private async replay(tx: Prisma.TransactionClient, operator: string, tenant: string | null, action: string, key: string, fingerprint: string) {
    const prior = await tx.auditEvent.findFirst({ where: { tenantId: tenant, userId: operator, action, payload: { path: ['idempotencyKey'], equals: key } }, select: { entityId: true, payload: true } })
    if (prior && (prior.payload as Prisma.JsonObject)?.fingerprint !== fingerprint) throw new ConflictException('Idempotency key was reused with different input')
    return prior
  }
  async directory(operator: string, query: TenantDirectoryDto, requestId?: string) {
    const run = async (tx: Prisma.TransactionClient) => {
      const permissions = await this.permissions(operator, tx)
      if (!permissions.includes('platform.tenants.read')) throw new ForbiddenException('Platform access denied')
      const configured = this.db.configured()
      const where: Prisma.TenantWhereInput = {
        ...(query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { slug: { contains: query.search, mode: 'insensitive' } }] } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.createdFrom || query.createdTo ? { createdAt: { ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}), ...(query.createdTo ? { lte: inclusiveDate(query.createdTo) } : {}) } } : {}),
        ...(query.country || query.classification ? { controlProfile: { is: { ...(query.country ? { country: query.country } : {}), ...(query.classification ? { classification: query.classification } : {}) } } } : {}),
      }
      if (!configured && (query.country || query.classification)) throw new BadRequestException('Business profile filters require tenant control configuration')
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0,0,0,0)
      const [rows, total, all, active, suspended, newThisMonth, pendingReview, incomplete] = await Promise.all([
        tx.tenant.findMany({ where, select: { ...tenantSelect, ...(configured ? { controlProfile: { select: { classification: true, country: true, stage: true } } } : {}) }, orderBy: [{ [query.sort ?? 'name']: query.order ?? 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        tx.tenant.count({ where }), tx.tenant.count(), tx.tenant.count({ where: { status: 'ACTIVE' } }), tx.tenant.count({ where: { status: 'SUSPENDED' } }), tx.tenant.count({ where: { createdAt: { gte: start } } }),
        configured ? tx.tenantControlProfile.count({ where: { stage: 'REVIEW' } }) : Promise.resolve(null),
        configured ? tx.tenant.count({ where: { OR: [{ controlProfile: { is: null } }, { controlProfile: { is: { stage: 'DRAFT' } } }] } }) : Promise.resolve(null),
      ])
      const items = await Promise.all(rows.map(async row => {
        const scoped = configured && permissions.includes('platform.tenants.access') ? await this.db.withPlatformTenant(operator, row.id, async c => {
          const [members, activity] = await Promise.all([c.membership.count({ where: { tenantId: row.id, revokedAt: null } }), c.auditEvent.findFirst({ where: { tenantId: row.id, action: { notIn: ['platform.tenant.context.entered','tenant.context.selected','platform.tenant.audit.read'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })])
          return { members, lastActivity: activity?.createdAt.toISOString() ?? null }
        }) : { members: null, lastActivity: null }
        return { ...row, createdAt: row.createdAt.toISOString(), profile: 'controlProfile' in row ? row.controlProfile : null, controlProfile: undefined, ...scoped }
      }))
      await this.audit(tx, operator, null, 'platform.tenants.directory.read', 'platform.tenants.read', { requestId: requestId ?? null, count: rows.length })
      return { items, total, page: query.page, pageSize: query.pageSize, metrics: { total: all, active, suspended, newThisMonth, pendingReview, incomplete }, permissions, authoringConfigured: configured }
    }
    return this.db.configured() ? this.db.withPlatform(operator, run) : this.prisma.withPlatform(operator, run)
  }
  async detail(operator: string, tenantId: string): Promise<TenantControlDetail> {
    return this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.access')
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: tenantSelect })
      if (!tenant) throw new NotFoundException('Tenant not found')
      const [profile, members, settings, agencies, suppliers, hotels, contracts, rates, restrictions, policies, connections, approvals] = await Promise.all([
        tx.tenantControlProfile.findUnique({ where: { tenantId } }),
        tx.membership.findMany({ where: { tenantId }, select: { id: true, role: true, revokedAt: true, user: { select: safeUser } }, orderBy: { createdAt: 'asc' }, take: 200 }),
        tx.tenantSettings.findUnique({ where: { tenantId } }),
        tx.agency.count({ where: { tenantId } }), tx.supplier.count({ where: { tenantId } }), tx.hotel.count({ where: { tenantId } }),
        tx.contract.count({ where: { tenantId } }), tx.ratePlan.count({ where: { tenantId } }), tx.distributionRestriction.count({ where: { tenantId } }), tx.commercialMarkupRule.count({ where: { tenantId } }), tx.supplierHotelMapping.count({ where: { tenantId } }),
        tx.approvalRequest.findMany({ where: { tenantId, entityType: 'tenant', action: ACTION }, orderBy: { createdAt: 'desc' }, take: 25 }),
      ])
      const roleAssignments = await tx.userRole.findMany({ where: { tenantId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })
      const owners = await tx.membership.count({ where: { tenantId, role: 'owner', revokedAt: null, user: { status: 'ACTIVE', lastLoginAt: { not: null } } } })
      await this.audit(tx, operator, tenantId, 'platform.tenant.context.entered', tenantId)
      return {
        platformContext: { permission: 'platform.tenants.access', targetTenantId: tenantId },
        tenant: { ...tenant, createdAt: tenant.createdAt.toISOString() }, profile: profile ? { business: profile.business as unknown as TenantBusiness, stage: profile.stage, complianceStatus: profile.complianceStatus, version: profile.version } : null,
        counts: { members: await tx.membership.count({ where: { tenantId, revokedAt: null } }), agencies, suppliers, hotels, contracts, ratePlans: rates, bookings: null, pendingApprovals: await tx.approvalRequest.count({ where: { tenantId, status: 'PENDING' } }) },
        readiness: tenantReadiness(profile, owners), permissions: await this.permissions(operator, tx),
        memberships: members.map(m => ({ ...m, revokedAt: m.revokedAt?.toISOString() ?? null, user: { id: m.user.id, email: m.user.email, name: m.user.name, lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null }, permissions: roleAssignments.filter(a => a.userId === m.user.id).flatMap(a => a.role.permissions.map(p => p.permission.key)) })),
        approvals: approvals.map(a => ({ id: a.id, status: a.status, reason: a.reason, requestedById: a.requestedById, proposedState: a.proposedState, createdAt: a.createdAt.toISOString() })),
        commercial: { contracts, restrictions, markupPolicies: policies, supplierConnections: connections },
        finance: { status: 'not_readable', message: 'Financial positions remain in the canonical finance workflow. Tenant authoring has no wallet or ledger grants.' },
        settings: settings ? { supportEmail: settings.supportEmail, defaultLanguage: settings.defaultLanguage, timeZone: settings.timeZone, defaultCurrency: settings.defaultCurrency.trim(), lowBalanceThreshold: { amountMinor: settings.lowBalanceThresholdMinor.toString(), currency: settings.lowBalanceCurrency.trim() } } : null,
      }
    })
  }
  async create(operator: string, input: CreateTenantDto, keyInput?: string) {
    const key = this.key(keyInput), business = this.business(input.business), fingerprint = hash({ ...input, business })
    return this.db.withPlatform(operator, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.create')
      await this.authorize(tx, operator, 'platform.tenants.memberships.manage')
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tenant-control-create'))`
      const prior = await this.replay(tx, operator, null, 'tenant.created', key, fingerprint)
      if (prior) return { id: prior.entityId }
      const admin = await tx.user.findUnique({ where: { email: input.administratorEmail.toLowerCase().trim() }, select: safeUser })
      if (!admin || admin.status !== 'ACTIVE' || !admin.lastLoginAt) throw new BadRequestException('Use an existing verified administrator. Secure email invitations are not configured.')
      if (admin.id === operator) throw new ForbiddenException('Operators cannot grant themselves tenant ownership')
      if (await tx.tenant.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw new ConflictException('Tenant slug already exists')
      const duplicate = await tx.tenantControlProfile.findUnique({ where: { registrationKey: registrationKey(business) }, select: { tenantId: true } })
      if (duplicate) throw new ConflictException('Company registration already exists in this country')
      const tenant = await tx.tenant.create({ data: { id: randomUUID(), name: business.name, slug: input.slug, status: 'SUSPENDED' }, select: { id: true } })
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`
      await tx.tenantControlProfile.create({ data: { tenantId: tenant.id, business: business as unknown as Prisma.InputJsonValue, registrationKey: registrationKey(business), classification: business.classification, country: business.country, stage: 'REVIEW', updatedBy: operator } })
      await tx.membership.create({ data: { userId: admin.id, tenantId: tenant.id, role: 'owner' } })
      await tx.tenantSettings.create({ data: { tenantId: tenant.id, defaultCurrency: business.currency, lowBalanceCurrency: business.currency } })
      await this.audit(tx, operator, null, 'tenant.created', tenant.id, { idempotencyKey: key, fingerprint, initialStatus: 'SUSPENDED' })
      await this.audit(tx, operator, tenant.id, 'tenant.created', tenant.id)
      return tenant
    })
  }
  async updateProfile(operator: string, tenantId: string, input: UpdateTenantProfileDto, keyInput?: string) {
    const key = this.key(keyInput), business = this.business(input.business), fingerprint = hash({ ...input, business })
    return this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.manage')
      await this.lock(tx, tenantId)
      if (await this.replay(tx, operator, tenantId, 'tenant.profile.updated', key, fingerprint)) return { id: tenantId }
      const current = await this.version(tx, tenantId, input.version)
      // Serializes company duplicate checks against both creation and concurrent edits.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tenant-control-create'))`
      await tx.tenant.update({ where: { id: tenantId }, data: { name: business.name } })
      await tx.tenantControlProfile.upsert({ where: { tenantId }, create: { tenantId, business: business as unknown as Prisma.InputJsonValue, registrationKey: registrationKey(business), classification: business.classification, country: business.country, stage: 'REVIEW', updatedBy: operator }, update: { business: business as unknown as Prisma.InputJsonValue, registrationKey: registrationKey(business), classification: business.classification, country: business.country, complianceStatus: 'PENDING', complianceApprovedBy: null, stage: 'REVIEW', updatedBy: operator, version: { increment: 1 } } })
      await this.audit(tx, operator, tenantId, 'tenant.profile.updated', tenantId, { idempotencyKey: key, fingerprint, previousVersion: current?.version ?? 0 })
      return { id: tenantId }
    })
  }
  async membership(operator: string, tenantId: string, input: MembershipChangeDto, keyInput?: string) {
    const key = this.key(keyInput), fingerprint = hash(input)
    return this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.memberships.manage')
      await this.lock(tx, tenantId)
      if (await this.replay(tx, operator, tenantId, 'tenant.membership.changed', key, fingerprint)) return { id: tenantId }
      await this.version(tx, tenantId, input.version)
      const user = await tx.user.findUnique({ where: { email: input.email.toLowerCase().trim() }, select: safeUser })
      if (!user || user.status !== 'ACTIVE' || !user.lastLoginAt) throw new BadRequestException('An existing verified user is required')
      if (user.id === operator) throw new ForbiddenException('Operators cannot change their own membership')
      const current = await tx.membership.findUnique({ where: { userId_tenantId: { userId: user.id, tenantId } } })
      const owners = await tx.membership.count({ where: { tenantId, role: 'owner', revokedAt: null, user: { status: 'ACTIVE' } } })
      if (current?.role === 'owner' && !current.revokedAt && input.role !== 'owner' && owners <= 1) throw new ConflictException('The final tenant administrator cannot be removed')
      if (input.role === 'revoke') {
        if (!current) throw new NotFoundException('Membership not found')
        await tx.membership.update({ where: { id: current.id }, data: { revokedAt: new Date() } })
      } else if (current) await tx.membership.update({ where: { id: current.id }, data: { role: input.role, revokedAt: null } })
      else await tx.membership.create({ data: { tenantId, userId: user.id, role: input.role } })
      await tx.tenantControlProfile.updateMany({ where: { tenantId }, data: { version: { increment: 1 } } })
      await this.audit(tx, operator, tenantId, 'tenant.membership.changed', tenantId, { idempotencyKey: key, fingerprint, targetUserId: user.id, role: input.role })
      return { id: tenantId }
    })
  }
  async compliance(operator: string, tenantId: string, input: ComplianceDecisionDto, keyInput?: string) {
    const key = this.key(keyInput), fingerprint = hash(input)
    return this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.compliance.approve')
      await this.lock(tx, tenantId)
      if (await this.replay(tx, operator, tenantId, 'tenant.compliance.decided', key, fingerprint)) return { id: tenantId }
      const profile = await this.version(tx, tenantId, input.version)
      if (!profile) throw new ConflictException('Business profile is required')
      if (profile.updatedBy === operator) throw new ForbiddenException('Compliance requires an independent reviewer')
      await tx.tenantControlProfile.update({ where: { tenantId }, data: { complianceStatus: input.decision, complianceApprovedBy: input.decision === 'APPROVED' ? operator : null, stage: input.decision === 'APPROVED' ? 'APPROVED' : 'REVIEW', version: { increment: 1 } } })
      await this.audit(tx, operator, tenantId, 'tenant.compliance.decided', tenantId, { idempotencyKey: key, fingerprint, decision: input.decision, reason: input.reason })
      return { id: tenantId }
    })
  }
  async requestLifecycle(operator: string, tenantId: string, input: LifecycleRequestDto, keyInput?: string) {
    const key = this.key(keyInput)
    await this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.lifecycle.request')
      await this.lock(tx, tenantId); await this.version(tx, tenantId, input.version)
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: tenantSelect })
      if (tenant.status === input.status) throw new ConflictException('Tenant already has the requested status')
    })
    const prior = await this.approvals.list(tenantId, { entityType: 'tenant', entityId: tenantId, limit: 100 })
    const same = prior.find(p => p.requestId === key)
    if (same && hash(same.proposedState) !== hash({ status: input.status, version: input.version })) throw new ConflictException('Idempotency key was reused with different lifecycle input')
    return this.approvals.request({ tenantId, requesterId: operator, action: ACTION, entityType: 'tenant', entityId: tenantId, requestId: key, reason: input.reason, proposedState: { status: input.status, version: input.version } })
  }
  async decideLifecycle(operator: string, tenantId: string, approvalId: string, input: LifecycleDecisionDto) {
    await this.db.withPlatformTenant(operator, tenantId, tx => this.authorize(tx, operator, 'platform.tenants.lifecycle.approve'))
    const approval = await this.approvals.get(tenantId, approvalId)
    if (approval.action !== ACTION || approval.entityType !== 'tenant' || approval.entityId !== tenantId) throw new NotFoundException('Tenant lifecycle request not found')
    await this.approvals.decide({ tenantId, approverId: operator, approvalId, decision: input.decision, reason: input.reason })
    if (input.decision === 'REJECTED') return { id: tenantId }
    return this.approvals.execute({ tenantId, executorId: operator, approvalId, expectedAction: ACTION }, async approved => {
      return this.db.withPlatformTenant(operator, tenantId, async tx => {
        await this.authorize(tx, operator, 'platform.tenants.lifecycle.approve')
        await this.lock(tx, tenantId)
        if (await tx.auditEvent.findFirst({ where: { tenantId, action: 'tenant.lifecycle.changed', payload: { path: ['approvalId'], equals: approvalId } } })) return { id: tenantId }
        const proposed = approved.proposedState as { status: 'ACTIVE' | 'SUSPENDED'; version: number }
        if (!proposed || !['ACTIVE','SUSPENDED'].includes(proposed.status) || !Number.isInteger(proposed.version)) throw new BadRequestException('Invalid approved transition')
        const profile = await this.version(tx, tenantId, proposed.version)
        if (proposed.status === 'ACTIVE') {
          const owners = await tx.membership.count({ where: { tenantId, role: 'owner', revokedAt: null, user: { status: 'ACTIVE', lastLoginAt: { not: null } } } })
          if (tenantReadiness(profile, owners).some(r => !r.ready)) throw new ConflictException('Activation readiness requirements are incomplete')
        }
        await tx.tenant.update({ where: { id: tenantId }, data: { status: proposed.status } })
        await tx.tenantControlProfile.updateMany({ where: { tenantId }, data: { version: { increment: 1 } } })
        await this.audit(tx, operator, tenantId, 'tenant.lifecycle.changed', tenantId, { status: proposed.status, approvalId, effectiveAt: new Date().toISOString() })
        return { id: tenantId }
      })
    })
  }
  async auditEvents(operator: string, tenantId: string, query: TenantAuditDto) {
    return this.db.withPlatformTenant(operator, tenantId, async tx => {
      await this.authorize(tx, operator, 'platform.tenants.audit.read')
      if (!await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })) throw new NotFoundException('Tenant not found')
      const where: Prisma.AuditEventWhereInput = { tenantId, ...(query.actor ? { userId: query.actor } : {}), ...(query.action ? { action: { contains: query.action } } : {}), ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: inclusiveDate(query.to) } : {}) } } : {}) }
      const [items, total] = await Promise.all([tx.auditEvent.findMany({ where, select: { id: true, action: true, entityType: true, entityId: true, userId: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25, skip: (query.page - 1) * 25 }), tx.auditEvent.count({ where })])
      return { items, total, page: query.page, pageSize: 25 }
    })
  }
}
