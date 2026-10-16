'use client'

import { useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import type { SearchCriteria } from '@bedbanks/domain'
import { criteriaFilters, minorToMajorInput } from '@/lib/search-filters'
import { filterCount, sameFilters } from '@/lib/listing'

type Filters = NonNullable<SearchCriteria['filters']>

/**
 * Bedbank-style results sidebar. Every filter is applied by the server before pagination, so totals and pages stay exact:
 * the sidebar keeps a local draft and only "Apply filters" runs a new search. Editing the draft never clears the results on screen.
 */
export function ResultFilters({ applied, currency, boards, propertyTypeOptions, searching, onApply }: {
  applied: Filters | undefined
  currency: string
  boards: { id: string; name: string }[]
  propertyTypeOptions: string[]
  searching: boolean
  onApply: (filters: Filters) => void
}) {
  const [open, setOpen] = useState(false)
  const [starRatings, setStarRatings] = useState<number[]>(applied?.starRatings ?? [])
  const [refundableOnly, setRefundableOnly] = useState(Boolean(applied?.refundableOnly))
  const [boardBasisIds, setBoardBasisIds] = useState<string[]>(applied?.boardBasisIds ?? [])
  const [propertyTypes, setPropertyTypes] = useState<string[]>(applied?.propertyTypes ?? [])
  const [minPrice, setMinPrice] = useState(minorToMajorInput(applied?.minPriceMinor, currency))
  const [maxPrice, setMaxPrice] = useState(minorToMajorInput(applied?.maxPriceMinor, currency))
  const parsed = criteriaFilters({ starRatings, refundableOnly, minPrice, maxPrice, currency, boardBasisIds, propertyTypes })
  const drafted = parsed.ok ? parsed.filters : undefined
  const pending = parsed.ok && !sameFilters(drafted, applied)
  const appliedCount = filterCount(applied)
  const toggle = <T,>(current: T[], value: T, set: (next: T[]) => void) => set(current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  const apply = () => { if (parsed.ok && !searching) { onApply(parsed.filters ?? {}); setOpen(false) } }
  const clear = () => {
    setStarRatings([]); setRefundableOnly(false); setBoardBasisIds([]); setPropertyTypes([]); setMinPrice(''); setMaxPrice('')
    if (appliedCount > 0 && !searching) { onApply({}); setOpen(false) }
  }
  return <>
    <button type="button" className="bb-filter-toggle portal-secondary" aria-expanded={open} aria-controls="bb-result-filters" onClick={() => setOpen((value) => !value)}>
      <SlidersHorizontal size={15} /> Filters{appliedCount ? ` (${appliedCount})` : ''}
    </button>
    <aside id="bb-result-filters" className={`bb-filters${open ? ' is-open' : ''}`} aria-label="Filter results">
      <div className="bb-filters-head">
        <h2>Filter results</h2>
        {appliedCount > 0 || pending ? <button type="button" className="portal-link" onClick={clear} disabled={searching}>Clear all</button> : null}
        <button type="button" className="bb-filters-close" aria-label="Close filters" onClick={() => setOpen(false)}><X size={16} /></button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); apply() }}>
        <fieldset className="bb-filter-group">
          <legend>Total stay price ({currency})</legend>
          <div className="bb-price-range">
            <label><span>Min</span><input inputMode="decimal" value={minPrice} placeholder="0" aria-label={`Minimum total stay in ${currency}`} onChange={(event) => setMinPrice(event.target.value)} /></label>
            <span aria-hidden="true">–</span>
            <label><span>Max</span><input inputMode="decimal" value={maxPrice} placeholder="Any" aria-label={`Maximum total stay in ${currency}`} onChange={(event) => setMaxPrice(event.target.value)} /></label>
          </div>
          {!parsed.ok && <p className="portal-field-error" role="alert">{parsed.reason}</p>}
        </fieldset>
        <fieldset className="bb-filter-group">
          <legend>Star rating</legend>
          {[5, 4, 3, 2, 1].map((star) => <label key={star} className="bb-check"><input type="checkbox" checked={starRatings.includes(star)} onChange={() => toggle(starRatings, star, setStarRatings)} /><span className="market-stars" aria-label={`${star} star${star === 1 ? '' : 's'}`}>{'★'.repeat(star)}<span aria-hidden="true">{'☆'.repeat(5 - star)}</span></span></label>)}
        </fieldset>
        {boards.length > 0 && <fieldset className="bb-filter-group">
          <legend>Meal plan</legend>
          {boards.map((board) => <label key={board.id} className="bb-check"><input type="checkbox" checked={boardBasisIds.includes(board.id)} onChange={() => toggle(boardBasisIds, board.id, setBoardBasisIds)} />{board.name}</label>)}
        </fieldset>}
        <fieldset className="bb-filter-group">
          <legend>Cancellation</legend>
          <label className="bb-check"><input type="checkbox" checked={refundableOnly} onChange={(event) => setRefundableOnly(event.target.checked)} />Refundable rates only</label>
        </fieldset>
        {propertyTypeOptions.length > 0 && <fieldset className="bb-filter-group">
          <legend>Property type</legend>
          {propertyTypeOptions.map((type) => <label key={type} className="bb-check"><input type="checkbox" checked={propertyTypes.includes(type)} onChange={() => toggle(propertyTypes, type, setPropertyTypes)} />{type}</label>)}
        </fieldset>}
        <div className="bb-filters-actions">
          <button type="submit" className="portal-primary" disabled={!pending || searching} aria-busy={searching}>{searching ? 'Updating results…' : 'Apply filters'}</button>
          {pending && <p role="status">Filters changed. Apply to update the results.</p>}
        </div>
      </form>
    </aside>
  </>
}
