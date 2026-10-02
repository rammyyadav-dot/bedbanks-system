'use client'

import { useState } from 'react'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { describeApiError } from '@/lib/api/describe-error'
import { ApiResponseError } from '@/lib/api/errors'
import { useCan } from '@/lib/auth/capabilities'
import { IssuePanel, ReadinessGates } from '../ui'

/** Readiness gates and issues come from the API. The master-data form below edits the entity (not commercial readiness) through the existing supply endpoint. */
export function OverviewPanel({ data, onChanged }: { data: HotelCommercial360; onChanged: () => void }) {
  const can = useCan()
  const [name, setName] = useState(data.hotel.name)
  const [contentStatus, setContentStatus] = useState(data.hotel.contentStatus)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; requestId?: string | null } | null>(null)
  const dirty = name.trim() !== data.hotel.name || contentStatus !== data.hotel.contentStatus

  async function save() {
    if (saving || !dirty || !name.trim()) return
    setSaving(true); setMessage(null)
    try {
      await apiRequest(`/supply/hotels/${data.hotel.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), contentStatus }) })
      setMessage({ kind: 'ok', text: 'Hotel master data saved. Readiness has been recalculated.' }); onChanged()
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'save the hotel'), requestId: error instanceof ApiResponseError ? error.requestId : null })
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }}><ReadinessGates gates={data.gates} hotelId={data.hotel.id} /></div>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Commercial issues</h2>
        <IssuePanel issues={data.issues} hotelId={data.hotel.id} />
      </div>
      <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }} onSubmit={(event) => { event.preventDefault(); void save() }} aria-label="Hotel master data">
        <h2 style={{ fontSize: 14, margin: 0 }}>Hotel master data</h2>
        <p style={{ color: '#3f565c', fontSize: 12, margin: 0 }}>This is the hotel record, not its commercial readiness. Only COMPLETE hotels with a 1-5 star rating are offered to Agents.</p>
        <label>Hotel name<input value={name} onChange={(event) => setName(event.target.value)} className="input-wrap" maxLength={160} /></label>
        <label>Content status<select aria-label="Content status" value={contentStatus} onChange={(event) => setContentStatus(event.target.value)} className="input-wrap">{['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED'].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
        <p style={{ color: '#3f565c', fontSize: 12, margin: 0 }}>{data.hotel.address || 'No address recorded'} · {data.hotel.timeZone} · updated {new Date(data.hotel.updatedAt).toLocaleString()}</p>
        {can('supply.hotels.manage') && <button type="submit" className="button primary" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save changes'}</button>}
        {message && <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ margin: 0, color: message.kind === 'error' ? '#a11d1d' : '#0b6b55' }}>{message.text}{message.requestId ? ` Request id: ${message.requestId}` : ''}</p>}
      </form>
    </div>
  )
}
