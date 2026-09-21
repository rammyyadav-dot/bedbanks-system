import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'

export default function AssignmentsPage() {
  return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Role assignments" description="Assignments are governed by platform permissions and protected against self-escalation." actions={<Link href="/access" className="admin-btn">Back to access</Link>} /><section className="admin-auth-state"><h2>Assignment API ready</h2><p>Grant and revoke operations are transactional, audited, and must be performed by an authorized platform operator.</p></section></div>
}
