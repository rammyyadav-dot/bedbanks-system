export type Role = 'platform_admin' | 'tenant_admin' | 'ops_agent' | 'finance_viewer'
export type Permission = 'tenant:read' | 'tenant:write' | 'access:manage' | 'hotel:read' | 'distribution:read' | 'audit:read'
export type TenantContext = { id: string; name: string; code: string; tier: string }
export const permissionsByRole: Record<Role, Permission[]> = {
  platform_admin: ['tenant:read','tenant:write','access:manage','hotel:read','distribution:read','audit:read'],
  tenant_admin: ['tenant:read','access:manage','hotel:read','distribution:read','audit:read'],
  ops_agent: ['hotel:read','distribution:read'],
  finance_viewer: ['tenant:read','audit:read'],
}
export const demoTenants: TenantContext[] = [
  { id: 't_atlas', name: 'Atlas Platform', code: 'PLT-001', tier: 'Platform' },
  { id: 't_travel', name: 'Travel Republic', code: 'TRV-001', tier: 'Gold' },
  { id: 't_holiday', name: 'Holiday Lines', code: 'HLY-442', tier: 'VIP' },
]
export const adminSections = [
  { href: '/', label: 'Overview', icon: 'LayoutDashboard' },
  { href: '/tenants', label: 'Tenants', icon: 'Building2' },
  { href: '/access', label: 'Access & RBAC', icon: 'ShieldCheck' },
  { href: '/hotels', label: 'Hotel Master', icon: 'Hotel' },
  { href: '/distribution', label: 'Distribution', icon: 'Network' },
  { href: '/audit', label: 'Audit Log', icon: 'ScrollText' },
] as const
export function can(role: Role, permission: Permission) { return permissionsByRole[role].includes(permission) }
export const demoSession = { user: { id: 'usr_jordan', name: 'Jordan Davis', email: 'jordan@atlas.example' }, role: 'platform_admin' as Role }

// Future seams: replace demoSession with Better Auth/enterprise IdP and resolve tenant context from the request.
export type DomainService = { tenantId: string; health(): Promise<'healthy' | 'degraded'> }
export type SupplierAdapter = { provider: string; capabilities: string[]; status(): Promise<'connected' | 'disabled'> }
export type ApiLayer = { search: DomainService; booking: DomainService; finance: DomainService }
export const adapterBoundary = ['API', 'XML', 'DMC'] as const

export type WorkspaceKey = 'tenants' | 'access' | 'hotels' | 'distribution' | 'audit'
export const workspaceData: Record<WorkspaceKey, { eyebrow: string; title: string; description: string; rows: string[] }> = {
  tenants: { eyebrow: 'TENANT CONTROL', title: 'Tenant directory', description: 'Provision and monitor isolated B2B workspaces, commercial tiers, and wallet posture.', rows: ['Travel Republic · TRV-001 · Gold · Healthy', 'Atlas Getaways · AGT-093 · Silver · Healthy', 'Holiday Lines · HLY-442 · VIP · Degraded'] },
  access: { eyebrow: 'IDENTITY & POLICY', title: 'Access and RBAC', description: 'Manage memberships, roles, permission bundles, and authentication policy boundaries.', rows: ['Jordan Davis · Platform Admin · 6 permissions', 'Maya Chen · Tenant Admin · 5 permissions', 'Omar Khan · Operations Agent · 2 permissions'] },
  hotels: { eyebrow: 'MASTER DATA', title: 'Hotel master', description: 'The canonical hotel/content boundary sits upstream of search and supplier normalization.', rows: ['GIATA 001042 · The Hoxton Shoreditch · London', 'GIATA 002981 · CitizenM Tower · London', 'GIATA 007730 · Hotel Arts · Barcelona'] },
  distribution: { eyebrow: 'API LAYER / ADAPTERS', title: 'Distribution control plane', description: 'Observe future API, XML, and DMC adapter health without executing supplier calls in this phase.', rows: ['API Gateway · 99.98% · 1.42M requests', 'XML Channel · 4 suppliers · Sync paused', 'DMC Adapter · Contract pending · Disabled'] },
  audit: { eyebrow: 'GOVERNANCE', title: 'Audit log', description: 'Immutable tenant-scoped activity records for compliance, support, and operational review.', rows: ['14:32 · Jordan Davis · Viewed tenant directory', '14:18 · System · API policy evaluated', '13:57 · Maya Chen · Updated membership role'] },
}
export function getWorkspace(key: WorkspaceKey) { return workspaceData[key] }
export function isWorkspaceKey(value: string): value is WorkspaceKey { return value in workspaceData }

export type AdminWorkspaceProps = { workspace: WorkspaceKey }
export const architectureMap = { edge: 'Next.js / Vercel', surfaces: ['Agent Portal', 'Admin / Extranet'], domains: ['Search', 'Booking', 'Finance'], stores: ['Redis', 'PostgreSQL'], adapters: [...adapterBoundary] }
// Booking execution and supplier API/XML/DMC calls intentionally remain future implementation seams.
