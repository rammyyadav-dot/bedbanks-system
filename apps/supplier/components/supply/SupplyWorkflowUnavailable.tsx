import Link from 'next/link'
import { CircleAlert } from 'lucide-react'
import { getSupplyWorkflowAvailability } from '../../lib/supply-api'
import { PageHeader } from '../ui/PageHeader'

export function SupplyWorkflowUnavailable({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  const availability = getSupplyWorkflowAvailability()

  return (
    <div className="supplier-page">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <section className="panel" aria-labelledby="workflow-api-status">
        <div style={{ display: 'grid', gap: 14, padding: 24, maxWidth: 720 }}>
          <CircleAlert aria-hidden="true" color="#d90429" size={28} />
          <div>
            <h2 id="workflow-api-status" style={{ margin: 0 }}>This module is unavailable</h2>
            <p style={{ margin: '8px 0 0', color: '#4b5563' }}>{availability.reason}</p>
          </div>
          <p style={{ margin: 0, color: '#4b5563' }}>
            Approval, publication, external distribution, search, booking, and payment remain unavailable.
          </p>
          <div>
            <Link className="btn btn-primary" href="/dashboard">Return to workspace</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
