'use client'

import { FormEvent, useState } from 'react'
import type { HotelMappingSuggestion, HotelMappingSuggestions } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'
import { reasonLabel, suggestionPath, suggestionView, TIER_LABEL, type SuggestionView } from '@/lib/hotel-mapping-suggestions-ui'

type Props = {
  /** Called when staff pick a suggestion. The page only fills its form; nothing is created or approved here. */
  onUse: (suggestion: HotelMappingSuggestion) => void
}

/** Advisory lookup of canonical hotels for a supplier hotel being mapped. Read-only: a person still creates the pending mapping. */
export function HotelSuggestionPanel({ onUse }: Props) {
  const [form, setForm] = useState({ name: '', address: '', city: '', countryCode: '' })
  const [view, setView] = useState<SuggestionView | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function search(event: FormEvent) {
    event.preventDefault()
    const path = suggestionPath(form)
    if (!path) { setMessage('Enter the supplier hotel name (at least two characters).'); return }
    setLoading(true); setMessage(''); setView(null)
    try {
      setView(suggestionView(await apiRequest<HotelMappingSuggestions>(path)))
    } catch (error) {
      setMessage(error instanceof ApiResponseError ? error.message : 'Suggestions are unavailable right now.')
    } finally { setLoading(false) }
  }

  return <div style={{ borderBottom: '1px solid var(--c-e5e7eb)', paddingBottom: 16, marginBottom: 16 }}>
    <h3>Find the canonical hotel</h3>
    <p>Describe the supplier&apos;s hotel and we will suggest matching hotels from your catalogue. Suggestions are advisory; you still create a pending mapping that a second person approves.</p>
    <form onSubmit={search} style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
      <label>Supplier hotel name<input className="input-wrap" required minLength={2} maxLength={200} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Address (optional)<input className="input-wrap" maxLength={200} value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} /></label>
      <label>City (optional)<input className="input-wrap" maxLength={200} value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label>
      <label>Country code (optional, e.g. AE)<input className="input-wrap" maxLength={2} pattern="[A-Za-z]{2}" value={form.countryCode} onChange={event => setForm({ ...form, countryCode: event.target.value })} /></label>
      <button className="button" disabled={loading}>{loading ? 'Searching…' : 'Suggest matches'}</button>
    </form>
    <div role="status" aria-live="polite">
      {message && <p>{message}</p>}
      {view?.kind === 'index-empty' && <p>The hotel search index has not been built for this tenant yet, so no suggestions can be made. Ask an operator to run the hotel search reindex, or choose the hotel manually below.</p>}
      {view?.kind === 'none' && <p>No close match in your catalogue. Choose the hotel manually below, or create the hotel first.</p>}
    </div>
    {view?.kind === 'matches' && <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
      {view.suggestions.map(item => <li key={item.hotelId} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', borderTop: '1px solid var(--c-e5e7eb)', padding: '12px 0' }}>
        <div>
          <strong>{item.name}</strong> · {item.city}, {item.countryCode}
          <div style={{ fontWeight: 600 }}>{TIER_LABEL[item.tier]} · score {item.confidence}/100</div>
          {item.reasons.length > 0 && <div style={{ fontSize: 13 }}>{item.reasons.map(reasonLabel).join(' · ')}</div>}
        </div>
        <button type="button" className="button" onClick={() => onUse(item)} aria-label={`Use ${item.name}`}>Use this hotel</button>
      </li>)}
    </ul>}
  </div>
}
