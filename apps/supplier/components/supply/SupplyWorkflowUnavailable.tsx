import Link from 'next/link'
import { CircleAlert, ClipboardCheck } from 'lucide-react'
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
            <h2 id="workflow-api-status" style={{ margin: 0 }}>Supply workflow is not available yet</h2>
            <p style={{ margin: '8px 0 0', color: '#4b5563' }}>
              {availability.status === 'unavailable'
                ? availability.reason
                : 'The portal is waiting for the reviewed supply-workflow API contract.'}
            </p>
          </div>
          <p style={{ margin: 0, color: '#4b5563' }}>
            No supplier record, rate, availability update, contract, or mapping is being created from this screen.
            Approval, publication, external distribution, search, and booking remain unavailable.
          </p>
          <div>
            <Link className="btn btn-primary" href="/dashboard">
              <ClipboardCheck size={14} aria-hidden="true" /> Return to workspace
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
