'use client'

import { useEffect, useState } from 'react'
import { BOOKING_SUPPLIER_OP_LABEL, type BookingDetailView, type BookingSupplierOp } from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'
import { describeActionError, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { formatInZone } from '@/lib/booking-ui'
import { postBookingSupplier } from '@/lib/data/operations'

const muted: React.CSSProperties = { color: '#3f565c' }
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', fontSize: 11, color: '#3f565c' }
const td: React.CSSProperties = { padding: '4px 8px', fontSize: 12, verticalAlign: 'top' }
const JOB_TONE = { QUEUED: 'warn', RUNNING: 'warn', RETRY_WAIT: 'warn', SUCCEEDED: 'ok', FAILED: 'bad', UNKNOWN: 'bad' } as const
const OP_HELP: Record<BookingSupplierOp, string> = {
  send: 'Queues the booking to its supplier. The result appears here and in the timeline.',
  cancel: 'Queues the cancellation to the supplier. If the supplier refuses, the booking stays “Cancel requested” for you to settle by hand.',
  retryNow: 'The next attempt is waiting for its delay: run it now.',
  sync: 'Asks the supplier what it holds under our reference. Safe to repeat; it never creates a booking.',
}
const EXPLAIN: Record<string, string> = {
  SUPPLIER_TIMEOUT: 'The supplier did not answer in time.', SUPPLIER_UNREACHABLE: 'The supplier could not be reached.', NO_AVAILABILITY: 'The supplier has no availability.', CANCEL_NOT_ALLOWED: 'The supplier will not cancel this booking.',
  SUPPLIER_NOT_CONFIGURED: 'No supplier connection is set up.', RUNNER_LOST: 'The worker stopped during the last attempt, so the outcome is not known.', ALREADY_APPLIED: 'The booking had already been settled.', NOT_FOUND_AT_SUPPLIER: 'The supplier holds nothing under our reference.',
}
const explain = (code: string | null) => (code ? EXPLAIN[code] ?? code : null)

/** The supplier queue of one booking: what is queued, what the supplier said, and what an operator may do next. Polls while a job is in flight. */
export function SupplierPanel({ d, onChanged, refresh }: { d: BookingDetailView; onChanged: (message: string) => void; refresh: () => void }) {
  const s = d.supplier
  const [busy, setBusy] = useState<BookingSupplierOp | null>(null)
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)
  const [keys] = useState<Record<string, string>>({})
  const inFlight = s?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'RETRY_WAIT') ?? false
  useEffect(() => { if (!inFlight) return; const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [inFlight, refresh])
  if (!s) return null
  const unknown = s.jobs[0]?.status === 'UNKNOWN' || s.supplierStatus === 'UNKNOWN'

  async function start(op: BookingSupplierOp) {
    if (busy) return
    setBusy(op); setError(null)
    // The key is kept per operation and status so a retry after a timeout replays; it changes once the booking has moved on.
    const id = `${op}:${d.booking.status}:${s?.jobs[0]?.id ?? 'none'}`
    keys[id] ??= newIdempotencyKey()
    try { await postBookingSupplier(d.booking.id, { op, expectedStatus: d.booking.status }, keys[id]); onChanged(`${BOOKING_SUPPLIER_OP_LABEL[op]}: queued.`) } catch (err) { setError(describeActionError(err)) } finally { setBusy(null) }
  }

  return (
    <section className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 12 }} aria-labelledby="sup-h" data-testid="supplier-panel">
      <h2 id="sup-h" style={{ fontSize: 14, margin: 0 }}>Supplier</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <span style={muted}>Supplier:</span> <strong>{d.booking.supplier}</strong>
        <span style={muted}>Supplier answer:</span> {s.supplierStatus ? <Tag tone={s.supplierStatus === 'UNKNOWN' || s.supplierStatus === 'CANCEL_FAILED' ? 'bad' : 'neutral'}>{s.supplierStatus.replace(/_/g, ' ')}</Tag> : <span style={muted}>none yet</span>}
      </div>
      {unknown && <div role="alert" data-testid="supplier-unknown" style={{ border: '1px solid #e0b4b4', background: '#fff7f7', padding: 10, borderRadius: 6, fontSize: 12 }}><strong>The supplier’s answer is not known.</strong> The booking has not been marked failed, because the supplier may have booked it. Use “Sync with supplier” to ask by our reference, or record the answer by hand once you know it. Do not send it again until then.</div>}
      {s.dispatch.reason === 'SUPPLIER_NOT_CONFIGURED' && <p role="status" style={{ ...muted, margin: 0, fontSize: 12 }}>No supplier connection is set up for “{d.booking.supplier}”, so nothing can be sent from here. Record the supplier’s answer with the actions above.</p>}
      {s.dispatch.reason === 'DISABLED' && <p role="status" style={{ ...muted, margin: 0, fontSize: 12 }}>The supplier queue is switched off in this environment.</p>}
      {s.dispatch.reason === 'NOT_PERMITTED' && <p role="status" style={{ ...muted, margin: 0, fontSize: 12 }}>You can see the queue but not use it (needs the supplier retry permission).</p>}
      {s.ops.length > 0 && (
        <div role="group" aria-label="Supplier operations" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {s.ops.map((op) => <button key={op} type="button" className="admin-btn" disabled={busy !== null} aria-busy={busy === op} data-op={op} title={OP_HELP[op]} onClick={() => void start(op)}>{busy === op ? 'Working…' : BOOKING_SUPPLIER_OP_LABEL[op]}</button>)}
        </div>
      )}
      {error && <div role="alert" data-testid="supplier-error" style={{ color: '#a11d1d', fontSize: 12 }}>{error.message}{error.requestId ? <div style={{ fontSize: 11, color: '#3f565c' }}>Reference: request {error.requestId}</div> : null}</div>}
      <div style={{ overflowX: 'auto' }}>
        <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Jobs</h3>
        {s.jobs.length === 0 ? <p style={{ ...muted, fontSize: 12, margin: 0 }}>Nothing has been sent to the supplier.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Supplier jobs"><thead><tr><th style={th}>Job</th><th style={th}>State</th><th style={th}>Attempt</th><th style={th}>Next try</th><th style={th}>Last problem</th></tr></thead>
            <tbody>{s.jobs.map((j) => <tr key={j.id}><td style={td}>{j.kind.replace('_', ' ').toLowerCase()}</td><td style={td}><Tag tone={JOB_TONE[j.status]}>{j.status.replace('_', ' ')}</Tag></td><td style={td}>{j.attempt} of {j.maxAttempts}</td><td style={td}>{j.status === 'RETRY_WAIT' ? formatInZone(j.runAfter, null) : '—'}</td><td style={td}>{explain(j.lastErrorCode) ?? '—'}</td></tr>)}</tbody></table>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Calls to the supplier</h3>
        <p style={{ ...muted, fontSize: 11, margin: '0 0 4px' }}>A summary of each call. The supplier’s raw requests and responses are never stored.</p>
        {s.calls.length === 0 ? <p style={{ ...muted, fontSize: 12, margin: 0 }}>No calls yet.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Supplier calls"><thead><tr><th style={th}>When</th><th style={th}>Call</th><th style={th}>Attempt</th><th style={th}>Result</th><th style={th}>Took</th><th style={th}>Supplier ref</th></tr></thead>
            <tbody>{s.calls.map((c) => <tr key={c.id}><td style={td}>{formatInZone(c.at, null)}</td><td style={td}>{c.action.replace('_', ' ').toLowerCase()}</td><td style={td}>{c.attempt}</td><td style={td}>{c.outcome.replace(/_/g, ' ')}{c.errorCode ? ` (${explain(c.errorCode)})` : ''}</td><td style={td}>{c.durationMs === null ? '—' : `${c.durationMs} ms`}</td><td style={td}>{c.supplierRef ?? '—'}</td></tr>)}</tbody></table>
        )}
      </div>
    </section>
  )
}
