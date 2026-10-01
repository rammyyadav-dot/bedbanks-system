import Link from 'next/link'
import { PageHeader } from '../../../components/ui/PageHeader'
import { loadPortal } from '../../../lib/portal'

export default async function DashboardPage() {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  const name = portal.user.name || portal.user.email
  const organization = portal.organization

  return (
    <div className="supplier-page">
      <PageHeader
        eyebrow="Workspace"
        title={organization ? organization.displayName : 'No supplier organization'}
        description={organization
          ? `Signed in as ${name}. Mapped hotels can be reviewed, and a permitted user can save a private room note. Publication, booking, and settlement are not available.`
          : `Signed in as ${name}. This account has no active supplier-organization membership, so no hotels are shown.`}
        actions={organization ? <Link className="btn btn-primary" href="/hotels">View hotels</Link> : undefined}
      />
      <section className="panel">
        <div style={{ display: 'grid', gap: 10, padding: 24, maxWidth: 720 }}>
          <h2 style={{ margin: 0 }}>What this workspace can do</h2>
          <p style={{ margin: 0, color: '#4b5563' }}>Hotel list, hotel detail, room list, and a private room note when your membership allows it.</p>
          <p style={{ margin: 0, color: '#4b5563' }}>Profile, contracts, rates, availability, allotments, promotions, bookings, invoices, and reports stay unavailable. Nothing on those screens is created or published.</p>
        </div>
      </section>
    </div>
  )
}
