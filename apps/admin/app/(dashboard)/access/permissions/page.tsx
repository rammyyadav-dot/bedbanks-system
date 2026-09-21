import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'

export default function PermissionsPage() {
  return <div className="admin-page"><PageHeader eyebrow="BUSINESS · ACCESS" title="Permission catalogue" description="Canonical platform permissions are read from the database-backed access model." actions={<Link href="/access" className="admin-btn">Back to access</Link>} /><section className="admin-auth-state"><h2>Permission catalogue API ready</h2><p>Permissions are explicit, scoped, and consumed by server-side guards rather than client-side visibility alone.</p></section></div>
}
