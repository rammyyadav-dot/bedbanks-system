'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { FormField } from '@/components/forms/FormField'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { createSupplier, updateSupplier, type SupplySupplier } from '@/lib/data'

const TYPES = ['HOTEL_DIRECT', 'DMC', 'CHANNEL_MANAGER', 'BEDBANK', 'GDS'] as const
const STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE'] as const

/** Create or edit a supplier through the authoritative supplier API. A supplier must be ACTIVE for its contracts to be sellable. */
export function SupplierForm({ supplier, onSaved }: { supplier?: SupplySupplier; onSaved?: (saved: SupplySupplier) => void }) {
  const router = useRouter()
  const can = useCan()
  const canManage = can('supply.suppliers.manage')
  const [form, setForm] = useState({ type: supplier?.type ?? 'DMC', status: supplier?.status ?? 'DRAFT', legalName: supplier?.legalName ?? '', displayName: supplier?.displayName ?? '', countryCode: supplier?.countryCode ?? 'AE', defaultCurrency: supplier?.defaultCurrency ?? 'AED' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    if (!form.legalName.trim() || !form.displayName.trim()) return setMessage({ kind: 'error', text: 'Legal name and display name are required.' })
    if (!/^[A-Za-z]{2}$/.test(form.countryCode) || !/^[A-Za-z]{3}$/.test(form.defaultCurrency)) return setMessage({ kind: 'error', text: 'Country must be a 2-letter ISO-3166 code and currency a 3-letter ISO-4217 code.' })
    const body = { ...form, legalName: form.legalName.trim(), displayName: form.displayName.trim(), countryCode: form.countryCode.toUpperCase(), defaultCurrency: form.defaultCurrency.toUpperCase() }
    setSaving(true)
    try {
      if (supplier) { const saved = await updateSupplier(supplier.id, body); setMessage({ kind: 'ok', text: 'Supplier saved.' }); onSaved?.(saved) }
      else { const created = await createSupplier({ ...body, contactMetadata: {} }); router.push(`/suppliers/${created.id}`) }
    } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the supplier') }) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 4, maxWidth: 720, padding: 22, marginTop: supplier ? 16 : 0 }} aria-label="Supplier form">
      <FormField label="Supplier type"><select value={form.type} onChange={(e) => set('type', e.target.value)} disabled={!canManage}>{TYPES.map((type) => <option key={type} value={type}>{type.split('_').join(' ')}</option>)}</select></FormField>
      <FormField label="Status"><select value={form.status} onChange={(e) => set('status', e.target.value)} disabled={!canManage}>{STATUSES.map((status) => <option key={status} value={status}>{status.split('_').join(' ')}</option>)}</select></FormField>
      <FormField label="Legal name"><input value={form.legalName} onChange={(e) => set('legalName', e.target.value)} disabled={!canManage} required /></FormField>
      <FormField label="Display name"><input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} disabled={!canManage} required /></FormField>
      <FormField label="Country (ISO-3166 alpha-2)"><input value={form.countryCode} onChange={(e) => set('countryCode', e.target.value.toUpperCase())} disabled={!canManage} maxLength={2} required /></FormField>
      <FormField label="Default currency (ISO-4217)"><input value={form.defaultCurrency} onChange={(e) => set('defaultCurrency', e.target.value.toUpperCase())} disabled={!canManage} maxLength={3} required /></FormField>
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#bc5652' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
      {canManage ? <button type="submit" className="admin-btn admin-btn-primary" disabled={saving}>{saving ? 'Saving…' : supplier ? 'Save supplier' : 'Create supplier'}</button> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to suppliers.</p>}
    </form>
  )
}
