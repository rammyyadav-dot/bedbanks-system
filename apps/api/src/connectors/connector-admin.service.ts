import { createHash } from 'node:crypto'
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  CONNECTOR_APPROVAL_ACTION, CONNECTOR_ERROR_CODES, CONNECTOR_TYPES, DECLARABLE_CONNECTOR_CAPABILITIES,
  type ConnectorAdminView, type ConnectorStatusName, type ConnectorTypeName, type CreateConnectorBody, type SetConnectorCredentialBody,
} from '@bedbanks/contracts'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { PrismaService } from '../database/prisma.service'
import { ConnectorSecretResolver, SecretResolutionError, scopedSecretName } from './connector-secret-resolver'

const ENTITY_TYPE = 'connector'
/** The approval action (ADR 0016), written out here so the permission catalogue spec can see it is checked; typed against the contracts constant so the two cannot drift. */
const ACTIVATE_ACTION: typeof CONNECTOR_APPROVAL_ACTION = 'connector.activate'
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,63}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/
const PURPOSE = /^[a-z][a-z0-9_]{1,31}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,80}$/

const INCLUDE = { supplier: { select: { displayName: true } }, credentialReferences: { select: { purpose: true, secretRef: true }, orderBy: { purpose: 'asc' } } } satisfies Prisma.ConnectorDefinitionInclude
type Row = Prisma.ConnectorDefinitionGetPayload<{ include: typeof INCLUDE }>

const exact = (body: unknown, allowed: string[], required: string[]): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A JSON object is required')
  const keys = Object.keys(body)
  if (keys.some((k) => !allowed.includes(k)) || required.some((k) => !keys.includes(k))) throw new BadRequestException(`Allowed fields: ${allowed.join(', ')}`)
  return body as Record<string, unknown>
}
const reasonOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) throw new BadRequestException('A reason of 3 to 500 characters is required')
  return value.trim()
}
const refHash = (reference: string) => createHash('sha256').update(reference).digest('hex').slice(0, 12)
const capabilitiesOf = (row: { capabilities: Prisma.JsonValue }): string[] => (Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is string => typeof c === 'string') : []).sort()
/** What an approver reviews, bound into the approval: version, capabilities and which credential references (by hash) are attached. */
const fingerprint = (row: Row) => createHash('sha256').update(JSON.stringify({ v: row.version, c: capabilitiesOf(row), r: row.credentialReferences.map((r) => [r.purpose, refHash(r.secretRef)]) })).digest('hex')

/**
 * Connector administration (audit finding F4, ADR 0085). The permission is declared and verified by the controller guard; tenant identity comes from the session. Every mutation is audited in
 * the same call, payloads carry ids, codes and a short hash of a reference, never a reference, a value or an endpoint. Activation is the only dangerous step and is maker-checker: a second
 * person approves a fingerprint of exactly what was reviewed, and execution re-checks it and that every referenced secret is in place and well formed.
 */
@Injectable()
export class ConnectorAdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService, private readonly secrets: ConnectorSecretResolver) {}

  private async load(tenantId: string, connectorId: string): Promise<Row> {
    if (!ID.test(connectorId)) throw new BadRequestException('Invalid connectorId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId }, include: INCLUDE }))
    if (!row) throw new NotFoundException('Connector not found')
    return row
  }

  private async view(tenantId: string, row: Row, userId?: string): Promise<ConnectorAdminView> {
    const open = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [row.id])).find((a) => a.action === ACTIVATE_ACTION && (a.status === 'PENDING' || a.status === 'APPROVED'))
    return {
      id: row.id, supplierId: row.supplierId, supplierName: row.supplier.displayName, type: row.type as ConnectorTypeName, status: row.status as ConnectorStatusName, name: row.name, version: row.version,
      capabilities: capabilitiesOf(row), credentials: row.credentialReferences.map((r) => ({ purpose: r.purpose, status: 'configured' as const })),
      activation: open ? { approvalId: open.id, status: open.status, requestedById: open.requestedById, requestId: open.requestId, reason: open.reason, canDecide: !!userId && open.status === 'PENDING' && open.requestedById !== userId, canExecute: open.status === 'APPROVED' } : null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }
  }

  async list(tenantId: string, userId: string, query: { supplierId?: string } = {}): Promise<ConnectorAdminView[]> {
    if (query.supplierId !== undefined && !ID.test(query.supplierId)) throw new BadRequestException('Invalid supplierId')
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.connectorDefinition.findMany({ where: { tenantId, ...(query.supplierId ? { supplierId: query.supplierId } : {}) }, include: INCLUDE, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 200 }))
    return Promise.all(rows.map((r) => this.view(tenantId, r, userId)))
  }

  async get(tenantId: string, userId: string, connectorId: string): Promise<ConnectorAdminView> { return this.view(tenantId, await this.load(tenantId, connectorId), userId) }

  async create(tenantId: string, userId: string, input: unknown): Promise<ConnectorAdminView> {
    const body = exact(input, ['supplierId', 'type', 'name', 'version', 'capabilities'], ['supplierId', 'type', 'name', 'version', 'capabilities']) as unknown as CreateConnectorBody
    if (typeof body.supplierId !== 'string' || !ID.test(body.supplierId)) throw new BadRequestException('Invalid supplierId')
    if (!(CONNECTOR_TYPES as readonly string[]).includes(body.type)) throw new BadRequestException(`type must be one of ${CONNECTOR_TYPES.join(', ')}`)
    if (typeof body.name !== 'string' || !NAME.test(body.name)) throw new BadRequestException('name must be 3 to 64 letters, digits, spaces, dots, underscores or hyphens')
    if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new BadRequestException('Invalid version')
    if (!Array.isArray(body.capabilities) || body.capabilities.length === 0 || new Set(body.capabilities).size !== body.capabilities.length) throw new BadRequestException('capabilities must be a non-empty list without duplicates')
    const refused = body.capabilities.filter((c) => !(DECLARABLE_CONNECTOR_CAPABILITIES as readonly string[]).includes(c))
    if (refused.length) throw new BadRequestException({ code: CONNECTOR_ERROR_CODES.capabilityNotEnableable, message: `Only ${DECLARABLE_CONNECTOR_CAPABILITIES.join(', ')} can be declared. Mutating capabilities (prebook, book, cancel) need their own approved activation, which is not built.` })
    try {
      const row = await this.prisma.withTenant(tenantId, async (tx) => {
        const supplier = await tx.supplier.findFirst({ where: { id: body.supplierId, tenantId }, select: { id: true } })
        if (!supplier) throw new BadRequestException('Supplier not found in this tenant')
        // The endpoint is operator configuration (ADR 0060), so transport metadata starts empty and this API cannot set it.
        return tx.connectorDefinition.create({ data: { tenantId, supplierId: body.supplierId, type: body.type, status: 'DRAFT', name: body.name, version: body.version, capabilities: [...body.capabilities].sort(), transportMetadata: {} }, include: INCLUDE })
      })
      await this.audit.record({ tenantId, userId, action: 'connector.created', entityType: ENTITY_TYPE, entityId: row.id, payload: { supplierId: row.supplierId, type: row.type, name: row.name, version: row.version, capabilities: capabilitiesOf(row) } })
      return this.view(tenantId, row, userId)
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.duplicate, message: 'This supplier already has a connector with that name.' })
      throw error
    }
  }

  /** Attaches or replaces the reference for one purpose. Never accepts a value; the reference must lie under this connector's own secret prefix. Only a DRAFT or SUSPENDED connector can change. */
  async setCredentialReference(tenantId: string, userId: string, connectorId: string, input: unknown): Promise<ConnectorAdminView> {
    const body = exact(input, ['purpose', 'secretRef'], ['purpose', 'secretRef']) as unknown as SetConnectorCredentialBody
    if (typeof body.purpose !== 'string' || !PURPOSE.test(body.purpose)) throw new BadRequestException('purpose must be 2 to 32 lowercase letters, digits or underscores')
    if (!this.secrets.configured()) throw new ServiceUnavailableException({ code: CONNECTOR_ERROR_CODES.secretsNotConfigured, message: 'Connector secrets are not configured on this deployment (CONNECTOR_SECRETS_PREFIX).' })
    const current = await this.load(tenantId, connectorId)
    try { scopedSecretName(body.secretRef, { tenantId, connectorId: current.id }, this.secrets.secretPrefix()) } catch (error) {
      throw new BadRequestException({ code: CONNECTOR_ERROR_CODES.invalidSecretReference, message: error instanceof SecretResolutionError && error.code === 'out_of_scope' ? 'The reference must be a secret under this connector\'s own prefix.' : 'The reference must be aws-sm:<secret name> under this connector\'s own prefix.' })
    }
    if (current.status === 'ACTIVE' || current.status === 'DISABLED') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: `A ${current.status.toLowerCase()} connector's credentials cannot change. Suspend it first.` })
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      const live = await tx.connectorDefinition.findFirst({ where: { id: current.id, tenantId, status: { in: ['DRAFT', 'SUSPENDED'] } }, select: { id: true } })
      if (!live) throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: 'The connector changed state; reload and retry.' })
      await tx.connectorCredentialReference.upsert({ where: { connectorId_purpose: { connectorId: current.id, purpose: body.purpose } }, create: { connectorId: current.id, purpose: body.purpose, secretRef: body.secretRef }, update: { secretRef: body.secretRef } })
      return tx.connectorDefinition.findFirstOrThrow({ where: { id: current.id, tenantId }, include: INCLUDE })
    })
    await this.audit.record({ tenantId, userId, action: 'connector.credential_reference.set', entityType: ENTITY_TYPE, entityId: current.id, payload: { purpose: body.purpose, referenceHash: refHash(body.secretRef) } })
    return this.view(tenantId, row, userId)
  }

  async requestActivation(tenantId: string, userId: string, connectorId: string, input: unknown): Promise<ConnectorAdminView> {
    const body = exact(input, ['requestId', 'reason'], ['requestId', 'reason']) as { requestId: unknown; reason: unknown }
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new BadRequestException('requestId must be 8 to 80 letters, digits or . _ : -')
    const reason = reasonOf(body.reason)
    const row = await this.load(tenantId, connectorId)
    if (row.status !== 'DRAFT' && row.status !== 'SUSPENDED') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: `Only a draft or suspended connector can be activated; this one is ${row.status.toLowerCase()}.` })
    if (row.credentialReferences.length === 0) throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: 'Attach at least one credential reference before requesting activation.' })
    const open = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [row.id])).find((a) => a.action === ACTIVATE_ACTION && (a.status === 'PENDING' || a.status === 'APPROVED') && a.requestId !== body.requestId)
    if (open) throw new ConflictException('This connector already has an open activation request')
    await this.approvals.request({
      tenantId, requesterId: userId, action: ACTIVATE_ACTION, entityType: ENTITY_TYPE, entityId: row.id, requestId: body.requestId, reason,
      beforeState: { status: row.status },
      proposedState: { fingerprint: fingerprint(row), version: row.version, capabilities: capabilitiesOf(row).join(','), purposes: row.credentialReferences.map((r) => r.purpose).join(',') },
    })
    return this.view(tenantId, row, userId)
  }

  private async approvalFor(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== ACTIVATE_ACTION) throw new BadRequestException('Not a connector activation approval')
    return a
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', input: unknown): Promise<ConnectorAdminView> {
    const a = await this.approvalFor(tenantId, approvalId)
    const body = exact(input, ['reason'], ['reason']) as { reason: unknown }
    await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: reasonOf(body.reason) })
    return this.view(tenantId, await this.load(tenantId, a.entityId), userId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<ConnectorAdminView> {
    const a = await this.approvalFor(tenantId, approvalId)
    await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.view(tenantId, await this.load(tenantId, a.entityId), userId)
  }

  /** Activates once. Re-checks, under the approval claim, that the connector is exactly what was approved and that every referenced secret resolves to well-formed material. */
  async execute(tenantId: string, userId: string, approvalId: string): Promise<ConnectorAdminView> {
    await this.approvalFor(tenantId, approvalId)
    const { result } = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: ACTIVATE_ACTION }, async (approval) => {
      const row = await this.load(tenantId, approval.entityId)
      if (row.status !== 'DRAFT' && row.status !== 'SUSPENDED') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: `The connector is ${row.status.toLowerCase()}, not a draft or suspended.` })
      const approved = (approval.proposedState ?? {}) as { fingerprint?: string }
      if (approved.fingerprint !== fingerprint(row)) throw new ConflictException({ code: CONNECTOR_ERROR_CODES.changedSinceApproval, message: 'The connector differs from what was approved. Request activation again.' })
      for (const ref of row.credentialReferences) {
        const check = await this.secrets.check(ref.secretRef, { tenantId, connectorId: row.id })
        if (!check.ok) throw new ConflictException({ code: CONNECTOR_ERROR_CODES.secretUnavailable, message: `The secret for credential purpose "${ref.purpose}" is not usable (${check.reason}). Put it in the secret manager and retry.` })
      }
      const changed = await this.prisma.withTenant(tenantId, (tx) => tx.connectorDefinition.updateMany({ where: { id: row.id, tenantId, status: row.status, version: row.version }, data: { status: 'ACTIVE' } }))
      if (changed.count !== 1) throw new ConflictException({ code: CONNECTOR_ERROR_CODES.changedSinceApproval, message: 'The connector changed while activating; retry.' })
      return { id: row.id, from: row.status }
    })
    await this.audit.record({ tenantId, userId, action: 'connector.activated', entityType: ENTITY_TYPE, entityId: result.id, payload: { approvalId, from: result.from } })
    return this.view(tenantId, await this.load(tenantId, result.id), userId)
  }

  /** Stopping use is always allowed and direct: it is the safe direction. */
  async suspend(tenantId: string, userId: string, connectorId: string, input: unknown): Promise<ConnectorAdminView> { return this.stop(tenantId, userId, connectorId, input, 'SUSPENDED') }
  async disable(tenantId: string, userId: string, connectorId: string, input: unknown): Promise<ConnectorAdminView> { return this.stop(tenantId, userId, connectorId, input, 'DISABLED') }

  private async stop(tenantId: string, userId: string, connectorId: string, input: unknown, to: 'SUSPENDED' | 'DISABLED'): Promise<ConnectorAdminView> {
    const reason = reasonOf((exact(input, ['reason'], ['reason']) as { reason: unknown }).reason)
    const row = await this.load(tenantId, connectorId)
    if (row.status === to) return this.view(tenantId, row, userId)
    if (row.status === 'DISABLED') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: 'A disabled connector is final.' })
    if (to === 'SUSPENDED' && row.status !== 'ACTIVE') throw new ConflictException({ code: CONNECTOR_ERROR_CODES.notEditable, message: 'Only an active connector can be suspended.' })
    const changed = await this.prisma.withTenant(tenantId, (tx) => tx.connectorDefinition.updateMany({ where: { id: row.id, tenantId, status: row.status }, data: { status: to } }))
    if (changed.count === 1) await this.audit.record({ tenantId, userId, action: to === 'SUSPENDED' ? 'connector.suspended' : 'connector.disabled', entityType: ENTITY_TYPE, entityId: row.id, payload: { from: row.status, reason } })
    return this.view(tenantId, await this.load(tenantId, row.id), userId)
  }
}
