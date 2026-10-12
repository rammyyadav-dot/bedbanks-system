import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { evaluateReadiness } from '@bedbanks/connectors-core'
import type { ConnectorAdminView } from '@bedbanks/contracts'
import { PrismaService } from '../../database/prisma.service'
import { parseConnectorCreate, parseConnectorUpdate, parseCredentialPurpose, parseCredentialReference } from './connector-rules'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/
const ID = /^[A-Za-z0-9_-]{1,100}$/
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const refDigest = (ref: string): string => createHash('sha256').update(ref).digest('hex').slice(0, 16)

type Row = Prisma.ConnectorDefinitionGetPayload<{ include: { supplier: { select: { id: true; displayName: true } }; credentialReferences: { select: { purpose: true } } } }>

/**
 * Admin connector registration (ADR 0062). Tenant comes from the authenticated context only. Reads need `supply.suppliers.read`, writes
 * `supply.suppliers.manage`; every write is audited in the same transaction. A connector is created DRAFT and this service cannot
 * change `status`, `capabilities` or health: making a supplier live is a privileged, certified step that does not exist yet.
 * Readiness is computed from real state and honestly reports NOT_IMPLEMENTED while no provider profile is registered.
 */
@Injectable()
export class ConnectorAdminService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  private async permit(tenantId: string, userId: string, permission: 'supply.suppliers.read' | 'supply.suppliers.manage', requestId?: string): Promise<void> {
    const assignments = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    if (assignments.flatMap((a) => a.role.permissions.map((p) => p.permission.key)).includes(permission)) return
    await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'permission.denied', entityType: 'permission', entityId: permission, payload: { tenantId, requestId: requestId ?? null } } })).catch(() => undefined)
    throw new ForbiddenException('Insufficient permission')
  }

  private prefix(): string | undefined { return this.env.CONNECTOR_SECRET_PREFIX?.trim() || undefined }
  private allowedHosts(): string[] { return (this.env.CONNECTOR_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) }

  private async view(tx: Prisma.TransactionClient, tenantId: string, row: Row): Promise<ConnectorAdminView> {
    const meta = (row.transportMetadata && typeof row.transportMetadata === 'object' && !Array.isArray(row.transportMetadata) ? row.transportMetadata : {}) as Record<string, string>
    const mapped = await tx.supplierHotelMapping.count({ where: { tenantId, supplierId: row.supplierId, status: 'MAPPED' } })
    // No provider profile is registered in the API yet, so the profile is null and the report says NOT_IMPLEMENTED. Gates reflect real state.
    const report = evaluateReadiness(meta.provider ?? 'unknown', null, {
      active: row.status === 'ACTIVE',
      hasCredentialReference: row.credentialReferences.length > 0,
      secretResolverBound: this.prefix() !== undefined,
      endpointAllowlisted: !!meta.endpointHost && this.allowedHosts().includes(meta.endpointHost.toLowerCase()),
      sharedGateBound: false,
      governedMappingsPresent: mapped > 0,
      executionAuditWired: false,
    })
    return {
      id: row.id, supplierId: row.supplierId, supplierName: row.supplier.displayName, name: row.name, type: row.type, status: row.status, version: row.version,
      provider: meta.provider ?? null, transportMetadata: meta, healthState: row.healthState,
      credentials: row.credentialReferences.map((c) => ({ purpose: c.purpose, status: 'configured' as const })).sort((a, b) => a.purpose.localeCompare(b.purpose)),
      readiness: { certification: report.certification, searchable: report.searchable, bookable: report.bookable, gates: report.gates },
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }
  }

  private include() { return { supplier: { select: { id: true, displayName: true } }, credentialReferences: { select: { purpose: true } } } as const }

  async list(tenantId: string, userId: string, requestId?: string): Promise<ConnectorAdminView[]> {
    await this.permit(tenantId, userId, 'supply.suppliers.read', requestId)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.connectorDefinition.findMany({ where: { tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 200, include: this.include() })
      return Promise.all(rows.map((r) => this.view(tx, tenantId, r)))
    })
  }

  async get(tenantId: string, userId: string, connectorId: string, requestId?: string): Promise<ConnectorAdminView> {
    await this.permit(tenantId, userId, 'supply.suppliers.read', requestId)
    if (!ID.test(connectorId)) throw new NotFoundException('Connector not found')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId }, include: this.include() })
      if (!row) throw new NotFoundException('Connector not found')
      return this.view(tx, tenantId, row)
    })
  }

  async create(tenantId: string, userId: string, body: unknown, idempotencyKey: string | undefined, requestId?: string): Promise<ConnectorAdminView> {
    await this.permit(tenantId, userId, 'supply.suppliers.manage', requestId)
    const key = idempotencyKey?.trim() ?? ''
    if (!IDEMPOTENCY_KEY.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required.' })
    const input = parseConnectorCreate(body)
    const print = fingerprint(input)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const previous = await tx.auditEvent.findFirst({ where: { tenantId, action: 'supply.connector.created', payload: { path: ['idempotencyKey'], equals: key } } })
      if (previous) {
        if ((previous.payload as Prisma.JsonObject).fingerprint !== print) throw new ConflictException('Idempotency key was reused with a different connector')
        const again = await tx.connectorDefinition.findFirst({ where: { id: previous.entityId, tenantId }, include: this.include() })
        if (again) return this.view(tx, tenantId, again)
      }
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId }, select: { id: true } })
      if (!supplier) throw new NotFoundException('Supplier not found')
      if (await tx.connectorDefinition.findFirst({ where: { supplierId: supplier.id, name: input.name }, select: { id: true } })) throw new ConflictException({ code: 'CONNECTOR_NAME_TAKEN', message: 'This supplier already has a connector with that name.' })
      const created = await tx.connectorDefinition.create({ data: { tenantId, supplierId: supplier.id, type: input.type, name: input.name, version: input.version, transportMetadata: input.transportMetadata }, select: { id: true } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.connector.created', entityType: 'connector', entityId: created.id, payload: { outcome: 'allowed', requestId: requestId ?? null, idempotencyKey: key, fingerprint: print, supplierId: supplier.id, type: input.type, status: 'DRAFT' } } })
      return this.view(tx, tenantId, await tx.connectorDefinition.findFirstOrThrow({ where: { id: created.id, tenantId }, include: this.include() }))
    })
  }

  async update(tenantId: string, userId: string, connectorId: string, body: unknown, requestId?: string): Promise<ConnectorAdminView> {
    await this.permit(tenantId, userId, 'supply.suppliers.manage', requestId)
    const input = parseConnectorUpdate(body)
    if (!ID.test(connectorId)) throw new NotFoundException('Connector not found')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const current = await tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId }, select: { id: true, supplierId: true, name: true, version: true, status: true } })
      if (!current) throw new NotFoundException('Connector not found')
      // Editing the wire description of a live connector would change production behaviour without a certification step.
      if (current.status === 'ACTIVE' && input.transportMetadata) throw new ConflictException({ code: 'CONNECTOR_ACTIVE_LOCKED', message: 'Transport metadata of an active connector cannot be changed here.' })
      if (input.name && input.name !== current.name && await tx.connectorDefinition.findFirst({ where: { supplierId: current.supplierId, name: input.name, NOT: { id: current.id } }, select: { id: true } })) throw new ConflictException({ code: 'CONNECTOR_NAME_TAKEN', message: 'This supplier already has a connector with that name.' })
      await tx.connectorDefinition.update({ where: { id: current.id }, data: { ...(input.name && { name: input.name }), ...(input.version && { version: input.version }), ...(input.transportMetadata && { transportMetadata: input.transportMetadata }) }, select: { id: true } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.connector.updated', entityType: 'connector', entityId: current.id, payload: { outcome: 'allowed', requestId: requestId ?? null, fields: Object.keys(input), before: { name: current.name, version: current.version } } } })
      return this.view(tx, tenantId, await tx.connectorDefinition.findFirstOrThrow({ where: { id: current.id, tenantId }, include: this.include() }))
    })
  }

  async setCredential(tenantId: string, userId: string, connectorId: string, purposeInput: string, body: unknown, requestId?: string): Promise<ConnectorAdminView> {
    await this.permit(tenantId, userId, 'supply.suppliers.manage', requestId)
    const purpose = parseCredentialPurpose(purposeInput)
    if (!ID.test(connectorId)) throw new NotFoundException('Connector not found')
    const secretRef = parseCredentialReference(body, this.prefix(), { tenantId, connectorId }, purpose)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const connector = await tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId }, select: { id: true, status: true } })
      if (!connector) throw new NotFoundException('Connector not found')
      if (connector.status === 'ACTIVE') throw new ConflictException({ code: 'CONNECTOR_ACTIVE_LOCKED', message: 'Credentials of an active connector cannot be changed here.' })
      const existing = await tx.connectorCredentialReference.findUnique({ where: { connectorId_purpose: { connectorId, purpose } }, select: { id: true } })
      if (existing) await tx.connectorCredentialReference.update({ where: { id: existing.id }, data: { secretRef }, select: { id: true } })
      else await tx.connectorCredentialReference.create({ data: { connectorId, purpose, secretRef }, select: { id: true } })
      // Never the reference itself: a short digest lets an auditor match it without exposing the path.
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.connector.credential_set', entityType: 'connector', entityId: connectorId, payload: { outcome: 'allowed', requestId: requestId ?? null, purpose, referenceDigest: refDigest(secretRef), replaced: !!existing } } })
      return this.view(tx, tenantId, await tx.connectorDefinition.findFirstOrThrow({ where: { id: connectorId, tenantId }, include: this.include() }))
    })
  }

  async removeCredential(tenantId: string, userId: string, connectorId: string, purposeInput: string, requestId?: string): Promise<ConnectorAdminView> {
    await this.permit(tenantId, userId, 'supply.suppliers.manage', requestId)
    const purpose = parseCredentialPurpose(purposeInput)
    if (!ID.test(connectorId)) throw new NotFoundException('Connector not found')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const connector = await tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId }, select: { id: true, status: true } })
      if (!connector) throw new NotFoundException('Connector not found')
      if (connector.status === 'ACTIVE') throw new ConflictException({ code: 'CONNECTOR_ACTIVE_LOCKED', message: 'Credentials of an active connector cannot be changed here.' })
      const removed = await tx.connectorCredentialReference.deleteMany({ where: { connectorId, purpose } })
      if (removed.count === 0) throw new NotFoundException('Credential not found')
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.connector.credential_removed', entityType: 'connector', entityId: connectorId, payload: { outcome: 'allowed', requestId: requestId ?? null, purpose } } })
      return this.view(tx, tenantId, await tx.connectorDefinition.findFirstOrThrow({ where: { id: connectorId, tenantId }, include: this.include() }))
    })
  }
}
