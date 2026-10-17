'use client'

import { useMemo, useState, type FormEvent } from 'react'
import type { ContractAmendmentChanges, ContractCancellationTerm, ContractChildTerm, ContractLeadTimeTerm } from '@bedbanks/contracts'
import { describeApiError } from '@/lib/api/describe-error'
import { setFromInput } from '@/lib/cancellation-sets'
import { describeChanges, newContractRequestId } from '@/lib/contract-lifecycle-ui'
import { requestContractAmendment, type AdminContractDetail } from '@/lib/data'

const cancellationOf = (c: AdminContractDetail): ContractCancellationTerm[] => c.cancellationPolicies.map((p) => ({ policySet: p.policySet ?? null, daysBeforeCheckin: p.daysBeforeCheckin, penaltyPercent: p.penaltyPercent, penaltyMinor: p.penaltyMinor, currency: p.currency }))
const childOf = (c: AdminContractDetail): ContractChildTerm[] => c.childPolicies.map((p) => ({ minAge: p.minAge, maxAge: p.maxAge, extraBedAllowed: p.extraBedAllowed, supplementMinor: p.supplementMinor, currency: p.currency }))
const leadOf = (c: AdminContractDetail): ContractLeadTimeTerm | null => { const r = Array.isArray(c.leadTimeRules) ? c.leadTimeRules[0] : c.leadTimeRules; return r ? { minLeadHours: r.minLeadHours, maxLeadDays: r.maxLeadDays } : null }
const key = (v: unknown) => JSON.stringify(v)

/**
 * Stages policy changes for an ACTIVE contract and files them as ONE amendment (ADR 0067). Nothing is written until a second person approves
 * and the amendment is applied; the staged sets replace the current ones whole. The API validates and re-checks everything.
 */
export function ContractPolicyAmendment({ contract, fingerprint, onFiled }: { contract: AdminContractDetail; fingerprint: string; onFiled: () => void }) {
  const [cancellation, setCancellation] = useState(() => cancellationOf(contract))
  const [children, setChildren] = useState(() => childOf(contract))
  const [lead, setLead] = useState(() => leadOf(contract))
  const [cancelForm, setCancelForm] = useState({ days: '', percent: '', set: '' })
  const [childForm, setChildForm] = useState({ min: '', max: '', extraBed: false })
  const [leadForm, setLeadForm] = useState({ hours: '', days: '' })
  const [reason, setReason] = useState('')
  const [requestId, setRequestId] = useState(() => newContractRequestId())
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const changes = useMemo<ContractAmendmentChanges>(() => ({
    ...(key(cancellation) !== key(cancellationOf(contract)) ? { cancellationPolicies: cancellation } : {}),
    ...(key(children) !== key(childOf(contract)) ? { childPolicies: children } : {}),
    ...(key(lead) !== key(leadOf(contract)) ? { leadTimeRule: lead } : {}),
  }), [cancellation, children, lead, contract])

  const addCancel = (e: FormEvent) => { e.preventDefault(); setCancellation((c) => [...c, { policySet: setFromInput(cancelForm.set) ?? null, daysBeforeCheckin: Number(cancelForm.days), penaltyPercent: Number(cancelForm.percent), penaltyMinor: null, currency: null }]); setCancelForm({ days: '', percent: '', set: '' }) }
  const addChild = (e: FormEvent) => { e.preventDefault(); setChildren((c) => [...c, { minAge: Number(childForm.min), maxAge: Number(childForm.max), extraBedAllowed: childForm.extraBed, supplementMinor: null, currency: null }]); setChildForm({ min: '', max: '', extraBed: false }) }
  const setLeadRule = (e: FormEvent) => { e.preventDefault(); setLead({ minLeadHours: Number(leadForm.hours), maxLeadDays: leadForm.days === '' ? null : Number(leadForm.days) }) }

  const file = async () => {
    setBusy(true); setMessage(null)
    try {
      await requestContractAmendment(contract.id, { requestId, reason: reason.trim(), expectedFingerprint: fingerprint, changes })
      setMessage({ kind: 'ok', text: 'Policy amendment requested. It applies once a second person approves it.' }); setReason(''); setRequestId(newContractRequestId()); onFiled()
    } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'request the amendment') }) } finally { setBusy(false) }
  }

  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16, display: 'grid', gap: 8 }} aria-label="Policy amendment">
      <h2 style={{ fontSize: 14, margin: 0 }}>Propose a policy amendment</h2>
      <p style={{ fontSize: 12, margin: 0, color: '#3f565c' }}>Stage the policy sets as they should be. The staged sets replace the current ones once a second person approves.</p>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Cancellation (staged)</h3>
      <ul style={{ fontSize: 12, margin: 0 }}>{cancellation.map((p, i) => <li key={`${p.policySet}-${p.daysBeforeCheckin}-${i}`}>{p.policySet ? `[${p.policySet}] ` : ''}{p.daysBeforeCheckin}+ days: {p.penaltyPercent ?? '—'}%{' '}<button type="button" className="admin-btn" onClick={() => setCancellation((c) => c.filter((_, j) => j !== i))}>Remove</button></li>)}</ul>
      <form onSubmit={addCancel} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged rule set" placeholder="Set (blank = default)" maxLength={80} value={cancelForm.set} onChange={(e) => setCancelForm({ ...cancelForm, set: e.target.value })} /><input className="admin-filter-select" aria-label="Staged days before check-in" inputMode="numeric" placeholder="Days" value={cancelForm.days} onChange={(e) => setCancelForm({ ...cancelForm, days: e.target.value })} required /><input className="admin-filter-select" aria-label="Staged penalty percent" inputMode="numeric" placeholder="Penalty %" value={cancelForm.percent} onChange={(e) => setCancelForm({ ...cancelForm, percent: e.target.value })} required /><button type="submit" className="admin-btn">Stage tier</button></form>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Child bands (staged)</h3>
      <ul style={{ fontSize: 12, margin: 0 }}>{children.map((p, i) => <li key={`${p.minAge}-${p.maxAge}`}>Ages {p.minAge}–{p.maxAge}{p.extraBedAllowed ? ', extra bed' : ''}{' '}<button type="button" className="admin-btn" onClick={() => setChildren((c) => c.filter((_, j) => j !== i))}>Remove</button></li>)}</ul>
      <form onSubmit={addChild} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged minimum age" inputMode="numeric" placeholder="Min age" value={childForm.min} onChange={(e) => setChildForm({ ...childForm, min: e.target.value })} required /><input className="admin-filter-select" aria-label="Staged maximum age" inputMode="numeric" placeholder="Max age" value={childForm.max} onChange={(e) => setChildForm({ ...childForm, max: e.target.value })} required /><label style={{ fontSize: 11 }}><input type="checkbox" checked={childForm.extraBed} onChange={(e) => setChildForm({ ...childForm, extraBed: e.target.checked })} /> Extra bed</label><button type="submit" className="admin-btn">Stage band</button></form>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Booking lead time (staged)</h3>
      <p style={{ fontSize: 12, margin: 0 }}>{lead ? `Minimum ${lead.minLeadHours} hours${lead.maxLeadDays != null ? `, up to ${lead.maxLeadDays} days ahead` : ''}` : 'None'}{lead ? <> <button type="button" className="admin-btn" onClick={() => setLead(null)}>Remove</button></> : null}</p>
      <form onSubmit={setLeadRule} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged minimum lead hours" inputMode="numeric" placeholder="Min lead hours" value={leadForm.hours} onChange={(e) => setLeadForm({ ...leadForm, hours: e.target.value })} required /><input className="admin-filter-select" aria-label="Staged maximum lead days" inputMode="numeric" placeholder="Max lead days (optional)" value={leadForm.days} onChange={(e) => setLeadForm({ ...leadForm, days: e.target.value })} /><button type="submit" className="admin-btn">Stage lead time</button></form>
      {Object.keys(changes).length ? <ul aria-label="Staged changes" style={{ fontSize: 12, margin: 0 }}>{describeChanges(changes).map((line) => <li key={line}>{line}</li>)}</ul> : <p style={{ fontSize: 12, margin: 0 }}>Nothing staged yet.</p>}
      <label style={{ fontSize: 11 }}>Reason shown to the approver <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Amendment reason" maxLength={500} style={{ width: '100%' }} /></label>
      <button type="button" className="admin-btn admin-btn-primary" disabled={busy || Object.keys(changes).length === 0 || reason.trim().length < 3} onClick={() => void file()}>{busy ? 'Sending…' : 'Request policy amendment'}</button>
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ fontSize: 12, margin: 0, color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a' }}>{message.text}</p> : null}
    </section>
  )
}
