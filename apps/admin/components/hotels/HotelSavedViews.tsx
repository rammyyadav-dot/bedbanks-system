'use client'

import { useEffect, useState } from 'react'
import { HOTEL_VIEW_NAME_MAX, deleteHotelView, loadHotelViews, saveHotelView, type HotelView, type ViewStorage } from '@/lib/hotel-views'
import type { ListFilterKey } from '@/lib/hotel-ui'

type Filters = Partial<Record<ListFilterKey, string>>

function browserStorage(): ViewStorage | null { try { return window.localStorage } catch { return null } }

/** Personal, this-browser filter presets for the Hotels list. Choosing one only changes the URL filters; the API still authorizes the query. */
export function HotelSavedViews({ filters, onApply }: { filters: Filters; onApply: (filters: Filters) => void }) {
  const [views, setViews] = useState<HotelView[]>([])
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => setViews(loadHotelViews(browserStorage())), [])

  const save = () => {
    const result = saveHotelView(browserStorage(), name, filters)
    if (result.ok) { setViews(result.views); setSelected(name.trim().slice(0, HOTEL_VIEW_NAME_MAX)); setName(''); setNote('View saved in this browser.') } else setNote(result.reason)
  }
  const remove = () => {
    const result = deleteHotelView(browserStorage(), selected)
    if (result.ok) { setViews(result.views); setSelected(''); setNote('View deleted.') } else setNote(result.reason)
  }
  return (
    <section aria-label="Saved views" data-testid="hotel-saved-views" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end', margin: '0 0 12px', fontSize: 11 }}>
      <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}><span>Saved views (this browser)</span>
        <select value={selected} onChange={(e) => { const v = views.find((x) => x.name === e.target.value); setSelected(e.target.value); setNote(null); if (v) onApply(v.filters) }} style={{ minWidth: 160 }}>
          <option value="">{views.length ? 'Choose a view' : 'No saved views'}</option>{views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select></label>
      {selected && <button type="button" className="admin-btn" onClick={remove}>Delete view</button>}
      <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}><span>Save current filters as</span>
        <input value={name} maxLength={HOTEL_VIEW_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="View name" /></label>
      <button type="button" className="admin-btn" onClick={save}>Save view</button>
      {note && <span role="status">{note}</span>}
    </section>
  )
}
