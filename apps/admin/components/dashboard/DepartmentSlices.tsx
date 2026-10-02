'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { departments, type DepartmentId, type OperationsReadiness, type SectionState } from '@bedbanks/contracts'
import { getOpsReadiness } from '@/lib/data/operations'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { OPS_FAILURE_COPY } from '@/lib/ops-state'
import { FinanceAuditSlices } from './FinanceAuditSlices'

interface Tile { label: string; value: number; href: string }

/** One department card. `section` is the API's own availability: a denied section shows as denied, never as zeros. */
function Slice<T>({ id, section, tiles }: { id: DepartmentId; section: SectionState<T>; tiles: (data: T) => Tile[] }) {
  const dept = departments.find((d) => d.id === id)!
  const home = dept.modules.find((m) => m.readiness === 'live')?.href ?? '/dashboard'
  return (
    <section className="dashboard-panel" aria-labelledby={`dept-${id}`} data-testid={`dept-${id}`}>
      <div className="dashboard-panel-header"><div><h2 id={`dept-${id}`}>{dept.label}</h2><p>{dept.summary}</p></div><Link href={home}>Open</Link></div>
      {section.state === 'unavailable'
        ? <div role="status" data-state="denied"><strong>{OPS_FAILURE_COPY.denied.title}</strong><p>{OPS_FAILURE_COPY.denied.body}</p></div>
        : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            {tiles(section.data).map((t) => (
              <li key={t.label}>
                <Link href={t.href} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`${t.label}: ${t.value}`}>
                  <strong style={{ font: '700 20px system-ui', color: '#17333e' }}>{t.value}</strong>
                  <div style={{ fontSize: 12, color: '#3f565c' }}>{t.label}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

function Slices({ r }: { r: OperationsReadiness }): ReactNode {
  return (
    <>
      <Slice id="contracting" section={r.supply} tiles={(s) => [{ label: 'Contracts expiring', value: s.contractsExpiring, href: '/hotels?contractState=EXPIRING' }]} />
      <Slice id="mapping" section={r.supply} tiles={(s) => [
        { label: 'Hotel mappings pending', value: s.hotelMappings.pending, href: '/mappings' }, { label: 'Hotel mappings rejected', value: s.hotelMappings.rejected, href: '/mappings' },
        { label: 'Room mappings pending', value: s.roomMappings.pending, href: '/mappings' }, { label: 'Room mappings rejected', value: s.roomMappings.rejected, href: '/mappings' },
      ]} />
      <Slice id="rates" section={r.supply} tiles={(s) => [
        { label: 'Hotels with rate gaps', value: s.rateGapHotels, href: '/hotels?issue=RATE_MISSING' }, { label: 'Hotels with availability gaps', value: s.availabilityGapHotels, href: '/hotels?issue=AVAILABILITY_MISSING' },
        { label: 'Hotels on stop-sell', value: s.stopSellHotels, href: '/hotels?issue=STOP_SELL' },
      ]} />
      <Slice id="connectivity" section={r.connectors} tiles={(c) => [
        { label: 'Connectors', value: c.total, href: '/connectors' }, { label: 'Enabled', value: c.enabled, href: '/connectors' },
        { label: 'Unhealthy', value: c.unhealthy, href: '/connectors' }, { label: 'Health unknown', value: c.unknown, href: '/connectors' },
      ]} />
      <Slice id="reservations" section={r.transactions} tiles={(t) => [
        { label: 'Pending', value: t.bookings.pending, href: '/bookings?status=PENDING' }, { label: 'Confirmed', value: t.bookings.confirmed, href: '/bookings?status=CONFIRMED' },
        { label: 'Failed', value: t.bookings.failed, href: '/bookings?status=FAILED' }, { label: 'Cancelled', value: t.bookings.cancelled, href: '/bookings?status=CANCELLED' },
        { label: 'Holds held', value: t.holds.held, href: '/holds?status=HELD' },
      ]} />
      <Slice id="reconciliation" section={r.transactions} tiles={(t) => [
        { label: 'Need reconciliation', value: t.reconciliationRequired, href: '/reconciliation' }, { label: 'Cancellations needing refund review', value: t.cancellationsMissingRefund, href: '/cancellations' },
      ]} />
    </>
  )
}

/**
 * Functional department slices. One authoritative readiness call feeds every card; each card names its department
 * from the catalogue and drills into the filtered Admin view. Only departments that have real aggregates appear
 * Finance and Audit come from their own summary endpoints (FinanceAuditSlices).
 */
export function DepartmentSlices() {
  const { state, reload } = useOpsQuery(() => getOpsReadiness(), [])
  return (
    <div data-testid="dashboard-departments" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, margin: '12px 0' }}>
      <OpsState state={state} onRetry={reload}>{(r) => <Slices r={r} />}</OpsState>
      <FinanceAuditSlices />
    </div>
  )
}
