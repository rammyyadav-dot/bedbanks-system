/**
 * Connector administration (audit finding F4, ADR 0085). A connector is a tenant-owned, supplier-bound link to an upstream source. This API creates it as a DRAFT, attaches credential
 * *references* (never values), and activates it only after a second person approves exactly what was reviewed. It never accepts an endpoint URL or secret material: endpoints are
 * operator configuration (ADR 0060) and secrets live in the secret manager.
 */
export const CONNECTOR_TYPES = ['API_JSON', 'XML_IN', 'XML_OUT', 'CHANNEL_MANAGER', 'MANUAL_EXTRANET'] as const
export type ConnectorTypeName = (typeof CONNECTOR_TYPES)[number]

/** Read-only capabilities may be declared. Mutating ones (prebook, book, cancel) each need their own approved activation, which is not built (the planned `connector.*.activate` keys). */
export const DECLARABLE_CONNECTOR_CAPABILITIES = ['search', 'recheck', 'content', 'availability', 'status'] as const
export type DeclarableConnectorCapability = (typeof DECLARABLE_CONNECTOR_CAPABILITIES)[number]

export type ConnectorStatusName = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED'

/** The approval action that authorises activating a connector (maker-checker, ADR 0016). Gated by `supply.connectors.manage`. */
export const CONNECTOR_APPROVAL_ACTION = 'connector.activate'

export interface ConnectorCredentialView { purpose: string; status: 'configured' }
export interface ConnectorActivationView { approvalId: string; status: string; requestedById: string; requestId: string; reason: string; canDecide: boolean; canExecute: boolean }
export interface ConnectorAdminView {
  id: string
  supplierId: string
  supplierName: string
  type: ConnectorTypeName
  status: ConnectorStatusName
  name: string
  version: string
  capabilities: string[]
  credentials: ConnectorCredentialView[]
  /** The latest activation request still open (pending or approved, not yet executed), if any. */
  activation: ConnectorActivationView | null
  createdAt: string
  updatedAt: string
}

export interface CreateConnectorBody { supplierId: string; type: ConnectorTypeName; name: string; version: string; capabilities: DeclarableConnectorCapability[] }
/** `secretRef` is `aws-sm:<secret name>` under the connector's own prefix. A value is never accepted or returned. */
export interface SetConnectorCredentialBody { purpose: string; secretRef: string }
export interface ConnectorActivationRequestBody { requestId: string; reason: string }
export interface ConnectorDecisionBody { reason: string }
export interface ConnectorReasonBody { reason: string }
export interface ConnectorActivationResult { connector: ConnectorAdminView }

export const CONNECTOR_ERROR_CODES = {
  secretsNotConfigured: 'CONNECTOR_SECRETS_NOT_CONFIGURED',
  invalidSecretReference: 'CONNECTOR_SECRET_REFERENCE_INVALID',
  secretUnavailable: 'CONNECTOR_SECRET_UNAVAILABLE',
  capabilityNotEnableable: 'CONNECTOR_CAPABILITY_NOT_ENABLEABLE',
  notEditable: 'CONNECTOR_NOT_EDITABLE',
  duplicate: 'CONNECTOR_NAME_CONFLICT',
  changedSinceApproval: 'CONNECTOR_CHANGED_SINCE_APPROVAL',
} as const
