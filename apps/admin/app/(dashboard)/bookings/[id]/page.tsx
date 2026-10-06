'use client'

import Link from 'next/link'
import { Suspense, use, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { BOOKING_ACTION_RULES, type BookingDetailView } from '@bedbanks/contracts'
import { LoadingState } from '@/components/common/LoadingState'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, bookingTone } from '@/components/ops/ops-ui'
import { BookingActions } from '@/components/bookings/BookingActions'
import { OperationsRecord } from '@/components/bookings/OperationsRecord'
import { deadlineUrgency, formatInZone, statusLabel } from '@/lib/booking-ui'
import { getOpsBooking } from '@/lib/data/operations'

const TABS = [{ id: 'summary', label: 'Summary' }, { id: 'pricing', label: 'Pricing' }, { id: 'timeline', label: 'Timeline' }, { id: 'record', label: 'Operations record' }] as const
type TabId = (typeof TABS)[number]['id']
const parseTab = (v: string | null): TabId => TABS.find((t) => t.id === v)?.id ?? 'summary'
const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(150px, 230px) 1fr', gap: '6px 14px', margin: 0, fontSize: 12 }
const actionLabel = (a: NonNullable<BookingDetailView['timeline'][number]['action']>) => (a === 'createManual' ? 'Entered manually' : a === 'editReferences' ? 'References edited' : BOOKING_ACTION_RULES[a]?.label ?? a)
const muted: React.CSSProperties = { color: '#3f565c' }

function Detail({ id }: { id: string }) {
  const tab = parseTab(useSearchParams().get('tab'))
  const { state, reload } = useOpsQuery(() => getOpsBooking(id), [id])
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div className="admin-page">
      {notice && <div role="status" data-testid="booking-notice" className="workspace-panel" style={{ padding: '8px 14px', marginBottom: 10, fontSize: 12 }}>{notice}</div>}
      <OpsState state={state} onRetry={reload}>
        {(d) => <DetailBody d={d} id={id} tab={tab} onChanged={(message) => { setNotice(message || null); reload() }} />}
      </OpsState>
    </div>
  )
}

function DetailBody({ d, id, tab, onChanged }: { d: BookingDetailView; id: string; tab: TabId; onChanged: (message: string) => void }) {
  const b = d.booking
  const tabs = TABS.filter((t) => t.id !== 'record' || d.operationsRecord !== null)
  const urgency = deadlineUrgency(b.cancelDeadline, new Date())
  return (
    <>
      <header className="workspace-panel" data-testid="booking-header" style={{ padding: '12px 18px', position: 'sticky', top: 0, zIndex: 2, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href="/bookings" className="admin-btn">All bookings</Link>
          <h1 style={{ margin: 0, fontSize: 18 }}>{b.reference}</h1>
          <Tag tone={bookingTone(b.status)}>{statusLabel(b.status)}</Tag>
          {b.supplierStatus && b.supplierStatus.toUpperCase() !== b.status ? <span style={muted}>Supplier: {b.supplierStatus}</span> : null}
          {b.isRefundable === false && <Tag tone="warn">NON-REFUNDABLE</Tag>}
          {b.amended && <Tag tone="neutral">AMENDED</Tag>}
          {b.closedAt && <Tag tone="neutral">CLOSED</Tag>}
          {b.missingSupplierRef && <Tag tone="bad">MISSING SUPPLIER REF</Tag>}
        </div>
        <div style={{ ...muted, fontSize: 11 }}>
          {b.agency ? b.agency.name : 'Unassigned agency'}{b.agent ? ` · ${b.agent}` : ''} · {b.hotel.name ?? 'hotel not readable'}
          {b.cancelDeadline ? <> · free cancellation until <strong style={{ color: urgency === 'soon' ? '#a11d1d' : undefined }}>{formatInZone(b.cancelDeadline, b.hotel.timeZone)}</strong>{urgency === 'passed' ? ' (passed)' : ''}</> : null}
        </div>
        <BookingActions d={d} onChanged={onChanged} />
      </header>
      <nav aria-label="Booking sections" style={{ marginTop: 12 }}>
        <div className="admin-tabs" role="tablist">
          {tabs.map((t) => <Link key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="booking-panel" href={t.id === 'summary' ? `/bookings/${encodeURIComponent(id)}` : `/bookings/${encodeURIComponent(id)}?tab=${t.id}`} replace scroll={false} className={`admin-tab ${tab === t.id ? 'active' : ''}`}>{t.label}</Link>)}
        </div>
      </nav>
      <div role="tabpanel" id="booking-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'summary' && <Summary d={d} />}
        {tab === 'pricing' && <Pricing d={d} />}
        {tab === 'timeline' && <Timeline d={d} />}
        {tab === 'record' && d.operationsRecord !== null && (
          d.operationsRecord.state === 'available'
            ? <OperationsRecord b={d.operationsRecord.data} />
            : <div className="workspace-panel" role="status" data-state="denied" style={{ padding: 18 }}><strong>The transaction record is not readable here.</strong><p style={{ margin: '6px 0 0' }}>Inventory hold, supplier journal, finance entries, documents and reconciliation flags come from tables the API database role cannot read. That is a deliberate privilege boundary, not an empty record. A human must review the grant before this appears.</p></div>
        )}
      </div>
    </>
  )
}

function Summary({ d }: { d: BookingDetailView }) {
  const b = d.booking
  return (
    <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="s-stay">
        <h2 id="s-stay" style={{ fontSize: 14, margin: '0 0 8px' }}>Stay</h2>
        <dl style={dl}>
          <dt>Hotel</dt><dd>{b.hotel.name ?? <span style={muted}>not readable</span>}{b.hotel.city ? `, ${b.hotel.city}` : ''}</dd>
          <dt>Address</dt><dd>{b.hotelAddress ?? '—'}</dd>
          <dt>Check-in → check-out</dt><dd>{b.checkIn && b.checkOut ? `${b.checkIn} → ${b.checkOut} (${b.nights ?? '—'} night${b.nights === 1 ? '' : 's'})` : <span style={muted}>not recorded</span>}</dd>
          <dt>Hotel time zone</dt><dd>{b.hotel.timeZone ?? '—'}</dd>
          <dt>Rooms</dt>
          <dd>{d.rooms.length === 0 ? <span style={muted}>not recorded</span> : <ul style={{ margin: 0, paddingLeft: 16 }}>{d.rooms.map((r) => <li key={r.position}>{r.quantity} × {r.roomName ?? 'room'}{r.boardCode ? ` · ${r.boardCode}` : ''} · {r.adults} adult{r.adults === 1 ? '' : 's'}{r.children ? `, ${r.children} child${r.children === 1 ? '' : 'ren'}${r.childAges.length ? ` (ages ${r.childAges.join(', ')})` : ''}` : ''} per room</li>)}</ul>}</dd>
          <dt>Special requests</dt><dd><span style={muted}>Not stored on bookings yet</span></dd>
        </dl>
      </section>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="s-guests">
        <h2 id="s-guests" style={{ fontSize: 14, margin: '0 0 8px' }}>Guests</h2>
        {d.guests.length === 0 ? <p style={muted}>No guest is recorded for this booking.</p> : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }} aria-label="Guests">
            <thead><tr><th scope="col" align="left">Name</th><th scope="col" align="left">Type</th><th scope="col" align="left">Room</th></tr></thead>
            <tbody>{d.guests.map((g, i) => <tr key={i}><td>{g.name}{g.isLead ? ' (lead)' : ''}</td><td>{g.type === 'ADULT' ? 'AD' : `CH${g.age !== null ? ` ${g.age}` : ''}`}</td><td>{g.roomPosition ?? '—'}</td></tr>)}</tbody>
          </table>
        )}
        {d.guests.some((g) => g.masked) && <p style={{ ...muted, fontSize: 11 }}>Names are masked: your role does not include the guest-data permission. Unmasked reads are audited.</p>}
      </section>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="s-ref">
        <h2 id="s-ref" style={{ fontSize: 14, margin: '0 0 8px' }}>References and ownership</h2>
        <dl style={dl}>
          <dt>Reference</dt><dd><code>{b.reference}</code></dd>
          <dt>Agency</dt><dd>{b.agency?.name ?? <span style={muted}>Unassigned (not derivable for this booking)</span>}</dd>
          <dt>Agent</dt><dd>{b.agent ?? '—'}</dd>
          <dt>Agent reference</dt><dd>{b.agentRef ?? '—'}</dd>
          <dt>Channel</dt><dd>{b.channel}</dd>
          <dt>Supplier</dt><dd>{b.supplier}</dd>
          <dt>Supplier reference</dt><dd>{b.supplierRef ? <code>{b.supplierRef}</code> : b.missingSupplierRef ? <strong style={{ color: '#a11d1d' }}>Missing</strong> : '—'}</dd>
          <dt>Hotel confirmation no.</dt><dd>{b.hotelConfirmationNo ?? '—'}</dd>
          <dt>Assigned to</dt><dd>{b.assignedTo?.name ?? '—'}</dd>
          <dt>Booked on</dt><dd>{formatInZone(b.createdAt, null)}</dd>
          <dt>Version</dt><dd>{b.version}</dd>
        </dl>
      </section>
    </div>
  )
}

function Pricing({ d }: { d: BookingDetailView }) {
  const p = d.pricing
  const hidden = p.netVisibility === 'HIDDEN_BY_PERMISSION'
  return (
    <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="p-amt" data-testid="pricing">
        <h2 id="p-amt" style={{ fontSize: 14, margin: '0 0 8px' }}>Amounts ({p.currency})</h2>
        <dl style={dl}>
          <dt>Sell</dt><dd><Money minor={p.sellMinor} currency={p.currency} /></dd>
          <dt>Net cost</dt><dd>{hidden ? <span style={muted}>Not visible to your role</span> : p.netMinor === null ? <span style={muted}>Not recorded</span> : <Money minor={p.netMinor} currency={p.currency} />}</dd>
          <dt>Markup</dt><dd>{hidden ? <span style={muted}>Not visible to your role</span> : p.markupMinor === null ? <span style={muted}>Not recorded</span> : <Money minor={p.markupMinor} currency={p.currency} />}</dd>
          <dt>Margin</dt><dd>{hidden ? <span style={muted}>Not visible to your role</span> : p.marginMinor === null ? <span style={muted}>Not recorded</span> : <Money minor={p.marginMinor} currency={p.currency} />}</dd>
          <dt>FX rate frozen at booking</dt><dd>{p.fxRate ?? <span style={muted}>Not recorded</span>}</dd>
        </dl>
      </section>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="p-can">
        <h2 id="p-can" style={{ fontSize: 14, margin: '0 0 8px' }}>Cancellation</h2>
        <dl style={dl}>
          <dt>Refundable</dt><dd>{p.isRefundable === null ? <span style={muted}>Not recorded</span> : p.isRefundable ? 'Yes' : 'No (non-refundable)'}</dd>
          <dt>Free cancellation until</dt><dd>{p.cancelDeadline ? formatInZone(p.cancelDeadline, d.booking.hotel.timeZone) : <span style={muted}>Not recorded</span>}</dd>
          <dt>Policy snapshot</dt><dd><span style={muted}>Not stored on bookings yet. The penalty steps are not invented here.</span></dd>
          <dt>Markup rule applied</dt><dd><span style={muted}>Not stored on bookings yet.</span></dd>
        </dl>
      </section>
    </div>
  )
}

function Timeline({ d }: { d: BookingDetailView }) {
  return (
    <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="t-h" data-testid="timeline">
      <h2 id="t-h" style={{ fontSize: 14, margin: '0 0 8px' }}>Timeline</h2>
      {d.timeline.length === 0 ? <p style={muted}>No events are recorded.</p> : (
        <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, fontSize: 12 }}>
          {d.timeline.map((e, i) => (
            <li key={i} data-kind={e.kind}>
              <strong>{e.kind === 'status' ? e.title.replace(/_/g, ' ') : e.title}</strong>{e.action ? <span style={muted}> · {actionLabel(e.action)}</span> : null}{' '}
              <span style={muted}>· {formatInZone(e.at, null)}{e.actor ? ` · ${e.actor}` : e.actorType ? ` · ${e.actorType.toLowerCase()}` : ''}{e.requestId ? ` · request ${e.requestId}` : ''}</span>
              {e.reason ? <div style={muted}>{e.reason}</div> : null}
              {e.backfilled ? <div style={{ ...muted, fontSize: 11 }}>Recorded when the lifecycle log was introduced; earlier history is in the audit entries.</div> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <Suspense fallback={<LoadingState rows={6} />}><Detail id={id} /></Suspense>
}
