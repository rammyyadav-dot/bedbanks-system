'use client'

import { useState, type FormEvent } from 'react'
import { describeApiError } from '@/lib/api/describe-error'
import { formatMinorUnits } from '@/lib/minor-units'
import { createCancellationPolicy, createChildPolicy, setLeadTimeRule, type AdminContractDetail } from '@/lib/data'

/** Smallest usable policy editor over the existing policy endpoints (create-only; the API owns validation). */
export function ContractPolicies({ contract, canManage, onChanged }: { contract: AdminContractDetail; canManage: boolean; onChanged: () => void }) {
  const [cancel, setCancel] = useState({ days: '', percent: '' })
  const [child, setChild] = useState({ min: '', max: '', extraBed: false })
  const [lead, setLead] = useState({ hours: '', days: '' })
  const [message, setMessage] = useState<string | null>(null)
  const leadRule = Array.isArray(contract.leadTimeRules) ? contract.leadTimeRules[0] : contract.leadTimeRules

  async function run(work: () => Promise<unknown>, done: string) {
    setMessage(null)
    try { await work(); setMessage(done); onChanged() } catch (error) { setMessage(describeApiError(error, 'save the policy')) }
  }
  const submitCancel = (event: FormEvent) => { event.preventDefault(); void run(() => createCancellationPolicy(contract.id, { daysBeforeCheckin: Number(cancel.days), penaltyPercent: Number(cancel.percent) }), 'Cancellation policy added.') }
  const submitChild = (event: FormEvent) => { event.preventDefault(); void run(() => createChildPolicy(contract.id, { minAge: Number(child.min), maxAge: Number(child.max), extraBedAllowed: child.extraBed }), 'Child policy added.') }
  const submitLead = (event: FormEvent) => { event.preventDefault(); void run(() => setLeadTimeRule(contract.id, { minLeadHours: Number(lead.hours), maxLeadDays: lead.days === '' ? null : Number(lead.days) }), 'Booking lead-time rule saved.') }

  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Commercial policies">
      <h2 style={{ fontSize: 14, marginBottom: 10 }}>Commercial policies</h2>
      <h3 style={{ fontSize: 12 }}>Cancellation</h3>
      {contract.cancellationPolicies.length === 0 ? <p style={{ fontSize: 12 }}>No cancellation policy defined.</p> : <ul style={{ fontSize: 12 }}>{contract.cancellationPolicies.map((policy) => <li key={policy.id}>{policy.daysBeforeCheckin}+ days before check-in: {policy.penaltyPercent != null ? `${policy.penaltyPercent}% penalty` : policy.penaltyMinor != null && policy.currency ? `${formatMinorUnits(policy.penaltyMinor, policy.currency)} penalty` : 'penalty unspecified'}</li>)}</ul>}
      {canManage ? <form onSubmit={submitCancel} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Days before check-in" inputMode="numeric" placeholder="Days before check-in" value={cancel.days} onChange={(e) => setCancel({ ...cancel, days: e.target.value })} required /><input className="admin-filter-select" aria-label="Penalty percent" inputMode="numeric" placeholder="Penalty %" value={cancel.percent} onChange={(e) => setCancel({ ...cancel, percent: e.target.value })} required /><button type="submit" className="admin-btn">Add cancellation tier</button></form> : null}
      <h3 style={{ fontSize: 12 }}>Child</h3>
      {contract.childPolicies.length === 0 ? <p style={{ fontSize: 12 }}>No child policy defined.</p> : <ul style={{ fontSize: 12 }}>{contract.childPolicies.map((policy) => <li key={policy.id}>Ages {policy.minAge}–{policy.maxAge}{policy.extraBedAllowed ? ', extra bed allowed' : ''}{policy.supplementMinor != null && policy.currency ? `, supplement ${formatMinorUnits(policy.supplementMinor, policy.currency)}` : ''}</li>)}</ul>}
      {canManage ? <form onSubmit={submitChild} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Minimum age" inputMode="numeric" placeholder="Min age" value={child.min} onChange={(e) => setChild({ ...child, min: e.target.value })} required /><input className="admin-filter-select" aria-label="Maximum age" inputMode="numeric" placeholder="Max age" value={child.max} onChange={(e) => setChild({ ...child, max: e.target.value })} required /><label style={{ fontSize: 11 }}><input type="checkbox" checked={child.extraBed} onChange={(e) => setChild({ ...child, extraBed: e.target.checked })} /> Extra bed allowed</label><button type="submit" className="admin-btn">Add child band</button></form> : null}
      <h3 style={{ fontSize: 12 }}>Booking lead time</h3>
      <p style={{ fontSize: 12 }}>{leadRule ? `Minimum ${leadRule.minLeadHours} hours${leadRule.maxLeadDays != null ? `, up to ${leadRule.maxLeadDays} days ahead` : ''}.` : 'No lead-time rule defined.'}</p>
      {canManage ? <form onSubmit={submitLead} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Minimum lead hours" inputMode="numeric" placeholder="Min lead hours" value={lead.hours} onChange={(e) => setLead({ ...lead, hours: e.target.value })} required /><input className="admin-filter-select" aria-label="Maximum lead days" inputMode="numeric" placeholder="Max lead days (optional)" value={lead.days} onChange={(e) => setLead({ ...lead, days: e.target.value })} /><button type="submit" className="admin-btn">Save lead-time rule</button></form> : null}
      {message ? <p role="status" style={{ fontSize: 12 }}>{message}</p> : null}
    </section>
  )
}
