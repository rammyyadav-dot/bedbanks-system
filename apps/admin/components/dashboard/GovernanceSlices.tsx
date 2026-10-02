'use client'

import { getAccessReviewSummary, getMarketsSummary, getReliabilitySummary } from '@/lib/data/operations'
import { listHref } from '@/lib/hotel-ui'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Card, Section, Stat, grid } from './FinanceAuditSlices'

/**
 * Market, Reliability and Risk slices from their own summary endpoints. Counts only, straight from the API;
 * a section the database role cannot read shows as denied, never as zero.
 */
export function GovernanceSlices() {
  const markets = useOpsQuery(() => getMarketsSummary(), [])
  const reliability = useOpsQuery(() => getReliabilitySummary(), [])
  const access = useOpsQuery(() => getAccessReviewSummary(), [])
  return (
    <>
      <Card id="markets" window={markets.state.status === 'ready' ? `window ${markets.state.data.window.days} nights` : undefined}>
        <OpsState state={markets.state} onRetry={markets.reload} isEmpty={(m) => m.destinations.length === 0} empty={{ title: 'No hotels yet', description: 'No destinations to show.' }}>
          {(m) => (
            <>
              <ul style={grid}>
                <Stat label="Hotels" value={m.totalHotels} href="/hotels" />
                <Stat label="Destinations" value={m.destinations.length} href="/markets" />
              </ul>
              <p style={{ fontSize: 11, color: '#3f565c', margin: 0 }}>
                {m.destinations.slice(0, 3).map((d) => <a key={`${d.countryCode}-${d.city}`} href={listHref({ destination: d.city })} style={{ marginRight: 10 }}>{d.city}: {d.ready} ready / {d.hotels}</a>)}
              </p>
            </>
          )}
        </OpsState>
      </Card>
      <Card id="reliability" window={reliability.state.status === 'ready' ? `last ${reliability.state.data.window.days} days` : undefined}>
        <OpsState state={reliability.state} onRetry={reliability.reload}>
          {(r) => (
            <>
              <Section section={r.connectors}>{(c) => <ul style={grid}><Stat label="Unhealthy connectors" value={c.unhealthy} href="/reliability" /><Stat label="Health unknown" value={c.unknown} href="/reliability" /></ul>}</Section>
              <Section section={r.executions}>{(e) => <ul style={grid}><Stat label="Failed executions" value={e.failed} href="/reliability" /><Stat label="Retrying" value={e.retrying} href="/reliability" /></ul>}</Section>
              <Section section={r.supplierOutcomes}>{(s) => <ul style={grid}><Stat label="Unknown supplier outcomes" value={s.uncertain} href="/reconciliation" /></ul>}</Section>
              <Section section={r.holds}>{(h) => <ul style={grid}><Stat label="Stalled holds" value={h.stalledProcessing} href="/reconciliation" /></ul>}</Section>
            </>
          )}
        </OpsState>
      </Card>
      <Card id="risk">
        <OpsState state={access.state} onRetry={access.reload}>
          {(a) => (
            <ul style={grid}>
              <Stat label="Members" value={a.members.total} href="/access-review" />
              <Stat label="Hold sensitive permissions" value={a.members.holdingSensitive} href="/access-review" />
              <Stat label="No role" value={a.members.noRole} href="/access-review" />
              <Stat label="Inactive" value={a.members.inactive} href="/access-review" />
              <Stat label="Never logged in" value={a.members.neverLoggedIn} href="/access-review" />
            </ul>
          )}
        </OpsState>
      </Card>
    </>
  )
}
