'use client'

import { useState } from 'react'
import type { SimulationResult } from '@bedbanks/contracts'
import { Chip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { Money } from '@/components/ops/ops-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { simulateRateStay } from '@/lib/data/rate-certification'
import { reasonText } from '@/lib/hotel-ui'
import { percentText } from '@/lib/rate-certification-ui'

const label = { display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#2c4a55' } as const
const iso = /^\d{4}-\d{2}-\d{2}$/

/** Prices a stay through the API's single contracted-stay evaluator. It shows the evaluator's answer and an independent recomputation; it saves nothing. */
export function Simulator({ initialRatePlanId = '' }: { initialRatePlanId?: string }) {
  const [ratePlanId, setRatePlanId] = useState(initialRatePlanId)
  const [checkIn, setCheckIn] = useState(''); const [checkOut, setCheckOut] = useState('')
  const [adults, setAdults] = useState('2'); const [children, setChildren] = useState('0'); const [rooms, setRooms] = useState('1')
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [result, setResult] = useState<SimulationResult | null>(null)
  const valid = ratePlanId.trim().length > 0 && iso.test(checkIn) && iso.test(checkOut) && checkOut > checkIn && Number(adults) >= 1
  async function run() {
    setBusy(true); setError(null)
    try { setResult(await simulateRateStay({ ratePlanId: ratePlanId.trim(), checkIn, checkOut, adults: Number(adults), children: Number(children), rooms: Number(rooms) })) }
    catch (e) { setResult(null); setError(describeApiError(e, 'simulate the stay')) }
    finally { setBusy(false) }
  }
  return (
    <div data-testid="simulator">
      <p style={{ fontSize: 12, color: '#3f565c', margin: '0 0 8px' }}>Read-only price check. It uses the same evaluator as Agent search and writes nothing: no hold, no rate change, no audit event.</p>
      <form aria-label="Price simulator" onSubmit={(event) => { event.preventDefault(); if (valid && !busy) void run() }} className="workspace-panel" style={{ padding: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={label}><span>Rate plan ID</span><input value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} maxLength={64} style={{ minWidth: 240 }} required /></label>
        <label style={label}><span>Check-in</span><input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required /></label>
        <label style={label}><span>Check-out</span><input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required /></label>
        <label style={label}><span>Adults</span><input type="number" min={1} max={9} value={adults} onChange={(e) => setAdults(e.target.value)} style={{ width: 64 }} /></label>
        <label style={label}><span>Children</span><input type="number" min={0} max={9} value={children} onChange={(e) => setChildren(e.target.value)} style={{ width: 64 }} /></label>
        <label style={label}><span>Rooms</span><input type="number" min={1} max={9} value={rooms} onChange={(e) => setRooms(e.target.value)} style={{ width: 64 }} /></label>
        <button type="submit" className="admin-btn" disabled={!valid || busy}>{busy ? 'Pricing…' : 'Simulate'}</button>
      </form>
      {error && <div className="admin-error" role="alert" style={{ marginTop: 12 }}><strong>Simulation failed</strong><span>{error}</span></div>}
      {result && (
        <div className="workspace-panel" style={{ marginTop: 12 }} data-testid="simulation-result" data-eligible={String(result.eligible)}>
          <div style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip tone={result.eligible ? 'ok' : 'bad'}>{result.eligible ? 'SELLABLE' : 'REFUSED'}</Chip>
            <span>Plan <code>{result.ratePlanCode}</code> · {result.rooms} room{result.rooms === 1 ? '' : 's'}</span>
            {result.eligible && <strong data-testid="simulation-total"><Money minor={result.totalMinor} currency={result.currency} /></strong>}
            {result.eligible && <span style={{ fontSize: 12, color: '#3f565c' }}>net <Money minor={result.netMinor} currency={result.currency} /> + markup <Money minor={result.markupMinor} currency={result.currency} /></span>}
            <Chip tone={result.reconciles ? 'ok' : 'bad'} title="The evaluator total compared with an independent per-night recomputation">{result.reconciles ? 'RECONCILES' : 'MISMATCH'}</Chip>
          </div>
          {result.reasons.length > 0 && <ul style={{ margin: '0 14px 12px', fontSize: 12 }} data-testid="simulation-reasons">{result.reasons.map((r) => <li key={r}><code>{r}</code> · {reasonText(r)}</li>)}</ul>}
          <ScrollRegion label="Per-night price breakdown">
            <table style={tableStyle} aria-label="Per-night price breakdown">
              <thead><tr>{['Night', 'Stored rate', 'Basis', 'Markup', 'Markup amount', 'Sell (per room)'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{result.nights.map((n) => (
                <tr key={n.date}>
                  <td style={td}>{n.date}</td>
                  <td style={td}><Money minor={n.rateMinor} currency={result.currency} /></td>
                  <td style={td}>{n.basis ?? '—'}</td>
                  <td style={td}>{n.markupBasisPoints === null ? '—' : percentText(n.markupBasisPoints)}</td>
                  <td style={td}><Money minor={n.markupMinor} currency={result.currency} /></td>
                  <td style={td}><Money minor={n.sellMinor} currency={result.currency} /></td>
                </tr>))}</tbody>
            </table>
          </ScrollRegion>
        </div>
      )}
    </div>
  )
}
