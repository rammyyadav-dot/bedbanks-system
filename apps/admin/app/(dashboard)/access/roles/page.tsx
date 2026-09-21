import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'

export default function RolesPage() {
  return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Platform roles" description="Role bundles are managed through the governed platform access API." actions={<Link href="/access" className="admin-btn">Back to access</Link>} /><section className="admin-auth-state"><h2>Role management API ready</h2><p>Use the platform access endpoints to list roles, attach canonical permissions, and audit every change.</p></section></div>
}
