'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'

export default function NewHotelPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', propertyType: 'HOTEL', starRating: '5', address: '', city: '', countryCode: '', timeZone: 'Asia/Dubai', externalRef: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  function update(key: keyof typeof form, value: string) { setForm((current) => ({ ...current, [key]: value })) }
  async function submit(event: FormEvent) { event.preventDefault(); setError(''); setSaving(true); try { const hotel = await apiRequest<{ id: string }>('/supply/hotels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, starRating: Number(form.starRating), externalRef: form.externalRef || null }) }); router.push(`/hotels/${hotel.id}`) } catch (cause) { setError(cause instanceof ApiResponseError ? cause.message : 'Could not create hotel.') } finally { setSaving(false) } }
  return <div className="admin-page"><PageHeader eyebrow="HOTEL SUPPLY · HOTELS" title="Add hotel" description="Create a tenant-scoped authoritative hotel record." /><form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 14, maxWidth: 720, padding: 22 }}>{(['name', 'propertyType', 'address', 'city', 'countryCode', 'timeZone', 'externalRef'] as const).map((key) => <label key={key}>{key.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}<input required={['name', 'propertyType', 'city', 'countryCode'].includes(key)} value={form[key]} onChange={(event) => update(key, event.target.value)} className="input-wrap" /></label>)}<label>STAR RATING<input required type="number" min="1" max="5" value={form.starRating} onChange={(event) => update('starRating', event.target.value)} className="input-wrap" /></label>{error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}<button disabled={saving} className="button primary" type="submit">{saving ? 'Creating…' : 'Create hotel'}</button></form></div>
}
