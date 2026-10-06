import type { ReactNode } from 'react'
import { PageHeader } from './PageHeader'

/**
 * Honest placeholder for modules that are not authoritative in the Dubai MVP.
 * It renders no records, so nothing here can be mistaken for live data.
 */
export function FeatureUnavailable({ eyebrow, title, reason, gap }: { eyebrow: string; title: string; reason: ReactNode; gap?: string }) {
  return (
    <div className="admin-page">
      <PageHeader eyebrow={eyebrow} title={title} description="Not enabled for the Dubai MVP." />
      <div className="admin-empty" role="status" data-testid="feature-unavailable">
        <strong>{title} is not enabled</strong>
        <span>{reason}</span>
        {gap ? <span>Tracked gap: {gap}</span> : null}
      </div>
    </div>
  )
}
