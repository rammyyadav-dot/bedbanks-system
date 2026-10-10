'use client'

import { amenityGroup } from '@/lib/hotel-amenity-groups'
import { AMENITY_CATALOGUE, AMENITY_FEE_TYPES, type AmenityFeeType, type AmenityScope, type AmenitySelection } from '@bedbanks/contracts'

const FEE_LABEL: Record<AmenityFeeType, string> = { FREE: 'Free', PAID: 'Paid', UNKNOWN: 'Not known' }

/** Controlled amenity selection. A box that is not ticked means "not recorded", not "absent"; "Not known" is an explicit answer. */
export function AmenityPicker({ scope, value, onChange, readOnly, idPrefix }: { scope: 'HOTEL' | 'ROOM'; value: AmenitySelection[]; onChange: (next: AmenitySelection[]) => void; readOnly?: boolean; idPrefix: string }) {
  const entries = AMENITY_CATALOGUE.filter((a) => a.scope === 'BOTH' || (a.scope as AmenityScope) === scope)
  const by = new Map(value.map((v) => [v.code, v.feeType]))
  return (
    <div role="group" aria-label={`${scope === 'HOTEL' ? 'Hotel' : 'Room'} amenities`} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
      {Array.from(new Set(entries.map(a => amenityGroup(a.code)))).map(group => <fieldset key={group} style={{ border: '1px solid #d7e1e4', minWidth: 0, margin: 0, padding: 10 }}><legend>{group}</legend>
      {entries.filter(a => amenityGroup(a.code) === group).map((a) => {
        const fee = by.get(a.code)
        const id = `${idPrefix}-${a.code}`
        return (
          <div key={a.code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }} data-amenity={a.code}>
            <input id={id} type="checkbox" checked={fee !== undefined} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? [...value, { code: a.code, feeType: 'UNKNOWN' }] : value.filter((v) => v.code !== a.code))} />
            <label htmlFor={id} style={{ flex: 1 }}>{a.label}</label>
            {fee !== undefined && (
              <select aria-label={`${a.label} fee`} value={fee} disabled={readOnly} onChange={(e) => onChange(value.map((v) => (v.code === a.code ? { ...v, feeType: e.target.value as AmenityFeeType } : v)))}>
                {AMENITY_FEE_TYPES.map((f) => <option key={f} value={f}>{FEE_LABEL[f]}</option>)}
              </select>
            )}
          </div>
        )
      })}</fieldset>)}
    </div>
  )
}

export const sameAmenities = (a: AmenitySelection[], b: AmenitySelection[]) => JSON.stringify([...a].sort((x, y) => x.code.localeCompare(y.code))) === JSON.stringify([...b].sort((x, y) => x.code.localeCompare(y.code)))
export const amenityLabel = (code: string) => AMENITY_CATALOGUE.find((a) => a.code === code)?.label ?? code
