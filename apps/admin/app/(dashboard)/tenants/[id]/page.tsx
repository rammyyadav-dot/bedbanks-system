import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { ServerLoadFailure } from '@/components/auth/ServerLoadFailure'
import { getPlatformTenantSummary } from '@/lib/data/server'
import { ApiResponseError } from '@/lib/api/errors'
import { EmptyState } from '@/components/common/EmptyState'

type Summary = { tenant: { id: string; name: string; slug: string; status: string; createdAt: string }; counts: { memberships: number; bookings: number } }

export default async function TenantSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const { tenant, counts } = await getPlatformTenantSummary(id) as Summary
    return (
      <div className="admin-page">
        <PageHeader eyebrow="BUSINESS · TENANT" title={tenant.name} description="Read-only summary. Opening it recorded a platform audit event." actions={<Link href="/tenants" className="admin-btn">Back to tenants</Link>} />
        <div className="admin-table-wrap"><table className="admin-table"><tbody>
          <tr><th>Slug</th><td>{tenant.slug}</td></tr>
          <tr><th>Status</th><td>{tenant.status}</td></tr>
          <tr><th>Created</th><td>{new Date(tenant.createdAt).toLocaleDateString('en-GB')}</td></tr>
          <tr><th>Members</th><td>{counts.memberships}</td></tr>
          <tr><th>Bookings</th><td>{counts.bookings}</td></tr>
        </tbody></table></div>
      </div>
    )
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 404) return <div className="admin-page"><EmptyState title="Tenant not found" description="No tenant exists with this id." /></div>
    return <ServerLoadFailure error={error} title="Tenant" permission="platform.tenants.access" subject="the tenant summary" />
  }
}
