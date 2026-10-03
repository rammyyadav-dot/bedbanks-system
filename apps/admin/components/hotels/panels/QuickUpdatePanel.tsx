'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { QUICK_UPDATE_LIMITS, QUICK_UPDATE_WEEKDAYS, type HotelCommercial360, type HotelContractsView, type QuickUpdateChanges, type QuickUpdateFlag, type QuickUpdatePreview, type QuickUpdateRequest, type QuickUpdateWeekday } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { formatMinorUnits } from '@/lib/minor-units'
import { getHotelContracts } from '@/lib/data/hotel-commercial'
import { applyQuickUpdate, previewQuickUpdate } from '@/lib/data/hotel-quick-update'
import { hotelHref } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
type Flag = '' | QuickUpdateFlag
type Panels = { price: boolean; availability: boolean; restrictions: boolean }

/**
 * Quick Update: select a scope, opt each panel in, preview, review, apply. The server validates and applies; nothing here prices,
 * rounds or decides. An untouched panel or blank field is not sent, so it stays exactly as stored.
 */
export function QuickUpdatePanel({ hotelId, data }: { hotelId: string; data: HotelCommercial360 }) {
  const { state, reload } = useOpsQuery(() => getHotelContracts(hotelId), [hotelId])
  return <OpsState state={state} onRetry={reload}>{(contracts) => <QuickUpdateForm hotelId={hotelId} data={data} contracts={contracts} />}</OpsState>
}

function QuickUpdateForm({ hotelId, data, contracts }: { hotelId: string; data: HotelCommercial360; contracts: HotelContractsView }) {
  const can = useCan()
  const canRates = can('supply.rates.manage'); const canAvail = can('supply.availability.manage')
  const [contractId, setContractId] = useState(''); const [roomId, setRoomId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [ranges, setRanges] = useState([{ from: '', to: '' }])
  const [weekdays, setWeekdays] = useState<QuickUpdateWeekday[]>([])
  const [panels, setPanels] = useState<Panels>({ price: false, availability: false, restrictions: false })
  const [amount, setAmount] = useState(''); const [basis, setBasis] = useState<'NET' | 'SELL'>('SELL')
  const [allotment, setAllotment] = useState(''); const [stopSell, setStopSell] = useState<Flag>('')
  const [minStay, setMinStay] = useState(''); const [cta, setCta] = useState<Flag>('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<{ data: QuickUpdatePreview; key: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null); const inFlight = useRef(false); const applyKey = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[]; requestId: string | null } | null>(null)
  const [result, setResult] = useState<{ text: string; requestId: string | null } | null>(null)

  const plans = contracts.ratePlans.filter((p) => (!contractId || p.contractId === contractId) && (!roomId || p.roomTypeId === roomId))
  const currencies = useMemo(() => [...new Set(contracts.ratePlans.filter((p) => selected.includes(p.id)).map((p) => p.currency))], [contracts.ratePlans, selected])

  function build(): QuickUpdateRequest {
    const changes: QuickUpdateChanges = {}
    if (panels.price && amount.trim() !== '') changes.price = { amount: amount.trim(), basis }
    if (panels.availability) { const a: NonNullable<QuickUpdateChanges['availability']> = {}; if (allotment.trim() !== '') a.allotment = Number(allotment); if (stopSell) a.stopSell = stopSell; if (Object.keys(a).length) changes.availability = a }
    if (panels.restrictions) { const r: NonNullable<QuickUpdateChanges['restrictions']> = {}; if (minStay.trim() !== '') r.minStay = Number(minStay); if (cta) r.closedToArrival = cta; if (Object.keys(r).length) changes.restrictions = r }
    return { scope: { ratePlanIds: selected, ranges: ranges.filter((r) => r.from || r.to).map((r) => ({ from: r.from, to: r.to || r.from })), ...(weekdays.length ? { weekdays } : {}) }, changes }
  }
  const request = build(); const requestKey = JSON.stringify(request)
  const edited = (fn: () => void) => { fn(); applyKey.current = null; setResult(null) }
  const previewIsCurrent = preview !== null && preview.key === requestKey

  async function runPreview() {
    if (inFlight.current) return
    inFlight.current = true; setBusy('preview'); setError(null); setResult(null)
    try { const { data: p } = await previewQuickUpdate(hotelId, request); setPreview({ data: p, key: requestKey }) }
    catch (e) { const p = apiErrorParts(e, 'preview the update'); setPreview(null); setError({ message: p.message, details: p.details, requestId: p.requestId }) }
    finally { inFlight.current = false; setBusy(null) }
  }
  async function runApply() {
    if (inFlight.current || !preview || !previewIsCurrent || !preview.data.canApply || reason.trim().length < 3) return
    inFlight.current = true; setBusy('apply'); setError(null); applyKey.current ??= crypto.randomUUID()
    try {
      const { data: r, requestId } = await applyQuickUpdate(hotelId, { ...request, idempotencyKey: applyKey.current, expectedFingerprint: preview.data.fingerprint, reason: reason.trim() })
      applyKey.current = null; setPreview(null); setReason('')
      setResult({ text: `${r.replayed ? 'Already applied. ' : ''}Applied ${r.records} record${r.records === 1 ? '' : 's'}: ${r.changed.rates} rate${r.changed.rates === 1 ? '' : 's'} and ${r.changed.availabilityRows} inventory row${r.changed.availabilityRows === 1 ? '' : 's'} written.`, requestId: r.auditRequestId || requestId })
    } catch (e) { const p = apiErrorParts(e, 'apply the update'); setError({ message: p.message, details: p.details, requestId: p.requestId }) }
    finally { inFlight.current = false; setBusy(null) }
  }

  const togglePlan = (id: string) => edited(() => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < QUICK_UPDATE_LIMITS.plans ? [...s, id] : s)))
  const panelBox = (key: keyof Panels, label: string, enabled: boolean, children: React.ReactNode, why: string) => (
    <fieldset className="workspace-panel" style={{ padding: 14, margin: 0, display: 'grid', gap: 8, border: '1px solid #e6eef0' }} data-panel={key}>
      <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 6px' }}>{label}</legend>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={panels[key]} disabled={!enabled} onChange={(e) => edited(() => setPanels((p) => ({ ...p, [key]: e.target.checked })))} /> Change {label.toLowerCase()}</label>
      {!enabled && <p style={note}>{why}</p>}
      {panels[key] && enabled && children}
    </fieldset>
  )

  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="quick-update">
      <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Quick Update scope">
        <h2 style={{ fontSize: 14, margin: 0 }}>1. Select what to change</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label style={field}>Supplier / contract<select className="input-wrap" value={contractId} onChange={(e) => edited(() => setContractId(e.target.value))}><option value="">All contracts</option>{contracts.contracts.map((c) => <option key={c.id} value={c.id}>{c.supplierName} · {c.code}</option>)}</select></label>
          <label style={field}>Canonical room<select className="input-wrap" value={roomId} onChange={(e) => edited(() => setRoomId(e.target.value))}><option value="">All rooms</option>{data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <div style={field}><span>Allotment pool</span><span style={note}>Not supported: inventory is edited per rate plan.</span></div>
        </div>
        {plans.length === 0 ? <p data-testid="qu-no-plans" style={{ fontSize: 12 }}>No rate plan matches. Create a rate plan first; Quick Update changes existing plans.</p> : (
          <ScrollRegion label="Rate plans"><table style={tableStyle} aria-label="Rate plans to update">
            <thead><tr>{['Select', 'Rate plan', 'Room', 'Board', 'Supplier / contract', 'Currency', 'Occ.', 'Status'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{plans.map((p) => { const sup = contracts.contracts.find((c) => c.id === p.contractId); return (
              <tr key={p.id} data-plan-id={p.id}>
                <td style={td}><input type="checkbox" aria-label={`Select ${p.code}`} checked={selected.includes(p.id)} disabled={!selected.includes(p.id) && selected.length >= QUICK_UPDATE_LIMITS.plans} onChange={() => togglePlan(p.id)} /></td>
                <td style={td}><code>{p.code}</code></td><td style={td}>{p.roomName}</td><td style={td}>{p.boardCode}</td><td style={td}>{sup?.supplierName ?? '—'} · {p.contractCode}</td><td style={td}><strong>{p.currency}</strong></td><td style={td}>{p.occupancy}</td><td style={td}><Chip tone={p.status === 'ACTIVE' ? 'ok' : 'warn'}>{p.status}</Chip></td>
              </tr>) })}</tbody></table></ScrollRegion>
        )}
        <p style={note}>Up to {QUICK_UPDATE_LIMITS.plans} rate plans and {QUICK_UPDATE_LIMITS.records} plan-nights per update.{currencies.length > 1 ? ' The selected plans use different currencies, so a price cannot be changed in one update.' : ''}</p>
        <fieldset style={{ border: '1px solid #e6eef0', padding: 12, margin: 0, display: 'grid', gap: 8 }}>
          <legend style={{ fontSize: 12, fontWeight: 600 }}>Dates (hotel local, up to {QUICK_UPDATE_LIMITS.ranges} ranges)</legend>
          {ranges.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
              <label style={field}>From<input type="date" className="input-wrap" value={r.from} onChange={(e) => edited(() => setRanges(ranges.map((x, j) => (j === i ? { ...x, from: e.target.value } : x))))} /></label>
              <label style={field}>To<input type="date" className="input-wrap" value={r.to} onChange={(e) => edited(() => setRanges(ranges.map((x, j) => (j === i ? { ...x, to: e.target.value } : x))))} /></label>
              {ranges.length > 1 && <button type="button" className="admin-btn" onClick={() => edited(() => setRanges(ranges.filter((_, j) => j !== i)))}>Remove range</button>}
            </div>
          ))}
          {ranges.length < QUICK_UPDATE_LIMITS.ranges && <div><button type="button" className="admin-btn" onClick={() => edited(() => setRanges([...ranges, { from: '', to: '' }]))}>Add range</button></div>}
          <div role="group" aria-label="Weekdays" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
            {QUICK_UPDATE_WEEKDAYS.map((w) => <label key={w} style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={weekdays.includes(w)} onChange={() => edited(() => setWeekdays((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w])))} />{w}</label>)}
          </div>
          <p style={note}>No weekday ticked means every day in the range.</p>
        </fieldset>
      </section>

      <section style={{ display: 'grid', gap: 12 }} aria-label="Quick Update changes">
        <h2 style={{ fontSize: 14, margin: 0 }}>2. Choose what to change</h2>
        <p style={note}>Each panel changes nothing until you tick it, and a blank field inside a ticked panel is left unchanged. A blank price is no change, not zero.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {panelBox('price', 'Price', canRates, <>
            <label style={field}>Amount per night{currencies.length === 1 ? ` (${currencies[0]})` : ''}<input className="input-wrap" inputMode="decimal" value={amount} onChange={(e) => edited(() => setAmount(e.target.value))} placeholder="450.50" /></label>
            <label style={field}>Amount basis<select className="input-wrap" value={basis} onChange={(e) => edited(() => setBasis(e.target.value as 'NET' | 'SELL'))}><option value="SELL">SELL</option><option value="NET">NET</option></select></label>
            <p style={note}>Entered in the plan&apos;s own currency and stored as integer minor units. Applies to each plan&apos;s occupancy.</p>
          </>, 'You need the rates permission to change prices.')}
          {panelBox('availability', 'Availability', canAvail, <>
            <label style={field}>Allotment (units)<input className="input-wrap" inputMode="numeric" value={allotment} onChange={(e) => edited(() => setAllotment(e.target.value))} placeholder="leave blank for no change" /></label>
            <label style={field}>Stop-sell<select className="input-wrap" value={stopSell} onChange={(e) => edited(() => setStopSell(e.target.value as Flag))}><option value="">No change</option><option value="SET">Set stop-sell</option><option value="CLEAR">Clear stop-sell</option></select></label>
            <p style={note}>Stop-sell takes precedence over allotment. Allotment cannot go below units already sold or held.</p>
          </>, 'You need the availability permission to change inventory.')}
          {panelBox('restrictions', 'Restrictions', canAvail, <>
            <label style={field}>Minimum stay (nights)<input className="input-wrap" inputMode="numeric" value={minStay} onChange={(e) => edited(() => setMinStay(e.target.value))} placeholder="leave blank for no change" /></label>
            <label style={field}>Closed to arrival<select className="input-wrap" value={cta} onChange={(e) => edited(() => setCta(e.target.value as Flag))}><option value="">No change</option><option value="SET">Close to arrival</option><option value="CLEAR">Open to arrival</option></select></label>
            <p style={note}>Maximum stay, release days, lead time and cancellation terms belong to the rate plan or contract.</p>
          </>, 'You need the availability permission to change restrictions.')}
        </div>
        <div><button type="button" className="button primary" data-testid="qu-preview" disabled={busy !== null || selected.length === 0 || Object.keys(request.changes).length === 0 || request.scope.ranges.length === 0} onClick={() => void runPreview()}>{busy === 'preview' ? 'Previewing…' : 'Preview changes'}</button></div>
      </section>

      {error && <div role="alert" className="admin-error" data-testid="qu-error" style={{ padding: 12 }}><strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}{error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}</div>}
      {result && <div role="status" className="workspace-panel" data-testid="qu-result" style={{ padding: 12 }}><strong>{result.text}</strong>{result.requestId && <div style={note}>Audit reference (request id): <code data-testid="qu-request-id">{result.requestId}</code> · <Link href={hotelHref(hotelId, 'audit')}>Open the audit trail</Link></div>}</div>}

      {preview && (
        <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Preview" data-testid="qu-preview-result">
          <h2 style={{ fontSize: 14, margin: 0 }}>3. Review</h2>
          {!previewIsCurrent && <p role="status" data-testid="qu-stale-form" style={{ ...note, color: '#8a5a00' }}>You changed the form after this preview. Preview again before applying.</p>}
          <p style={{ fontSize: 12, margin: 0 }} data-testid="qu-counts">{preview.data.counts.records} record{preview.data.counts.records === 1 ? '' : 's'} over {preview.data.dates.length} night{preview.data.dates.length === 1 ? '' : 's'} (hotel today is {preview.data.hotelToday}, {preview.data.timeZone}): <strong>{preview.data.counts.willChange} will change</strong>, {preview.data.counts.unchanged} already match, <strong style={{ color: preview.data.counts.invalid ? '#a11d1d' : undefined }}>{preview.data.counts.invalid} invalid</strong>.</p>
          {preview.data.errors.length > 0 && <ul role="alert" data-testid="qu-errors" style={{ color: '#a11d1d', fontSize: 12 }}>{preview.data.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          {preview.data.counts.invalid > 0 && <p role="alert" style={{ fontSize: 12, color: '#a11d1d', margin: 0 }}>The batch is applied as a whole or not at all. Fix the invalid records or narrow the scope before applying.</p>}
          {preview.data.rows.length > 0 && (
            <ScrollRegion label="Preview rows" maxHeight={380}><table style={tableStyle} aria-label="Preview of changes">
              <thead><tr>{['Date', 'Rate plan', 'Outcome', 'Changes (old → new)', 'Problems'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{preview.data.rows.map((row) => { const plan = preview.data.plans.find((p) => p.id === row.ratePlanId); return (
                <tr key={`${row.ratePlanId}-${row.date}`} data-outcome={row.outcome} data-date={row.date}>
                  <td style={td}>{row.date}</td><td style={td}><code>{plan?.code ?? row.ratePlanId}</code></td>
                  <td style={td}><Chip tone={row.outcome === 'CHANGE' ? 'ok' : row.outcome === 'INVALID' ? 'bad' : 'neutral'}>{row.outcome === 'NO_CHANGE' ? 'NO CHANGE' : row.outcome}</Chip></td>
                  <td style={td}>{row.changes.length ? row.changes.map((c) => <div key={c.field}>{c.field === 'price' ? `price: ${c.from === null ? 'none' : formatMinorUnits(String(c.from), c.currency ?? '')} → ${formatMinorUnits(String(c.to), c.currency ?? '')}` : `${c.field}: ${c.from === null ? 'none' : String(c.from)} → ${String(c.to)}`}</div>) : '—'}</td>
                  <td style={td}>{row.problems.length ? row.problems.map((p) => <div key={p} style={{ color: '#a11d1d' }}>{p}</div>) : '—'}</td>
                </tr>) })}</tbody></table></ScrollRegion>
          )}
          {preview.data.truncated && <p style={note}>Only the first {QUICK_UPDATE_LIMITS.reportedRows} records are listed. All of them are validated and applied.</p>}
          <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>What Quick Update does not do</summary><ul style={{ fontSize: 12 }} data-testid="qu-unsupported">{preview.data.unsupported.map((u) => <li key={u}>{u}</li>)}</ul></details>
          <form style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void runApply() }}>
            <label style={{ ...field, minWidth: 280 }}>Reason (required, recorded in the audit)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => { applyKey.current = null; setReason(e.target.value) }} /></label>
            <button type="submit" className="button primary" data-testid="qu-apply" disabled={busy !== null || !previewIsCurrent || !preview.data.canApply || reason.trim().length < 3}>{busy === 'apply' ? 'Applying…' : 'Apply changes'}</button>
          </form>
        </section>
      )}
    </div>
  )
}
