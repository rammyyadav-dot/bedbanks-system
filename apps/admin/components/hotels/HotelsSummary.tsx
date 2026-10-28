'use client'

import Link from 'next/link'
import type { HotelCommercialSummary } from '@bedbanks/contracts'
import { listHref } from '@/lib/hotel-ui'

/** Tenant-wide aggregates from the API (not the loaded page). Each tile applies the matching server-side filter. */
export function HotelsSummary({ summary }: { summary: HotelCommercialSummary }) {
  const tiles = [
    { label: 'Total hotels', value: summary.totalHotels, href: listHref({}) },
    { label: 'Draft profiles', value: summary.profileStatus.draft, href: listHref({ contentStatus: 'DRAFT' }) },
    { label: 'Incomplete profiles', value: summary.profileStatus.incomplete, href: listHref({ contentStatus: 'INCOMPLETE' }) },
    { label: 'Suspended', value: summary.profileStatus.suspended, href: listHref({ contentStatus: 'SUSPENDED' }) },
    { label: 'Ready', value: summary.readiness.ready, href: listHref({ readiness: 'READY' }) },
    { label: 'Partial', value: summary.readiness.partial, href: listHref({ readiness: 'PARTIAL' }) },
    { label: 'Blocked', value: summary.readiness.blocked, href: listHref({ readiness: 'BLOCKED' }) },
    { label: 'Mapping issues', value: summary.mappingIssueHotels, href: listHref({ issue: 'SUPPLIER_MAPPING_INVALID' }) },
    { label: 'Rate gaps', value: summary.rateGapHotels, href: listHref({ issue: 'RATE_MISSING' }) },
    { label: 'Availability gaps', value: summary.availabilityGapHotels, href: listHref({ issue: 'AVAILABILITY_MISSING' }) },
    { label: `Contracts expiring (<${summary.contractExpiringDays}d)`, value: summary.contractsExpiring, href: listHref({ contractState: 'EXPIRING' }) },
  ]
  return (
    <section aria-label="Commercial summary" data-testid="hotels-summary" style={{ marginBottom: 12 }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
        {tiles.map((tile) => (
          <li key={tile.label} className="workspace-panel" style={{ padding: '10px 14px' }}>
            <Link href={tile.href} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`${tile.label}: ${tile.value}. Apply filter`}>
              <div style={{ font: '700 22px system-ui', color: 'var(--c-111111)' }}>{tile.value}</div>
              <div style={{ color: 'var(--c-444444)', fontSize: 11 }}>{tile.label}</div>
            </Link>
          </li>
        ))}
      </ul>
      {summary.scanCapped && <p role="status" style={{ color: 'var(--c-2a2a2a)', fontSize: 11 }}>Counts cover the first alphabetical hotels only; this tenant has more than the scan limit.</p>}
    </section>
  )
}
