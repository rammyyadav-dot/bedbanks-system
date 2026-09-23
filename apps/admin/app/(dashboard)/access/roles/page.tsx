import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { getRoles } from '@/lib/data'

export default async function RolesPage() {
  try {
    const roles = await getRoles() as Array<{ id: string; name: string; description?: string | null; _count?: { assignments: number }; permissions?: Array<{ permission: { key: string } }> }>
    return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Platform roles" description="Governed role bundles evaluated from the database on every request." actions={<Link href="/access" className="admin-btn">Back to access</Link>} />{roles.length === 0 ? <EmptyState title="No platform roles" description="Create the first governed role through the platform access API." /> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Description</th><th>Permissions</th><th>Assignments</th></tr></thead><tbody>{roles.map((role) => <tr key={role.id}><td><strong>{role.name}</strong><div className="admin-muted">{role.id}</div></td><td>{role.description ?? '—'}</td><td>{role.permissions?.map((item) => item.permission.key).join(', ') || 'None'}</td><td>{role._count?.assignments ?? 0}</td></tr>)}</tbody></table></div>}</div>
  } catch { return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Platform roles" description="The platform access API could not be reached." /><section className="admin-auth-state"><h2>Unable to load roles</h2><p>Retry after confirming your session and API availability.</p></section></div> }
}
