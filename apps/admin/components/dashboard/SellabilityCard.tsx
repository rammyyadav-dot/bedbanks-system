'use client'

import Link from 'next/link'
import { getHotelsSummary } from '@/lib/data/hotel-commercial'
import { listHref } from '@/lib/hotel-ui'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'

const SEGMENTS = [
  { key: 'ready', label: 'Ready', color: '#1f7a4d' },
  { key: 'partial', label: 'Partial', color: '#b7791f' },
  { key: 'blocked', label: 'Blocked', color: '#b42318' },
] as const

/**
 * Hotel sellability from the API's tenant-wide summary (same evaluator Agent search uses).
 * Nothing is computed here: segment widths are the API's counts used as flex weights, and a failure or a
 * missing permission is shown as such, never as zero hotels.
 */
export function SellabilityCard() {
  const { state, reload } = useOpsQuery(() => getHotelsSummary(), [])
  return (
    <section className="dashboard-panel" aria-labelledby="sellability-heading" data-testid="dashboard-sellability">
      <div className="dashboard-panel-header"><div><h2 id="sellability-heading">Hotel sellability</h2><p>Can fBeds sell each hotel in the next 30 nights</p></div><Link href="/hotels">Hotels</Link></div>
      <OpsState state={state} onRetry={reload} isEmpty={(s) => s.totalHotels === 0} empty={{ title: 'No hotels yet', description: 'This tenant has no hotels, so there is nothing to assess.' }}>
        {(s) => (
          <>
            <div role="img" aria-label={`${s.readiness.ready} ready, ${s.readiness.partial} partial, ${s.readiness.blocked} blocked of ${s.totalHotels} hotels`} style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: '#e4eaec' }}>
              {SEGMENTS.map((seg) => s.readiness[seg.key] > 0 ? <span key={seg.key} style={{ flexGrow: s.readiness[seg.key], flexBasis: 0, background: seg.color }} /> : null)}
            </div>
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
              {SEGMENTS.map((seg) => (
                <li key={seg.key}>
                  <Link href={listHref({ readiness: seg.key.toUpperCase() })} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <strong style={{ font: '700 20px system-ui', color: '#17333e' }}>{s.readiness[seg.key]}</strong>
                    <div style={{ fontSize: 12, color: '#3f565c' }}><span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: seg.color, marginRight: 6 }} />{seg.label}</div>
                  </Link>
                </li>
              ))}
              <li>
                <Link href={listHref({ contractState: 'EXPIRING' })} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <strong style={{ font: '700 20px system-ui', color: '#17333e' }}>{s.contractsExpiring}</strong>
                  <div style={{ fontSize: 12, color: '#3f565c' }}>Contracts expiring (&lt;{s.contractExpiringDays}d)</div>
                </Link>
              </li>
            </ul>
            <p style={{ fontSize: 11, color: '#3f565c', margin: '8px 0 0' }}>Window {s.window.from} to {s.window.to}. <Link href="/exceptions">View exceptions</Link></p>
            {s.scanCapped && <p role="status" style={{ color: '#8a5a00', fontSize: 11 }}>Counts cover the first alphabetical hotels only; this tenant has more than the scan limit.</p>}
          </>
        )}
      </OpsState>
    </section>
  )
}
