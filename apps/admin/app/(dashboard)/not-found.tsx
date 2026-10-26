import Link from 'next/link'

export default function DashboardNotFound() {
  return <div className="admin-page"><section className="admin-auth-state" role="alert"><h2>Page not found</h2><p>This page does not exist, or the record is not available for the active tenant.</p><Link href="/dashboard">Back to dashboard</Link></section></div>
}
