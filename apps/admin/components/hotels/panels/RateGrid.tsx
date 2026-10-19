'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CalendarEdit, CalendarPreview } from '@bedbanks/contracts'
import { dateRange } from '@/lib/dubai-operations'
import { describeApiError } from '@/lib/api/describe-error'
import { applyPaste, buildGridEdit, parsePaste, type GridBaseline, type GridPlan } from '@/lib/calendar-tools'
import { minorToMajorInput } from '@/lib/minor-units'
import { LargeChangeConfirm } from '@/components/commercial/LargeChangeConfirm'
import { applyCalendar, getDailyRates, getHotelRatePlans, previewCalendar, type AdminRatePlan } from '@/lib/data'
import { CalendarReview } from './CalendarReview'
import { ScrollRegion, td, th, tableStyle } from '../ui'

const MAX_PLANS = 25
const today = () => new Date().toISOString().slice(0, 10)

/**
 * Multi-plan price grid (ADR 0057, S7): plans down, nights across. Only changed cells are sent, as an ordinary calendar edit, through the same
 * server preview and atomic apply as every other rate change. Paste from a spreadsheet fills right and down. Prices are not deleted here.
 */
export function RateGrid({ hotelId, onApplied }: { hotelId: string; onApplied: () => void }) {
  const [start, setStart] = useState(today()); const [days, setDays] = useState(7)
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [baseline, setBaseline] = useState<Record<string, Record<string, GridBaseline>>>({})
  const [edited, setEdited] = useState<Record<string, Record<string, string>>>({})
  const [basis, setBasis] = useState<Record<string, 'NET' | 'SELL' | ''>>({})
  const [derivedHidden, setDerivedHidden] = useState(0)
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<{ edit: CalendarEdit; preview: CalendarPreview } | null>(null)
  const [confirmLarge, setConfirmLarge] = useState(false)
  const largeWarnings = (review?.preview.largePriceChanges ?? []).map((c) => `${c.stayDate}: ${c.warning}`)
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const dates = useMemo(() => { try { return dateRange(start, days) } catch { return [] } }, [start, days])
  const gridPlans: GridPlan[] = useMemo(() => plans.map((p) => ({ id: p.id, code: p.code, currency: p.currency, occupancy: p.occupancy })), [plans])

  const load = useCallback(async () => {
    if (dates.length === 0) return
    setLoading(true); setError(null); setReview(null); setEdited({})
    try {
      const listing = await getHotelRatePlans(hotelId, { page: 1, pageSize: MAX_PLANS })
      // A derived plan has no rates of its own (ADR 0058, S10b): its price is its parent's, so it has nothing to edit in the grid.
      const shown = listing.items.filter((p) => p.status !== 'EXPIRED' && !p.derivedFromId)
      setDerivedHidden(listing.items.filter((p) => p.status !== 'EXPIRED' && p.derivedFromId).length)
      const rateRows = await Promise.all(shown.map((p) => getDailyRates(dates[0]!, dates[dates.length - 1]!, p.id)))
      const nextBase: Record<string, Record<string, GridBaseline>> = {}; const nextBasis: Record<string, 'NET' | 'SELL' | ''> = {}
      shown.forEach((p, i) => {
        nextBase[p.id] = {}; nextBasis[p.id] = ''
        for (const r of rateRows[i]!) {
          if (r.occupancy !== p.occupancy) continue
          nextBase[p.id]![r.stayDate.slice(0, 10)] = { amount: minorToMajorInput(r.amountMinor, r.currency), updatedAt: r.updatedAt }
          if (!nextBasis[p.id] && (r.amountBasis === 'NET' || r.amountBasis === 'SELL')) nextBasis[p.id] = r.amountBasis
        }
      })
      setPlans(shown); setBaseline(nextBase); setBasis(nextBasis)
    } catch (e) { setPlans([]); setError(describeApiError(e, 'load the rate grid')) } finally { setLoading(false) }
  }, [hotelId, dates])
  useEffect(() => { void load() }, [load])

  const draft = { plans: gridPlans, dates, baseline, edited, basis }
  const built = useMemo(() => buildGridEdit(draft), [gridPlans, dates, baseline, edited, basis])
  const set = (planId: string, date: string, value: string) => { setReview(null); setMessage(null); setEdited((cur) => ({ ...cur, [planId]: { ...(cur[planId] ?? {}), [date]: value } })) }
  const planCode = (id: string) => plans.find((p) => p.id === id)?.code ?? id

  async function runReview() {
    if (!built.edit) return
    setBusy(true); setMessage(null)
    try { setConfirmLarge(false); setReview({ edit: built.edit, preview: await previewCalendar(built.edit) }) } catch (e) { setMessage({ kind: 'error', text: describeApiError(e, 'preview the changes') }) } finally { setBusy(false) }
  }
  async function apply() {
    if (!review) return
    setBusy(true); setMessage(null)
    try { await applyCalendar({ ...review.edit, ...(confirmLarge ? { confirmLargeChanges: true } : {}) }); setMessage({ kind: 'ok', text: `Applied ${review.preview.affectedCells} cell(s) atomically.` }); onApplied(); await load() } catch (e) { setMessage({ kind: 'error', text: describeApiError(e, 'apply the changes') }) } finally { setBusy(false) }
  }

  return (
    <section aria-label="Multi-plan price grid" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>From</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Nights</span><select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 10, 14].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <span style={{ fontSize: 11, color: '#3f565c' }}>Up to {MAX_PLANS} plans. Type, or paste from a spreadsheet (fills right and down). Rates are in major units of the plan currency.</span>
      </div>
      {derivedHidden > 0 ? <p style={{ fontSize: 12, color: '#3f565c' }}>{derivedHidden} derived plan{derivedHidden === 1 ? '' : 's'} not shown: they sell at a parent plan’s rate and have no rates of their own to edit here.</p> : null}
      {loading ? <p role="status" style={{ fontSize: 12 }}>Loading rates…</p> : error ? <p role="alert" style={{ color: '#a11d1d', fontSize: 12 }}>{error} No fallback data is shown.</p> : plans.length === 0 ? <p style={{ fontSize: 12 }}>This hotel has no editable rate plan.</p> : (
        <ScrollRegion label="Price grid" maxHeight={420}>
          <table style={tableStyle} aria-label="Prices by plan and night">
            <thead><tr><th scope="col" style={th}>Plan</th><th scope="col" style={th}>Basis</th>{dates.map((d) => <th key={d} scope="col" style={th}>{d.slice(5)}</th>)}</tr></thead>
            <tbody>
              {plans.map((plan, pi) => (
                <tr key={plan.id} data-plan-id={plan.id}>
                  <td style={td}><code>{plan.code}</code><div style={{ fontSize: 10, color: '#3f565c' }}>{plan.currency} · {plan.status}</div></td>
                  <td style={td}>
                    <select aria-label={`Basis for ${plan.code}`} value={basis[plan.id] ?? ''} onChange={(e) => { setReview(null); setBasis((cur) => ({ ...cur, [plan.id]: e.target.value as 'NET' | 'SELL' | '' })) }}>
                      <option value="">Choose…</option><option value="SELL">SELL</option><option value="NET">NET</option>
                    </select>
                  </td>
                  {dates.map((date, di) => {
                    const base = baseline[plan.id]?.[date]; const typed = edited[plan.id]?.[date]
                    const changed = typed !== undefined && typed.trim() !== (base?.amount ?? '')
                    return (
                      <td key={date} style={{ ...td, padding: 4, background: changed ? '#fff7d6' : undefined }}>
                        <input inputMode="decimal" size={8} aria-label={`${plan.code} ${date}`} value={typed ?? base?.amount ?? ''} placeholder="—"
                          onChange={(e) => set(plan.id, date, e.target.value)}
                          onPaste={(e) => { const text = e.clipboardData.getData('text'); if (!/[\t\n]/.test(text.trim())) return; e.preventDefault(); setReview(null); setEdited(applyPaste({ plans: gridPlans, dates, edited }, pi, di, parsePaste(text))) }} />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {built.problems.length ? <ul aria-label="Problems" style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#a11d1d' }}>{built.problems.slice(0, 8).map((p, i) => <li key={i}>{p.planId ? <code>{planCode(p.planId)}</code> : null} {p.date ?? ''} {p.message}</li>)}{built.problems.length > 8 ? <li>…and {built.problems.length - 8} more</li> : null}</ul> : null}
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="admin-btn admin-btn-primary" disabled={busy || !built.edit} onClick={runReview}>{busy && !review ? 'Checking…' : `Review ${built.changed} changed cell${built.changed === 1 ? '' : 's'}`}</button>
        {review ? <LargeChangeConfirm warnings={largeWarnings} confirmed={confirmLarge} onChange={setConfirmLarge} /> : null}
        {review ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy || (largeWarnings.length > 0 && !confirmLarge)} onClick={apply}>{busy ? 'Applying…' : `Apply ${review.preview.affectedCells} cell(s) atomically`}</button> : null}
        {Object.keys(edited).length ? <button type="button" className="admin-btn" onClick={() => { setEdited({}); setReview(null) }}>Discard edits</button> : null}
      </span>
      {review ? <CalendarReview preview={review.preview} planCode={planCode} /> : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a', fontSize: 12, margin: 0 }}>{message.text}</p> : null}
    </section>
  )
}
