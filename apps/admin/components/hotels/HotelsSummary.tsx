'use client'

import Link from 'next/link'
import type { HotelCommercialSummary } from '@bedbanks/contracts'
import { listHref } from '@/lib/hotel-ui'

/** Tenant-wide aggregates from the API (not the loaded page). Each tile applies the matching server-side filter. */
export function HotelsSummary({ summary }: { summary: HotelCommercialSummary }) {
  const tiles = [
    { label: 'Total hotels', value: summary.totalHotels, href: listHref({}) },
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
              <div style={{ font: '700 22px system-ui', color: '#17333e' }}>{tile.value}</div>
              <div style={{ color: '#3f565c', fontSize: 11 }}>{tile.label}</div>
            </Link>
          </li>
        ))}
      </ul>
      {summary.scanCapped && <p role="status" style={{ color: '#8a5a00', fontSize: 11 }}>Counts cover the first alphabetical hotels only; this tenant has more than the scan limit.</p>}
    </section>
  )
}
