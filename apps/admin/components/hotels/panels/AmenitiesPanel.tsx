'use client'

import { useMemo, useRef, useState } from 'react'
import type { AmenitySelection, HotelAmenitiesView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { getHotelAmenities, saveHotelAmenities } from '@/lib/data/hotel-rooms'
import { AmenityPicker, sameAmenities } from '../AmenityPicker'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const

/** Hotel-level amenities from the controlled catalogue. Room amenities are edited with each room. */
export function AmenitiesPanel({ hotelId, onChanged }: { hotelId: string; onChanged: () => void }) {
  const [version, setVersion] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const { state, reload } = useOpsQuery(() => getHotelAmenities(hotelId), [hotelId, version])
  return (
    <OpsState state={state} onRetry={reload}>
      {(view) => (
        <>
          {flash && <div role="status" data-testid="amenities-flash" className="workspace-panel" style={{ padding: 12, marginBottom: 12 }}><strong>{flash}</strong></div>}
          <AmenitiesForm key={`${view.hotelId}:${view.concurrencyToken}`} hotelId={hotelId} view={view} onSaved={(t) => { setFlash(t); setVersion((v) => v + 1); onChanged() }} />
        </>
      )}
    </OpsState>
  )
}

function AmenitiesForm({ hotelId, view, onSaved }: { hotelId: string; view: HotelAmenitiesView; onSaved: (text: string) => void }) {
  const can = useCan()
  const canManage = can('supply.hotels.manage')
  const [value, setValue] = useState<AmenitySelection[]>(view.hotel)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const key = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[]; requestId: string | null } | null>(null)
  const dirty = useMemo(() => !sameAmenities(value, view.hotel), [value, view.hotel])
  async function save() {
    if (inFlight.current || !dirty) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const { data } = await saveHotelAmenities(hotelId, { idempotencyKey: key.current, expectedToken: view.concurrencyToken, amenities: value })
      key.current = null; onSaved(`Amenities saved (${data.amenities.hotel.length} recorded). Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (e) { const p = apiErrorParts(e, 'save the amenities'); setError({ message: p.message, details: p.details, requestId: p.requestId }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Hotel amenities" data-testid="amenities-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Hotel amenities</h2>
      <p style={note}>Choose from the controlled catalogue and say whether each is free, paid or not known. An amenity that is not ticked is not recorded; it is not a statement that the hotel lacks it. Room amenities are edited on each room in the Rooms tab.</p>
      <AmenityPicker scope="HOTEL" idPrefix="hotel" value={value} onChange={(v) => { key.current = null; setValue(v) }} readOnly={!canManage} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {canManage ? <button type="submit" className="button primary" disabled={busy || !dirty} data-testid="amenities-save">{busy ? 'Saving…' : 'Save amenities'}</button> : <span style={note}>You can view these amenities but not change them.</span>}
        {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={() => setValue(view.hotel)}>Discard edits</button>}
      </div>
      {error && <div role="alert" data-testid="amenities-error" className="admin-error" style={{ padding: 12 }}><strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}{error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}</div>}
    </form>
  )
}
