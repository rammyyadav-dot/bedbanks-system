'use client'

import Link from 'next/link'
import { CheckCircle2, Circle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { useCan } from '@/lib/auth/capabilities'
import { hotelHref } from '@/lib/hotel-ui'

/** A visual summary of API verdicts and reported records, never a second readiness evaluator. */
export function HotelManagementSummary({ data, onRefresh }: { data: HotelCommercial360; onRefresh: () => void }) {
  const can = useCan()
  const passed = data.gates.filter(gate => gate.state === 'PASS').length
  const percent = data.gates.length ? Math.round(passed / data.gates.length * 100) : 0
  const issueCount = (...categories: string[]) => data.issues.filter(issue => categories.includes(issue.category)).length
  const stats = [
    ['Room Types', can('supply.rooms.read') ? data.rooms.length : null],
    ['Active Rate Plans', can('supply.rates.read') ? data.rooms.reduce((total, room) => total + room.ratePlans.active, 0) : null],
    ['Mapping Issues', issueCount('UNMAPPED_HOTEL', 'UNMAPPED_ROOM')],
    ['Rate Issues', issueCount('RATE_MISSING', 'RATE_INVALID')],
    ['Availability Issues', issueCount('AVAILABILITY_MISSING')],
    ['Stop Sell Issues', issueCount('STOP_SELL')],
    ['Currency Issues', issueCount('CURRENCY_OR_BASIS')],
    ['Reported Issues', data.issues.length],
  ] as const
  const gateHref = (target: Parameters<typeof hotelHref>[1]) => target === 'overview' ? `/hotels/${encodeURIComponent(data.hotel.id)}?tab=overview` : hotelHref(data.hotel.id, target)
  return <div className="hotel-management-summary">
    <section className="hotel-readiness-card" aria-label="Property readiness">
      <div className="hotel-readiness-heading"><h2>{data.hotel.name}</h2><button type="button" className="hotel-ui-button" onClick={onRefresh}>Run Property Check</button></div>
      <div className="hotel-readiness-caption"><span>Property Readiness: <strong>{passed} / {data.gates.length}</strong> checks passed</span><span>{percent}%</span></div>
      <div className="hotel-readiness-progress" role="progressbar" aria-label="Property readiness checks passed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
      {data.gates.length ? <ol className="hotel-readiness-steps">{data.gates.map((gate, index) => <li key={gate.key} data-state={gate.state}>
        <Link href={gateHref(gate.section)} title={`${gate.label}: ${gate.state}. ${gate.detail}`}>
          {gate.state === 'PASS' ? <CheckCircle2 size={15} /> : gate.state === 'FAIL' ? <TriangleAlert size={15} /> : <Circle size={15} />}
          <span>{String(index + 1).padStart(2, '0')} {gate.label}<span className="sr-only">: {gate.state}</span></span>
        </Link>
      </li>)}</ol> : <p className="hotel-summary-note">No readiness checks were returned for this assessment.</p>}
    </section>
    <section className="hotel-integrity-card" aria-label="Commercial Integrity">
      <div className="hotel-integrity-heading"><ShieldCheck size={18} /><div><h2>Commercial Integrity</h2><p>Room, rate plan, mapping, daily rate and availability readiness</p></div><span className={`hotel-integrity-status ${data.readiness.toLowerCase()}`}>{data.readiness === 'READY' ? 'Ready' : data.readiness === 'PARTIAL' ? 'Partial' : 'Blocked'}</span><button type="button" className="hotel-summary-refresh" onClick={onRefresh} aria-label="Refresh commercial integrity"><RefreshCw size={16} /></button></div>
      <dl className="hotel-integrity-metrics">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? <span aria-label="Unavailable">—</span>}</dd></div>)}</dl>
      <div className="hotel-integrity-footer">{data.agentSellable ? <CheckCircle2 size={15} /> : <Circle size={15} />}<span>{data.agentSellable ? 'Sellable inventory exists' : 'No sellable inventory was found'} in the assessed {data.window.days}-day window <span className="hotel-assessment-dates">({data.window.from} → {data.window.to})</span></span></div>
    </section>
  </div>
}
