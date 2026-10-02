'use client'

import { useRef, useState } from 'react'
import type { HotelCommercial360, SellabilityInspection } from '@bedbanks/contracts'
import { Money, Tag } from '@/components/ops/ops-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { ApiResponseError } from '@/lib/api/errors'
import { classifyOpsFailure, OPS_FAILURE_COPY, failureReference } from '@/lib/ops-state'
import { inspectHotelSellability } from '@/lib/data/hotel-commercial'
import { reasonText } from '@/lib/hotel-ui'
import { Chip } from '../ui'

const offset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** Runs the Agent's own stay evaluator server-side for the requested party and dates. The browser only renders the verdict. */
export function SellabilityPanel({ hotelId, rooms }: { hotelId: string; rooms: HotelCommercial360['rooms'] }) {
  const [checkIn, setCheckIn] = useState(offset(14)); const [checkOut, setCheckOut] = useState(offset(17))
  const [adults, setAdults] = useState('2'); const [children, setChildren] = useState('0'); const [roomsCount, setRoomsCount] = useState('1'); const [roomTypeId, setRoomTypeId] = useState('')
  const [running, setRunning] = useState(false); const inFlight = useRef(false)
  const [result, setResult] = useState<SellabilityInspection | null>(null)
  const [failure, setFailure] = useState<{ title: string; body: string; ref: string | null; kind: string } | null>(null)

  async function run() {
    if (inFlight.current) return
    inFlight.current = true; setRunning(true); setFailure(null); setResult(null)
    try {
      setResult(await inspectHotelSellability(hotelId, { checkIn, checkOut, adults, children, rooms: roomsCount, roomTypeId: roomTypeId || undefined }))
    } catch (error) {
      const kind = classifyOpsFailure(error)
      const copy = OPS_FAILURE_COPY[kind]
      // A 400 carries the API's own validation message (for example "Check-in must not be in the past").
      setFailure({ title: copy.title, body: error instanceof ApiResponseError && error.status === 400 ? describeApiError(error, 'inspect sellability') : copy.body, ref: failureReference(error), kind })
    } finally { inFlight.current = false; setRunning(false) }
  }

  return (
    <div className="workspace-panel" style={{ padding: 18 }}>
      <form aria-label="Sellability inspector" onSubmit={(event) => { event.preventDefault(); void run() }} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Check-in</span><input type="date" required value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Check-out</span><input type="date" required value={checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Adults</span><input type="number" min={1} max={9} required value={adults} onChange={(event) => setAdults(event.target.value)} style={{ width: 70 }} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Children</span><input type="number" min={0} max={9} value={children} onChange={(event) => setChildren(event.target.value)} style={{ width: 70 }} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Rooms</span><input type="number" min={1} max={9} value={roomsCount} onChange={(event) => setRoomsCount(event.target.value)} style={{ width: 70 }} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Room</span><select value={roomTypeId} onChange={(event) => setRoomTypeId(event.target.value)}><option value="">All rooms</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <button type="submit" className="button primary" disabled={running}>{running ? 'Checking…' : 'Check sellability'}</button>
      </form>
      {failure && <div className="admin-error" role="alert" data-state={failure.kind} style={{ marginTop: 12 }}><strong>{failure.title}</strong><span>{failure.body}</span>{failure.ref && <span>Reference: <code>{failure.ref}</code></span>}</div>}
      {result && (
        <div data-testid="sellability-result" style={{ marginTop: 16 }}>
          <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <Tag tone={result.sellable ? 'ok' : 'bad'}>{result.sellable ? 'SELLABLE' : 'NOT SELLABLE'}</Tag>
            <span>{result.request.checkIn} → {result.request.checkOut} · {result.request.nights} night{result.request.nights === 1 ? '' : 's'} · {result.request.adults} adult{result.request.adults === 1 ? '' : 's'}{result.request.children ? ` + ${result.request.children} child${result.request.children === 1 ? '' : 'ren'}` : ''} · {result.request.rooms} room{result.request.rooms === 1 ? '' : 's'}</span>
            {result.sellable && <span>Offers: <strong>{result.offers}</strong>{result.cheapestMinor && result.currency ? <> · cheapest total <strong><Money minor={result.cheapestMinor} currency={result.currency} /></strong></> : null}</span>}
          </div>
          {result.hotelReasons.length > 0 && <p>Hotel-level: {result.hotelReasons.map((r) => <Chip key={r} tone="bad" title={reasonText(r)}>{r}</Chip>)}</p>}
          {result.plans.length === 0 && <p data-testid="no-plans">This hotel has no rate plan to evaluate for the request.</p>}
          {result.plans.map((plan) => (
            <section key={plan.ratePlanId} aria-label={`${plan.roomName} ${plan.ratePlanCode}`} style={{ border: '1px solid #e6eef0', borderRadius: 6, padding: 12, marginBottom: 10 }} data-plan-id={plan.ratePlanId} data-sellable={plan.sellable}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Tag tone={plan.sellable ? 'ok' : 'bad'}>{plan.sellable ? 'SELLABLE' : 'NOT SELLABLE'}</Tag>
                <strong>{plan.roomName}</strong><span>{plan.boardCode} · <code>{plan.ratePlanCode}</code> · {plan.contractCode} · {plan.supplierName}</span>
                {plan.totalMinor && <span>Total <strong><Money minor={plan.totalMinor} currency={plan.currency} /></strong></span>}
              </div>
              {plan.reasons.length > 0 && <p style={{ margin: '8px 0 4px' }}>Blocking: {plan.reasons.map((r) => <span key={r} title={reasonText(r)} style={{ marginRight: 6 }}><code>{r}</code> {reasonText(r)}.</span>)}</p>}
              <ul style={{ listStyle: 'none', display: 'flex', gap: 6, flexWrap: 'wrap', padding: 0, margin: '8px 0' }} aria-label="Gates">
                {plan.gates.map((gate) => <li key={gate.key} data-gate={gate.key} data-state={gate.state}>{gate.label}: <Chip tone={gate.state === 'PASS' ? 'ok' : 'bad'}>{gate.state}</Chip></li>)}
              </ul>
              <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Night by night">
                {plan.nights.map((night) => (
                  <li key={night.date} data-date={night.date} data-sellable={night.sellable} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                    <span style={{ width: 90 }}>{night.date}</span><Chip tone={night.sellable ? 'ok' : 'bad'}>{night.sellable ? 'PASS' : night.reasons[0] ?? 'FAIL'}</Chip>
                    {night.rateMinor && plan.currency ? <Money minor={night.rateMinor} currency={plan.currency} /> : <span>no rate</span>}
                    <span style={{ color: '#3f565c', fontSize: 11 }}>remaining {night.remaining ?? '—'}</span>
                    {!night.sellable && night.reasons.length > 1 && <span style={{ fontSize: 11 }}>{night.reasons.slice(1).join(', ')}</span>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
