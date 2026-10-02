'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { OPS_FAILURE_COPY } from '@/lib/ops-state'
import { getOpsReadiness } from '@/lib/data/operations'
import { when } from '@/components/ops/ops-ui'
import type { SectionState } from '@bedbanks/contracts'

function Section<T>({ title, section, children }: { title: string; section: SectionState<T>; children: (data: T) => React.ReactNode }) {
  return (
    <section className="workspace-panel" style={{ padding: '12px 18px', marginBottom: 12 }} aria-labelledby={`s-${title}`}>
      <h2 id={`s-${title}`}>{title}</h2>
      {section.state === 'unavailable'
        ? <div role="status" data-state="denied"><strong>{OPS_FAILURE_COPY.denied.title}</strong><p>{OPS_FAILURE_COPY.denied.body}</p></div>
        : children(section.data)}
    </section>
  )
}
const Stat = ({ label, value, href }: { label: string; value: number; href?: string }) => (
  <div style={{ display: 'inline-block', minWidth: 150, margin: '4px 16px 4px 0' }}>
    <div style={{ font: '700 24px system-ui' }}>{href ? <Link href={href}>{value}</Link> : value}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{label}</div>
  </div>
)

export default function OperationsPage() {
  const { state, reload } = useOpsQuery(() => getOpsReadiness(), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DUBAI OPERATIONS" title="Operational readiness" description="Every number is computed by the API from authoritative records for the active tenant. Nothing is estimated in the browser." actions={<Link href="/hotels" className="admin-btn">Hotels</Link>} />
      <OpsState state={state} onRetry={reload}>
        {r => (
          <>
            <p style={{ color: '#3f565c' }}>Generated {when(r.generatedAt)} · sellability window {r.window.from} → {r.window.to} ({r.window.days} nights)</p>
            <Section title="Supply" section={r.supply}>{s => (
              <>
                <Stat label="Suppliers (active)" value={s.suppliers.active} href="/suppliers" /><Stat label="Hotels ready" value={s.hotels.ready} href="/hotels?readiness=READY" /><Stat label="Hotels partial" value={s.hotels.partial} href="/hotels?readiness=PARTIAL" /><Stat label="Hotels blocked" value={s.hotels.blocked} href="/hotels?readiness=BLOCKED" />
                <Stat label="Hotel mappings pending" value={s.hotelMappings.pending} href="/mappings" /><Stat label="Room mappings pending" value={s.roomMappings.pending} href="/mappings" />
                <Stat label="Hotels with rate gaps" value={s.rateGapHotels} href="/hotels?issue=RATE_MISSING" /><Stat label="Hotels with availability gaps" value={s.availabilityGapHotels} href="/hotels?issue=AVAILABILITY_MISSING" /><Stat label="Hotels on stop-sell" value={s.stopSellHotels} href="/hotels?issue=STOP_SELL" /><Stat label="Hotels with contract expiring" value={s.contractsExpiring} href="/hotels?contractState=EXPIRING" />
              </>
            )}</Section>
            <Section title="Transactions" section={r.transactions}>{t => (
              <>
                <Stat label="Bookings confirmed" value={t.bookings.confirmed} href="/bookings" /><Stat label="Bookings pending" value={t.bookings.pending} href="/bookings" /><Stat label="Bookings failed" value={t.bookings.failed} href="/bookings" /><Stat label="Bookings cancelled" value={t.bookings.cancelled} href="/bookings" />
                <Stat label="Holds held" value={t.holds.held} href="/holds" /><Stat label="Holds processing" value={t.holds.processing} href="/holds" />
                <Stat label="Need reconciliation" value={t.reconciliationRequired} href="/reconciliation" /><Stat label="Cancellations needing refund review" value={t.cancellationsMissingRefund} href="/cancellations" />
              </>
            )}</Section>
            <Section title="Connectors" section={r.connectors}>{c => (
              <><Stat label="Connectors" value={c.total} href="/connectors" /><Stat label="Enabled" value={c.enabled} /><Stat label="Unhealthy" value={c.unhealthy} /><Stat label="Health unknown" value={c.unknown} /></>
            )}</Section>
            <details><summary>How these numbers are defined</summary><dl>{Object.entries(r.definitions).map(([k, v]) => <div key={k}><dt><code>{k}</code></dt><dd>{v}</dd></div>)}</dl></details>
          </>
        )}
      </OpsState>
    </div>
  )
}
