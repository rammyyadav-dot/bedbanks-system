import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { getPlatformAssignments } from '@/lib/data'

export default async function AssignmentsPage() {
  try {
    const assignments = await getPlatformAssignments() as Array<{ user: { email: string; name?: string | null }; role: { id: string; name: string }; createdAt: string }>
    return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Platform assignments" description="Role grants are auditable and cannot be self-escalated." actions={<Link href="/access" className="admin-btn">Back to access</Link>} />{assignments.length === 0 ? <EmptyState title="No assignments" description="No platform roles are currently assigned." /> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Role</th><th>Granted</th></tr></thead><tbody>{assignments.map((assignment) => <tr key={`${assignment.user.email}-${assignment.role.id}`}><td>{assignment.user.name ?? assignment.user.email}<div className="admin-muted">{assignment.user.email}</div></td><td>{assignment.role.name}</td><td>{new Date(assignment.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</div>
  } catch { return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Platform assignments" description="The platform access API could not be reached." /><section className="admin-auth-state"><h2>Unable to load assignments</h2><p>Retry after confirming your session and API availability.</p></section></div> }
}
