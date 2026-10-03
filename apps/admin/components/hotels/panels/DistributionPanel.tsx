'use client'

import Link from 'next/link'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getHotelDistribution } from '@/lib/data/hotel-commercial'
import { hotelHref, reasonText } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'
import { SellabilityPanel } from './SellabilityPanel'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const REASON: Record<string, string> = {
  HOTEL_NOT_PUBLISHED: 'The profile is not COMPLETE, so the hotel is not published to the catalogue.',
  HOTEL_SUSPENDED: 'The hotel is SUSPENDED and withdrawn from the catalogue.',
  HOTEL_STAR_RATING_MISSING: 'No 1-5 star category is recorded, and Agent search lists only rated hotels.',
}

/**
 * Distribution and readiness. Catalogue publication, distribution eligibility, transaction enablement and sellability are four
 * different facts, shown apart. Coverage and blockers come from the evaluator Agent search uses; this view only reads.
 */
export function DistributionPanel({ hotelId, rooms }: { hotelId: string; rooms: HotelCommercial360['rooms'] }) {
  const { state, reload } = useOpsQuery(() => getHotelDistribution(hotelId), [hotelId])
  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="distribution">
      <OpsState state={state} onRetry={reload}>
        {(d) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
              <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 6, alignContent: 'start' }} aria-label="Catalogue publication" data-testid="dist-catalogue">
                <h2 style={{ fontSize: 14, margin: 0 }}>Catalogue publication</h2>
                <div><Chip tone={d.catalogue.published ? 'ok' : d.catalogue.suspended ? 'bad' : 'warn'}>{d.catalogue.status}</Chip> <Chip tone={d.catalogue.eligible ? 'ok' : 'bad'}>{d.catalogue.eligible ? 'ELIGIBLE FOR THE CATALOGUE' : 'NOT ELIGIBLE'}</Chip></div>
                {d.catalogue.reasons.length > 0 && <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>{d.catalogue.reasons.map((r) => <li key={r}>{REASON[r] ?? r}</li>)}</ul>}
                <p style={note}>Publishing is the profile approval. Change it in <Link href={hotelHref(hotelId, 'setup')}>Hotel Setup</Link>. Eligibility is not sellability.</p>
              </section>
              <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 6, alignContent: 'start' }} aria-label="Distribution" data-testid="dist-distribution">
                <h2 style={{ fontSize: 14, margin: 0 }}>Distribution</h2>
                <div><Chip tone={d.agentSellable ? 'ok' : 'bad'}>{d.agentSellable ? 'SELLABLE TO AGENTS' : 'NOT SELLABLE TO AGENTS'}</Chip></div>
                <p style={{ fontSize: 12, margin: 0 }}>{d.agentSellable ? `At least one night in the next ${d.coverage.window.days} is sellable by the Agent evaluator.` : `No night in the next ${d.coverage.window.days} is sellable by the Agent evaluator.`}</p>
                <p style={{ fontSize: 12, margin: 0 }}>{d.restrictions === null ? 'Agency restrictions are unavailable to the API database role.' : `Agency restrictions: ${d.restrictions.hotel} on this hotel, ${d.restrictions.supplier} on its suppliers.`}</p>
                <p style={note}>Restrictions narrow what individual agencies see; they never grant access. Manage them under Distribution.</p>
              </section>
              <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 6, alignContent: 'start' }} aria-label="Transaction enablement" data-testid="dist-transaction">
                <h2 style={{ fontSize: 14, margin: 0 }}>Transaction enablement</h2>
                <div><Chip tone={d.transaction.bookingEnabled ? 'warn' : 'neutral'}>{d.transaction.bookingEnabled ? 'BOOKING ENABLED (PLATFORM)' : 'BOOKING NOT ENABLED (PLATFORM)'}</Chip></div>
                <p style={note}>This is the platform booking switch. Publishing, approving or mapping a hotel never changes it, and nothing on this page can.</p>
              </section>
            </div>

            <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Seven-day coverage" data-testid="dist-coverage">
              <h2 style={{ fontSize: 14, margin: 0 }}>Coverage, next {d.coverage.window.days} nights ({d.coverage.window.from} → {d.coverage.window.to})</h2>
              <p style={{ fontSize: 12, margin: 0 }} data-testid="dist-coverage-summary"><strong>{d.coverage.sellableNights} of {d.coverage.planNights}</strong> plan-nights are sellable{d.coverage.truncated ? ' (first rate plans only)' : ''}. A plan-night is one rate plan on one night.</p>
              {d.coverage.planNights === 0 ? <p style={{ fontSize: 12 }}>This hotel has no rate plan, so there is nothing to assess.</p> : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                  {([['Room', d.coverage.byRoom], ['Supplier', d.coverage.bySupplier]] as const).map(([label, rows]) => (
                    <ScrollRegion key={label} label={`Coverage by ${label.toLowerCase()}`}><table style={tableStyle} aria-label={`Coverage by ${label.toLowerCase()}`}>
                      <thead><tr>{[label, 'Sellable', 'Plan-nights'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                      <tbody>{rows.map((r) => <tr key={r.label}><td style={td}>{r.label}</td><td style={td}>{r.sellable}</td><td style={td}>{r.planNights}</td></tr>)}</tbody></table></ScrollRegion>
                  ))}
                </div>
              )}
              <h3 style={{ fontSize: 13, margin: '6px 0 0' }}>Blockers</h3>
              {d.blockers.length === 0 ? <p data-testid="dist-no-blockers" style={{ fontSize: 12, margin: 0 }}>No night in this window is blocked.</p> : (
                <ScrollRegion label="Blockers by reason"><table style={tableStyle} aria-label="Blockers by reason">
                  <thead><tr>{['Reason', 'Nights', 'Dates', 'Rooms', 'Rate plans', 'Suppliers'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{d.blockers.map((b) => (
                    <tr key={b.reason} data-reason={b.reason}><td style={td} title={reasonText(b.reason)}><code>{b.reason}</code><div style={{ fontSize: 10, color: '#3f565c' }}>{reasonText(b.reason)}</div></td><td style={td}>{b.nights}</td><td style={td}>{b.dates.join(', ')}</td><td style={td}>{b.rooms.join(', ')}</td><td style={td}>{b.ratePlans.join(', ')}</td><td style={td}>{b.suppliers.join(', ')}</td></tr>
                  ))}</tbody></table></ScrollRegion>
              )}
            </section>
          </>
        )}
      </OpsState>
      <section aria-label="Check a specific stay" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Check a specific stay</h2>
        <p style={note}>Runs the Agent&apos;s own stay evaluator for the dates and party you choose. Read-only: it creates no hold and no booking.</p>
        <SellabilityPanel hotelId={hotelId} rooms={rooms} />
      </section>
    </div>
  )
}
