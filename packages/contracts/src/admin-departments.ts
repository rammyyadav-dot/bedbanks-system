/**
 * Enterprise Admin: departments and the scoped permission catalogue (ADR 0015).
 *
 * Departments are operational views over shared canonical domains, never copies of them.
 * This file is a catalogue, not an authorizer: the API remains the only place a permission is enforced
 * (tenant from the session, formal role assignments, fail closed). The Admin uses it for navigation only.
 *
 * Every permission is either `enforced` (an API guard checks it today and a test proves it) or `planned`
 * (named so departments can be designed against it; granted to nobody, checked nowhere).
 * A planned permission must never gate a visible control, and a department only appears in the sidebar
 * through modules that are `live`.
 */

export const DEPARTMENT_IDS = [
  'executive', 'contracting', 'supply', 'mapping', 'rates', 'commercial', 'distribution', 'connectivity', 'reservations',
  'reconciliation', 'clients', 'finance', 'service', 'risk', 'markets', 'platform', 'reliability', 'audit',
] as const
export type DepartmentId = (typeof DEPARTMENT_IDS)[number]

/** S0 read, S1 routine operation, S2 commercially sensitive, S3 transaction or security critical (maker-checker). */
export type ActionClass = 'S0' | 'S1' | 'S2' | 'S3'

/** Hard security boundary first. Region, country and destination are business scope only until the backend enforces them. */
export type PermissionScope = 'PLATFORM' | 'TENANT'

export type PermissionStatus = 'enforced' | 'planned'

export interface PermissionDef {
  key: string
  department: DepartmentId
  actionClass: ActionClass
  scope: PermissionScope
  status: PermissionStatus
  /** For a planned key: the enforced key it will eventually refine. Renaming is a separate, reviewed migration. */
  refines?: string
  /**
   * An approval action, not a grantable permission: it names what a maker-checker request authorises (ADR 0016).
   * Access to request, decide and execute it is gated by the permission in `refines`.
   */
  approvalOnly?: true
  description: string
}

const enforced = (key: string, department: DepartmentId, actionClass: ActionClass, description: string): PermissionDef =>
  ({ key, department, actionClass, scope: 'TENANT', status: 'enforced', description })
const planned = (key: string, department: DepartmentId, actionClass: ActionClass, description: string, refines?: string, scope: PermissionScope = 'TENANT'): PermissionDef =>
  ({ key, department, actionClass, scope, status: 'planned', description, ...(refines ? { refines } : {}) })

export const permissionCatalogue: readonly PermissionDef[] = [
  // Enforced today. These are the only keys an API guard checks.
  enforced('supply.hotels.read', 'supply', 'S0', 'View hotels and the commercial 360'),
  enforced('supply.hotels.manage', 'supply', 'S1', 'Create and edit hotel master data'),
  enforced('supply.rooms.read', 'supply', 'S0', 'View rooms'),
  enforced('supply.rooms.manage', 'supply', 'S1', 'Create and edit rooms'),
  enforced('supply.suppliers.read', 'connectivity', 'S0', 'View suppliers'),
  enforced('supply.suppliers.manage', 'connectivity', 'S1', 'Create and edit suppliers'),
  enforced('supply.mappings.read', 'mapping', 'S0', 'View hotel and room mappings'),
  enforced('supply.mappings.manage', 'mapping', 'S2', 'Approve, reject and reopen mappings'),
  enforced('supply.contracts.read', 'contracting', 'S0', 'View contracts'),
  enforced('supply.contracts.manage', 'contracting', 'S2', 'Create and edit contracts'),
  enforced('supply.rates.read', 'rates', 'S0', 'View rate plans, rates, board bases and sellability'),
  enforced('supply.rates.manage', 'rates', 'S2', 'Edit rate plans, rates and board bases'),
  enforced('supply.availability.read', 'rates', 'S0', 'View availability'),
  enforced('supply.availability.manage', 'rates', 'S2', 'Edit availability and stop-sell'),
  enforced('booking.read', 'reservations', 'S0', 'View bookings, holds and connector status'),
  enforced('booking.reconcile', 'reconciliation', 'S3', 'Run reconciliation of interrupted booking attempts'),
  enforced('booking.cancel', 'reservations', 'S3', 'Cancel a booking'),
  enforced('finance.read', 'finance', 'S0', 'View wallets and ledger'),
  enforced('funding.manage', 'finance', 'S3', 'Declare, verify, clear and post agency funding receipts (different people at each step; a second approver above the threshold)'),
  enforced('audit.read', 'audit', 'S0', 'View tenant audit events'),

  enforced('agency.read', 'clients', 'S0', 'View agencies and their members'),
  enforced('agency.manage', 'clients', 'S1', 'Create and edit agencies and manage their members'),
  enforced('case.read', 'service', 'S0', 'View service cases'),
  enforced('case.manage', 'service', 'S1', 'Open, assign, update and add notes to service cases'),
  enforced('distribution.read', 'distribution', 'S0', 'View distribution restrictions'),
  enforced('distribution.manage', 'distribution', 'S2', 'Create and retire distribution restrictions that hide inventory from an agency'),

  // Planned: named by the department matrix, granted to nobody and enforced nowhere.
  planned('contract.approve', 'contracting', 'S3', 'Approve a commercial contract (maker-checker)', 'supply.contracts.manage'),
  planned('contract.terminate', 'contracting', 'S3', 'Terminate a contract', 'supply.contracts.manage'),
  { key: 'hotel.activate', department: 'supply', actionClass: 'S3', scope: 'TENANT', status: 'enforced', refines: 'supply.hotels.manage', approvalOnly: true, description: 'Publish a hotel profile after the publication requirements are met (maker-checker, ADR 0022)' },
  planned('hotel.deactivate', 'supply', 'S2', 'Deactivate a hotel', 'supply.hotels.manage'),
  planned('mapping.override', 'mapping', 'S3', 'Override a mapping with audit evidence', 'supply.mappings.manage'),
  planned('rate.bulk_update', 'rates', 'S3', 'Bulk rate change', 'supply.rates.manage'),
  planned('availability.bulk_update', 'rates', 'S3', 'Bulk availability or allotment change', 'supply.availability.manage'),
  planned('stop_sell.update', 'rates', 'S2', 'Set or clear a stop-sell', 'supply.availability.manage'),
  { key: 'markup.activate', department: 'commercial', actionClass: 'S3', scope: 'TENANT', status: 'enforced', refines: 'supply.rates.manage', approvalOnly: true, description: 'Activate a NET-rate markup rule (maker-checker, ADR 0018)' },
  planned('distribution.rule.approve', 'distribution', 'S3', 'Approve a global or channel distribution rule'),
  planned('connector.credentials.manage', 'connectivity', 'S3', 'Manage connector credential references; never exposes a value'),
  planned('connector.search.activate', 'connectivity', 'S3', 'Activate search capability on a connector'),
  planned('connector.recheck.activate', 'connectivity', 'S3', 'Activate recheck capability on a connector'),
  planned('connector.booking.activate', 'connectivity', 'S3', 'Activate booking capability on a connector (technical and release approval)'),
  planned('connector.cancel.activate', 'connectivity', 'S3', 'Activate cancellation capability on a connector'),
  { key: 'reconciliation.resolve', department: 'reconciliation', actionClass: 'S3', scope: 'TENANT', status: 'enforced', refines: 'booking.reconcile', approvalOnly: true, description: 'Approve a reconciliation run through the canonical service (maker-checker, ADR 0017)' },
  { key: 'credit_limit.approve', department: 'finance', actionClass: 'S3', scope: 'TENANT', status: 'enforced', refines: 'agency.manage', approvalOnly: true, description: 'Set, change or remove an agency credit limit; new holds are refused over the limit (maker-checker, ADR 0024)' },
  planned('refund.request', 'finance', 'S2', 'Request a refund'),
  planned('refund.approve', 'finance', 'S3', 'Approve a refund (requester and approver differ)'),
  planned('adjustment.request', 'finance', 'S2', 'Request a ledger adjustment'),
  planned('adjustment.approve', 'finance', 'S3', 'Approve a ledger adjustment (requester and approver differ)'),
  { key: 'agency.suspend', department: 'clients', actionClass: 'S3', scope: 'TENANT', status: 'enforced', refines: 'agency.manage', approvalOnly: true, description: 'Suspend or reinstate an agency; a suspended agency cannot search or book (maker-checker, ADR 0020)' },
  planned('role_permission.assign', 'platform', 'S3', 'Change the permissions of a role (anti self-escalation)', undefined, 'PLATFORM'),
  planned('user_role.assign', 'platform', 'S3', 'Assign a role to a user (anti self-escalation)', undefined, 'PLATFORM'),
  planned('audit.export', 'audit', 'S3', 'Export audit events'),
]

/**
 * Permissions that must never exist, whoever asks. Held and sold inventory are transaction-controlled,
 * ledger and wallet balances move only through the finance service, and status changes only through
 * canonical booking services.
 */
export const FORBIDDEN_PERMISSION_KEYS = [
  'inventory.held.update', 'inventory.sold.update', 'ledger.update', 'wallet.balance.update',
  'booking.status.update', 'booking.confirm', 'admin.all', 'finance.all', 'hotel.manage_everything',
] as const

export type ModuleReadiness = 'live' | 'planned'

export interface DepartmentModule {
  /** Admin route. Present for a `live` module; a `planned` module has none. */
  href?: string
  label: string
  readiness: ModuleReadiness
  /** The enforced permission that gates the route, when it has one. */
  requires?: string
}

export interface DepartmentDef {
  id: DepartmentId
  label: string
  summary: string
  modules: readonly DepartmentModule[]
}

const live = (href: string, label: string, requires?: string): DepartmentModule => ({ href, label, readiness: 'live', ...(requires ? { requires } : {}) })
const todo = (label: string): DepartmentModule => ({ label, readiness: 'planned' })

export const departments: readonly DepartmentDef[] = [
  { id: 'executive', label: 'Control Tower', summary: 'Business-wide health and exceptions', modules: [live('/dashboard', 'Dashboard'), live('/exceptions', 'Exceptions', 'supply.hotels.read'), todo('Market performance')] },
  { id: 'contracting', label: 'Contracting & Sourcing', summary: 'Acquire hotel supply', modules: [live('/contracts', 'Contracts', 'supply.contracts.read'), todo('Contracting pipeline'), todo('Renewals'), todo('Commercial terms')] },
  { id: 'supply', label: 'Supply Operations', summary: 'Maintain hotel master data', modules: [live('/hotels', 'Hotels', 'supply.hotels.read'), todo('Hotel content and documents')] },
  { id: 'mapping', label: 'Mapping', summary: 'Normalize supplier inventory', modules: [live('/mappings', 'Mappings', 'supply.mappings.read'), todo('Duplicate candidates')] },
  { id: 'rates', label: 'Rates & Inventory', summary: 'Make contracted supply sellable', modules: [live('/board-basis', 'Board Basis', 'supply.rates.read'), live('/rates/plans', 'Rate Plans', 'supply.rates.read'), live('/rates', 'Rates & Inventory', 'supply.rates.read'), live('/sellability', 'Sellability', 'supply.rates.read'), live('/rate-certification', 'Rate Certification', 'supply.rates.read')] },
  { id: 'commercial', label: 'Commercial', summary: 'Margin and pricing rules', modules: [live('/commercial/markups', 'Markups', 'supply.rates.read'), todo('Promotions'), todo('Pricing analysis')] },
  { id: 'distribution', label: 'Distribution', summary: 'Where inventory is exposed', modules: [live('/distribution/restrictions', 'Restrictions', 'distribution.read'), todo('Markets and channels'), todo('Search monitor')] },
  { id: 'connectivity', label: 'Supplier Connectivity', summary: 'External supply integrations', modules: [live('/suppliers', 'Suppliers', 'supply.suppliers.read'), live('/connectors', 'Connectors', 'booking.read')] },
  { id: 'reservations', label: 'Reservations', summary: 'Booking operations', modules: [live('/operations', 'Readiness', 'booking.read'), live('/bookings', 'Bookings', 'booking.read'), live('/holds', 'Inventory holds', 'booking.read'), live('/cancellations', 'Cancellations', 'booking.cancel')] },
  { id: 'reconciliation', label: 'Reconciliation', summary: 'Unknown and pending supplier outcomes', modules: [live('/reconciliation', 'Reconciliation', 'booking.reconcile')] },
  { id: 'clients', label: 'Agents & Clients', summary: 'B2B buyer management', modules: [live('/clients/agencies', 'Agencies', 'agency.read'), todo('Commercial profiles'), todo('Credit and wallet limits')] },
  { id: 'finance', label: 'Finance', summary: 'Money and settlement', modules: [live('/finance/wallets', 'Wallets', 'finance.read'), live('/finance/ledger', 'Ledger', 'finance.read'), live('/finance/funding', 'Funding receipts', 'finance.read'), live('/finance/receivables', 'Receivables', 'finance.read'), todo('Payables'), todo('Refunds')] },
  { id: 'service', label: 'Service Operations', summary: 'Cases and escalations', modules: [live('/service/cases', 'Cases', 'case.read'), todo('Escalation policies')] },
  { id: 'risk', label: 'Risk & Compliance', summary: 'Verification and governance', modules: [live('/access-review', 'Access reviews', 'audit.read'), todo('Verification'), todo('Risk flags')] },
  { id: 'markets', label: 'Market Operations', summary: 'Regions, countries and destinations', modules: [live('/markets', 'Destinations', 'supply.hotels.read'), todo('Market bookings and revenue')] },
  { id: 'platform', label: 'Platform Administration', summary: 'Tenants, users, roles and configuration', modules: [live('/access', 'Roles & Permissions'), live('/settings', 'Settings'), todo('Tenants'), todo('Users')] },
  { id: 'reliability', label: 'System & Reliability', summary: 'Platform health', modules: [live('/reliability', 'System health', 'booking.read'), todo('Incidents')] },
  { id: 'audit', label: 'Audit & Security', summary: 'Evidence and investigation', modules: [live('/audit', 'Audit explorer', 'audit.read')] },
]

/** Sidebar groups: departments folded into the sections an operator works in. Only live modules render. */
export const sidebarGroups: ReadonlyArray<{ label: string; departments: readonly DepartmentId[] }> = [
  { label: 'Control tower', departments: ['executive', 'markets'] },
  { label: 'Supply & contracting', departments: ['contracting', 'supply', 'mapping', 'connectivity'] },
  { label: 'Rates & inventory', departments: ['rates', 'commercial', 'distribution'] },
  { label: 'Reservations', departments: ['reservations', 'reconciliation'] },
  { label: 'Clients & service', departments: ['clients', 'service'] },
  { label: 'Finance', departments: ['finance'] },
  { label: 'Platform', departments: ['platform', 'audit', 'risk', 'reliability'] },
]
