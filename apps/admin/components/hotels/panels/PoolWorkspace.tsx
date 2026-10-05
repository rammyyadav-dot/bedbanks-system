'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { POOL_CAPACITY_LIMITS, QUICK_UPDATE_WEEKDAYS, type InventoryPoolDetail, type PoolCapacityPreview, type PoolConsumptionReport, type QuickUpdateWeekday } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { ApiResponseError } from '@/lib/api/errors'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { applyPoolCapacity, getPoolConsumption, getPoolDetail, previewPoolCapacity } from '@/lib/data/hotel-inventory'
import { hotelHref } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const iso = /^\d{4}-\d{2}-\d{2}$/
type Failure = { message: string; details: string[]; requestId: string | null; code: string | null }

/**
 * One shared pool (ADR 0036): identity, daily counters, per-plan consumption and the bounded capacity editor. Every number comes from the API;
 * nothing here computes stock. The editor previews first (no write), then applies exactly that preview: the server re-validates and refuses
 * a preview that has gone stale.
 */
export function PoolWorkspace({ hotelId, poolId }: { hotelId: string; poolId: string }) {
  const [days, setDays] = useState(14); const [from, setFrom] = useState('')
  const range = { ...(iso.test(from) ? { from } : {}), days }
  const detail = useOpsQuery(() => getPoolDetail(hotelId, poolId, range), [hotelId, poolId, from, days])
  const consumption = useOpsQuery(() => getPoolConsumption(hotelId, poolId, range), [hotelId, poolId, from, days])
  const refreshAll = () => { detail.refresh(); consumption.refresh() }
  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="pool-workspace">
      <p style={{ margin: 0 }}><Link href={`/hotels/${hotelId}?tab=inventory`} data-testid="pool-back">← All pools of this hotel</Link></p>
      <OpsState state={detail.state} onRetry={detail.reload}>
        {(d) => (
          <>
            <PoolIdentity hotelId={hotelId} d={d} />
            <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 10 }} aria-label="Pool window">
              <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={(e) => e.preventDefault()} aria-label="Date range">
                <label style={field}>From (hotel date)<input type="date" className="input-wrap" value={from || d.window.from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label style={field}>Nights<select className="input-wrap" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 62].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <span style={note}>{d.window.from} → {d.window.to} · hotel time zone {d.timeZone} · hotel today {d.hotelToday}</span>
              </form>
              <DailyTable d={d} />
            </section>
          </>
        )}
      </OpsState>
      <OpsState state={consumption.state} onRetry={consumption.reload}>{(c) => <ConsumptionReport c={c} />}</OpsState>
      <CapacityEditor hotelId={hotelId} poolId={poolId} hotelToday={detail.state.status === 'ready' ? detail.state.data.hotelToday : ''} archived={detail.state.status === 'ready' && detail.state.data.pool.status !== 'ACTIVE'} onApplied={refreshAll} />
    </div>
  )
}

function PoolIdentity({ hotelId, d }: { hotelId: string; d: InventoryPoolDetail }) {
  const can = useCan()
  return (
    <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 6 }} aria-label="Pool identity" data-testid="pool-identity">
      <header style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{d.pool.name}</h2><Chip tone={d.pool.status === 'ACTIVE' ? 'ok' : 'warn'}>{d.pool.status}</Chip>
        <span style={note}>{d.hotelName} · supplier {d.pool.supplierName}</span>
      </header>
      <p style={{ margin: 0, fontSize: 12 }}>Rooms: {d.rooms.length ? d.rooms.map((r) => r.name).join(', ') : 'none (no linked plan)'}</p>
      <p style={{ margin: 0, fontSize: 12 }}>Linked rate plans: {d.pool.members.length === 0 ? 'none' : d.pool.members.map((m) => <span key={m.ratePlanId} style={{ marginRight: 8 }}><code>{m.ratePlanCode}</code> ({m.roomName} · {m.boardCode}, {m.planStatus})</span>)}</p>
      <p style={note}>{d.auditNote}{can('audit.read') ? <> <Link href={hotelHref(hotelId, 'audit')}>Open the hotel audit trail</Link>.</> : ' You do not have audit.read, so the trail is not shown to you.'}</p>
    </section>
  )
}

function DailyTable({ d }: { d: InventoryPoolDetail }) {
  return (
    <ScrollRegion label="Pool nights" maxHeight={320}><table style={tableStyle} aria-label="Pool capacity and consumption by night" data-testid="pool-days">
      <thead><tr>{['Date', 'Capacity', 'Sold', 'Held', 'Available', 'Source', 'State'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
      <tbody>{d.days.map((n) => (
        <tr key={n.date} data-date={n.date} data-state={!n.exists ? 'missing' : n.stale ? 'stale' : n.available === 0 ? 'sold-out' : 'ok'}>
          <td style={td}>{n.date}</td><td style={td}>{n.capacity ?? '—'}</td><td style={td}>{n.sold ?? '—'}</td><td style={td}>{n.held ?? '—'}</td><td style={td}><strong>{n.available ?? '—'}</strong></td>
          <td style={td}>{n.source ?? '—'}</td>
          <td style={td}>{!n.exists ? <Chip tone="warn">NO STOCK ROW (unknown)</Chip> : n.stale ? <Chip tone="bad">STALE</Chip> : n.available === 0 ? <Chip tone="bad">SOLD OUT</Chip> : <Chip tone="ok">OK</Chip>}</td>
        </tr>))}</tbody></table></ScrollRegion>
  )
}

function ConsumptionReport({ c }: { c: PoolConsumptionReport }) {
  const unavailable = c.attribution.state === 'unavailable'
  const name = (id: string) => c.plans.find((p) => p.ratePlanId === id)?.ratePlanCode ?? id
  return (
    <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 10 }} aria-label="Per-plan consumption" data-testid="consumption">
      <h2 style={{ fontSize: 14, margin: 0 }}>Consumption by rate plan</h2>
      {unavailable && <div role="status" className="admin-error" data-testid="attribution-unavailable" style={{ padding: 8, fontSize: 12 }}><strong>Per-plan attribution is unavailable.</strong> The API database role cannot read the hold records it needs. Pool totals below are still exact; the per-plan split is unknown, not zero.</div>}
      {!unavailable && c.totals.inconsistentNights > 0 && <div role="alert" className="admin-error" data-testid="inconsistent" style={{ padding: 8, fontSize: 12 }}><strong>{c.totals.inconsistentNights} night{c.totals.inconsistentNights === 1 ? '' : 's'} inconsistent.</strong> The holds recorded for these nights claim more units than the pool counter holds. The figures are shown as recorded and are not corrected here.</div>}
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px 16px', margin: 0 }} data-testid="consumption-totals">
        <div><dt>Nights with a pool row</dt><dd>{c.totals.nightsWithPoolDay}</dd></div>
        <div><dt>Attributed held</dt><dd>{c.totals.attributedHeld ?? '—'}</dd></div><div><dt>Attributed sold</dt><dd>{c.totals.attributedSold ?? '—'}</dd></div>
        <div><dt>Unattributed held</dt><dd>{c.totals.unattributedHeld ?? '—'}</dd></div><div><dt>Unattributed sold</dt><dd>{c.totals.unattributedSold ?? '—'}</dd></div>
      </dl>
      <ScrollRegion label="Totals per rate plan"><table style={tableStyle} aria-label="Totals per rate plan" data-testid="consumption-plans">
        <thead><tr>{['Rate plan', 'Room · board', 'Contract', 'Membership', 'Held (unit-nights)', 'Sold (unit-nights)'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{c.plans.map((p) => (
          <tr key={p.ratePlanId} data-plan-id={p.ratePlanId}>
            <td style={td}><code>{p.ratePlanCode}</code></td><td style={td}>{p.roomName} · {p.boardCode}</td><td style={td}>{p.contractCode}</td>
            <td style={td}>{p.member ? <Chip tone="ok">MEMBER</Chip> : <Chip tone="warn" title="Left the pool; its recorded consumption is kept">FORMER MEMBER</Chip>}</td>
            <td style={td}>{p.held ?? '—'}</td><td style={td}>{p.sold ?? '—'}</td>
          </tr>))}</tbody></table></ScrollRegion>
      <ScrollRegion label="Consumption by night" maxHeight={360}><table style={tableStyle} aria-label="Consumption by night" data-testid="consumption-nights">
        <thead><tr>{['Date', 'Capacity', 'Held', 'Sold', 'Available', 'Held by plan', 'Sold by plan', 'Unattributed (held / sold)', 'Reconciles'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{c.nights.map((n) => (
          <tr key={n.date} data-date={n.date} data-consistent={String(n.consistent)}>
            <td style={td}>{n.date}</td><td style={td}>{n.capacity ?? '—'}</td><td style={td}>{n.held ?? '—'}</td><td style={td}>{n.sold ?? '—'}</td><td style={td}>{n.available ?? '—'}</td>
            <td style={td}>{n.plans.filter((p) => p.held > 0).map((p) => `${name(p.ratePlanId)} ${p.held}`).join(', ') || '—'}</td>
            <td style={td}>{n.plans.filter((p) => p.sold > 0).map((p) => `${name(p.ratePlanId)} ${p.sold}`).join(', ') || '—'}</td>
            <td style={td}>{n.unattributedHeld === null ? '—' : `${n.unattributedHeld} / ${n.unattributedSold}`}</td>
            <td style={td}>{!n.exists ? <Chip tone="warn">NO STOCK ROW</Chip> : n.consistent === null ? <Chip tone="neutral">UNKNOWN</Chip> : n.consistent ? <Chip tone="ok">YES</Chip> : <Chip tone="bad">INCONSISTENT</Chip>}</td>
          </tr>))}</tbody></table></ScrollRegion>
      <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>How these numbers are defined</summary>
        <ul style={{ fontSize: 12, display: 'grid', gap: 4 }}>
          <li>{c.definitions.counters}</li><li><strong>Held.</strong> {c.definitions.held}</li><li><strong>Sold.</strong> {c.definitions.sold}</li><li><strong>Not counted.</strong> {c.definitions.excluded}</li><li><strong>Attribution.</strong> {c.definitions.attribution}</li>
          {c.definitions.limitations.map((l) => <li key={l}><strong>Limitation.</strong> {l}</li>)}
        </ul></details>
    </section>
  )
}

function CapacityEditor({ hotelId, poolId, hotelToday, archived, onApplied }: { hotelId: string; poolId: string; hotelToday: string; archived: boolean; onApplied: () => void }) {
  const can = useCan()
  const canPreview = can('supply.pool_capacity.preview'); const canApply = can('supply.pool_capacity.apply')
  const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [weekdays, setWeekdays] = useState<QuickUpdateWeekday[]>([]); const [capacity, setCapacity] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<{ result: PoolCapacityPreview; request: { startDate: string; endDate: string; weekdays: QuickUpdateWeekday[]; capacity: number } } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null); const [error, setError] = useState<Failure | null>(null); const [done, setDone] = useState<string | null>(null)
  const inFlight = useRef(false); const key = useRef<string | null>(null)

  const trimmed = capacity.trim()
  const capacityNumber = trimmed === '' ? null : /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  const problems: string[] = []
  if (!iso.test(start)) problems.push('Choose a start date.')
  if (!iso.test(end)) problems.push('Choose an end date.')
  if (iso.test(start) && iso.test(end) && end < start) problems.push('The end date is before the start date.')
  if (hotelToday && iso.test(start) && start < hotelToday) problems.push(`Nights before ${hotelToday} (hotel date) cannot be edited.`)
  if (capacityNumber === null) problems.push('Enter a capacity. Blank means unchanged, so there is nothing to preview (0 is a valid capacity).')
  else if (!Number.isInteger(capacityNumber) || capacityNumber < 0 || capacityNumber > POOL_CAPACITY_LIMITS.maxCapacity) problems.push(`Capacity must be a whole number from 0 to ${POOL_CAPACITY_LIMITS.maxCapacity}.`)
  const valid = problems.length === 0

  const invalidate = () => { setPreview(null); setDone(null); key.current = null }
  const fail = (e: unknown, action: string) => { const p = apiErrorParts(e, action); setError({ message: p.message, details: p.details, requestId: p.requestId, code: p.code }) }

  async function runPreview() {
    if (inFlight.current || !valid) return
    inFlight.current = true; setBusy('preview'); setError(null); setDone(null)
    const request = { startDate: start, endDate: end, weekdays, capacity: capacityNumber as number }
    try { setPreview({ result: await previewPoolCapacity(hotelId, poolId, request), request }); key.current = crypto.randomUUID() }
    catch (e) { setPreview(null); fail(e, 'preview the capacity change') }
    finally { inFlight.current = false; setBusy(null) }
  }
  async function runApply() {
    if (inFlight.current || !preview || !preview.result.canApply || reason.trim().length < POOL_CAPACITY_LIMITS.reasonMin) return
    inFlight.current = true; setBusy('apply'); setError(null)
    try {
      const { data } = await applyPoolCapacity(hotelId, poolId, { ...preview.request, expectedFingerprint: preview.result.fingerprint, reason: reason.trim(), idempotencyKey: key.current ?? crypto.randomUUID() })
      setDone(`${data.replayed ? 'Already applied (retry recognised). ' : ''}Capacity applied: ${data.changed.updated} night(s) changed, ${data.changed.created} created.`)
      setPreview(null); key.current = null; setReason(''); onApplied()
    } catch (e) {
      fail(e, 'apply the capacity change')
      // An unreachable or failed server may or may not have applied it: keep the idempotency key so a retry of this same preview is recognised, not repeated. A definite refusal gets a new key.
      if (!(e instanceof ApiResponseError && (e.status === 0 || e.status >= 500))) key.current = null
    }
    finally { inFlight.current = false; setBusy(null) }
  }
  const stale = error?.code === 'POOL_CAPACITY_STALE'

  if (!canPreview && !canApply) return <p style={note} data-testid="read-only-note">You have read-only access to this pool. Previewing or changing capacity needs the pool capacity permissions.</p>
  return (
    <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 10 }} aria-label="Capacity editor" data-testid="capacity-editor">
      <h2 style={{ fontSize: 14, margin: 0 }}>Edit capacity</h2>
      <p style={note}>Sets the shared capacity of this pool for a range of nights (up to {POOL_CAPACITY_LIMITS.maxRangeDays}). It never allocates stock, removes holds or sold units, changes prices or restrictions, or enables booking. A capacity below the units already sold or held is refused.</p>
      {archived && <p role="status" className="admin-error" style={{ padding: 8, fontSize: 12, margin: 0 }}>This pool is archived and cannot be edited.</p>}
      <form style={{ display: 'grid', gap: 10 }} aria-label="Capacity change" onSubmit={(e) => { e.preventDefault(); void runPreview() }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={field}>Start date<input type="date" className="input-wrap" value={start} min={hotelToday || undefined} onChange={(e) => { setStart(e.target.value); invalidate() }} /></label>
          <label style={field}>End date<input type="date" className="input-wrap" value={end} min={start || hotelToday || undefined} onChange={(e) => { setEnd(e.target.value); invalidate() }} /></label>
          <label style={field}>New capacity (rooms)<input className="input-wrap" inputMode="numeric" value={capacity} aria-describedby="capacity-help" onChange={(e) => { setCapacity(e.target.value); invalidate() }} style={{ width: 130 }} /></label>
        </div>
        <fieldset style={{ border: '1px solid #e6eef0', margin: 0, padding: 8 }}><legend style={{ fontSize: 12 }}>Weekdays (none selected = every day)</legend>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{QUICK_UPDATE_WEEKDAYS.map((w) => (
            <label key={w} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={weekdays.includes(w)} onChange={(e) => { setWeekdays((s) => e.target.checked ? [...s, w] : s.filter((x) => x !== w)); invalidate() }} />{w}</label>))}</div></fieldset>
        <p id="capacity-help" style={note}>Whole number 0–{POOL_CAPACITY_LIMITS.maxCapacity}. Leave blank to change nothing; enter 0 to set a capacity of zero.</p>
        {problems.length > 0 && (start !== '' || end !== '' || capacity !== '') && <ul role="status" data-testid="editor-problems" style={{ margin: 0, fontSize: 12, color: '#a11d1d' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div><button type="submit" className="button primary" data-testid="preview-button" disabled={busy !== null || !valid || !canPreview || archived}>{busy === 'preview' ? 'Previewing…' : 'Preview change'}</button></div>
      </form>

      {error && (
        <div role="alert" className="admin-error" data-testid="editor-error" style={{ padding: 8, fontSize: 12 }}>
          <strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}
          {error.requestId && <div>Reference: <code>{error.requestId}</code></div>}
          {stale && <div style={{ marginTop: 6 }} data-testid="stale-help">The pool changed after you previewed it, so nothing was written. <button type="button" className="admin-btn" disabled={busy !== null || !valid} onClick={() => void runPreview()}>Preview again</button></div>}
        </div>)}
      {done && <p role="status" data-testid="editor-done" style={{ margin: 0, fontSize: 12 }}>{done}</p>}

      {preview && (
        <div style={{ display: 'grid', gap: 8 }} data-testid="preview" aria-label="Preview of the capacity change">
          <p style={{ margin: 0, fontSize: 12 }} data-testid="preview-counts"><strong>{preview.result.counts.willChange}</strong> to change · <strong>{preview.result.counts.willCreate}</strong> to create · <strong>{preview.result.counts.unchanged}</strong> unchanged · <strong>{preview.result.counts.invalid}</strong> invalid (of {preview.result.counts.dates} nights, hotel time {preview.result.timeZone}).{preview.result.truncated ? ` Showing the first ${preview.result.rows.length}.` : ''}</p>
          {preview.result.errors.length > 0 && <ul role="alert" style={{ margin: 0, fontSize: 12, color: '#a11d1d' }}>{preview.result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <ScrollRegion label="Capacity preview" maxHeight={320}><table style={tableStyle} aria-label="Capacity preview by night" data-testid="preview-table">
            <thead><tr>{['Date', 'Day', 'Before: capacity · sold · held · available', 'After: capacity · available', 'Result'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{preview.result.rows.map((r) => (
              <tr key={r.date} data-date={r.date} data-outcome={r.outcome}>
                <td style={td}>{r.date}</td><td style={td}>{r.weekday}</td>
                <td style={td}>{r.before ? `${r.before.capacity} · ${r.before.sold} · ${r.before.held} · ${r.before.available}` : 'no stock row (unknown)'}</td>
                <td style={td}>{r.after ? `${r.after.capacity} · ${r.after.available}` : '—'}</td>
                <td style={td}><Chip tone={r.outcome === 'INVALID' ? 'bad' : r.outcome === 'UNCHANGED' ? 'neutral' : 'ok'}>{r.outcome}</Chip>{r.problems.map((p) => <div key={p} style={{ fontSize: 11, color: '#a11d1d' }}>{p}</div>)}</td>
              </tr>))}</tbody></table></ScrollRegion>
          <ul style={{ ...note, paddingLeft: 16 }}>{preview.result.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          {canApply ? (
            <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }} aria-label="Apply capacity change" onSubmit={(e) => { e.preventDefault(); void runApply() }}>
              <label style={{ ...field, minWidth: 260 }}>Reason (audited, 3–{POOL_CAPACITY_LIMITS.reasonMax} characters)<input className="input-wrap" value={reason} maxLength={POOL_CAPACITY_LIMITS.reasonMax} onChange={(e) => setReason(e.target.value)} /></label>
              <button type="submit" className="button primary" data-testid="apply-button" disabled={busy !== null || !preview.result.canApply || reason.trim().length < POOL_CAPACITY_LIMITS.reasonMin}>{busy === 'apply' ? 'Applying…' : 'Apply exactly this change'}</button>
              {!preview.result.canApply && <span style={note}>This preview cannot be applied: fix the invalid nights or change nothing.</span>}
            </form>
          ) : <p style={note} data-testid="no-apply-note">You can preview but not apply. Applying needs the pool capacity apply permission.</p>}
        </div>)}
    </section>
  )
}
