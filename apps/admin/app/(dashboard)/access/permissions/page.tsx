import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { getPlatformPermissions } from '@/lib/data'

export default async function PermissionsPage() {
  try {
    const permissions = await getPlatformPermissions() as Array<{ id: string; key: string; description?: string | null; roles?: Array<unknown> }>
    return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Permission catalogue" description="Server-controlled platform permissions. Clients cannot create permissions." actions={<Link href="/access" className="admin-btn">Back to access</Link>} />{permissions.length === 0 ? <EmptyState title="No permissions" description="The server permission catalogue is empty." /> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Key</th><th>Description</th><th>Roles</th></tr></thead><tbody>{permissions.map((permission) => <tr key={permission.id}><td><code>{permission.key}</code></td><td>{permission.description ?? '—'}</td><td>{permission.roles?.length ?? 0}</td></tr>)}</tbody></table></div>}</div>
  } catch { return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Permission catalogue" description="The platform access API could not be reached." /><section className="admin-auth-state"><h2>Unable to load permissions</h2><p>Retry after confirming your session and API availability.</p></section></div> }
}
