'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { HotelCommercial360, RatePlanReadiness, RatePlanReadinessCheck } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { capabilityBlockedReason, describeRatePlanActionError, readinessFailuresFromError, type RatePlanAction } from '@/lib/rate-plan-errors'
import { activateRatePlan, cloneRatePlan, getHotelRatePlans, getRatePlanCapabilities, getRatePlanReadiness, suspendRatePlan, type AdminRatePlan } from '@/lib/data'
import { hotelHref } from '@/lib/hotel-ui'
import { ActivationApprovalPanel } from './ActivationApprovalPanel'
import { HotelOfferPanel } from './HotelOfferPanel'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const
const PAGE_SIZE = 25
// The Actions column stays visible while the table scrolls sideways, so Activate/Suspend/Clone are never clipped off-screen.
const nowrap: React.CSSProperties = { ...td, whiteSpace: 'nowrap' }
const actionsTh: React.CSSProperties = { ...th, position: 'sticky', right: 0, zIndex: 1, borderLeft: '1px solid #e6eef0' }
const actionsTd: React.CSSProperties = { ...td, whiteSpace: 'nowrap', position: 'sticky', right: 0, background: '#fff', borderLeft: '1px solid #e6eef0' }
const statusTone = (status: string) => (status === 'ACTIVE' ? 'ok' : status === 'DRAFT' ? 'neutral' : 'warn') as 'ok' | 'neutral' | 'warn'
const OCCUPANCY_LABEL: Record<number, string> = { 1: 'SGL', 2: 'DBL', 3: 'TPL', 4: 'QUAD' }
const markets = (value: unknown): string => (Array.isArray(value) && value.length ? value.join(', ') : 'All markets')

type Pending = { plan: AdminRatePlan; action: 'activate' | 'suspend' | 'clone' }

/**
 * Hotel-scoped rate plan listing and lifecycle. Every rule (readiness, versioning, permission, audit) lives in the API; this
 * panel shows its verdict and never decides eligibility itself.
 */
export function RatePlansPanel({ hotelId, rooms }: { hotelId: string; rooms: HotelCommercial360['rooms'] }) {
  const can = useCan()
  const canManage = can('supply.rates.manage')
  const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1)
  const [pending, setPending] = useState<Pending | null>(null)
  const { state, reload } = useOpsQuery(() => getHotelRatePlans(hotelId, { search: search.trim() || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }), [hotelId, search, status, page])
  // The server states which actions this environment can perform (ADR 0041 Amendment 3). A failed or pending lookup fails closed: controls stay disabled.
  const caps = useOpsQuery(() => getRatePlanCapabilities(), [])
  const capabilities = caps.state.status === 'ready' ? caps.state.data : undefined
  const blocked = (action: RatePlanAction) => (caps.state.status === 'loading' ? 'Checking availability for this environment…' : capabilityBlockedReason(capabilities, action))
  const blockedNotices = canManage && caps.state.status !== 'loading' ? [...new Set((['activate', 'suspend', 'clone'] as const).map(blocked).filter((reason): reason is string => reason !== null))] : []
  const roomName = (id: string) => rooms.find((room) => room.id === id)?.name ?? '—'

  return (
    <div className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }}>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.total === 0 && !search && !status} empty={{ title: 'No rate plans', description: 'This hotel has no rate plan yet. Create one against a contract and room type to start loading rates.' }}>
        {(data) => (
          <>
            <div role="toolbar" aria-label="Rate plan toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', position: 'sticky', top: 0, background: '#fff', zIndex: 2, paddingBottom: 8 }}>
              <span data-testid="plan-counts" style={{ fontSize: 12 }}>
                <strong>{rooms.length}</strong> room types · <strong>{data.statusCounts ? Object.values(data.statusCounts).reduce((a, b) => a + b, 0) : data.total}</strong> rate plans
                {data.statusCounts ? <> · {data.statusCounts.ACTIVE} active · {data.statusCounts.DRAFT + data.statusCounts.SUSPENDED + data.statusCounts.EXPIRED} inactive ({data.statusCounts.DRAFT} draft, {data.statusCounts.SUSPENDED} suspended, {data.statusCounts.EXPIRED} expired)</> : null}
              </span>
              <label style={{ fontSize: 11 }}>Search code <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Rate plan code" aria-label="Search rate plans by code" /></label>
              <label style={{ fontSize: 11 }}>Status <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Filter by status"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {canManage ? <Link href="/rates/plans/new" className="admin-btn admin-btn-primary">+ Create Rate Plan</Link> : null}
                {canManage ? <Link href={hotelHref(hotelId, 'quick')} className="admin-btn">Bulk Update</Link> : null}
                <Link href={hotelHref(hotelId, 'rates')} className="admin-btn">View Rate Calendar</Link>
              </span>
            </div>
            {blockedNotices.length ? (
              <div role="note" data-testid="capability-notice" style={{ border: '1px solid #e5d9a8', background: '#fffbe6', padding: '8px 12px', fontSize: 12, display: 'grid', gap: 2 }}>
                {blockedNotices.map((notice) => <span key={notice}>{notice}</span>)}
              </div>
            ) : null}
            {pending && pending.action === 'activate' && capabilities?.activationApproval === 'required'
              ? <ActivationApprovalPanel key={`${pending.plan.id}:approval`} plan={pending.plan} onClose={() => { setPending(null); reload() }} onDone={() => { setPending(null); reload() }} />
              : pending ? <ActionPanel key={`${pending.plan.id}:${pending.action}`} pending={pending} rooms={rooms} onClose={() => setPending(null)} onDone={() => { setPending(null); reload() }} /> : null}
            <ScrollRegion label="Rate plans" maxHeight={560}>
              <table style={tableStyle} aria-label="Rate plans">
                <thead><tr>{['Code', 'Status', 'Room type', 'Board', 'Contract', 'Currency', 'Occupancy', 'Validity', 'Cancellation', 'Distribution', 'Actions'].map((h) => <th key={h} scope="col" style={h === 'Actions' ? actionsTh : th}>{h}</th>)}</tr></thead>
                <tbody>
                  {data.items.length === 0 ? <tr><td style={td} colSpan={11}>No rate plan matches these filters.</td></tr> : null}
                  {data.items.map((plan) => (
                    <tr key={plan.id} data-plan-id={plan.id} data-status={plan.status}>
                      <td style={nowrap}><code>{plan.code}</code></td>
                      <td style={td}><Chip tone={statusTone(plan.status)}>{plan.status}</Chip></td>
                      <td style={td}>{roomName(plan.roomTypeId)}</td>
                      <td style={td} title={plan.boardBasis.name}>{plan.boardBasis.code}</td>
                      <td style={nowrap}><Link href={`/contracts/${plan.contract.id}`}>{plan.contract.code}</Link><div style={{ fontSize: 10, color: '#3f565c' }}>{plan.contract.supplier.displayName}{plan.contract.status ? ` · ${plan.contract.status}` : ''}</div></td>
                      <td style={td}>{plan.currency}</td>
                      <td style={nowrap}>{OCCUPANCY_LABEL[plan.occupancy] ?? `${plan.occupancy} pax`} · stay {plan.minStay}{plan.maxStay ? `–${plan.maxStay}` : '+'}</td>
                      <td style={nowrap}>{plan.contract.validFrom && plan.contract.validTo ? `${plan.contract.validFrom.slice(0, 10)} → ${plan.contract.validTo.slice(0, 10)}` : '—'}<div style={{ fontSize: 10, color: '#3f565c' }}>contract term</div></td>
                      <td style={td}>{plan.refundable ? <Chip tone="neutral" title="Uses the contract's cancellation schedule">Contract schedule</Chip> : <Chip tone="warn">Non-refundable</Chip>}</td>
                      <td style={td}>{markets(plan.contract.salesMarkets)}</td>
                      <td style={actionsTd}>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <Link href={`/rates/plans/${plan.id}`}>{canManage ? 'View / edit' : 'View'}</Link>
                          {canManage ? <ActionButton label="Clone" reason={blocked('clone')} onClick={() => setPending({ plan, action: 'clone' })} /> : null}
                          {canManage && (plan.status === 'DRAFT' || plan.status === 'SUSPENDED') ? <ActionButton label={capabilities?.activationApproval === 'required' ? 'Activation approval' : 'Activate'} reason={blocked('activate')} onClick={() => setPending({ plan, action: 'activate' })} /> : null}
                          {canManage && plan.status === 'ACTIVE' ? <ActionButton label="Suspend" reason={blocked('suspend')} onClick={() => setPending({ plan, action: 'suspend' })} /> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <nav aria-label="Rate plan pages" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <button type="button" className="admin-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {data.page} · {data.total} match{data.total === 1 ? '' : 'es'}</span>
              <button type="button" className="admin-btn" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>Next</button>
            </nav>
            <p style={{ color: '#3f565c', fontSize: 11, margin: 0 }}>Activation runs the API's readiness checklist; a plan with any failed check stays in its current state. Per-plan market eligibility is inherited from the contract: there is no separate plan-level distribution setting.</p>
            {canManage ? <HotelOfferPanel hotelId={hotelId} plans={data.items.filter((plan) => plan.status !== 'EXPIRED')} onApplied={reload} /> : null}
          </>
        )}
      </OpsState>
    </div>
  )
}

/** A lifecycle control that is disabled, with the reason as its tooltip and accessible description, when the environment cannot perform the action. */
function ActionButton({ label, reason, onClick }: { label: string; reason: string | null; onClick: () => void }) {
  return <button type="button" className="admin-btn" disabled={reason !== null} title={reason ?? undefined} aria-label={reason ? `${label} (unavailable: ${reason})` : undefined} data-unavailable={reason !== null} onClick={onClick}>{label}</button>
}

function ActionPanel({ pending, rooms, onClose, onDone }: { pending: Pending; rooms: HotelCommercial360['rooms']; onClose: () => void; onDone: () => void }) {
  const { plan, action } = pending
  const [reason, setReason] = useState(''); const [code, setCode] = useState(''); const [roomTypeId, setRoomTypeId] = useState(plan.roomTypeId)
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [failedChecks, setFailedChecks] = useState<RatePlanReadinessCheck[]>([])
  const readiness = useOpsQuery<RatePlanReadiness>(() => getRatePlanReadiness(plan.id), [plan.id])

  const run = async (version: string) => {
    setBusy(true); setError(null); setFailedChecks([])
    try {
      if (action === 'activate') await activateRatePlan(plan.id, version)
      else if (action === 'suspend') await suspendRatePlan(plan.id, version, reason.trim())
      onDone()
    } catch (e) { setError(describeRatePlanActionError(e, action as RatePlanAction)); setFailedChecks(readinessFailuresFromError(e)); readiness.reload() } finally { setBusy(false) }
  }
  const clone = async () => {
    setBusy(true); setError(null)
    try { await cloneRatePlan(plan.id, { code: code.trim(), ...(roomTypeId !== plan.roomTypeId ? { roomTypeId } : {}) }); onDone() } catch (e) { setError(describeRatePlanActionError(e, 'clone')) } finally { setBusy(false) }
  }

  return (
    <section aria-label={`${action} ${plan.code}`} style={{ border: '1px solid #e5e7eb', background: '#f7f8fa', padding: 12, display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>{action === 'activate' ? 'Activate' : action === 'suspend' ? 'Suspend' : 'Clone'} <code>{plan.code}</code></h3>
      {action === 'clone' ? (
        <>
          <p style={{ margin: 0, fontSize: 12 }}>Creates a new DRAFT with the same commercial setup. Rates, availability and inventory pool membership are not copied.</p>
          <label style={{ fontSize: 11 }}>New rate plan code <input value={code} onChange={(e) => setCode(e.target.value)} required aria-label="New rate plan code" /></label>
          <label style={{ fontSize: 11 }}>Room type <select value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
          <span style={{ display: 'flex', gap: 8 }}><button type="button" className="admin-btn admin-btn-primary" disabled={busy || code.trim().length < 2} onClick={clone}>{busy ? 'Cloning…' : 'Create draft clone'}</button><button type="button" className="admin-btn" onClick={onClose}>Cancel</button></span>
        </>
      ) : (
        <OpsState state={readiness.state} onRetry={readiness.reload}>
          {(r) => (
            <>
              {action === 'activate' ? (
                <ul data-testid="readiness-checklist" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                  {r.checks.map((c) => <li key={c.code} data-check={c.code} data-ok={c.ok} style={{ padding: '2px 0' }}><Chip tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'PASS' : 'FAIL'}</Chip> <strong>{c.label}</strong>: {c.message}</li>)}
                </ul>
              ) : (
                <label style={{ fontSize: 11 }}>Reason (recorded in the audit history) <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Suspension reason" style={{ width: '100%' }} /></label>
              )}
              {error ? <p role="alert" style={{ color: '#a11d1d', fontSize: 12, margin: 0 }}>{error}</p> : null}
              {failedChecks.length ? (
                <ul data-testid="server-failed-checks" aria-label="Checks the server rejected" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                  {failedChecks.map((c) => <li key={c.code} data-check={c.code}><Chip tone="bad">FAIL</Chip> <strong>{c.label}</strong>: {c.message}</li>)}
                </ul>
              ) : null}
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="admin-btn admin-btn-primary" disabled={busy || (action === 'activate' ? !r.ready : reason.trim().length < 3)} onClick={() => run(r.updatedAt)}>{busy ? 'Saving…' : action === 'activate' ? 'Confirm activation' : 'Confirm suspension'}</button>
                <button type="button" className="admin-btn" onClick={onClose}>Cancel</button>
              </span>
              {action === 'suspend' ? <p style={{ margin: 0, fontSize: 11, color: '#3f565c' }}>Suspending stops this plan from being offered in Agent search. Existing bookings keep their stored references.</p> : null}
            </>
          )}
        </OpsState>
      )}
      {action === 'clone' && error ? <p role="alert" style={{ color: '#a11d1d', fontSize: 12, margin: 0 }}>{error}</p> : null}
    </section>
  )
}
