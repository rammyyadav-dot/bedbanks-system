'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { ContractPolicies } from './ContractPolicies'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import {
  createContract, getContract, getHotelMappings, getHotels, getSuppliers, updateContract,
  type AdminContractDetail, type HotelMappingRecord, type HotelRecord, type SupplySupplier,
} from '@/lib/data'

const CONTRACT_STATUSES = ['DRAFT', 'REVIEW', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const
const list = (value: string) => value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)

interface FormState { supplierId: string; supplierHotelMappingId: string; code: string; status: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string; nationalities: string }
const blank: FormState = { supplierId: '', supplierHotelMappingId: '', code: '', status: 'DRAFT', validFrom: '', validTo: '', settlementCurrency: 'AED', salesMarkets: '', nationalities: '' }

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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    let active = true
    Promise.all([getSuppliers('page=1&pageSize=100'), getHotelMappings(), getHotels(), contractId ? getContract(contractId) : Promise.resolve(null)])
      .then(([supplierList, mappingList, hotelList, contract]) => {
        if (!active) return
        setSuppliers(supplierList.items); setMappings(mappingList); setHotels(hotelList); setDetail(contract)
        if (contract) setForm({ supplierId: contract.supplierId, supplierHotelMappingId: contract.supplierHotelMappingId ?? '', code: contract.code, status: contract.status, validFrom: contract.validFrom.slice(0, 10), validTo: contract.validTo.slice(0, 10), settlementCurrency: contract.settlementCurrency, salesMarkets: (contract.salesMarkets ?? []).join(', '), nationalities: (contract.nationalities ?? []).join(', ') })
      })
      .catch((error) => { if (active) setLoadError(describeApiError(error, 'load contract data')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [contractId])

  const hotelName = (hotelId: string) => hotels.find((hotel) => hotel.id === hotelId)?.name ?? hotelId
  const approvedMappings = mappings.filter((mapping) => mapping.supplierId === form.supplierId && (mapping.status === 'MAPPED' || mapping.id === form.supplierHotelMappingId))
  const supplierChanged = (supplierId: string) => setForm((current) => ({ ...current, supplierId, supplierHotelMappingId: '', settlementCurrency: current.settlementCurrency || suppliers.find((supplier) => supplier.id === supplierId)?.defaultCurrency || '' }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    if (!form.supplierId || !form.code.trim() || !form.validFrom || !form.validTo) return setMessage({ kind: 'error', text: 'Supplier, code and both validity dates are required.' })
    if (form.validTo < form.validFrom) return setMessage({ kind: 'error', text: 'Valid to must be on or after valid from.' })
    if (!/^[A-Za-z]{3}$/.test(form.settlementCurrency)) return setMessage({ kind: 'error', text: 'Settlement currency must be a 3-letter ISO-4217 code.' })
    const body = { supplierId: form.supplierId, supplierHotelMappingId: form.supplierHotelMappingId || null, code: form.code.trim(), validFrom: form.validFrom, validTo: form.validTo, settlementCurrency: form.settlementCurrency.toUpperCase(), salesMarkets: list(form.salesMarkets), nationalities: list(form.nationalities) }
    setSaving(true)
    try {
      if (contractId) {
        const saved = await updateContract(contractId, { ...body, status: form.status })
        setForm((current) => ({ ...current, status: saved.status }))
        setMessage({ kind: 'ok', text: 'Contract saved.' })
      } else {
        const created = await createContract(body)
        router.push(`/contracts/${created.id}`)
      }
    } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the contract') }) } finally { setSaving(false) }
  }

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · CONTRACTS" title={editing ? `Contract ${detail?.code ?? ''}` : 'New contract'} description={editing ? 'Edit commercial terms. The API validates every change; a contract must be ACTIVE and bound to an approved hotel mapping to be sellable.' : 'Create a contract in DRAFT. Set it ACTIVE from the edit screen once its terms are complete.'} actions={<Link href="/contracts" className="admin-btn">Back to contracts</Link>} />
      {loading ? <LoadingState rows={4} /> : loadError ? <ErrorState title="Contract data unavailable" description={`${loadError} No fallback data is shown.`} /> : (
        <>
          <form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 4, maxWidth: 760, padding: 22 }} aria-label="Contract form">
            <FormField label="Supplier"><select value={form.supplierId} onChange={(e) => supplierChanged(e.target.value)} disabled={!canManage} required><option value="">Select supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.displayName} ({supplier.status})</option>)}</select></FormField>
            <FormField label="Hotel mapping (approved only)"><select value={form.supplierHotelMappingId} onChange={(e) => set('supplierHotelMappingId', e.target.value)} disabled={!canManage || !form.supplierId}><option value="">No hotel binding</option>{approvedMappings.map((mapping) => <option key={mapping.id} value={mapping.id}>{hotelName(mapping.hotelId)} · {mapping.supplierHotelId}</option>)}</select></FormField>
            <FormField label="Contract code"><input value={form.code} onChange={(e) => set('code', e.target.value)} disabled={!canManage} required maxLength={80} /></FormField>
            {editing ? <FormField label="Status"><select value={form.status} onChange={(e) => set('status', e.target.value)} disabled={!canManage}>{CONTRACT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></FormField> : null}
            <FormField label="Valid from"><input type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} disabled={!canManage} required /></FormField>
            <FormField label="Valid to"><input type="date" value={form.validTo} onChange={(e) => set('validTo', e.target.value)} disabled={!canManage} required /></FormField>
            <FormField label="Settlement currency (ISO-4217)"><input value={form.settlementCurrency} onChange={(e) => set('settlementCurrency', e.target.value.toUpperCase())} disabled={!canManage} required maxLength={3} /></FormField>
            <FormField label="Sales markets (ISO country codes, comma-separated)"><input value={form.salesMarkets} onChange={(e) => set('salesMarkets', e.target.value)} disabled={!canManage} placeholder="AE, SA" /></FormField>
            <FormField label="Nationality restrictions (ISO country codes, comma-separated)"><input value={form.nationalities} onChange={(e) => set('nationalities', e.target.value)} disabled={!canManage} placeholder="Leave empty for none" /></FormField>
            {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#bc5652' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
            {canManage ? <button type="submit" className="admin-btn admin-btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save contract' : 'Create contract'}</button> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to contracts.</p>}
          </form>
          {editing && detail ? <ContractPolicies contract={detail} canManage={canManage} onChanged={() => contractId && getContract(contractId).then(setDetail)} /> : null}
        </>
      )}
    </div>
  )
}
