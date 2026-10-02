'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getMarketsSummary } from '@/lib/data/operations'
import { listHref } from '@/lib/hotel-ui'

/** Destination supply and sellability. Every number is the API's; the verdicts are the Agent-search evaluator's. */
export default function MarketsPage() {
  const { state, reload } = useOpsQuery(() => getMarketsSummary(), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="MARKET OPERATIONS" title="Destinations" description="Hotel supply and sellability by destination. Geography groups supply; it never widens access beyond the active tenant." />
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.destinations.length === 0} empty={{ title: 'No hotels yet', description: 'This tenant has no hotels, so there are no destinations to show.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="markets-table">
            <p style={{ padding: '8px 14px', margin: 0, color: '#3f565c' }}>{d.totalHotels} hotel(s) · window {d.window.from} → {d.window.to} · generated {when(d.generatedAt)}</p>
            {d.scanCapped && <p role="status" style={{ padding: '0 14px', color: '#8a5a00', fontSize: 11 }}>Counts cover the first alphabetical hotels only; this tenant has more than the scan limit.</p>}
            <ScrollRegion label="Destinations">
              <table style={tableStyle} aria-label="Destinations">
                <thead><tr>{['Destination', 'Hotels', 'Ready', 'Partial', 'Blocked', 'Mapping issues', 'Rate gaps', 'Availability gaps', 'Contracts expiring'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.destinations.map((r) => (
                  <tr key={`${r.countryCode}-${r.city}`}>
                    <td style={td}><Link href={listHref({ destination: r.city })} style={{ fontWeight: 600 }}>{r.city}</Link>, {r.countryCode}</td>
                    <td style={td}>{r.hotels}</td><td style={td}>{r.ready}</td><td style={td}>{r.partial}</td><td style={td}>{r.blocked}</td>
                    <td style={td}>{r.mappingIssues}</td><td style={td}>{r.rateGaps}</td><td style={td}>{r.availabilityGaps}</td><td style={td}>{r.contractsExpiring}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
          </div>
        )}
      </OpsState>
    </div>
  )
}
