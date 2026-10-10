'use client'

import { useId } from 'react'
import { getHotelLocationOptions } from '@/lib/data/hotel-setup'
import { useOpsQuery } from '@/components/ops/useOpsQuery'

/** Canonical tenant suggestions with explicit free entry for a new destination; no invented geographic registry. */
export function HotelLocationFields({ countryCode, city, timeZone, onChange, readOnly = false }: { countryCode: string; city: string; timeZone: string; onChange: (key: 'countryCode' | 'city' | 'timeZone', value: string) => void; readOnly?: boolean }) {
  const id = useId()
  const options = useOpsQuery(() => getHotelLocationOptions(countryCode), [countryCode])
  const countries = options.state.status === 'ready' ? options.state.data.countries : []
  const cities = options.state.status === 'ready' ? options.state.data.cities : []
  const label = { display: 'grid', gap: 4, fontSize: 12 } as const
  return <>
    <label style={label}>Country (ISO-2)<input className="input-wrap" list={`${id}-countries`} value={countryCode} onChange={e => onChange('countryCode', e.target.value.toUpperCase())} maxLength={2} pattern="[A-Z]{2}" required readOnly={readOnly} autoComplete="country" aria-describedby={`${id}-help`} /></label>
    <datalist id={`${id}-countries`}>{countries.map(c => <option key={c} value={c} />)}</datalist>
    <label style={label}>City / destination<input className="input-wrap" list={`${id}-cities`} value={city} onChange={e => onChange('city', e.target.value)} maxLength={120} required readOnly={readOnly} autoComplete="address-level2" aria-describedby={`${id}-help`} /></label>
    <datalist id={`${id}-cities`}>{cities.map(c => <option key={c} value={c} />)}</datalist>
    <label style={label}>IANA time zone<input className="input-wrap" list={`${id}-zones`} value={timeZone} onChange={e => onChange('timeZone', e.target.value)} maxLength={64} required readOnly={readOnly} placeholder="Choose the hotel's local time zone" /></label>
    <datalist id={`${id}-zones`}><option value="UTC" />{(Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone').map(z => <option key={z} value={z} />)}</datalist>
    <p id={`${id}-help`} style={{ fontSize: 12, color: '#3f565c', gridColumn: '1 / -1', margin: 0 }}>
      Suggestions come from this tenant's saved hotels. Enter a new city explicitly when needed.
      {options.state.status === 'loading' && ' Loading suggestions…'}
      {options.state.status === 'failed' && <> Suggestions could not be loaded. Existing values remain editable. <button type="button" className="admin-btn" onClick={options.reload}>Retry suggestions</button></>}
      {options.state.status === 'ready' && options.state.data.capped && ' Suggestions are capped; type the destination if it is not listed.'}
    </p>
  </>
}
