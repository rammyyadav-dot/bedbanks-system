import { PageHeader } from './PageHeader'

export function CapabilityUnavailable({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="admin-page">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <section className="admin-auth-state" role="status">
        <h2>Not available yet</h2>
        <p>No production API backs this area, so no data is shown. It will appear here once the capability ships.</p>
      </section>
    </div>
  )
}
