'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { PlanPicker } from './PlanPicker'
import { describeApiError } from '@/lib/api/describe-error'
import { dateRange } from '@/lib/dubai-operations'
import { summarizeSellability, type SellabilitySummary } from '@/lib/sellability'
import { checkSellability, getRatePlans, type AdminRatePlan } from '@/lib/data'

const MAX_NIGHTS = 31
const defaultCheckIn = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)

/** Runs the authoritative per-night sellability endpoint for a stay and renders its backend reason codes verbatim. */
export function SellabilityInspector({ initialRatePlanId = '', initialCheckIn = '', initialNights = '' }: { initialRatePlanId?: string; initialCheckIn?: string; initialNights?: string }) {
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [ratePlanId, setRatePlanId] = useState(initialRatePlanId)
  const [checkIn, setCheckIn] = useState(initialCheckIn || defaultCheckIn())
  const [nights, setNights] = useState(initialNights && /^\d+$/.test(initialNights) ? initialNights : '7')
  const [adults, setAdults] = useState('')
  const [loadingPlans, setLoadingPlans] = useState(true)
  const [planError, setPlanError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [report, setReport] = useState<{ summary: SellabilitySummary; nights: number; checkIn: string; adults: number; planLabel: string } | null>(null)
  const plan = plans.find((candidate) => candidate.id === ratePlanId)

  useEffect(() => {
    let active = true
    getRatePlans().then((rows) => { if (active) setPlans(rows) }).catch((error) => { if (active) setPlanError(describeApiError(error, 'load rate plans')) }).finally(() => { if (active) setLoadingPlans(false) })
    return () => { active = false }
  }, [])

  async function run() {
    setRunError(null); setReport(null)
    const nightCount = /^\d+$/.test(nights) ? Number(nights) : NaN
    const adultCount = adults.trim() === '' ? plan?.occupancy ?? NaN : /^\d+$/.test(adults) ? Number(adults) : NaN
    if (!plan) return setRunError('Select a hotel, room and rate plan.')
    if (!Number.isInteger(nightCount) || nightCount < 1 || nightCount > MAX_NIGHTS) return setRunError(`Nights must be a whole number from 1 to ${MAX_NIGHTS}.`)
    if (!Number.isInteger(adultCount) || adultCount < 1) return setRunError('Adults must be a whole number of at least 1.')
    let stayDates: string[]
    try { stayDates = dateRange(checkIn, nightCount) } catch { return setRunError('Enter a valid check-in date.') }
    setRunning(true)
    try {
      const results = await Promise.all(stayDates.map(async (stayDate) => ({ stayDate, result: await checkSellability({ ratePlanId: plan.id, stayDate, occupancy: adultCount, checkInDate: stayDates[0], nights: nightCount }) })))
      setReport({ summary: summarizeSellability(results), nights: nightCount, checkIn, adults: adultCount, planLabel: `${plan.roomType.hotel.name} · ${plan.roomType.name} · ${plan.code}` })
    } catch (error) { setRunError(`${describeApiError(error, 'run the sellability check')} No result is shown.`) } finally { setRunning(false) }
  }

  const summary = report?.summary
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · SELLABILITY" title="Sellability inspector" description="Diagnostic only. Each night is evaluated by the API; reason codes below are exactly what it returned. Booking is not enabled." />
      {loadingPlans ? <LoadingState rows={3} /> : planError ? <ErrorState title="Rate plans unavailable" description={`${planError} No fallback data is shown.`} /> : (
        <>
          <section className="admin-filter-bar" aria-label="Sellability criteria">
            <PlanPicker plans={plans} ratePlanId={ratePlanId} onChange={(id) => { setRatePlanId(id); setReport(null) }} />
            <input aria-label="Check-in date" type="date" className="admin-filter-select" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            <input aria-label="Nights" className="admin-filter-select" style={{ width: 80 }} inputMode="numeric" value={nights} onChange={(e) => setNights(e.target.value)} />
            <input aria-label="Adults" className="admin-filter-select" style={{ width: 90 }} inputMode="numeric" placeholder={plan ? `Adults (${plan.occupancy})` : 'Adults'} value={adults} onChange={(e) => setAdults(e.target.value)} />
            <button type="button" className="admin-btn admin-btn-primary" onClick={run} disabled={running}>{running ? 'Checking…' : 'Check sellability'}</button>
          </section>
          <p style={{ fontSize: 11, color: '#66818a' }}>One room. The API evaluates adults against the rate plan occupancy; children and multi-room searches are not evaluated by this endpoint.</p>
          {plans.length === 0 ? <div className="admin-empty"><strong>No rate plans yet</strong><span>Create a contract and a rate plan first.</span></div> : null}
          {runError ? <p role="alert" style={{ color: '#bc5652', fontSize: 12 }}>{runError}</p> : null}
          {running ? <LoadingState rows={4} /> : null}
          {report && summary ? (
            <section className="workspace-panel" style={{ padding: 18 }} aria-label="Sellability result">
              <p style={{ fontSize: 11, color: '#66818a' }}>{report.planLabel} · {report.nights} night{report.nights === 1 ? '' : 's'} from {report.checkIn} · {report.adults} adult{report.adults === 1 ? '' : 's'}</p>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, margin: '10px 0' }}>
                <tbody>{summary.checks.map((check) => (
                  <tr key={check.label} data-check={check.label} data-status={check.status}>
                    <td style={{ padding: '4px 24px 4px 0', color: '#45636c' }}>{check.label}</td>
                    <td style={{ padding: '4px 16px 4px 0', fontWeight: 700, color: check.status === 'PASS' ? '#1f7a5a' : '#bc5652' }}>{check.status}</td>
                    <td style={{ padding: '4px 0', color: '#66818a' }}>{check.findings.map((finding) => `${finding.code} (${finding.stayDate})`).join(', ')}</td>
                  </tr>
                ))}</tbody>
              </table>
              <p role="status" style={{ fontSize: 14, fontWeight: 700, color: summary.sellable ? '#1f7a5a' : '#bc5652' }}>RESULT: {summary.sellable ? 'SELLABLE' : 'NOT SELLABLE'}</p>
              {!summary.sellable ? <ul style={{ fontSize: 12 }}>{summary.failures.map((failure) => <li key={`${failure.stayDate}-${failure.code}`}>{failure.code}: {failure.stayDate}</li>)}</ul> : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
