/**
 * The one authoritative definition of what the API runtime database role (`fbeds_api`) may do (ADR 0031, ADR 0032).
 *
 * Everything else is derived from this module: the provisioning statements, the live verifier, the 403/503 classification of a
 * database denial, the generated privilege matrix in docs/strict-runtime-db-role.md, and the drift guards in the specs
 * (the forward migration must equal it; every runtime write in the source tree must be covered by it or listed as a privileged path).
 * Do not state a grant anywhere else.
 *
 * Three separate enforcement layers apply to every request: application RBAC (guards and per-service permission checks),
 * PostgreSQL privileges (this module), and row-level security (tenant policies). Passing one never implies passing the others.
 */

export type WritePrivilege = 'INSERT' | 'UPDATE' | 'DELETE'

export interface RuntimeWrite {
  op: WritePrivilege
  /** Column-level grant. Absent means the whole table. */
  columns?: readonly string[]
  /** The application service that performs it. */
  service: string
  endpoints: readonly string[]
  reason: string
}

export interface RuntimeGrant {
  table: string
  /** The Prisma model that maps to the table (for the drift scan). */
  model: string
  read: boolean
  writes: readonly RuntimeWrite[]
  /** `forced-tenant`: forced RLS on tenant_id through fbeds_current_tenant_id(). `none`: authentication tables outside RLS. */
  rls: 'forced-tenant' | 'none'
  note?: string
}

const ADMIN_CLIENTS = '/admin/clients'
const HOTEL = '/admin/hotels/:hotelId'

/** Hotel columns the named Admin workflows write (setup, status, amenities touch, publication). Nothing else on Hotel is writable. */
export const HOTEL_WRITE_COLUMNS = ['name', 'property_type', 'country_code', 'city', 'address', 'latitude', 'longitude', 'time_zone', 'star_rating', 'content_status', 'updated_at'] as const

/** RoomType columns the Admin rooms workflow updates. Nothing else on RoomType (id, hotel_id, created_at) is writable. */
export const ROOM_WRITE_COLUMNS = ['name', 'code', 'max_adults', 'max_children', 'max_occupancy', 'bedding_metadata', 'is_active', 'updated_at'] as const

/** Amenity columns the runtime may update (a fee type change). The hotel, room and tenant a row belongs to are immutable for the role (ADR 0032 amendment). */
export const AMENITY_UPDATE_COLUMNS = ['fee_type', 'updated_by_id', 'updated_at'] as const

/** Tables the runtime reads and never writes. */
const READ_ONLY: ReadonlyArray<{ table: string; model: string; rls: RuntimeGrant['rls']; note?: string }> = [
  { table: 'tenants', model: 'Tenant', rls: 'none' },
  { table: 'memberships', model: 'Membership', rls: 'forced-tenant', note: 'also readable by the transaction-local app.current_user_id before a tenant is chosen (ADR 0008)' },
  { table: 'Permission', model: 'Permission', rls: 'none' },
  { table: 'Role', model: 'Role', rls: 'forced-tenant' },
  { table: 'UserRole', model: 'UserRole', rls: 'forced-tenant' },
  { table: 'RolePermission', model: 'RolePermission', rls: 'forced-tenant' },
  { table: 'HotelSearchIndex', model: 'HotelSearchIndex', rls: 'forced-tenant' },
  { table: 'BoardBasis', model: 'BoardBasis', rls: 'forced-tenant' },
  { table: 'Supplier', model: 'Supplier', rls: 'forced-tenant' },
  { table: 'SupplierHotelMapping', model: 'SupplierHotelMapping', rls: 'forced-tenant' },
  { table: 'SupplierRoomMapping', model: 'SupplierRoomMapping', rls: 'forced-tenant' },
  { table: 'supplier_memberships', model: 'SupplierMembership', rls: 'forced-tenant' },
  { table: 'Contract', model: 'Contract', rls: 'forced-tenant' },
  { table: 'RatePlan', model: 'RatePlan', rls: 'forced-tenant' },
  { table: 'DailyRate', model: 'DailyRate', rls: 'forced-tenant' },
  { table: 'DailyAvailability', model: 'DailyAvailability', rls: 'forced-tenant' },
  { table: 'CancellationPolicy', model: 'CancellationPolicy', rls: 'forced-tenant', note: 'search and recheck include each contract\'s cancellation terms' },
  { table: 'InventoryPool', model: 'InventoryPool', rls: 'forced-tenant', note: 'pool writes are a privileged path: a pool change also needs RatePlan and DailyAvailability writes' },
  { table: 'InventoryPoolDay', model: 'InventoryPoolDay', rls: 'forced-tenant', note: 'stock moves belong to the hold path and the hold-expiry role' },
]

/** Tables the runtime also writes, each with the exact operation, service, endpoints and reason. */
const READ_WRITE: readonly RuntimeGrant[] = [
  { table: 'users', model: 'User', read: true, rls: 'none', writes: [
    { op: 'UPDATE', columns: ['last_login_at', 'updated_at'], service: 'AuthService.login', endpoints: ['POST /auth/login'], reason: 'record the last successful sign-in' },
  ] },
  { table: 'sessions', model: 'Session', read: true, rls: 'none', writes: [
    { op: 'INSERT', service: 'AuthService.login', endpoints: ['POST /auth/login'], reason: 'create the opaque session (ADR 0001)' },
    { op: 'UPDATE', columns: ['last_seen_at', 'revoked_at'], service: 'AuthService (session guard, logout)', endpoints: ['every authenticated route', 'POST /auth/logout'], reason: 'slide and revoke the session' },
  ] },
  { table: 'AuditEvent', model: 'AuditEvent', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'AuditService and the RBAC guards', endpoints: ['every mutation and every denial'], reason: 'immutable audit trail (INSERT only: no UPDATE or DELETE)' },
  ] },
  { table: 'supplier_room_drafts', model: 'SupplierRoomDraft', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'SupplierExtranetService.upsertRoomDraft', endpoints: ['PATCH /supplier/extranet/hotels/:hotelId/rooms/:roomId/draft'], reason: 'supplier room-note drafts (ADR 0011)' },
    { op: 'UPDATE', service: 'SupplierExtranetService.upsertRoomDraft', endpoints: ['PATCH /supplier/extranet/hotels/:hotelId/rooms/:roomId/draft'], reason: 'edit an own draft' },
  ] },

  { table: 'Agency', model: 'Agency', read: true, rls: 'forced-tenant', note: 'also read by the agency-suspension guard and the distribution lookup (mandatory commercial control)', writes: [
    { op: 'INSERT', service: 'ClientsService.create', endpoints: [`POST ${ADMIN_CLIENTS}/agencies`], reason: 'create an agency' },
    { op: 'UPDATE', service: 'ClientsService.update; AgencySuspensionService.execute', endpoints: [`PATCH ${ADMIN_CLIENTS}/agencies/:agencyId`, `POST ${ADMIN_CLIENTS}/agencies/suspension-approvals/:approvalId/execute`], reason: 'edit an agency; apply an approved suspension change' },
  ] },
  { table: 'AgencyMember', model: 'AgencyMember', read: true, rls: 'forced-tenant', note: 'also read by the suspension guard and the distribution lookup (mandatory commercial control)', writes: [
    { op: 'INSERT', service: 'ClientsService.addMember', endpoints: [`POST ${ADMIN_CLIENTS}/agencies/:agencyId/members`], reason: 'attach a user to an agency' },
    { op: 'DELETE', service: 'ClientsService.removeMember', endpoints: [`DELETE ${ADMIN_CLIENTS}/agencies/:agencyId/members/:userId`], reason: 'detach a user from an agency' },
  ] },
  { table: 'AgencyCreditLimit', model: 'AgencyCreditLimit', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'AgencyCreditService.execute', endpoints: [`POST ${ADMIN_CLIENTS}/agencies/credit-approvals/:approvalId/execute`], reason: 'set the first credit limit after approval' },
    { op: 'UPDATE', service: 'AgencyCreditService.execute', endpoints: [`POST ${ADMIN_CLIENTS}/agencies/credit-approvals/:approvalId/execute`], reason: 'change the limit after approval' },
    { op: 'DELETE', service: 'AgencyCreditService.execute', endpoints: [`POST ${ADMIN_CLIENTS}/agencies/credit-approvals/:approvalId/execute`], reason: 'remove the limit after approval' },
  ] },
  { table: 'ApprovalRequest', model: 'ApprovalRequest', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'ApprovalService.request', endpoints: ['POST /admin/commercial/markups/:ruleId/request-activation', `POST ${ADMIN_CLIENTS}/agencies/:agencyId/request-suspension-change`, `POST ${ADMIN_CLIENTS}/agencies/:agencyId/request-credit-limit`, `POST ${HOTEL}/setup/publication/request`], reason: 'maker-checker request (ADR 0016)' },
    { op: 'UPDATE', service: 'ApprovalService.decide/cancel/execute', endpoints: ['POST .../approvals/:approvalId/{approve,reject,cancel,execute}'], reason: 'record the decision and the execution' },
  ] },
  { table: 'CommercialMarkupRule', model: 'CommercialMarkupRule', read: true, rls: 'forced-tenant', note: 'also read by Agent search and recheck when a NET rate is priced (mandatory commercial control)', writes: [
    { op: 'INSERT', service: 'CommercialMarkupService.create', endpoints: ['POST /admin/commercial/markups'], reason: 'draft a markup rule' },
    { op: 'UPDATE', service: 'CommercialMarkupService.retire/execute', endpoints: ['POST /admin/commercial/markups/:ruleId/retire', 'POST /admin/commercial/markups/approvals/:approvalId/execute'], reason: 'activate or retire a rule (rules are otherwise immutable)' },
  ] },
  { table: 'DistributionRestriction', model: 'DistributionRestriction', read: true, rls: 'forced-tenant', note: 'also read by Agent search and recheck (mandatory commercial control)', writes: [
    { op: 'INSERT', service: 'DistributionService.create', endpoints: ['POST /admin/distribution/restrictions'], reason: 'restrict a hotel or supplier for an agency' },
    { op: 'UPDATE', service: 'DistributionService.retire', endpoints: ['POST /admin/distribution/restrictions/:restrictionId/retire'], reason: 'retire a restriction' },
  ] },
  { table: 'ServiceCase', model: 'ServiceCase', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'ServiceCasesService.create', endpoints: ['POST /admin/service/cases'], reason: 'open a case' },
    { op: 'UPDATE', service: 'ServiceCasesService.transition/assign', endpoints: ['POST /admin/service/cases/:caseId/transition', 'POST /admin/service/cases/:caseId/assign'], reason: 'move or assign a case' },
  ] },
  { table: 'ServiceCaseNote', model: 'ServiceCaseNote', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'ServiceCasesService.addNote/transition/assign', endpoints: ['POST /admin/service/cases/:caseId/notes'], reason: 'append a note (notes are immutable)' },
  ] },

  { table: 'Hotel', model: 'Hotel', read: true, rls: 'forced-tenant', note: 'INSERT, plus column-level UPDATE only; DELETE and every other column stay with the privileged supply-authoring path', writes: [
    { op: 'INSERT', service: 'SupplyService.createHotel', endpoints: ['POST /supply/hotels (Admin "Add hotel")'], reason: 'create a draft hotel, the first step of the setup journey (publication stays a separate maker-checker step)' },
    { op: 'UPDATE', columns: HOTEL_WRITE_COLUMNS, service: 'HotelSetupService.save/changeStatus; touchSetup (amenities); HotelPublicationService.execute', endpoints: [`PATCH ${HOTEL}/setup`, `POST ${HOTEL}/setup/status`, `PUT ${HOTEL}/amenities`, `POST ${HOTEL}/setup/publication/:approvalId/execute`], reason: 'the profile workflows also stamp or change the hotel row (details, status, updated_at stale-token)' },
  ] },
  { table: 'HotelProfile', model: 'HotelProfile', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'HotelSetupService; touchSetup; HotelPublicationService', endpoints: [`PATCH ${HOTEL}/setup`, `POST ${HOTEL}/setup/status`, `PUT ${HOTEL}/amenities`], reason: 'first save of a hotel profile' },
    { op: 'UPDATE', service: 'HotelSetupService; touchSetup; HotelPublicationService', endpoints: [`PATCH ${HOTEL}/setup`, `POST ${HOTEL}/setup/status`, `PUT ${HOTEL}/amenities`, `POST ${HOTEL}/setup/publication/:approvalId/execute`], reason: 'save the profile, bump its version, stamp the approver' },
  ] },
  { table: 'HotelExternalIdentifier', model: 'HotelExternalIdentifier', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'HotelSetupService.save', endpoints: [`PATCH ${HOTEL}/setup`], reason: 'add an external identifier' },
    { op: 'DELETE', service: 'HotelSetupService.save', endpoints: [`PATCH ${HOTEL}/setup`], reason: 'remove or replace an identifier (a changed value is delete plus insert, so no UPDATE)' },
  ] },
  { table: 'HotelAmenity', model: 'HotelAmenity', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'HotelAmenitiesService.replace', endpoints: [`PUT ${HOTEL}/amenities`], reason: 'add an amenity' },
    { op: 'UPDATE', columns: AMENITY_UPDATE_COLUMNS, service: 'HotelAmenitiesService.replace', endpoints: [`PUT ${HOTEL}/amenities`], reason: 'change an amenity fee type (upsert); the hotel it belongs to cannot be reassigned' },
    { op: 'DELETE', service: 'HotelAmenitiesService.replace', endpoints: [`PUT ${HOTEL}/amenities`], reason: 'remove an amenity' },
  ] },
  { table: 'RoomType', model: 'RoomType', read: true, rls: 'forced-tenant', note: 'row-level security through the room\'s hotel', writes: [
    { op: 'INSERT', service: 'HotelRoomsService.create', endpoints: [`POST ${HOTEL}/rooms`], reason: 'add a canonical room to a hotel (publication needs one active room)' },
    { op: 'UPDATE', columns: ROOM_WRITE_COLUMNS, service: 'HotelRoomsService.update/archive/restore', endpoints: [`PATCH ${HOTEL}/rooms/:roomId`, `POST ${HOTEL}/rooms/:roomId/archive`, `POST ${HOTEL}/rooms/:roomId/restore`], reason: 'edit, archive or restore a room (rooms are never deleted)' },
  ] },
  { table: 'RoomAmenity', model: 'RoomAmenity', read: true, rls: 'forced-tenant', writes: [
    { op: 'INSERT', service: 'HotelRoomsService.replaceAmenities', endpoints: [`POST ${HOTEL}/rooms`, `PATCH ${HOTEL}/rooms/:roomId`], reason: 'record a room amenity' },
    { op: 'UPDATE', columns: AMENITY_UPDATE_COLUMNS, service: 'HotelRoomsService.replaceAmenities', endpoints: [`PATCH ${HOTEL}/rooms/:roomId`], reason: 'change an amenity fee type (upsert); the room it belongs to cannot be reassigned' },
    { op: 'DELETE', service: 'HotelRoomsService.replaceAmenities', endpoints: [`PATCH ${HOTEL}/rooms/:roomId`], reason: 'remove an amenity from a room' },
  ] },
  { table: 'HotelImage', model: 'HotelImage', read: true, rls: 'forced-tenant', note: 'also read by Agent search (primary image) and the Agent image route', writes: [
    { op: 'INSERT', service: 'HotelImagesService.upload', endpoints: [`POST ${HOTEL}/images`], reason: 'upload an image' },
    { op: 'UPDATE', service: 'HotelImagesService.update/reorder', endpoints: [`PATCH ${HOTEL}/images/:imageId`, `PUT ${HOTEL}/images/order`], reason: 'edit, reorder, choose the primary image' },
    { op: 'DELETE', service: 'HotelImagesService.remove', endpoints: [`DELETE ${HOTEL}/images/:imageId`], reason: 'delete an image' },
  ] },
]

export const RUNTIME_ROLE_GRANTS: readonly RuntimeGrant[] = [
  ...READ_ONLY.map((r): RuntimeGrant => ({ ...r, read: true, writes: [] })),
  ...READ_WRITE,
]

/**
 * Tables the API process writes in some code path that the runtime role deliberately does NOT write. Each is a PRIVILEGED PATH:
 * the write belongs to a trusted operator or a separate role, or to a capability that is gated off. The runtime answers a caller who
 * reaches one with a typed 403 (`RUNTIME_ROLE_OPERATION_PROHIBITED`), never a 5xx. `Hotel` and `users` appear here too: the runtime
 * holds only their listed columns, the rest of their writes (hotel insert, other columns; user creation) are privileged.
 */
export const PRIVILEGED_WRITE_MODELS: Readonly<Record<string, string>> = {
  Hotel: 'DELETE, external_ref and any column outside the profile set (supply authoring); INSERT and the profile columns are granted',
  BoardBasis: 'supply authoring',
  Supplier: 'supply authoring', Contract: 'supply authoring', RatePlan: 'supply authoring and pool membership/release', DailyRate: 'supply authoring and Quick Update',
  DailyAvailability: 'supply authoring and Quick Update', BookingLeadTimeRule: 'supply authoring', CancellationPolicy: 'supply authoring', ChildPolicy: 'supply authoring',
  SupplierHotelMapping: 'mapping governance', SupplierRoomMapping: 'mapping governance',
  InventoryPool: 'pool authoring needs RatePlan and DailyAvailability writes', InventoryPoolDay: 'pool authoring and stock moves (hold path, hold-expiry role)',
  SupplierMutation: 'booking mutation journal: written only by prebook, confirmation and reconciliation, which are gated off and need booking tables the role never holds',
  Booking: 'booking is disabled; finance-gated', BookingDocument: 'booking is disabled', InventoryHold: 'holds are gated; written by the booking path',
  InventoryHoldNight: 'holds are gated', LedgerEntry: 'finance-gated', Cancellation: 'booking is disabled',
  HotelSearchIndex: 'search-index maintenance (reindex) is an operator job; the runtime only reads the index',
  Tenant: 'tenant settings authoring', TenantSettings: 'tenant settings authoring',
  User: 'identity provisioning (create user) is an operator action; the runtime only records the last sign-in',
  PlatformRole: 'platform administration', PlatformRoleAssignment: 'platform administration', PlatformRolePermission: 'platform administration',
}

// ---- Derived views -----------------------------------------------------------------------------------------------------------------

const quote = (name: string) => `"${name}"`

/** Statements the owner runs. REVOKE ALL first, then exactly the contract. */
export function runtimeGrantStatements(group: string): string[] {
  const role = quote(group)
  const statements = [`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`, `GRANT USAGE ON SCHEMA public TO ${role}`]
  for (const grant of RUNTIME_ROLE_GRANTS) {
    const table = quote(grant.table)
    const privileges: string[] = [...(grant.read ? ['SELECT'] : []), ...grant.writes.filter((w) => !w.columns).map((w) => w.op)]
    const ordered = (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const).filter((p) => privileges.includes(p))
    if (ordered.length) statements.push(`GRANT ${ordered.join(', ')} ON ${table} TO ${role}`)
    for (const write of grant.writes.filter((w) => w.columns)) statements.push(`GRANT ${write.op} (${write.columns!.map(quote).join(', ')}) ON ${table} TO ${role}`)
  }
  return statements
}

/** Every table-level or column-level write the contract grants: the expected state the verifier compares against. */
export function expectedWrites(): Map<string, { table: Set<WritePrivilege>; columns: Map<WritePrivilege, Set<string>> }> {
  const out = new Map<string, { table: Set<WritePrivilege>; columns: Map<WritePrivilege, Set<string>> }>()
  for (const grant of RUNTIME_ROLE_GRANTS) {
    if (grant.writes.length === 0) continue
    const entry = { table: new Set<WritePrivilege>(), columns: new Map<WritePrivilege, Set<string>>() }
    for (const write of grant.writes) {
      if (write.columns) entry.columns.set(write.op, new Set(write.columns))
      else entry.table.add(write.op)
    }
    out.set(grant.table, entry)
  }
  return out
}

export const RUNTIME_READ_TABLES = RUNTIME_ROLE_GRANTS.filter((g) => g.read).map((g) => g.table)

const cell = (value: boolean) => (value ? 'yes' : '-')
const opCell = (grant: RuntimeGrant, op: WritePrivilege): string => {
  const write = grant.writes.find((w) => w.op === op)
  return write ? (write.columns ? `cols (${write.columns.length})` : 'yes') : '-'
}

/** The generated privilege matrix embedded in docs/strict-runtime-db-role.md. */
export function renderRuntimeRoleMatrix(): string {
  const lines = [
    '| Table | SELECT | INSERT | UPDATE | DELETE | RLS | Writer (service, endpoints) and reason |',
    '| --- | :-: | :-: | :-: | :-: | --- | --- |',
  ]
  for (const grant of [...RUNTIME_ROLE_GRANTS].sort((a, b) => a.table.localeCompare(b.table))) {
    const who = grant.writes.length
      ? [...new Map(grant.writes.map((w) => [`${w.service}|${w.reason}`, w])).values()].map((w) => `${w.op}${w.columns ? ` (${w.columns.join(', ')})` : ''}: ${w.service}; ${w.endpoints.join(', ')}; ${w.reason}`).join(' / ')
      : (grant.note ?? 'read only')
    lines.push(`| \`${grant.table}\` | ${cell(grant.read)} | ${opCell(grant, 'INSERT')} | ${opCell(grant, 'UPDATE')} | ${opCell(grant, 'DELETE')} | ${grant.rls === 'forced-tenant' ? 'forced tenant' : 'none (auth)'} | ${who} |`)
  }
  lines.push('', 'Privileged paths (written by the API process somewhere, never by the runtime role):', '')
  for (const [model, reason] of Object.entries(PRIVILEGED_WRITE_MODELS).sort(([a], [b]) => a.localeCompare(b))) lines.push(`- \`${model}\`: ${reason}`)
  return lines.join('\n')
}
