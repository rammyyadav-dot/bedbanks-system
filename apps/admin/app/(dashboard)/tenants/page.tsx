import { PageHeader } from '@/components/common/PageHeader'
import { ServerLoadFailure } from '@/components/auth/ServerLoadFailure'
import { getPlatformTenants } from '@/lib/data/server'
import { TenantsTable } from './TenantsTable'

export default async function TenantsPage() {
  try {
    const tenants = await getPlatformTenants()
    return (
      <div className="admin-page">
        <PageHeader eyebrow="BUSINESS · TENANTS" title="Tenants" description="Agency workspaces from the platform tenant directory. Every read is audited." />
        <TenantsTable tenants={tenants} />
      </div>
    )
  } catch (error) {
    return <ServerLoadFailure error={error} title="Tenants" permission="platform.tenants.read" subject="tenants" eyebrow="BUSINESS · TENANTS" source="platform tenant API" />
  }
}
