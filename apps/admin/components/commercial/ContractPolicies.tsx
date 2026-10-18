'use client'

import { useState, type FormEvent } from 'react'
import { describeApiError } from '@/lib/api/describe-error'
import { groupRules, setFromInput } from '@/lib/cancellation-sets'
import { formatMinorUnits, parseMajorToMinor } from '@/lib/minor-units'
import { createCancellationPolicy, createChildPolicy, deleteCancellationPolicy, deleteChildPolicy, deleteLeadTimeRule, setLeadTimeRule, type AdminContractDetail } from '@/lib/data'

/**
 * Policy editor over the contract policy endpoints; the API owns validation. Rules are added and removed only while the contract's terms are
 * editable (DRAFT, REVIEW, SUSPENDED). An ACTIVE contract's policies change through an approved amendment (ADR 0067).
 */
export function ContractPolicies({ contract, canManage, editable, onChanged }: { contract: AdminContractDetail; canManage: boolean; editable: boolean; onChanged: () => void }) {
  const canEdit = canManage && editable
  const [cancel, setCancel] = useState({ days: '', percent: '', set: '' })
  const [child, setChild] = useState({ min: '', max: '', extraBed: false, supplement: '' })
  const [lead, setLead] = useState({ hours: '', days: '' })
  const [message, setMessage] = useState<string | null>(null)
  const leadRule = Array.isArray(contract.leadTimeRules) ? contract.leadTimeRules[0] : contract.leadTimeRules

  async function run(work: () => Promise<unknown>, done: string) {
    setMessage(null)
    try { await work(); setMessage(done); onChanged() } catch (error) { setMessage(describeApiError(error, 'save the policy')) }
  }
  const submitCancel = (event: FormEvent) => { event.preventDefault(); void run(() => createCancellationPolicy(contract.id, { daysBeforeCheckin: Number(cancel.days), penaltyPercent: Number(cancel.percent), policySet: setFromInput(cancel.set) }), 'Cancellation policy added.') }
  const submitChild = (event: FormEvent) => {
    event.preventDefault()
    const supplementMinor = parseMajorToMinor(child.supplement, contract.settlementCurrency)
    if (supplementMinor === null) { setMessage(`Enter the supplement per child per night in ${contract.settlementCurrency} (0 for free).`); return }
    void run(() => createChildPolicy(contract.id, { minAge: Number(child.min), maxAge: Number(child.max), extraBedAllowed: child.extraBed, supplementMinor, currency: contract.settlementCurrency }), 'Child policy added.')
  }
  const submitLead = (event: FormEvent) => { event.preventDefault(); void run(() => setLeadTimeRule(contract.id, { minLeadHours: Number(lead.hours), maxLeadDays: lead.days === '' ? null : Number(lead.days) }), 'Booking lead-time rule saved.') }

  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Commercial policies">
      <h2 style={{ fontSize: 14, marginBottom: 10 }}>Commercial policies</h2>
      <h3 style={{ fontSize: 12 }}>Cancellation</h3>
      {contract.cancellationPolicies.length === 0 ? <p style={{ fontSize: 12 }}>No cancellation policy defined.</p> : groupRules(contract.cancellationPolicies).map((group) => <div key={group.set ?? 'default'}><h4 style={{ fontSize: 12, margin: '8px 0 2px' }}>{group.label}</h4><ul style={{ fontSize: 12 }}>{group.rules.map((policy) => <li key={policy.id}>{policy.daysBeforeCheckin}+ days before check-in: {policy.penaltyPercent != null ? `${policy.penaltyPercent}% penalty` : policy.penaltyMinor != null && policy.currency ? `${formatMinorUnits(policy.penaltyMinor, policy.currency)} penalty` : 'penalty unspecified'}{canEdit ? <> <button type="button" className="admin-btn" aria-label={`Remove rule ${policy.daysBeforeCheckin} days`} onClick={() => void run(() => deleteCancellationPolicy(contract.id, policy.id), 'Cancellation rule removed.')}>Remove</button></> : null}</li>)}</ul></div>)}
      {canEdit ? <form onSubmit={submitCancel} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Rule set name (blank = contract default)" placeholder="Set (blank = contract default)" maxLength={80} value={cancel.set} onChange={(e) => setCancel({ ...cancel, set: e.target.value })} /><input className="admin-filter-select" aria-label="Days before check-in" inputMode="numeric" placeholder="Days before check-in" value={cancel.days} onChange={(e) => setCancel({ ...cancel, days: e.target.value })} required /><input className="admin-filter-select" aria-label="Penalty percent" inputMode="numeric" placeholder="Penalty %" value={cancel.percent} onChange={(e) => setCancel({ ...cancel, percent: e.target.value })} required /><button type="submit" className="admin-btn">Add cancellation tier</button></form> : null}
      <h3 style={{ fontSize: 12 }}>Child</h3>
      <p style={{ fontSize: 11, color: '#3f565c', margin: 0 }}>Priced per child per night on the rate's basis, for every rate plan of this contract that has no child prices of its own. A child who fills a base place an adult leaves empty is not charged. A band without a supplement cannot price an extra child.</p>
      {contract.childPolicies.length === 0 ? <p style={{ fontSize: 12 }}>No child policy defined.</p> : <ul style={{ fontSize: 12 }}>{contract.childPolicies.map((policy) => <li key={policy.id}>Ages {policy.minAge}–{policy.maxAge}{policy.extraBedAllowed ? ', extra bed allowed' : ''}{policy.supplementMinor != null && policy.currency ? `, supplement ${formatMinorUnits(policy.supplementMinor, policy.currency)}` : ''}{canEdit ? <> <button type="button" className="admin-btn" aria-label={`Remove child band ${policy.minAge} to ${policy.maxAge}`} onClick={() => void run(() => deleteChildPolicy(contract.id, policy.id), 'Child band removed.')}>Remove</button></> : null}</li>)}</ul>}
      {canEdit ? <form onSubmit={submitChild} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Minimum age" inputMode="numeric" placeholder="Min age" value={child.min} onChange={(e) => setChild({ ...child, min: e.target.value })} required /><input className="admin-filter-select" aria-label="Maximum age" inputMode="numeric" placeholder="Max age" value={child.max} onChange={(e) => setChild({ ...child, max: e.target.value })} required /><input className="admin-filter-select" aria-label={`Supplement per child per night (${contract.settlementCurrency})`} inputMode="decimal" placeholder={`Supplement / night (${contract.settlementCurrency})`} value={child.supplement} onChange={(e) => setChild({ ...child, supplement: e.target.value })} required /><label style={{ fontSize: 11 }}><input type="checkbox" checked={child.extraBed} onChange={(e) => setChild({ ...child, extraBed: e.target.checked })} /> Extra bed allowed</label><button type="submit" className="admin-btn">Add child band</button></form> : null}
      <h3 style={{ fontSize: 12 }}>Booking lead time</h3>
      <p style={{ fontSize: 12 }}>{leadRule ? `Minimum ${leadRule.minLeadHours} hours${leadRule.maxLeadDays != null ? `, up to ${leadRule.maxLeadDays} days ahead` : ''}.` : 'No lead-time rule defined.'}{leadRule && canEdit ? <> <button type="button" className="admin-btn" onClick={() => void run(() => deleteLeadTimeRule(contract.id), 'Lead-time rule removed.')}>Remove</button></> : null}</p>
      {canEdit ? <form onSubmit={submitLead} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Minimum lead hours" inputMode="numeric" placeholder="Min lead hours" value={lead.hours} onChange={(e) => setLead({ ...lead, hours: e.target.value })} required /><input className="admin-filter-select" aria-label="Maximum lead days" inputMode="numeric" placeholder="Max lead days (optional)" value={lead.days} onChange={(e) => setLead({ ...lead, days: e.target.value })} /><button type="submit" className="admin-btn">Save lead-time rule</button></form> : null}
      {canManage && !editable ? <p role="status" style={{ fontSize: 12, color: '#3f565c' }}>These policies are locked while the contract is ACTIVE or EXPIRED. Change them through an amendment.</p> : null}
      {message ? <p role="status" style={{ fontSize: 12 }}>{message}</p> : null}
    </section>
  )
}
