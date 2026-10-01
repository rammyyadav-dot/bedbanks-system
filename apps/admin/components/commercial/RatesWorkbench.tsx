'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { PlanPicker } from './PlanPicker'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { dateRange } from '@/lib/dubai-operations'
import { formatMinorUnits, minorToMajorInput, parseMajorToMinor } from '@/lib/minor-units'
import { bulkUpdateAvailability, bulkUpdateDailyRates, getDailyRates, getInventory, getRatePlans, type AdminAvailabilityRow, type AdminDailyRate, type AdminRatePlan } from '@/lib/data'

interface DayDraft { amount: string; basis: 'SELL' | 'NET'; allotment: string; stopSell: boolean; minStay: string }
const today = () => new Date().toISOString().slice(0, 10)
const emptyDraft = (minStay: number): DayDraft => ({ amount: '', basis: 'SELL', allotment: '', stopSell: false, minStay: String(minStay) })

/** Rates and inventory for one rate plan over a 7- or 30-day window, edited together and saved through the authoritative bulk endpoints. */
export function RatesWorkbench({ initialRatePlanId = '' }: { initialRatePlanId?: string }) {
  const can = useCan()
  const canRates = can('supply.rates.manage')
  const canInventory = can('supply.availability.manage')
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [ratePlanId, setRatePlanId] = useState(initialRatePlanId)
  const [start, setStart] = useState(today())
  const [days, setDays] = useState(7)
  const [loadingPlans, setLoadingPlans] = useState(true)
  const [planError, setPlanError] = useState<string | null>(null)
  const [rates, setRates] = useState<AdminDailyRate[]>([])
  const [inventory, setInventory] = useState<AdminAvailabilityRow[]>([])
  const [loadingGrid, setLoadingGrid] = useState(false)
  const [gridError, setGridError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DayDraft>>({})
  const [bulk, setBulk] = useState({ amount: '', allotment: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  const plan = plans.find((candidate) => candidate.id === ratePlanId)
  const dates = useMemo(() => { try { return dateRange(start, days) } catch { return [] } }, [start, days])

  useEffect(() => {
    let active = true
    getRatePlans().then((rows) => { if (active) setPlans(rows) }).catch((error) => { if (active) setPlanError(describeApiError(error, 'load rate plans')) }).finally(() => { if (active) setLoadingPlans(false) })
    return () => { active = false }
  }, [])

  const loadGrid = useCallback(async () => {
    if (!plan || dates.length === 0) return
    setLoadingGrid(true); setGridError(null); setMessage(null)
    try {
      const [rateRows, inventoryRows] = await Promise.all([getDailyRates(dates[0], dates[dates.length - 1], plan.id), getInventory(dates[0], dates[dates.length - 1], plan.id)])
      setRates(rateRows); setInventory(inventoryRows)
      const next: Record<string, DayDraft> = {}
      for (const stayDate of dates) {
        const rate = rateRows.find((row) => row.stayDate.slice(0, 10) === stayDate && row.occupancy === plan.occupancy)
        const row = inventoryRows.find((item) => item.stayDate.slice(0, 10) === stayDate)
        next[stayDate] = { amount: rate ? minorToMajorInput(rate.amountMinor, rate.currency) : '', basis: rate?.amountBasis === 'NET' ? 'NET' : 'SELL', allotment: row ? String(row.allotment) : '', stopSell: row?.stopSell ?? false, minStay: String(row?.minStay ?? plan.minStay) }
      }
      setDrafts(next)
    } catch (error) { setRates([]); setInventory([]); setDrafts({}); setGridError(describeApiError(error, 'load rates and inventory')) } finally { setLoadingGrid(false) }
  }, [plan, dates])
  useEffect(() => { void loadGrid() }, [loadGrid])

  const patch = (stayDate: string, change: Partial<DayDraft>) => setDrafts((current) => ({ ...current, [stayDate]: { ...(current[stayDate] ?? emptyDraft(plan?.minStay ?? 1)), ...change } }))
  const applyToAll = () => setDrafts((current) => Object.fromEntries(dates.map((stayDate) => [stayDate, { ...(current[stayDate] ?? emptyDraft(plan?.minStay ?? 1)), ...(bulk.amount.trim() ? { amount: bulk.amount.trim() } : {}), ...(bulk.allotment.trim() ? { allotment: bulk.allotment.trim() } : {}) }])))

  async function save() {
    if (!plan) return
    setMessage(null)
    const rateRows: Parameters<typeof bulkUpdateDailyRates>[0] = []
    const availabilityRows: Parameters<typeof bulkUpdateAvailability>[0] = []
    for (const stayDate of dates) {
      const draft = drafts[stayDate]; if (!draft) continue
      if (canRates && draft.amount.trim() !== '') {
        const amountMinor = parseMajorToMinor(draft.amount, plan.currency)
        if (amountMinor === null) return setMessage({ kind: 'error', text: `${stayDate}: enter a plain amount in ${plan.currency} with at most the currency's decimal places.` })
        rateRows.push({ ratePlanId: plan.id, stayDate, occupancy: plan.occupancy, amountMinor, amountBasis: draft.basis, currency: plan.currency })
      }
      if (canInventory && draft.allotment.trim() !== '') {
        const allotment = /^\d+$/.test(draft.allotment.trim()) ? Number(draft.allotment) : NaN, minStay = /^\d+$/.test(draft.minStay.trim()) ? Number(draft.minStay) : NaN
        if (!Number.isInteger(allotment) || !Number.isInteger(minStay) || minStay < 1) return setMessage({ kind: 'error', text: `${stayDate}: allotment must be a whole number and minimum stay at least 1.` })
        availabilityRows.push({ ratePlanId: plan.id, stayDate, allotment, stopSell: draft.stopSell, minStay })
      }
    }
    if (rateRows.length === 0 && availabilityRows.length === 0) return setMessage({ kind: 'error', text: 'Nothing to save: enter a rate or availability for at least one day.' })
    setSaving(true)
    const outcomes: string[] = []
    try {
      if (rateRows.length) { await bulkUpdateDailyRates(rateRows); outcomes.push(`${rateRows.length} rate${rateRows.length === 1 ? '' : 's'}`) }
      if (availabilityRows.length) { await bulkUpdateAvailability(availabilityRows); outcomes.push(`${availabilityRows.length} availability row${availabilityRows.length === 1 ? '' : 's'}`) }
      await loadGrid()
      setMessage({ kind: 'ok', text: `Saved ${outcomes.join(' and ')}. Values below were re-read from the API.` })
    } catch (error) {
      setMessage({ kind: 'error', text: `${outcomes.length ? `${outcomes.join(' and ')} saved, but the next step failed. ` : ''}${describeApiError(error, 'save rates and inventory')} Reload to see what was stored.` })
    } finally { setSaving(false) }
  }

  const rateFor = (stayDate: string) => rates.find((row) => row.stayDate.slice(0, 10) === stayDate && plan && row.occupancy === plan.occupancy)
  const rowFor = (stayDate: string) => inventory.find((row) => row.stayDate.slice(0, 10) === stayDate)
  const canEdit = canRates || canInventory

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · RATES & INVENTORY" title="Rates & Inventory" description="Daily rate, allotment, stop sell and minimum stay for one rate plan. Every value shown is read from the API." />
      {loadingPlans ? <LoadingState rows={3} /> : planError ? <ErrorState title="Rate plans unavailable" description={`${planError} No fallback data is shown.`} /> : (
        <>
          <section className="admin-filter-bar" aria-label="Rates and inventory selection">
            <PlanPicker plans={plans} ratePlanId={ratePlanId} onChange={setRatePlanId} />
            <input aria-label="Start date" type="date" className="admin-filter-select" value={start} onChange={(e) => setStart(e.target.value)} />
            <select aria-label="Window" className="admin-filter-select" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option></select>
            {plan ? <Link href={`/sellability?ratePlanId=${plan.id}&checkIn=${dates[0] ?? start}&nights=${Math.min(days, 7)}`} className="admin-btn">Check sellability</Link> : null}
          </section>
          {plans.length === 0 ? <div className="admin-empty"><strong>No rate plans yet</strong><span>Create a contract and a rate plan first.</span></div> : null}
          {plan ? (
            <section className="workspace-panel" style={{ padding: 16 }} aria-label="Rate plan summary">
              <p style={{ fontSize: 12 }}>{plan.roomType.hotel.name} · {plan.roomType.name} · {plan.boardBasis.code.trim()} · {plan.currency} · {plan.occupancy} adult{plan.occupancy === 1 ? '' : 's'} · release {plan.releaseDays} day{plan.releaseDays === 1 ? '' : 's'} · status <strong>{plan.status}</strong>. Rates and inventory are per room.</p>
              {canEdit ? <div className="admin-filter-bar" style={{ marginTop: 8 }}>
                {canRates ? <input aria-label={`Fill every day with a rate in ${plan.currency}`} className="admin-filter-select" inputMode="decimal" placeholder={`Rate for all days (${plan.currency})`} value={bulk.amount} onChange={(e) => setBulk({ ...bulk, amount: e.target.value })} /> : null}
                {canInventory ? <input aria-label="Fill every day with an allotment" className="admin-filter-select" inputMode="numeric" placeholder="Allotment for all days" value={bulk.allotment} onChange={(e) => setBulk({ ...bulk, allotment: e.target.value })} /> : null}
                <button type="button" className="admin-btn" onClick={applyToAll}>Fill all days</button>
                <button type="button" className="admin-btn admin-btn-primary" onClick={save} disabled={saving || loadingGrid}>{saving ? 'Saving…' : 'Save changes'}</button>
              </div> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to rates and inventory.</p>}
              {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#bc5652' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
            </section>
          ) : null}
          {plan && loadingGrid ? <LoadingState rows={7} /> : null}
          {plan && gridError ? <ErrorState title="Rates and inventory unavailable" description={`${gridError} No fallback data is shown.`} /> : null}
          {plan && !loadingGrid && !gridError ? (
            <div className="workspace-panel" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }} aria-label="Daily rates and inventory">
                <thead><tr>{['Date', `Rate (${plan.currency})`, 'Stored rate', 'Basis', 'Allotment', 'Sold / held', 'Stop sell', 'Min stay', 'Release'].map((header) => <th key={header} style={{ textAlign: 'left', padding: '9px 12px', color: '#92a5a9', borderBottom: '1px solid #e6eef0', whiteSpace: 'nowrap' }}>{header}</th>)}</tr></thead>
                <tbody>{dates.map((stayDate) => {
                  const draft = drafts[stayDate] ?? emptyDraft(plan.minStay); const stored = rateFor(stayDate); const row = rowFor(stayDate)
                  return (
                    <tr key={stayDate} style={{ borderBottom: '1px solid #edf2f3' }}>
                      <td style={{ padding: '8px 12px' }}>{stayDate}</td>
                      <td style={{ padding: '8px 12px' }}><input aria-label={`Rate ${stayDate}`} className="admin-filter-select" style={{ width: 96 }} inputMode="decimal" value={draft.amount} disabled={!canRates} onChange={(e) => patch(stayDate, { amount: e.target.value })} /></td>
                      <td style={{ padding: '8px 12px' }}>{stored ? formatMinorUnits(stored.amountMinor, stored.currency) : <span style={{ color: '#bc5652' }}>No rate</span>}</td>
                      <td style={{ padding: '8px 12px' }}><select aria-label={`Basis ${stayDate}`} className="admin-filter-select" value={draft.basis} disabled={!canRates} onChange={(e) => patch(stayDate, { basis: e.target.value as 'SELL' | 'NET' })}><option value="SELL">SELL</option><option value="NET">NET</option></select></td>
                      <td style={{ padding: '8px 12px' }}><input aria-label={`Allotment ${stayDate}`} className="admin-filter-select" style={{ width: 70 }} inputMode="numeric" value={draft.allotment} disabled={!canInventory} onChange={(e) => patch(stayDate, { allotment: e.target.value })} /></td>
                      <td style={{ padding: '8px 12px' }}>{row ? `${row.sold} / ${row.held}` : <span style={{ color: '#bc5652' }}>No inventory</span>}</td>
                      <td style={{ padding: '8px 12px' }}><input aria-label={`Stop sell ${stayDate}`} type="checkbox" checked={draft.stopSell} disabled={!canInventory} onChange={(e) => patch(stayDate, { stopSell: e.target.checked })} /></td>
                      <td style={{ padding: '8px 12px' }}><input aria-label={`Minimum stay ${stayDate}`} className="admin-filter-select" style={{ width: 56 }} inputMode="numeric" value={draft.minStay} disabled={!canInventory} onChange={(e) => patch(stayDate, { minStay: e.target.value })} /></td>
                      <td style={{ padding: '8px 12px' }}>{plan.releaseDays}d <Link href={`/rates/plans/${plan.id}`} style={{ marginLeft: 6 }}>edit</Link></td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
