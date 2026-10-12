/** Admin connector API (ADR 0062). Credentials are shown as configured/missing by purpose only; a reference path is never echoed back. */
export type ConnectorTypeValue = 'API_JSON' | 'XML_IN' | 'XML_OUT' | 'CHANNEL_MANAGER' | 'MANUAL_EXTRANET'
export type ConnectorStatusValue = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED'
export type ConnectorCertificationValue = 'NOT_IMPLEMENTED' | 'FIXTURE_ONLY' | 'SANDBOX_CERTIFIED' | 'PRODUCTION_CERTIFIED'
export interface ConnectorReadinessGateView { id: string; passed: boolean; detail: string }
export interface ConnectorReadinessView { certification: ConnectorCertificationValue; searchable: boolean; bookable: boolean; gates: ConnectorReadinessGateView[] }
export interface ConnectorAdminView {
  id: string
  supplierId: string
  supplierName: string
  name: string
  type: ConnectorTypeValue
  status: ConnectorStatusValue
  version: string
  provider: string | null
  transportMetadata: Record<string, string>
  healthState: string
  credentials: Array<{ purpose: string; status: 'configured' }>
  readiness: ConnectorReadinessView
  createdAt: string
  updatedAt: string
}
export interface ConnectorCreateRequest { supplierId: string; name: string; type: ConnectorTypeValue; version: string; transportMetadata?: Record<string, string> }
export interface ConnectorUpdateRequest { name?: string; version?: string; transportMetadata?: Record<string, string> }
export interface ConnectorCredentialRequest { secretRef: string }
