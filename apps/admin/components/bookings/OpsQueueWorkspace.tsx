'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  BOOKING_OPS_PRIORITIES, BOOKING_OPS_PRIORITY_LABEL, BOOKING_OPS_REASON_LABEL, BOOKING_OPS_REASONS, BOOKING_OPS_SAFE_ACTION_LABEL, BOOKING_OPS_SLA_LABEL, BOOKING_OPS_SLA_STATES, BOOKING_OPS_TAB_LABEL, BOOKING_OPS_TABS,
  type BookingOpsQueueItem, type BookingOpsQueuePage, type BookingOpsQueueQuery, type BookingOpsTab,
} from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { Tag } from '@/components/ops/ops-ui'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { describeActionError, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { formatRemaining, opsQueryString, priorityTone, readOpsQuery, slaTone, withOpsFilters } from '@/lib/booking-ops-ui'
import { formatInZone, statusLabel } from '@/lib/booking-ui'
import { assignOpsCase, getOpsQueue } from '@/lib/data/operations'

const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '5px 8px', fontSize: 12, font: 'inherit', minWidth: 0 }
const label: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 11, color: '#3f565c' }
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#3f565c', borderBottom: '1px solid #dbe6e9', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12, verticalAlign: 'top', borderBottom: '1px solid #eef3f4' }

/**
 * The booking operations queue (ADR 0039, Phase 4). The server decides membership, priority, SLA and order; this screen only shows them. The order is not a column sort:
 * Critical, Urgent, breached, due soon, then the oldest case, the same for everyone. Every filter lives in the URL.
 */
export function OpsQueueWorkspace() {
  const router = useRouter(); const search = useSearchParams()
  const query = useMemo(() => readOpsQuery(new URLSearchParams(search.toString())), [search])
  const apiString = opsQueryString(query)
  const { state, reload } = useOpsQuery(() => getOpsQueue(Object.fromEntries(new URLSearchParams(apiString.replace(/^\?/, '')))), [apiString])
  const [last, setLast] = useState<BookingOpsQueuePage | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  if (state.status === 'ready' && last !== state.data) setLast(state.data)
  const go = (patch: Partial<BookingOpsQueueQuery>) => router.replace(`/bookings/queue${opsQueryString(withOpsFilters(query, patch))}`, { scroll: false })
  const tab: BookingOpsTab = query.tab ?? 'active'

  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKINGS" title="Operations queue" description="Bookings that need a person: why, how urgent, and by when. The order is fixed by the server: Critical, Urgent, SLA breached, due soon, then the oldest case." />
      <p style={{ margin: '0 0 10px', fontSize: 12 }}><Link href="/bookings">All bookings</Link> · Operations queue</p>
      {notice && <div role="status" data-testid="queue-notice" className="workspace-panel" style={{ padding: '8px 14px', marginBottom: 10, fontSize: 12 }}>{notice}</div>}
      <nav aria-label="Queue views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 10px' }}>
        {BOOKING_OPS_TABS.map((t) => (
          <button key={t} type="button" className="admin-btn" data-tab={t} aria-pressed={tab === t} style={tab === t ? { background: '#0d2631', color: '#fff', borderColor: '#0d2631' } : undefined} onClick={() => go({ tab: t })}>
            {BOOKING_OPS_TAB_LABEL[t]}{last ? <span data-testid={`count-${t}`}> ({last.counts[t]})</span> : null}
          </button>
        ))}
      </nav>
      <Filters key={apiString} query={query} onApply={(patch) => go(patch)} onClear={() => router.replace(`/bookings/queue${opsQueryString({ tab: query.tab })}`, { scroll: false })} />
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: tab === 'resolved' ? 'Nothing resolved recently' : 'No cases', description: 'The queue was read successfully and nothing matches. This is an empty result, not an error.' }}>
        {(data) => (
          <>
            {data.scanCapped && <p role="status" style={{ fontSize: 12, color: '#8a5a00' }}>More bookings need attention than the {2000} the queue reads at once: counts and order cover the most recently active.</p>}
            <div className="workspace-panel" style={{ overflowX: 'auto' }} role="region" aria-label="Operations queue table" tabIndex={0}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Operations queue" data-testid="queue-table">
                <thead><tr>
                  <th style={th} scope="col">Priority</th><th style={th} scope="col">Booking</th><th style={th} scope="col">Why</th><th style={th} scope="col">SLA</th><th style={th} scope="col">Booking status</th><th style={th} scope="col">Supplier</th>
                  <th style={th} scope="col">Owner</th><th style={th} scope="col">Last supplier activity</th><th style={th} scope="col">Next safe step</th><th style={th} scope="col"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>{data.items.map((i) => <Row key={i.bookingId} item={i} page={data} onChanged={(m) => { setNotice(m); reload() }} />)}</tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => go({ page })} />
            <p style={{ fontSize: 11, color: '#3f565c' }} data-testid="sla-policy">SLA targets (minutes): {BOOKING_OPS_REASONS.map((r) => `${BOOKING_OPS_REASON_LABEL[r]} ${data.slaPolicy.minutes[r]}`).join(' · ')}. Due soon is the last {Math.round(data.slaPolicy.dueSoonFraction * 100)}% of a target.</p>
          </>
        )}
      </OpsState>
    </div>
  )
}

function Row({ item: i, page, onChanged }: { item: BookingOpsQueueItem; page: BookingOpsQueuePage; onChanged: (message: string) => void }) {
  const [busy, setBusy] = useState(false); const [key] = useState(newIdempotencyKey); const [error, setError] = useState<string | null>(null)
  const mine = i.assignee?.id === page.viewer.id
  async function claim() {
    setBusy(true); setError(null)
    try { await assignOpsCase(i.bookingId, { assigneeUserId: page.viewer.id, expectedVersion: i.opsVersion }, key); onChanged(`${i.reference} is now yours.`) } catch (e) { const d = describeActionError(e); setError(d.message); setBusy(false) }
  }
  return (
    <tr data-testid="queue-row" data-reference={i.reference} data-priority={i.priority} data-sla={i.slaState ?? ''}>
      <td style={td}><Tag tone={priorityTone(i.priority)}>{BOOKING_OPS_PRIORITY_LABEL[i.priority].toUpperCase()}</Tag></td>
      <td style={td}><Link href={`/bookings/${i.bookingId}?tab=operations`} aria-label={`Open ${i.reference}`}>{i.reference}</Link><div style={{ color: '#3f565c', fontSize: 11 }}>{i.agency?.name ?? 'Unassigned agency'} · {i.hotel.name ?? '—'}{i.checkIn ? ` · check-in ${i.checkIn}` : ''}</div></td>
      <td style={td}>
        <strong>{i.primaryReason ? BOOKING_OPS_REASON_LABEL[i.primaryReason] : 'No longer a case'}</strong>
        {i.supplierCertainty === 'UNCERTAIN' && <div><Tag tone="bad">SUPPLIER STATE UNCERTAIN</Tag></div>}
        {i.reasons.length > 1 && <div style={{ color: '#3f565c', fontSize: 11 }}>also: {i.reasons.slice(1).map((r) => BOOKING_OPS_REASON_LABEL[r]).join(', ')}</div>}
      </td>
      <td style={td}>{i.slaState ? <><Tag tone={slaTone(i.slaState)}>{BOOKING_OPS_SLA_LABEL[i.slaState].toUpperCase()}</Tag><div style={{ fontSize: 11 }}>{formatRemaining(i.slaRemainingSeconds)}</div><div style={{ color: '#3f565c', fontSize: 11 }}>due {formatInZone(i.slaDueAt, null)}</div></> : <span style={{ color: '#3f565c' }}>{i.lastActivityAt ? `last activity ${formatInZone(i.lastActivityAt, null)}` : '—'}</span>}</td>
      <td style={td}>{statusLabel(i.status)}</td>
      <td style={td}>{i.supplier.name}{!i.supplier.configured && <div><Tag tone="neutral">NOT CONFIGURED</Tag></div>}{i.supplierStatus && <div style={{ fontSize: 11 }}>answer: {i.supplierStatus.replace(/_/g, ' ')}</div>}</td>
      <td style={td} data-testid="owner">{i.assignee ? <>{i.assignee.name}{mine ? ' (you)' : ''}{i.acknowledgedAt ? <div style={{ fontSize: 11, color: '#3f565c' }}>acknowledged</div> : null}</> : <span style={{ color: '#3f565c' }}>Unassigned</span>}</td>
      <td style={td}>{i.lastSupplierActivityAt ? formatInZone(i.lastSupplierActivityAt, null) : '—'}</td>
      <td style={td}>{i.safeAction ? BOOKING_OPS_SAFE_ACTION_LABEL[i.safeAction] : '—'}</td>
      <td style={td}>
        {i.inQueue && page.can.assign && !mine && <button type="button" className="admin-btn" disabled={busy} aria-label={`Claim ${i.reference}`} data-action="claim" onClick={() => void claim()}>{busy ? 'Claiming…' : i.assignee ? 'Take over' : 'Claim'}</button>}
        {error && <div role="alert" style={{ color: '#a11d1d', fontSize: 11, maxWidth: 220 }}>{error}</div>}
      </td>
    </tr>
  )
}

function Filters({ query, onApply, onClear }: { query: BookingOpsQueueQuery; onApply: (patch: Partial<BookingOpsQueueQuery>) => void; onClear: () => void }) {
  const [f, setF] = useState({ reference: query.reference ?? '', supplier: query.supplier ?? '', reason: query.reason?.[0] ?? '', priority: query.priority?.[0] ?? '', sla: query.sla?.[0] ?? '', assignee: query.assignee ?? '', checkInFrom: query.checkInFrom ?? '', checkInTo: query.checkInTo ?? '', createdFrom: query.createdFrom ?? '', createdTo: query.createdTo ?? '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((v) => ({ ...v, [k]: e.target.value }))
  return (
    <form aria-label="Queue filters" className="workspace-panel" style={{ padding: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', marginBottom: 10 }}
      onSubmit={(e) => { e.preventDefault(); onApply({ reference: f.reference.trim() || undefined, supplier: f.supplier.trim() || undefined, reason: f.reason ? [f.reason as never] : undefined, priority: f.priority ? [f.priority as never] : undefined, sla: f.sla ? [f.sla as never] : undefined, assignee: f.assignee || undefined, checkInFrom: f.checkInFrom || undefined, checkInTo: f.checkInTo || undefined, createdFrom: f.createdFrom || undefined, createdTo: f.createdTo || undefined }) }}>
      <label style={label}>Booking reference<input style={input} value={f.reference} onChange={set('reference')} placeholder="FB-…" /></label>
      <label style={label}>Supplier<input style={input} value={f.supplier} onChange={set('supplier')} /></label>
      <label style={label}>Queue reason<select style={input} value={f.reason} onChange={set('reason')}><option value="">Any</option>{BOOKING_OPS_REASONS.map((r) => <option key={r} value={r}>{BOOKING_OPS_REASON_LABEL[r]}</option>)}</select></label>
      <label style={label}>Priority<select style={input} value={f.priority} onChange={set('priority')}><option value="">Any</option>{BOOKING_OPS_PRIORITIES.map((p) => <option key={p} value={p}>{BOOKING_OPS_PRIORITY_LABEL[p]}</option>)}</select></label>
      <label style={label}>SLA state<select style={input} value={f.sla} onChange={set('sla')}><option value="">Any</option>{BOOKING_OPS_SLA_STATES.map((s) => <option key={s} value={s}>{BOOKING_OPS_SLA_LABEL[s]}</option>)}</select></label>
      <label style={label}>Owner<select style={input} value={f.assignee} onChange={set('assignee')}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option></select></label>
      <label style={label}>Check-in from<input style={input} type="date" value={f.checkInFrom} onChange={set('checkInFrom')} /></label>
      <label style={label}>Check-in to<input style={input} type="date" value={f.checkInTo} onChange={set('checkInTo')} /></label>
      <label style={label}>Created from<input style={input} type="date" value={f.createdFrom} onChange={set('createdFrom')} /></label>
      <label style={label}>Created to<input style={input} type="date" value={f.createdTo} onChange={set('createdTo')} /></label>
      <button type="submit" className="admin-btn admin-btn-primary">Apply filters</button><button type="button" className="admin-btn" onClick={onClear}>Clear</button>
    </form>
  )
}
