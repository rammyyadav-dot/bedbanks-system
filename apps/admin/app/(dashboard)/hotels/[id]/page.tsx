'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/status/StatusBadge'
import { AdminLoadingState, AdminServiceUnavailable, AccessDenied, AuthRequired } from '@/components/auth/AuthorizationStates'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'

type Hotel = { id: string; name: string; propertyType: string; starRating: number | null; address: string | null; city: string; countryCode: string; timeZone: string; contentStatus: string; externalRef: string | null; updatedAt: string; roomTypes?: { id: string; name: string; code: string; maxOccupancy: number }[] }
function status(value: string) { return value.toLowerCase() === 'published' ? 'active' : value.toLowerCase() === 'suspended' ? 'suspended' : value.toLowerCase() === 'archived' ? 'inactive' : 'pending' }

export default function HotelDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [hotel, setHotel] = useState<Hotel | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'auth' | 'forbidden'>('loading')
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => { let active = true; apiRequest<Hotel>(`/supply/hotels/${id}`).then((data) => { if (active) { setHotel(data); setName(data.name); setState('ready') } }).catch((error) => { if (!active) return; if (error instanceof ApiResponseError && error.status === 401) setState('auth'); else if (error instanceof ApiResponseError && [403, 404].includes(error.status)) setState('forbidden'); else setState('error') }); return () => { active = false } }, [id])
  async function save() { if (!hotel) return; setSaving(true); try { const updated = await apiRequest<Hotel>(`/supply/hotels/${hotel.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); setHotel(updated) } finally { setSaving(false) } }
  return <div className="admin-page">{state === 'loading' && <AdminLoadingState />}{state === 'auth' && <AuthRequired />}{state === 'forbidden' && <AccessDenied permission="supply.hotels.read" />}{state === 'error' && <AdminServiceUnavailable onRetry={() => window.location.reload()} />}{state === 'ready' && hotel && <><PageHeader eyebrow={`HOTEL · ${hotel.id}`} title={hotel.name} description={`${hotel.city}, ${hotel.countryCode} · ${hotel.propertyType}`} actions={<StatusBadge status={status(hotel.contentStatus)} />} /><div className="workspace-panel" style={{ display: 'grid', gap: 14, padding: 22, maxWidth: 720 }}><label>HOTEL NAME<input value={name} onChange={(event) => setName(event.target.value)} className="input-wrap" /></label><p style={{ color: '#698088', fontSize: 12 }}>{hotel.address || 'No address recorded'} · {hotel.timeZone}</p><p style={{ color: '#698088', fontSize: 12 }}>Last updated {new Date(hotel.updatedAt).toLocaleString()}</p><button type="button" className="button primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button></div><div className="workspace-panel" style={{ marginTop: 16, padding: 22 }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2>Room types</h2><Link href={`/hotels/${hotel.id}/rooms/new`} className="button primary">+ Add room</Link></div>{hotel.roomTypes?.length ? hotel.roomTypes.map((room) => <p key={room.id}><Link href={`/hotels/${hotel.id}/rooms/${room.id}`}>{room.name}</Link> · {room.code} · max {room.maxOccupancy}</p>) : <p style={{ color: '#698088' }}>No active room types.</p>}</div></>}</div>
}
