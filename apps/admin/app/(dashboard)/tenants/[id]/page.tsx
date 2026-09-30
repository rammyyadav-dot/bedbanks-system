import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/status/StatusBadge'
import { StatCard } from '@/components/common/StatCard'
import { ServerLoadFailure } from '@/components/auth/ServerLoadFailure'
import { getPlatformTenantSummary } from '@/lib/data/server'
import { tenantStatus } from '../tenant-status'

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const { tenant, counts } = await getPlatformTenantSummary(id)
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow={`TENANT · ${tenant.slug}`}
          title={tenant.name}
          description={`Created ${new Date(tenant.createdAt).toLocaleDateString()}. Opening this summary is recorded in the tenant audit trail.`}
          actions={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><StatusBadge status={tenantStatus(tenant.status)} /><Link href="/tenants" className="admin-btn">Back to tenants</Link></div>}
        />
        <div className="admin-summary-cards">
          <StatCard label="Members" value={String(counts.memberships)} />
          <StatCard label="Bookings" value={String(counts.bookings)} />
          <StatCard label="Slug" value={tenant.slug} />
          <StatCard label="Created" value={new Date(tenant.createdAt).toLocaleDateString()} />
        </div>
        <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>
          Cross-tenant user lists, activity, audit and settings are not available from the platform API yet. Tenant administrators manage their own workspace from Settings.
        </div>
      </div>
    )
  } catch (error) {
    return <ServerLoadFailure error={error} title="Tenant" permission="platform.tenants.access" subject="tenant" eyebrow="BUSINESS · TENANTS" source="platform tenant API" />
  }
}
