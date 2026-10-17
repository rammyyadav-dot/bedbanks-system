'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { ContractPolicies } from './ContractPolicies'
import { ContractLifecyclePanel } from './ContractLifecyclePanel'
import { ContractPolicyAmendment } from './ContractPolicyAmendment'
import type { ContractLifecycleView } from '@bedbanks/contracts'
import { describeChanges, headerAmendment, newContractRequestId } from '@/lib/contract-lifecycle-ui'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import {
  createContract, getContract, getContractLifecycle, getHotelMappings, getHotels, getSuppliers, requestContractAmendment, updateContract,
  type AdminContractDetail, type HotelMappingRecord, type HotelRecord, type SupplySupplier,
} from '@/lib/data'

const list = (value: string) => value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)

interface FormState { supplierId: string; supplierHotelMappingId: string; code: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string; nationalities: string }
const blank: FormState = { supplierId: '', supplierHotelMappingId: '', code: '', validFrom: '', validTo: '', settlementCurrency: 'AED', salesMarkets: '', nationalities: '' }

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
        if (contract) setForm({ supplierId: contract.supplierId, supplierHotelMappingId: contract.supplierHotelMappingId ?? '', code: contract.code, validFrom: contract.validFrom.slice(0, 10), validTo: contract.validTo.slice(0, 10), settlementCurrency: contract.settlementCurrency, salesMarkets: (contract.salesMarkets ?? []).join(', '), nationalities: (contract.nationalities ?? []).join(', ') })
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
    if (form.validTo < form.validFrom) return setMessage({ kind: 'error', text: 'Valid to must be on or after valid from.' })
    if (!/^[A-Za-z]{3}$/.test(form.settlementCurrency)) return setMessage({ kind: 'error', text: 'Settlement currency must be a 3-letter ISO-4217 code.' })
    const body = { supplierId: form.supplierId, supplierHotelMappingId: form.supplierHotelMappingId || null, code: form.code.trim(), validFrom: form.validFrom, validTo: form.validTo, settlementCurrency: form.settlementCurrency.toUpperCase(), salesMarkets: list(form.salesMarkets), nationalities: list(form.nationalities) }
    setSaving(true)
    try {
      if (contractId && lifecycle?.status === 'ACTIVE' && detail) {
        // ADR 0067: an ACTIVE contract changes only by an amendment a second person approves. Only the terms that differ are sent.
        const current = { code: detail.code, validFrom: detail.validFrom.slice(0, 10), validTo: detail.validTo.slice(0, 10), settlementCurrency: detail.settlementCurrency, salesMarkets: detail.salesMarkets ?? [], nationalities: detail.nationalities ?? [] }
        const changes = headerAmendment(current, { code: body.code, validFrom: body.validFrom, validTo: body.validTo, settlementCurrency: body.settlementCurrency, salesMarkets: body.salesMarkets, nationalities: body.nationalities })
        if (Object.keys(changes).length === 0) { setMessage({ kind: 'error', text: 'Nothing changed. Edit a term first.' }); return }
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
            <FormField label="Valid from"><input type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} disabled={locked} required /></FormField>
            <FormField label="Valid to"><input type="date" value={form.validTo} onChange={(e) => set('validTo', e.target.value)} disabled={locked} required /></FormField>
            <FormField label="Settlement currency (ISO-4217)"><input value={form.settlementCurrency} onChange={(e) => set('settlementCurrency', e.target.value.toUpperCase())} disabled={locked} required maxLength={3} /></FormField>
            <FormField label="Sales markets (ISO country codes, comma-separated)"><input value={form.salesMarkets} onChange={(e) => set('salesMarkets', e.target.value)} disabled={locked} placeholder="AE, SA" /></FormField>
            <FormField label="Nationality restrictions (ISO country codes, comma-separated)"><input value={form.nationalities} onChange={(e) => set('nationalities', e.target.value)} disabled={locked} placeholder="Leave empty for none" /></FormField>
            {amending && canManage ? <FormField label="Amendment reason (shown to the approver)"><input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} maxLength={500} placeholder="e.g. Hotel extended validity by addendum dated 12 Oct" /></FormField> : null}
            {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#bc5652' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
            {canManage && status !== 'EXPIRED' ? <button type="submit" className="admin-btn admin-btn-primary" disabled={saving}>{saving ? 'Saving…' : amending ? 'Request amendment' : editing ? 'Save contract' : 'Create contract'}</button> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to contracts.</p>}
          </form>
          {editing && lifecycle ? <ContractLifecyclePanel view={lifecycle} canManage={canManage} onChanged={() => void reload()} /> : null}
          {editing && detail ? <ContractPolicies contract={detail} canManage={canManage} editable={lifecycle?.termsEditable ?? false} onChanged={() => void reload()} /> : null}
          {editing && detail && lifecycle && amending && canManage && !lifecycle.openRequest ? <ContractPolicyAmendment key={lifecycle.fingerprint} contract={detail} fingerprint={lifecycle.fingerprint} onFiled={() => void reload()} /> : null}
        </>
      )}
    </div>
  )
}
