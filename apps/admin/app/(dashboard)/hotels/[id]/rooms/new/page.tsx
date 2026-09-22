'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { AdminLoadingState, AdminServiceUnavailable, AccessDenied, AuthRequired } from '@/components/auth/AuthorizationStates'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'

type Hotel = { id: string; name: string }
export default function NewRoomPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [hotel, setHotel] = useState<Hotel | null>(null)
  const [state, setState] = useState<'loading'|'ready'|'error'|'auth'|'forbidden'>('loading')
  const [form, setForm] = useState({ name: '', code: '', maxAdults: '2', maxChildren: '0', maxOccupancy: '2', bedding: '', isActive: true })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { let active=true; apiRequest<Hotel>(`/supply/hotels/${id}`).then(v=>{if(active){setHotel(v);setState('ready')}}).catch(e=>{if(!active)return;if(e instanceof ApiResponseError&&e.status===401)setState('auth');else if(e instanceof ApiResponseError&&[403,404].includes(e.status))setState('forbidden');else setState('error')});return()=>{active=false}},[id])
  async function submit(event: FormEvent) { event.preventDefault(); setError(''); setSaving(true); try { const room=await apiRequest<{id:string}>(`/supply/hotels/${id}/rooms`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.name,code:form.code,maxAdults:Number(form.maxAdults),maxChildren:Number(form.maxChildren),maxOccupancy:Number(form.maxOccupancy),beddingMetadata:form.bedding?{description:form.bedding}:{},isActive:form.isActive})});router.push(`/hotels/${id}/rooms/${room.id}`) } catch(cause){setError(cause instanceof ApiResponseError?cause.message:'Could not create room.')} finally{setSaving(false)}}
  if(state==='loading')return <div className="admin-page"><AdminLoadingState /></div>
  if(state==='auth')return <div className="admin-page"><AuthRequired /></div>
  if(state==='forbidden')return <div className="admin-page"><AccessDenied permission="supply.rooms.manage" /></div>
  if(state==='error')return <div className="admin-page"><AdminServiceUnavailable onRetry={()=>window.location.reload()} /></div>
  return <div className="admin-page"><PageHeader eyebrow="HOTEL SUPPLY · ROOMS" title="Add room" description={`Create an authoritative room type for ${hotel?.name ?? 'hotel'}.`} /><form onSubmit={submit} className="workspace-panel" style={{display:'grid',gap:14,maxWidth:720,padding:22}}><label>ROOM NAME<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} className="input-wrap" /></label><label>ROOM CODE<input required value={form.code} onChange={e=>setForm({...form,code:e.target.value})} className="input-wrap" /></label><label>MAX ADULTS<input type="number" min="1" required value={form.maxAdults} onChange={e=>setForm({...form,maxAdults:e.target.value})} className="input-wrap" /></label><label>MAX CHILDREN<input type="number" min="0" required value={form.maxChildren} onChange={e=>setForm({...form,maxChildren:e.target.value})} className="input-wrap" /></label><label>MAX OCCUPANCY<input type="number" min="1" required value={form.maxOccupancy} onChange={e=>setForm({...form,maxOccupancy:e.target.value})} className="input-wrap" /></label><label>BEDDING<input value={form.bedding} onChange={e=>setForm({...form,bedding:e.target.value})} className="input-wrap" /></label><label><input type="checkbox" checked={form.isActive} onChange={e=>setForm({...form,isActive:e.target.checked})} /> Active</label>{error&&<p role="alert" style={{color:'#b42318'}}>{error}</p>}<button disabled={saving} className="button primary" type="submit">{saving?'Creating…':'Create room'}</button></form></div>
}
