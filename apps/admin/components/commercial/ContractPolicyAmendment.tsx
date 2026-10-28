'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ContractAmendmentChanges, ContractCancellationTerm, ContractChildTerm, ContractLeadTimeTerm, ContractSupplementTerm } from '@bedbanks/contracts'
import { blankSupplement, describeSupplement, supplementFromForm, type SupplementForm } from '@/lib/supplements-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { describeRule, penaltyFromInput, setFromInput } from '@/lib/cancellation-sets'
import { describeChanges, newContractRequestId } from '@/lib/contract-lifecycle-ui'
import { getBoardBases, requestContractAmendment, type AdminContractDetail, type BoardBasisRecord } from '@/lib/data'

const cancellationOf = (c: AdminContractDetail): ContractCancellationTerm[] => c.cancellationPolicies.map((p) => ({ policySet: p.policySet ?? null, kind: p.kind ?? 'CANCELLATION', daysBeforeCheckin: p.daysBeforeCheckin, penaltyPercent: p.penaltyPercent, penaltyMinor: p.penaltyMinor, penaltyNights: p.penaltyNights ?? null, currency: p.currency }))
const childOf = (c: AdminContractDetail): ContractChildTerm[] => c.childPolicies.map((p) => ({ minAge: p.minAge, maxAge: p.maxAge, extraBedAllowed: p.extraBedAllowed, supplementMinor: p.supplementMinor, currency: p.currency }))
const leadOf = (c: AdminContractDetail): ContractLeadTimeTerm | null => { const r = Array.isArray(c.leadTimeRules) ? c.leadTimeRules[0] : c.leadTimeRules; return r ? { minLeadHours: r.minLeadHours, maxLeadDays: r.maxLeadDays } : null }
const supplementsOf = (c: AdminContractDetail): ContractSupplementTerm[] => (c.supplements ?? []).map(({ id: _id, ...s }) => ({ ...s, stayFrom: s.stayFrom?.slice(0, 10) ?? null, stayTo: s.stayTo?.slice(0, 10) ?? null }))
const key = (v: unknown) => JSON.stringify(v)

/**
 * Stages policy changes for an ACTIVE contract and files them as ONE amendment (ADR 0067). Nothing is written until a second person approves
 * and the amendment is applied; the staged sets replace the current ones whole. The API validates and re-checks everything.
 */
export function ContractPolicyAmendment({ contract, fingerprint, onFiled }: { contract: AdminContractDetail; fingerprint: string; onFiled: () => void }) {
  const [cancellation, setCancellation] = useState(() => cancellationOf(contract))
  const [children, setChildren] = useState(() => childOf(contract))
  const [lead, setLead] = useState(() => leadOf(contract))
  const [supplements, setSupplements] = useState(() => supplementsOf(contract))
  const [supplementForm, setSupplementForm] = useState<SupplementForm>(blankSupplement)
  const [boards, setBoards] = useState<BoardBasisRecord[]>([])
  useEffect(() => { getBoardBases().then(setBoards).catch(() => setBoards([])) }, [])
  const [cancelForm, setCancelForm] = useState<{ days: string; percent: string; set: string; form: 'PERCENT' | 'NIGHTS'; kind: 'CANCELLATION' | 'NO_SHOW' }>({ days: '', percent: '', set: '', form: 'PERCENT', kind: 'CANCELLATION' })
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
    ...(key(supplements) !== key(supplementsOf(contract)) ? { supplements } : {}),
  }), [cancellation, children, lead, supplements, contract])

  const addCancel = (e: FormEvent) => {
    e.preventDefault()
    const penalty = penaltyFromInput(cancelForm.form, cancelForm.percent)
    if (!penalty) { setMessage({ kind: 'error', text: 'Enter the penalty as a whole number.' }); return }
    setCancellation((c) => [...c, { policySet: setFromInput(cancelForm.set) ?? null, kind: cancelForm.kind, daysBeforeCheckin: cancelForm.kind === 'NO_SHOW' ? 0 : Number(cancelForm.days), penaltyPercent: 'penaltyPercent' in penalty ? penalty.penaltyPercent : null, penaltyMinor: null, penaltyNights: 'penaltyNights' in penalty ? penalty.penaltyNights : null, currency: null }])
    setCancelForm({ ...cancelForm, days: '', percent: '' })
  }
  const addChild = (e: FormEvent) => { e.preventDefault(); setChildren((c) => [...c, { minAge: Number(childForm.min), maxAge: Number(childForm.max), extraBedAllowed: childForm.extraBed, supplementMinor: null, currency: null }]); setChildForm({ min: '', max: '', extraBed: false }) }
  const setLeadRule = (e: FormEvent) => { e.preventDefault(); setLead({ minLeadHours: Number(leadForm.hours), maxLeadDays: leadForm.days === '' ? null : Number(leadForm.days) }) }

  const addSupplement = (e: FormEvent) => {
    e.preventDefault()
    const term = supplementFromForm(supplementForm, contract.settlementCurrency)
    if (typeof term === 'string') { setMessage({ kind: 'error', text: term }); return }
    setSupplements((s) => [...s, term]); setSupplementForm(blankSupplement)
  }

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
      <p style={{ fontSize: 12, margin: 0, color: 'var(--c-444444)' }}>Stage the policy sets as they should be. The staged sets replace the current ones once a second person approves.</p>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Cancellation (staged)</h3>
      <ul style={{ fontSize: 12, margin: 0 }}>{cancellation.map((p, i) => <li key={`${p.policySet}-${p.daysBeforeCheckin}-${i}`}>{p.policySet ? `[${p.policySet}] ` : ''}{describeRule(p, (m, c) => `${c} ${m} (minor units)`)}{' '}<button type="button" className="admin-btn" onClick={() => setCancellation((c) => c.filter((_, j) => j !== i))}>Remove</button></li>)}</ul>
      <form onSubmit={addCancel} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged rule set" placeholder="Set (blank = default)" maxLength={80} value={cancelForm.set} onChange={(e) => setCancelForm({ ...cancelForm, set: e.target.value })} /><select className="admin-filter-select" aria-label="Staged rule kind" value={cancelForm.kind} onChange={(e) => setCancelForm({ ...cancelForm, kind: e.target.value as 'CANCELLATION' | 'NO_SHOW' })}><option value="CANCELLATION">Tier</option><option value="NO_SHOW">No-show</option></select>{cancelForm.kind === 'CANCELLATION' ? <input className="admin-filter-select" aria-label="Staged days before check-in" inputMode="numeric" placeholder="Days" value={cancelForm.days} onChange={(e) => setCancelForm({ ...cancelForm, days: e.target.value })} required /> : null}<select className="admin-filter-select" aria-label="Staged penalty form" value={cancelForm.form} onChange={(e) => setCancelForm({ ...cancelForm, form: e.target.value as 'PERCENT' | 'NIGHTS' })}><option value="PERCENT">%</option><option value="NIGHTS">Nights</option></select><input className="admin-filter-select" aria-label="Staged penalty" inputMode="numeric" placeholder={cancelForm.form === 'NIGHTS' ? 'Nights' : 'Penalty %'} value={cancelForm.percent} onChange={(e) => setCancelForm({ ...cancelForm, percent: e.target.value })} required /><button type="submit" className="admin-btn">Stage tier</button></form>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Child bands (staged)</h3>
      <ul style={{ fontSize: 12, margin: 0 }}>{children.map((p, i) => <li key={`${p.minAge}-${p.maxAge}`}>Ages {p.minAge}–{p.maxAge}{p.extraBedAllowed ? ', extra bed' : ''}{' '}<button type="button" className="admin-btn" onClick={() => setChildren((c) => c.filter((_, j) => j !== i))}>Remove</button></li>)}</ul>
      <form onSubmit={addChild} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged minimum age" inputMode="numeric" placeholder="Min age" value={childForm.min} onChange={(e) => setChildForm({ ...childForm, min: e.target.value })} required /><input className="admin-filter-select" aria-label="Staged maximum age" inputMode="numeric" placeholder="Max age" value={childForm.max} onChange={(e) => setChildForm({ ...childForm, max: e.target.value })} required /><label style={{ fontSize: 11 }}><input type="checkbox" checked={childForm.extraBed} onChange={(e) => setChildForm({ ...childForm, extraBed: e.target.checked })} /> Extra bed</label><button type="submit" className="admin-btn">Stage band</button></form>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Booking lead time (staged)</h3>
      <p style={{ fontSize: 12, margin: 0 }}>{lead ? `Minimum ${lead.minLeadHours} hours${lead.maxLeadDays != null ? `, up to ${lead.maxLeadDays} days ahead` : ''}` : 'None'}{lead ? <> <button type="button" className="admin-btn" onClick={() => setLead(null)}>Remove</button></> : null}</p>
      <form onSubmit={setLeadRule} className="admin-filter-bar"><input className="admin-filter-select" aria-label="Staged minimum lead hours" inputMode="numeric" placeholder="Min lead hours" value={leadForm.hours} onChange={(e) => setLeadForm({ ...leadForm, hours: e.target.value })} required /><input className="admin-filter-select" aria-label="Staged maximum lead days" inputMode="numeric" placeholder="Max lead days (optional)" value={leadForm.days} onChange={(e) => setLeadForm({ ...leadForm, days: e.target.value })} /><button type="submit" className="admin-btn">Stage lead time</button></form>
      <h3 style={{ fontSize: 12, margin: '6px 0 0' }}>Supplements (staged)</h3>
      <ul style={{ fontSize: 12, margin: 0 }}>{supplements.map((s, i) => <li key={`${s.name}-${i}`}>{s.kind === 'BOARD' ? 'Board' : 'Compulsory'} · {describeSupplement(s, (m, c) => `${c} ${m} (minor units)`)}{' '}<button type="button" className="admin-btn" onClick={() => setSupplements((list) => list.filter((_, j) => j !== i))}>Remove</button></li>)}</ul>
      <form onSubmit={addSupplement} className="admin-filter-bar"><select className="admin-filter-select" aria-label="Staged supplement kind" value={supplementForm.kind} onChange={(e) => setSupplementForm({ ...supplementForm, kind: e.target.value as SupplementForm['kind'] })}><option value="COMPULSORY">Compulsory</option><option value="BOARD">Board</option></select><input className="admin-filter-select" aria-label="Staged supplement name" placeholder="Name" maxLength={80} value={supplementForm.name} onChange={(e) => setSupplementForm({ ...supplementForm, name: e.target.value })} required />{supplementForm.kind === 'BOARD' ? <select className="admin-filter-select" aria-label="Staged board" value={supplementForm.boardBasisId} onChange={(e) => setSupplementForm({ ...supplementForm, boardBasisId: e.target.value })} required><option value="">Board…</option>{boards.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select> : null}<input className="admin-filter-select" aria-label="Staged supplement amount" inputMode="decimal" placeholder={`Amount (${contract.settlementCurrency})`} value={supplementForm.amount} onChange={(e) => setSupplementForm({ ...supplementForm, amount: e.target.value })} required /><select className="admin-filter-select" aria-label="Staged supplement basis" value={supplementForm.basis} onChange={(e) => setSupplementForm({ ...supplementForm, basis: e.target.value as SupplementForm['basis'] })}><option value="PER_PERSON">per person</option><option value="PER_ADULT">per adult</option><option value="PER_CHILD">per child</option><option value="PER_ROOM">per room</option></select><select className="admin-filter-select" aria-label="Staged supplement frequency" value={supplementForm.frequency} onChange={(e) => setSupplementForm({ ...supplementForm, frequency: e.target.value as SupplementForm['frequency'] })}><option value="PER_STAY">once per stay</option><option value="PER_NIGHT">per night</option></select><input className="admin-filter-select" type="date" aria-label="Staged first stay night" value={supplementForm.stayFrom} onChange={(e) => setSupplementForm({ ...supplementForm, stayFrom: e.target.value })} /><input className="admin-filter-select" type="date" aria-label="Staged last stay night" value={supplementForm.stayTo} onChange={(e) => setSupplementForm({ ...supplementForm, stayTo: e.target.value })} /><button type="submit" className="admin-btn">Stage supplement</button></form>
      {Object.keys(changes).length ? <ul aria-label="Staged changes" style={{ fontSize: 12, margin: 0 }}>{describeChanges(changes).map((line) => <li key={line}>{line}</li>)}</ul> : <p style={{ fontSize: 12, margin: 0 }}>Nothing staged yet.</p>}
      <label style={{ fontSize: 11 }}>Reason shown to the approver <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Amendment reason" maxLength={500} style={{ width: '100%' }} /></label>
      <button type="button" className="admin-btn admin-btn-primary" disabled={busy || Object.keys(changes).length === 0 || reason.trim().length < 3} onClick={() => void file()}>{busy ? 'Sending…' : 'Request policy amendment'}</button>
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ fontSize: 12, margin: 0, color: message.kind === 'error' ? 'var(--c-b3141b)' : 'var(--c-111111)' }}>{message.text}</p> : null}
    </section>
  )
}
