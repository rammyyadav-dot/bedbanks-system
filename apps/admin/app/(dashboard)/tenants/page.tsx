import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { ServerLoadFailure } from '@/components/auth/ServerLoadFailure'
import { getPlatformTenants } from '@/lib/data/server'

type TenantRow = { id: string; name: string; slug: string; status: string; createdAt: string }

export default async function TenantsPage() {
  try {
    const tenants = await getPlatformTenants() as TenantRow[]
    return (
      <div className="admin-page">
        <PageHeader eyebrow="BUSINESS" title="Tenants" description="Read-only platform directory. Opening a tenant records an audit event; no tenant data is changed here." />
        {tenants.length === 0 ? <EmptyState title="No tenants" description="No tenants exist on this platform." /> : (
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Tenant</th><th>Slug</th><th>Status</th><th>Created</th><th>Open</th></tr></thead><tbody>
            {tenants.map((tenant) => <tr key={tenant.id}><td>{tenant.name}</td><td>{tenant.slug}</td><td>{tenant.status}</td><td>{new Date(tenant.createdAt).toLocaleDateString('en-GB')}</td><td><Link href={`/tenants/${encodeURIComponent(tenant.id)}`} className="admin-btn">Summary</Link></td></tr>)}
          </tbody></table></div>
        )}
      </div>
    )
  } catch (error) { return <ServerLoadFailure error={error} title="Tenants" permission="platform.tenants.read" subject="tenants" /> }
}
