import Link from 'next/link'
import { LockKeyhole } from 'lucide-react'
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
      <PageHeader eyebrow={eyebrow} title={title} description={description} tone="muted" />
      <section className="panel unavailable-panel" aria-labelledby="workflow-api-status">
        <span className="capability-icon"><LockKeyhole size={26} aria-hidden="true" /></span>
        <div>
          <h2 id="workflow-api-status">This module is unavailable</h2>
          <p>{availability.reason}</p>
          <p>Approval, publication, external distribution, search, booking and payment remain unavailable.</p>
          <div className="unavailable-actions">
            <Link className="btn btn-primary" href="/dashboard">Return to workspace</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
