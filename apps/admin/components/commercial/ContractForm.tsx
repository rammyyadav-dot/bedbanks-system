'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { ContractPolicies } from './ContractPolicies'
import { ContractSupplements } from './ContractSupplements'
import { ContractLifecyclePanel } from './ContractLifecyclePanel'
import { ContractPolicyAmendment } from './ContractPolicyAmendment'
import { CONTRACT_ALLOTMENT_TYPES, CONTRACT_MIN_STAY_MODES, CONTRACT_RATE_TYPES, type ContractHeaderTerms, type ContractLifecycleView } from '@bedbanks/contracts'
import { bpToPercent, describeChanges, headerAmendment, headerTermsOf, newContractRequestId, percentToBp } from '@/lib/contract-lifecycle-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import {
  createContract, getContract, getContractLifecycle, getHotelMappings, getHotels, getSuppliers, requestContractAmendment, updateContract,
  type AdminContractDetail, type HotelMappingRecord, type HotelRecord, type SupplySupplier,
} from '@/lib/data'

const list = (value: string) => value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)

interface FormState {
  supplierId: string; supplierHotelMappingId: string; code: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string; nationalities: string
  // ADR 0067 F-20/F-15 header terms, as typed.
  rateType: string; commissionPercent: string; paymentTermsDays: string; signedAt: string; signedDocumentRef: string; allotmentType: string; minStayMode: string; clientBufferDays: string
  // Governance: editable while ACTIVE, without an amendment.
  ownerUserId: string; renewalReminderDays: string
}
const blank: FormState = { supplierId: '', supplierHotelMappingId: '', code: '', validFrom: '', validTo: '', settlementCurrency: 'AED', salesMarkets: '', nationalities: '', rateType: '', commissionPercent: '', paymentTermsDays: '', signedAt: '', signedDocumentRef: '', allotmentType: '', minStayMode: 'STAY_THROUGH', clientBufferDays: '0', ownerUserId: '', renewalReminderDays: '60' }
const RATE_TYPE_LABEL: Record<(typeof CONTRACT_RATE_TYPES)[number], string> = { NET: 'Net (we add markup)', COMMISSIONABLE: 'Commissionable (hotel pays commission)' }
const ALLOTMENT_LABEL: Record<(typeof CONTRACT_ALLOTMENT_TYPES)[number], string> = { GUARANTEED: 'Guaranteed (we pay unsold rooms)', NON_GUARANTEED: 'Non-guaranteed (release applies)', FREE_SALE: 'Free sale (sell until stopped)' }
const MIN_STAY_LABEL: Record<(typeof CONTRACT_MIN_STAY_MODES)[number], string> = { STAY_THROUGH: 'Stay-through: every night’s minimum applies', ARRIVAL: 'On arrival: only the check-in night’s minimum applies' }

function formOf(contract: AdminContractDetail): FormState {
  const h = headerTermsOf(contract as unknown as Record<string, unknown>)
  const raw = contract as unknown as { ownerUserId?: string | null; renewalReminderDays?: number }
  return {
    supplierId: contract.supplierId, supplierHotelMappingId: contract.supplierHotelMappingId ?? '', code: contract.code, validFrom: contract.validFrom.slice(0, 10), validTo: contract.validTo.slice(0, 10), settlementCurrency: contract.settlementCurrency, salesMarkets: (contract.salesMarkets ?? []).join(', '), nationalities: (contract.nationalities ?? []).join(', '),
    rateType: h.rateType ?? '', commissionPercent: bpToPercent(h.commissionBp), paymentTermsDays: h.paymentTermsDays === null ? '' : String(h.paymentTermsDays), signedAt: h.signedAt ?? '', signedDocumentRef: h.signedDocumentRef ?? '', allotmentType: h.allotmentType ?? '', minStayMode: h.minStayMode, clientBufferDays: String(h.clientBufferDays),
    ownerUserId: raw.ownerUserId ?? '', renewalReminderDays: String(raw.renewalReminderDays ?? 60),
  }
}

/** The typed header as API terms, or the first problem. The API validates again. */
function headerOfForm(form: FormState): ContractHeaderTerms | string {
  const commissionBp = percentToBp(form.commissionPercent)
  if (commissionBp === undefined) return 'Commission: a percentage with at most two decimals, e.g. 12.5.'
  if (form.rateType === 'COMMISSIONABLE' && commissionBp === null) return 'A commissionable contract needs its commission.'
  if (form.rateType !== 'COMMISSIONABLE' && commissionBp !== null) return 'Only a commissionable contract carries a commission.'
  const days = form.paymentTermsDays.trim()
  if (days !== '' && !/^\d{1,3}$/.test(days)) return 'Payment terms: a whole number of days.'
  const buffer = form.clientBufferDays.trim()
  if (!/^\d{1,2}$/.test(buffer) || Number(buffer) > 30) return 'Client cancellation buffer: a whole number of days from 0 to 30.'
  return {
    clientBufferDays: Number(buffer),
    rateType: (form.rateType || null) as ContractHeaderTerms['rateType'], commissionBp, paymentTermsDays: days === '' ? null : Number(days), signedAt: form.signedAt || null, signedDocumentRef: form.signedDocumentRef.trim() || null,
    allotmentType: (form.allotmentType || null) as ContractHeaderTerms['allotmentType'], minStayMode: form.minStayMode === 'ARRIVAL' ? 'ARRIVAL' : 'STAY_THROUGH',
  }
}

export function ContractForm({ contractId }: { contractId?: string }) {
  const router = useRouter()
  const can = useCan()
  const editing = Boolean(contractId)
  const canManage = can('supply.contracts.manage')
  const [form, setForm] = useState<FormState>(blank)
  const [suppliers, setSuppliers] = useState<SupplySupplier[]>([])
  const [mappings, setMappings] = useState<HotelMappingRecord[]>([])
  const [hotels, setHotels] = useState<HotelRecord[]>([])
  const [detail, setDetail] = useState<AdminContractDetail | null>(null)
  const [lifecycle, setLifecycle] = useState<ContractLifecycleView | null>(null)
  const [amendReason, setAmendReason] = useState('')
  const [amendRequestId, setAmendRequestId] = useState(() => newContractRequestId())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    let active = true
    Promise.all([getSuppliers('page=1&pageSize=100'), getHotelMappings(), getHotels(), contractId ? getContract(contractId) : Promise.resolve(null), contractId ? getContractLifecycle(contractId) : Promise.resolve(null)])
      .then(([supplierList, mappingList, hotelList, contract, view]) => {
        if (!active) return
        setSuppliers(supplierList.items); setMappings(mappingList); setHotels(hotelList); setDetail(contract); setLifecycle(view)
        if (contract) setForm(formOf(contract))
      })
      .catch((error) => { if (active) setLoadError(describeApiError(error, 'load contract data')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [contractId])

  const hotelName = (hotelId: string) => hotels.find((hotel) => hotel.id === hotelId)?.name ?? hotelId
  const approvedMappings = mappings.filter((mapping) => mapping.supplierId === form.supplierId && (mapping.status === 'MAPPED' || mapping.id === form.supplierHotelMappingId))
  const supplierChanged = (supplierId: string) => setForm((current) => ({ ...current, supplierId, supplierHotelMappingId: '', settlementCurrency: current.settlementCurrency || suppliers.find((supplier) => supplier.id === supplierId)?.defaultCurrency || '' }))

  async function reload() {
    if (!contractId) return
    const [contract, view] = await Promise.all([getContract(contractId), getContractLifecycle(contractId)])
    setDetail(contract); setLifecycle(view)
  }
  const status = lifecycle?.status ?? 'DRAFT'
  const amending = status === 'ACTIVE'
  const locked = !canManage || status === 'EXPIRED'
  /** Supplier and hotel binding identify a contract: never amendable, editable only while the terms are. */
  const identityLocked = locked || amending

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    if (!form.supplierId || !form.code.trim() || !form.validFrom || !form.validTo) return setMessage({ kind: 'error', text: 'Supplier, code and both validity dates are required.' })
    if (form.validTo < form.validFrom) return setMessage({ kind: 'error', text: 'The last stay night must be on or after the first.' })
    if (!/^[A-Za-z]{3}$/.test(form.settlementCurrency)) return setMessage({ kind: 'error', text: 'Settlement currency must be a 3-letter ISO-4217 code.' })
    const header = headerOfForm(form)
    if (typeof header === 'string') return setMessage({ kind: 'error', text: header })
    if (!/^\d{1,3}$/.test(form.renewalReminderDays.trim()) || Number(form.renewalReminderDays) < 1 || Number(form.renewalReminderDays) > 365) return setMessage({ kind: 'error', text: 'Renewal reminder: a whole number of days from 1 to 365.' })
    const governance = { ownerUserId: form.ownerUserId.trim() || null, renewalReminderDays: Number(form.renewalReminderDays) }
    const body = { ...header, ...governance, supplierId: form.supplierId, supplierHotelMappingId: form.supplierHotelMappingId || null, code: form.code.trim(), validFrom: form.validFrom, validTo: form.validTo, settlementCurrency: form.settlementCurrency.toUpperCase(), salesMarkets: list(form.salesMarkets), nationalities: list(form.nationalities) }
    setSaving(true)
    try {
      if (contractId && lifecycle?.status === 'ACTIVE' && detail) {
        // ADR 0067: an ACTIVE contract changes only by an amendment a second person approves. Only the terms that differ are sent.
        const current = { code: detail.code, validFrom: detail.validFrom.slice(0, 10), validTo: detail.validTo.slice(0, 10), settlementCurrency: detail.settlementCurrency, salesMarkets: detail.salesMarkets ?? [], nationalities: detail.nationalities ?? [], ...headerTermsOf(detail as unknown as Record<string, unknown>) }
        const changes = headerAmendment(current, { code: body.code, validFrom: body.validFrom, validTo: body.validTo, settlementCurrency: body.settlementCurrency, salesMarkets: body.salesMarkets, nationalities: body.nationalities, ...header })
        // Owner and renewal reminder are governance, not terms: saved directly, with no amendment.
        const saved = formOf(detail)
        const governanceChanged = governance.ownerUserId !== (saved.ownerUserId || null) || String(governance.renewalReminderDays) !== saved.renewalReminderDays
        if (Object.keys(changes).length === 0) {
          if (!governanceChanged) { setMessage({ kind: 'error', text: 'Nothing changed. Edit a term first.' }); return }
          await updateContract(contractId, governance); setMessage({ kind: 'ok', text: 'Owner and renewal reminder saved.' }); await reload(); return
        }
        if (governanceChanged) await updateContract(contractId, governance)
        if (amendReason.trim().length < 3) { setMessage({ kind: 'error', text: 'Give the approver a reason for the amendment.' }); return }
        await requestContractAmendment(contractId, { requestId: amendRequestId, reason: amendReason.trim(), expectedFingerprint: lifecycle.fingerprint, changes })
        setAmendReason(''); setAmendRequestId(newContractRequestId())
        setMessage({ kind: 'ok', text: `Amendment requested: ${describeChanges(changes, current).join('; ')}. It applies once a second person approves it.` })
        await reload()
      } else if (contractId) {
        await updateContract(contractId, body)
        setMessage({ kind: 'ok', text: 'Contract saved.' })
        await reload()
      } else {
        const created = await createContract(body)
        router.push(`/contracts/${created.id}`)
      }
    } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the contract') }) } finally { setSaving(false) }
  }

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · CONTRACTS" title={editing ? `Contract ${detail?.code ?? ''}` : 'New contract'} description={editing ? 'Edit commercial terms while the contract is a draft, in review or suspended. An ACTIVE contract changes only through an amendment a second person approves.' : 'Create a contract in DRAFT. Once its terms are complete, request activation: a second person approves it.'} actions={<Link href="/contracts" className="admin-btn">Back to contracts</Link>} />
      {loading ? <LoadingState rows={4} /> : loadError ? <ErrorState title="Contract data unavailable" description={`${loadError} No fallback data is shown.`} /> : (
        <>
          <form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 4, maxWidth: 760, padding: 22 }} aria-label="Contract form">
            <FormField label="Supplier"><select value={form.supplierId} onChange={(e) => supplierChanged(e.target.value)} disabled={identityLocked} required><option value="">Select supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.displayName} ({supplier.status})</option>)}</select></FormField>
            <FormField label="Hotel mapping (approved only)"><select value={form.supplierHotelMappingId} onChange={(e) => set('supplierHotelMappingId', e.target.value)} disabled={identityLocked || !form.supplierId}><option value="">No hotel binding</option>{approvedMappings.map((mapping) => <option key={mapping.id} value={mapping.id}>{hotelName(mapping.hotelId)} · {mapping.supplierHotelId}</option>)}</select></FormField>
            <FormField label="Contract code"><input value={form.code} onChange={(e) => set('code', e.target.value)} disabled={locked} required maxLength={80} /></FormField>
            <FormField label="First stay night (valid from)"><input type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} disabled={locked} required /></FormField>
            <FormField label="Last stay night (valid to)"><input type="date" value={form.validTo} onChange={(e) => set('validTo', e.target.value)} disabled={locked} required /></FormField>
            <FormField label="Settlement currency (ISO-4217)"><input value={form.settlementCurrency} onChange={(e) => set('settlementCurrency', e.target.value.toUpperCase())} disabled={locked} required maxLength={3} /></FormField>
            <FormField label="Sales markets (ISO country codes, comma-separated)"><input value={form.salesMarkets} onChange={(e) => set('salesMarkets', e.target.value)} disabled={locked} placeholder="AE, SA" /></FormField>
            <FormField label="Nationality restrictions (ISO country codes, comma-separated)"><input value={form.nationalities} onChange={(e) => set('nationalities', e.target.value)} disabled={locked} placeholder="Leave empty for none" /></FormField>
            <h3 style={{ fontSize: 13, margin: '10px 0 0' }}>Commercial header</h3>
            <FormField label="Rate type"><select value={form.rateType} onChange={(e) => setForm((c) => ({ ...c, rateType: e.target.value, commissionPercent: e.target.value === 'COMMISSIONABLE' ? c.commissionPercent : '' }))} disabled={locked}><option value="">Not stated</option>{CONTRACT_RATE_TYPES.map((t) => <option key={t} value={t}>{RATE_TYPE_LABEL[t]}</option>)}</select></FormField>
            {form.rateType === 'COMMISSIONABLE' ? <FormField label="Commission (% of the sell price)"><input inputMode="decimal" value={form.commissionPercent} onChange={(e) => set('commissionPercent', e.target.value)} disabled={locked} placeholder="e.g. 12.5" /></FormField> : null}
            <FormField label="Payment terms (days after check-out)"><input inputMode="numeric" value={form.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} disabled={locked} placeholder="e.g. 30" /></FormField>
            <FormField label="Allotment type"><select value={form.allotmentType} onChange={(e) => set('allotmentType', e.target.value)} disabled={locked}><option value="">Not stated</option>{CONTRACT_ALLOTMENT_TYPES.map((t) => <option key={t} value={t}>{ALLOTMENT_LABEL[t]}</option>)}</select></FormField>
            <FormField label="Minimum stay reading"><select value={form.minStayMode} onChange={(e) => set('minStayMode', e.target.value)} disabled={locked}>{CONTRACT_MIN_STAY_MODES.map((m) => <option key={m} value={m}>{MIN_STAY_LABEL[m]}</option>)}</select></FormField>
            <FormField label="Client cancellation buffer (days the buyer's deadlines start before the hotel's)"><input inputMode="numeric" value={form.clientBufferDays} onChange={(e) => set('clientBufferDays', e.target.value)} disabled={locked} /></FormField>
            <FormField label="Signed on"><input type="date" value={form.signedAt} onChange={(e) => set('signedAt', e.target.value)} disabled={locked} /></FormField>
            <FormField label="Signed document reference"><input value={form.signedDocumentRef} onChange={(e) => set('signedDocumentRef', e.target.value)} disabled={locked} maxLength={200} placeholder="e.g. DMS-2026-0412" /></FormField>
            <h3 style={{ fontSize: 13, margin: '10px 0 0' }}>Ownership and renewal</h3>
            <FormField label="Owner (user ID of a tenant member)"><input value={form.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} disabled={!canManage || status === 'EXPIRED'} placeholder="Leave empty for none" /></FormField>
            <FormField label="Renewal reminder (days before the last stay night)"><input inputMode="numeric" value={form.renewalReminderDays} onChange={(e) => set('renewalReminderDays', e.target.value)} disabled={!canManage || status === 'EXPIRED'} /></FormField>
            {amending && canManage ? <FormField label="Amendment reason (shown to the approver)"><input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} maxLength={500} placeholder="e.g. Hotel extended validity by addendum dated 12 Oct" /></FormField> : null}
            {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? 'var(--c-bc5652)' : 'var(--c-1f7a5a)', fontSize: 12 }}>{message.text}</p> : null}
            {canManage && status !== 'EXPIRED' ? <button type="submit" className="admin-btn admin-btn-primary" disabled={saving}>{saving ? 'Saving…' : amending ? 'Request amendment' : editing ? 'Save contract' : 'Create contract'}</button> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to contracts.</p>}
          </form>
          {editing && lifecycle ? <ContractLifecyclePanel view={lifecycle} canManage={canManage} onChanged={() => void reload()} /> : null}
          {editing && detail ? <ContractPolicies contract={detail} canManage={canManage} editable={lifecycle?.termsEditable ?? false} onChanged={() => void reload()} /> : null}
          {editing && detail ? <ContractSupplements contract={detail} canManage={canManage} editable={lifecycle?.termsEditable ?? false} onChanged={() => void reload()} /> : null}
          {editing && detail && lifecycle && amending && canManage && !lifecycle.openRequest ? <ContractPolicyAmendment key={lifecycle.fingerprint} contract={detail} fingerprint={lifecycle.fingerprint} onFiled={() => void reload()} /> : null}
        </>
      )}
    </div>
  )
}
