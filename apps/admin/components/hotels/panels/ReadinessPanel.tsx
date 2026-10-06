'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import type { HotelReadinessAssessment, ReadinessGateResult } from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { ApiResponseError } from '@/lib/api/errors'
import { useCan } from '@/lib/auth/capabilities'
import { classifyOpsFailure, OPS_FAILURE_COPY, failureReference } from '@/lib/ops-state'
import { getHotelReadiness } from '@/lib/data/hotel-commercial'
import { outcomeLabel, outcomeTone, readinessActionHref, reasonText } from '@/lib/hotel-ui'

const offset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const field = { display: 'grid', gap: 2, fontSize: 11 } as const

function Gate({ gate, hotelId, canAct }: { gate: ReadinessGateResult; hotelId: string; canAct: (permission: string | null) => boolean }) {
  return (
    <li style={{ padding: '10px 0', borderBottom: '1px solid #edf2f3', display: 'grid', gap: 4 }} data-gate={gate.gate} data-outcome={gate.outcome}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{gate.label}</strong>
        <Tag tone={outcomeTone(gate.outcome)}>{outcomeLabel(gate.outcome)}</Tag>
        <span style={note}>evaluated {new Date(gate.evaluatedAt).toLocaleString()}</span>
      </div>
      {gate.reason && <p style={{ margin: 0, fontSize: 12 }} data-testid={`reason-${gate.gate}`}>{gate.reason}</p>}
      {gate.blockers.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, display: 'grid', gap: 2 }}>
          {gate.blockers.map((b) => (
            <li key={b.code}><code>{b.code}</code> {b.message === b.code ? reasonText(b.code) : b.message}{b.refs.length > 0 && <span style={note}> · {b.refs.slice(0, 6).map((r) => `${r.label ?? r.id}`).join(', ')}{b.refs.length > 6 ? ` +${b.refs.length - 6} more` : ''}</span>}</li>
          ))}
        </ul>
      )}
      {gate.notes.map((n) => <p key={n} style={note}>{n}</p>)}
      <details style={{ fontSize: 11, color: '#3f565c' }}>
        <summary>Criteria this gate applied</summary>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{gate.criteriaApplied.map((c) => <li key={c}>{c}</li>)}</ul>
      </details>
      {gate.action && (
        canAct(gate.action.permission)
          ? <p style={{ margin: 0, fontSize: 12 }}><Link href={readinessActionHref(hotelId, gate.action)}>{gate.action.label}</Link></p>
          : <p style={note}>{gate.action.label}: you do not have the permission needed to make changes there.</p>
      )}
    </li>
  )
}

/**
 * Unified readiness for one explicit set of criteria. Every outcome is computed by the API from the same evaluator Agent search uses;
 * this component only collects the criteria and renders the result, including what the result does not claim.
 */
export function ReadinessPanel({ hotelId }: { hotelId: string }) {
  const can = useCan()
  const [checkIn, setCheckIn] = useState(offset(14)); const [checkOut, setCheckOut] = useState(offset(17))
  const [adults, setAdults] = useState('2'); const [children, setChildren] = useState('0'); const [ages, setAges] = useState<string[]>([]); const [rooms, setRooms] = useState('1')
  const [nationality, setNationality] = useState(''); const [agencyId, setAgencyId] = useState(''); const [currency, setCurrency] = useState('')
  const [running, setRunning] = useState(false); const inFlight = useRef(false)
  const [result, setResult] = useState<HotelReadinessAssessment | null>(null)
  const [failure, setFailure] = useState<{ title: string; body: string; ref: string | null; kind: string } | null>(null)

  function resizeAges(count: number) { setAges((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? '')) }
  async function run() {
    if (inFlight.current) return
    inFlight.current = true; setRunning(true); setFailure(null); setResult(null)
    try {
      setResult(await getHotelReadiness(hotelId, { checkIn, checkOut, adults, children, rooms, childAges: ages.join(','), nationality: nationality.trim() || undefined, agencyId: agencyId.trim() || undefined, currency: currency.trim() || undefined }))
    } catch (error) {
      const kind = classifyOpsFailure(error); const copy = OPS_FAILURE_COPY[kind]
      const invalid = error instanceof ApiResponseError && error.status === 400
      setFailure({ title: invalid ? 'Check the criteria' : copy.title, body: invalid ? describeApiError(error, 'assess readiness') : copy.body, ref: failureReference(error), kind })
    } finally { inFlight.current = false; setRunning(false) }
  }
  const canAct = (permission: string | null) => permission === null || can(permission as never)

  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Readiness for stated criteria" data-testid="readiness">
      <h2 style={{ fontSize: 14, margin: 0 }}>Readiness for stated criteria</h2>
      <p style={note}>Seven separate gates for the stay, party, guest nationality, agency and currency you enter. A pass applies to those criteria only, at this moment. Read-only: nothing is held, booked or changed.</p>
      <form aria-label="Readiness criteria" onSubmit={(event) => { event.preventDefault(); void run() }} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={field}><span>Arrival date</span><input type="date" required value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></label>
        <label style={field}><span>Departure date</span><input type="date" required value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></label>
        <label style={field}><span>Rooms</span><input type="number" min={1} max={9} required value={rooms} onChange={(e) => setRooms(e.target.value)} style={{ width: 70 }} /></label>
        <label style={field}><span>Adults per room</span><input type="number" min={1} max={9} required value={adults} onChange={(e) => setAdults(e.target.value)} style={{ width: 70 }} /></label>
        <label style={field}><span>Children per room</span><input type="number" min={0} max={9} value={children} onChange={(e) => { setChildren(e.target.value); resizeAges(Math.max(0, Math.min(9, Number(e.target.value) || 0))) }} style={{ width: 70 }} /></label>
        {ages.map((age, i) => <label key={i} style={field}><span>Child {i + 1} age</span><input type="number" min={0} max={17} required value={age} onChange={(e) => setAges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))} style={{ width: 70 }} /></label>)}
        <label style={field}><span>Guest nationality (ISO code)</span><input value={nationality} maxLength={2} placeholder="e.g. IN" onChange={(e) => setNationality(e.target.value.toUpperCase())} style={{ width: 110 }} /></label>
        <label style={field}><span>Agency ID (optional)</span><input value={agencyId} onChange={(e) => setAgencyId(e.target.value)} style={{ width: 190 }} /></label>
        <label style={field}><span>Currency</span><input value={currency} maxLength={3} placeholder="default" onChange={(e) => setCurrency(e.target.value.toUpperCase())} style={{ width: 80 }} /></label>
        <button type="submit" className="button primary" disabled={running}>{running ? 'Assessing…' : 'Assess readiness'}</button>
      </form>
      {failure && <div className="admin-error" role="alert" data-state={failure.kind}><strong>{failure.title}</strong><span>{failure.body}</span>{failure.ref && <span>Reference: <code>{failure.ref}</code></span>}</div>}
      {result && (
        <div data-testid="readiness-result" style={{ display: 'grid', gap: 8 }}>
          <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag tone={outcomeTone(result.commercialVerdict)}>COMMERCIAL: {result.commercialVerdict}</Tag>
            <span style={{ fontSize: 12 }}>{result.criteria.checkIn} → {result.criteria.checkOut} · {result.criteria.rooms} room{result.criteria.rooms === 1 ? '' : 's'} · {result.criteria.adults} adult{result.criteria.adults === 1 ? '' : 's'}{result.criteria.children ? ` + ${result.criteria.children} child${result.criteria.children === 1 ? '' : 'ren'}` : ''} · nationality {result.criteria.nationality ?? 'not supplied'} · {result.criteria.agencyId ? `agency ${result.criteria.agencyId}` : 'no agency'} · {result.criteria.currency}</span>
            <span style={{ fontSize: 12 }}>Evaluator-predicted offers: <strong>{result.predictedOffers}</strong></span>
          </div>
          <p style={note}>{result.scope}</p>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Readiness gates">
            {result.gates.map((g) => <Gate key={g.gate} gate={g} hotelId={hotelId} canAct={canAct} />)}
          </ol>
          <ul style={{ ...note, paddingLeft: 16 }}>{result.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
    </section>
  )
}
