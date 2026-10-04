'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'
import { hotelHref } from '@/lib/hotel-ui'

export default function NewHotelPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', propertyType: 'HOTEL', starRating: '', address: '', city: '', countryCode: '', timeZone: 'Asia/Dubai', externalRef: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  function update(key: keyof typeof form, value: string) { setForm((current) => ({ ...current, [key]: value })) }
  async function submit(event: FormEvent) { event.preventDefault(); setError(''); setSaving(true); try { const hotel = await apiRequest<{ id: string }>('/supply/hotels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name, propertyType: form.propertyType, address: form.address || null, city: form.city, countryCode: form.countryCode, timeZone: form.timeZone, ...(form.starRating ? { starRating: Number(form.starRating) } : {}), contentStatus: 'DRAFT', externalRef: form.externalRef || null }) }); router.push(hotelHref(hotel.id, 'setup')) } catch (cause) { setError(cause instanceof ApiResponseError ? cause.message : 'Could not create hotel.') } finally { setSaving(false) } }
  return <div className="admin-page"><PageHeader eyebrow="HOTEL SUPPLY · HOTELS" title="Add hotel" description="Create a tenant-scoped authoritative hotel record." /><form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 14, maxWidth: 720, padding: 22 }}>{(['name', 'propertyType', 'address', 'city', 'countryCode', 'timeZone', 'externalRef'] as const).map((key) => <label key={key}>{key.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}<input required={['name', 'propertyType', 'city', 'countryCode'].includes(key)} value={form[key]} onChange={(event) => update(key, event.target.value)} className="input-wrap" /></label>)}<div style={{ color: '#698088', fontSize: 12 }} data-testid="new-hotel-steps"><p style={{ margin: '0 0 4px' }}>New hotels are created as DRAFT and open on the Hotel Setup tab. Then:</p><ol style={{ margin: 0, paddingLeft: 18 }}><li>Complete Hotel Setup (details, verified star category, descriptions, times, a reservations contact).</li><li>Add at least one active room, then amenities and images.</li><li>Request publication: a second person must approve it. Publication checks explicit requirements and enables nothing transactional.</li></ol></div><label>STAR RATING (optional; verify it in Hotel Setup)<input type="number" min="1" max="5" value={form.starRating} onChange={(event) => update('starRating', event.target.value)} className="input-wrap" /></label>{error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}<button disabled={saving} className="button primary" type="submit">{saving ? 'Creating…' : 'Create hotel'}</button></form></div>
}
