'use client'

import { useState } from 'react'
import { HOTEL_DEAL_CHANNELS, type HotelDealPlanRef, type HotelDealPreviewResult } from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { describeApiError } from '@/lib/api/describe-error'
import { previewDeal } from '@/lib/data/hotel-deals'
import { formatMinorUnits } from '@/lib/minor-units'

const label: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 11, color: 'var(--c-3f565c)' }
const input: React.CSSProperties = { color: 'var(--c-17333e)', font: 'inherit', padding: '6px 8px', minWidth: 0 }
const money = (minor: string | null, currency: string) => (minor === null ? '—' : formatMinorUnits(minor, currency))
const today = () => new Date().toISOString().slice(0, 10)
/** Basis points of margin shown as a percentage using integers only. */
const marginText = (bp: number | null) => (bp === null ? 'not known (SELL-basis rate)' : `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`)

const OUTCOME: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  APPLIED: { tone: 'ok', text: 'Applied' }, NOT_ELIGIBLE: { tone: 'neutral', text: 'Not eligible for this stay or buyer' }, NO_SAVING: { tone: 'neutral', text: 'Saves nothing' },
  GUARD_BREACHED: { tone: 'bad', text: 'Stopped by a commercial guard' }, OUTRANKED: { tone: 'warn', text: 'Another promotion saves more' }, EXCLUDED_BY_STACK_RULE: { tone: 'warn', text: 'Excluded by a stacking rule' },
}
const GUARD: Record<string, string> = { MAX_DISCOUNT_EXCEEDED: 'maximum discount', SELL_FLOOR_BREACHED: 'minimum sell floor', MARGIN_BELOW_MINIMUM: 'minimum margin', GUARD_UNVERIFIABLE: 'a guard that cannot be verified for this rate' }

/**
 * The read-only simulator. It runs the one stay evaluator over the stored rates, with and without this deal, and writes nothing: no rate, no stock, no hold,
 * no booking. It prices the SAVED version of the deal. Nothing is typed in as a price: the net and the markup come from the plan's real rates.
 */
export function DealPreview({ dealId, version, plans }: { dealId: string; version: number; plans: HotelDealPlanRef[] }) {
  const [planId, setPlanId] = useState(plans[0]?.id ?? '')
  const [checkIn, setCheckIn] = useState(''); const [nights, setNights] = useState('3'); const [adults, setAdults] = useState('2'); const [rooms, setRooms] = useState('1')
  const [bookingDate, setBookingDate] = useState(''); const [market, setMarket] = useState(''); const [channel, setChannel] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [result, setResult] = useState<HotelDealPreviewResult | null>(null)

  async function run(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      setResult(await previewDeal(dealId, {
        ratePlanId: planId, checkIn, nights: Number(nights), adults: Number(adults), rooms: Number(rooms),
        ...(bookingDate ? { bookingDate } : {}), ...(market.trim() ? { market: market.trim().toUpperCase() } : {}), ...(channel ? { channel: channel as (typeof HOTEL_DEAL_CHANNELS)[number] } : {}),
      }))
    } catch (caught) { setResult(null); setError(describeApiError(caught, 'run the preview')) } finally { setBusy(false) }
  }

  const currency = result?.currency ?? 'AED'
  return (
    <section className="workspace-panel" style={{ padding: '16px 18px', display: 'grid', gap: 12 }} aria-label="Pricing simulator" data-testid="deal-preview">
      <div><h2 style={{ fontSize: 14, margin: 0 }}>Pricing simulator</h2><p style={{ fontSize: 10, color: 'var(--c-3f565c)', margin: '2px 0 0' }}>Read-only. It prices version {version} with the same evaluator search uses and does not write rates, inventory, holds or bookings.</p></div>
      <form onSubmit={run} aria-label="Simulator inputs" style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <label style={label}>Rate plan<select value={planId} onChange={(event) => setPlanId(event.target.value)} style={input} required>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.roomTypeName} · {plan.code}</option>)}</select></label>
        <label style={label}>Check-in *<input type="date" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} style={input} required /></label>
        <label style={label}>Nights<input inputMode="numeric" value={nights} onChange={(event) => setNights(event.target.value)} style={input} /></label>
        <label style={label}>Adults<input inputMode="numeric" value={adults} onChange={(event) => setAdults(event.target.value)} style={input} /></label>
        <label style={label}>Rooms<input inputMode="numeric" value={rooms} onChange={(event) => setRooms(event.target.value)} style={input} /></label>
        <label style={label}>Booking date<input type="date" value={bookingDate} onChange={(event) => setBookingDate(event.target.value)} min={today()} style={input} /><span style={{ fontSize: 10 }}>Empty means today in the hotel.</span></label>
        <label style={label}>Buyer market<input value={market} onChange={(event) => setMarket(event.target.value)} maxLength={2} placeholder="e.g. IN" style={input} /></label>
        <label style={label}>Channel<select value={channel} onChange={(event) => setChannel(event.target.value)} style={input}><option value="">Not stated</option><option value="PORTAL">Agent portal</option><option value="API">Distribution API</option></select></label>
        <div style={{ display: 'flex', alignItems: 'end' }}><button type="submit" className="admin-btn admin-btn-primary" disabled={busy || !planId || !checkIn}>{busy ? 'Running…' : 'Run preview'}</button></div>
      </form>
      {error ? <div className="admin-error" role="alert">{error}</div> : null}
      {result ? (
        <div style={{ display: 'grid', gap: 10 }} role="status" aria-live="polite" data-testid="deal-preview-result">
          {!result.eligible ? <div className="admin-error" role="alert"><strong>The base rate cannot be sold for this stay, so no price is shown.</strong><span>{result.reasons.join(', ') || 'No reason was reported.'}</span></div> : (
            <>
              <p style={{ margin: 0, fontSize: 12 }}>
                {result.dealApplied ? <Tag tone="ok">DEAL APPLIES</Tag> : <Tag tone="warn">DEAL DOES NOT APPLY</Tag>}{' '}
                Sell price for {result.rooms} room(s): <strong>{money(result.withoutDeal?.sellMinor ?? null, currency)}</strong> without the deal, <strong>{money(result.withDeal?.sellMinor ?? null, currency)}</strong> with it; the buyer saves <strong>{money(result.savingSellMinor, currency)}</strong>.
              </p>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--c-3f565c)' }}>Supplier net {money(result.withoutDeal?.netMinor ?? null, currency)} → {money(result.withDeal?.netMinor ?? null, currency)}. Margin on sell: {marginText(result.marginWithoutBp)} → {marginText(result.marginWithBp)}.</p>
              <ScrollRegion label="Nightly breakdown for one room">
                <table style={tableStyle} aria-label="Nightly breakdown for one room">
                  <thead><tr>{['Night', 'Base net', 'Deal', 'Extras', 'Net after', 'Markup', 'Sell'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{result.nights.map((night) => (
                    <tr key={night.date}><td style={td}>{night.date}</td><td style={td}>{money(night.baseNetMinor, currency)}</td><td style={td}>{night.promotionMinor === '0' ? '—' : `−${money(night.promotionMinor, currency)}`}</td><td style={td}>{night.supplementMinor === '0' ? '—' : money(night.supplementMinor, currency)}</td><td style={td}>{money(night.netMinor, currency)}</td><td style={td}>{money(night.markupMinor, currency)}</td><td style={td}><strong>{money(night.sellMinor, currency)}</strong></td></tr>
                  ))}</tbody>
                </table>
              </ScrollRegion>
            </>
          )}
          {result.trace.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11 }} aria-label="Why">
              {result.trace.map((entry) => <li key={entry.id}><strong>{entry.name}</strong>: <Tag tone={OUTCOME[entry.outcome]?.tone ?? 'neutral'}>{OUTCOME[entry.outcome]?.text ?? entry.outcome}</Tag>{entry.guard ? ` (${GUARD[entry.guard] ?? entry.guard})` : ''}{entry.savingMinor ? ` · would save ${money(entry.savingMinor, currency)} on the net` : ''}</li>)}
            </ul>
          ) : null}
          <p style={{ margin: 0, fontSize: 10, color: 'var(--c-3f565c)' }}>As of {new Date(result.asOf).toLocaleString()}. Writes: {result.writes}.</p>
        </div>
      ) : null}
    </section>
  )
}
