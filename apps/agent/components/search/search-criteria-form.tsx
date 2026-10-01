'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Minus, Plus, Search } from 'lucide-react'
import { marketplaceHome } from '@/lib/marketplace-content'
import { destinationSuggestions } from '@/lib/destination-suggestions'
import { criteriaFilters } from '@/lib/search-filters'
import { GUEST_MARKETS, guestMarketName } from '@/lib/guest-market'
import { clampCount, MAX_OCCUPANTS, MAX_ROOMS, occupancySummary, resolvedChildAges, type DraftChildAge } from '@/lib/occupancy'
import { formatCompactStay, weekdayShort } from '@/lib/format'
import { addUtcDays, applyStayPick, monthGrid, monthLabel, nightCount, shiftMonth, utcToday } from '@/lib/stay-calendar'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function SearchCriteriaForm({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPriceAed, setMinPriceAed, maxPriceAed, setMaxPriceAed,
  searching, searchFailed = false, onSubmit, onChange, destinationInvalid = false,
}: {
  destination: string
  setDestination: (value: string) => void
  checkIn: string
  setCheckIn: (value: string) => void
  checkOut: string
  setCheckOut: (value: string) => void
  rooms: number
  setRooms: (value: number) => void
  adults: number
  setAdults: (value: number) => void
  children: number
  updateChildren: (value: number) => void
  childAges: DraftChildAge[]
  setChildAges: (value: DraftChildAge[]) => void
  nationality: string
  setNationality: (value: string) => void
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPriceAed: string
  setMinPriceAed: (value: string) => void
  maxPriceAed: string
  setMaxPriceAed: (value: string) => void
  searching: boolean
  searchFailed?: boolean
  onSubmit: () => void
  onChange: (action: () => void) => void
  destinationInvalid?: boolean
}) {
  const [advanced, setAdvanced] = useState(false)
  const [formError, setFormError] = useState('')
  const submitLabel = searching ? marketplaceHome.searchingCta : searchFailed ? marketplaceHome.retryCta : marketplaceHome.searchCta
  const nights = nightCount(checkIn, checkOut)
  const change = (action: () => void) => { setFormError(''); onChange(action) }
  const submit = () => {
    const parsed = criteriaFilters({ starRatings, refundableOnly, minPriceAed, maxPriceAed })
    if (!destination.trim()) return setFormError('Enter a destination.')
    if (!parsed.ok) return setFormError(parsed.reason)
    if (!resolvedChildAges(children, childAges)) return setFormError('Choose an age for each child.')
    if (nights === null || nights > 30) return setFormError('Choose a stay of 1 to 30 nights.')
    setFormError('')
    onSubmit()
  }
  return (
    <section className="market-search" id="hotel-search" aria-label="Hotel search">
      <div className="market-search-row">
        <DestinationField destination={destination} invalid={destinationInvalid || Boolean(formError && !destination.trim())} onChange={(value) => change(() => setDestination(value))} />
        <StayField checkIn={checkIn} checkOut={checkOut} nights={nights} onChange={(next) => change(() => { setCheckIn(next.checkIn); setCheckOut(next.checkOut) })} />
        <OccupancyField rooms={rooms} adults={adults} children={children} childAges={childAges} onChange={(next) => change(() => {
          setRooms(next.rooms)
          setAdults(next.adults)
          if (next.children !== children) updateChildren(next.children)
          else setChildAges(next.childAges)
        })} />
        <NationalityField nationality={nationality} onChange={(value) => change(() => setNationality(value))} />
        <button className="portal-primary market-search-cta" type="button" onClick={submit} disabled={searching}><Search size={16} /> {submitLabel}</button>
      </div>
      <div className="market-search-tools">
        <button type="button" className="portal-link" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>+ {marketplaceHome.advancedLabel}</button>
        <p><span>{marketplaceHome.currencyLabel}</span> <strong>{marketplaceHome.currencyCode}</strong></p>
      </div>
      {formError && <p className="portal-field-error" role="alert">{formError}</p>}
      <p className="trade-search-note">{marketplaceHome.currencyNote} {marketplaceHome.nationalityHelper} {marketplaceHome.residencyNote} A search total is not confirmed availability.</p>
      {advanced && <AdvancedFields starRatings={starRatings} setStarRatings={(value) => change(() => setStarRatings(value))} refundableOnly={refundableOnly} setRefundableOnly={(value) => change(() => setRefundableOnly(value))} minPriceAed={minPriceAed} setMinPriceAed={(value) => change(() => setMinPriceAed(value))} maxPriceAed={maxPriceAed} setMaxPriceAed={(value) => change(() => setMaxPriceAed(value))} onClear={() => change(() => { setStarRatings([]); setRefundableOnly(false); setMinPriceAed(''); setMaxPriceAed('') })} />}
    </section>
  )
}

function DestinationField({ destination, invalid, onChange }: { destination: string; invalid: boolean; onChange: (value: string) => void }) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const suggestions = destinationSuggestions(destination)
  useDismiss(box, () => setOpen(false))
  return (
    <div className="market-field" ref={box}>
      <span>Destination</span>
      <div className={invalid ? 'has-error' : ''}>
        <MapPin size={16} aria-hidden="true" />
        <input value={destination} placeholder={marketplaceHome.destinationPlaceholder} aria-label="Destination" aria-invalid={invalid} aria-expanded={open} aria-controls={listId} role="combobox" autoComplete="off" onFocus={() => setOpen(true)} onChange={(event) => { onChange(event.target.value); setOpen(true) }} />
      </div>
      {open && suggestions.length > 0 && <ul className="market-suggest" id={listId} role="listbox">
        {suggestions.map((item) => <li key={item.id} role="presentation"><button type="button" role="option" onClick={() => { onChange(item.value); setOpen(false) }}><strong>{item.label}</strong><small>{item.kind === 'city' ? 'City' : 'Destination text'}</small><span>{item.detail}</span></button></li>)}
      </ul>}
    </div>
  )
}

function StayField({ checkIn, checkOut, nights, onChange }: { checkIn: string; checkOut: string; nights: number | null; onChange: (stay: { checkIn: string; checkOut: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [selecting, setSelecting] = useState<'check-in' | 'check-out'>('check-in')
  const box = useRef<HTMLDivElement>(null)
  const start = /^(\d{4})-(\d{2})-/.exec(checkIn)
  const initial = start ? { year: Number(start[1]), monthIndex: Number(start[2]) - 1 } : { year: Number(utcToday().slice(0, 4)), monthIndex: Number(utcToday().slice(5, 7)) - 1 }
  const [cursor, setCursor] = useState(initial)
  useDismiss(box, () => setOpen(false))
  const checkInDay = weekdayShort(checkIn)
  const checkOutDay = weekdayShort(checkOut)
  const nextMonth = shiftMonth(cursor.year, cursor.monthIndex, 1)
  const pick = (iso: string) => {
    const next = applyStayPick({ checkIn, checkOut }, iso, selecting)
    if (!next) return
    setSelecting(next.selecting)
    onChange({ checkIn: next.checkIn, checkOut: next.checkOut })
  }
  return (
    <div className="market-field" ref={box}>
      <span>Stay</span>
      <button type="button" className="market-control" aria-expanded={open} onClick={() => { if (start) setCursor({ year: Number(start[1]), monthIndex: Number(start[2]) - 1 }); setOpen((value) => !value) }}>
        <CalendarDays size={16} aria-hidden="true" />
        <span><strong>{formatCompactStay(checkIn, checkOut)}</strong><small>{nights ? `${nights} night${nights === 1 ? '' : 's'}` : 'Choose dates'}{checkInDay && checkOutDay ? ` · ${checkInDay} – ${checkOutDay}` : ''}</small></span>
      </button>
      {open && <div className="market-popover market-calendar" role="dialog" aria-label="Stay dates">
        <div className="market-calendar-head">
          <button type="button" aria-label="Previous month" onClick={() => setCursor((value) => shiftMonth(value.year, value.monthIndex, -1))}><ChevronLeft size={16} /></button>
          <div className="market-calendar-months"><Month year={cursor.year} monthIndex={cursor.monthIndex} checkIn={checkIn} checkOut={checkOut} onPick={pick} /><Month className="is-second" year={nextMonth.year} monthIndex={nextMonth.monthIndex} checkIn={checkIn} checkOut={checkOut} onPick={pick} /></div>
          <button type="button" aria-label="Next month" onClick={() => setCursor((value) => shiftMonth(value.year, value.monthIndex, 1))}><ChevronRight size={16} /></button>
        </div>
        <div className="market-date-entry">
          <label>Check-in<input type="date" value={checkIn} aria-label="Check-in" onChange={(event) => { const next = applyStayPick({ checkIn, checkOut }, event.target.value, 'check-in'); if (next) onChange(next) }} /></label>
          <label>Check-out<input type="date" value={checkOut} min={addUtcDays(checkIn, 1) ?? undefined} aria-label="Check-out" onChange={(event) => { const next = applyStayPick({ checkIn, checkOut }, event.target.value, 'check-out'); if (next) onChange(next) }} /></label>
        </div>
        <p>{nights ? `${nights} night${nights === 1 ? '' : 's'}` : 'Check-out must be after check-in.'} Dates before today cannot be selected.</p>
      </div>}
    </div>
  )
}

function Month({ year, monthIndex, checkIn, checkOut, onPick, className = '' }: { year: number; monthIndex: number; checkIn: string; checkOut: string; onPick: (iso: string) => void; className?: string }) {
  const today = utcToday()
  return <div className={`market-month ${className}`}>
    <strong>{monthLabel(year, monthIndex)}</strong>
    <div className="market-month-grid">{WEEKDAYS.map((day) => <b key={day}>{day}</b>)}{monthGrid(year, monthIndex).map((cell) => {
      const selected = cell.iso === checkIn || cell.iso === checkOut
      const inRange = cell.iso > checkIn && cell.iso < checkOut
      const disabled = !cell.inMonth || cell.iso < today
      return <button type="button" key={cell.iso} disabled={disabled} className={`${selected ? 'is-selected' : ''} ${inRange ? 'is-range' : ''} ${cell.inMonth ? '' : 'is-outside'}`} onClick={() => onPick(cell.iso)}>{Number(cell.iso.slice(8))}</button>
    })}</div>
  </div>
}

function OccupancyField({ rooms, adults, children, childAges, onChange }: { rooms: number; adults: number; children: number; childAges: DraftChildAge[]; onChange: (value: { rooms: number; adults: number; children: number; childAges: DraftChildAge[] }) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => setOpen(false))
  const setRooms = (value: number) => onChange({ rooms: clampCount(value, 1, MAX_ROOMS), adults, children, childAges })
  const setAdults = (value: number) => onChange({ rooms, adults: clampCount(value, 1, MAX_OCCUPANTS), children, childAges })
  const setChildren = (value: number) => {
    const next = clampCount(value, 0, MAX_OCCUPANTS)
    onChange({ rooms, adults, children: next, childAges: Array.from({ length: next }, (_, index) => childAges[index] ?? null) })
  }
  return (
    <div className="market-field" ref={box}>
      <span>Rooms & guests</span>
      <button type="button" className="market-control" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span><strong>{occupancySummary(rooms, adults, children)}</strong><small>Maximum {MAX_ROOMS} rooms</small></span>
      </button>
      {open && <div className="market-popover market-occupancy" role="dialog" aria-label="Rooms and guests">
        <Stepper label="Rooms" value={rooms} min={1} max={MAX_ROOMS} onChange={setRooms} />
        <Stepper label="Adults" value={adults} min={1} max={MAX_OCCUPANTS} onChange={setAdults} />
        <Stepper label="Children" value={children} min={0} max={MAX_OCCUPANTS} onChange={setChildren} />
        {childAges.map((age, index) => <label key={index} className="market-child-age">Child {index + 1} age<select aria-label={`Child ${index + 1} age`} value={age ?? ''} onChange={(event) => { const picked = event.target.value; if (picked === '') return; onChange({ rooms, adults, children, childAges: childAges.map((current, position) => position === index ? Number(picked) : current) }) }}><option value="" disabled>Age</option>{Array.from({ length: 18 }, (_, value) => <option key={value} value={value}>{value} years</option>)}</select></label>)}
        <p>Occupancy is sent as one total for this search. The maximum is {MAX_ROOMS} rooms.</p>
      </div>}
    </div>
  )
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <div className="market-stepper"><span>{label}</span><div><button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={14} /></button><strong>{value}</strong><button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={14} /></button></div></div>
}

function NationalityField({ nationality, onChange }: { nationality: string; onChange: (value: string) => void }) {
  return <label className="market-field"><span>{marketplaceHome.nationalityLabel}</span><div><select aria-label={marketplaceHome.nationalityLabel} value={nationality} onChange={(event) => onChange(event.target.value)}>{GUEST_MARKETS.map((market) => <option key={market.code} value={market.code}>{market.name}</option>)}</select></div><small>{guestMarketName(nationality)}</small></label>
}

function AdvancedFields({ starRatings, setStarRatings, refundableOnly, setRefundableOnly, minPriceAed, setMinPriceAed, maxPriceAed, setMaxPriceAed, onClear }: {
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPriceAed: string
  setMinPriceAed: (value: string) => void
  maxPriceAed: string
  setMaxPriceAed: (value: string) => void
  onClear: () => void
}) {
  const toggleStar = (star: number) => setStarRatings(starRatings.includes(star) ? starRatings.filter((value) => value !== star) : [...starRatings, star])
  return <div className="market-advanced">
    <p>{marketplaceHome.advancedNote}</p>
    <fieldset><legend>Star rating</legend><div>{[5, 4, 3, 2, 1].map((star) => <label key={star}><input type="checkbox" checked={starRatings.includes(star)} onChange={() => toggleStar(star)} /> {star}★</label>)}</div></fieldset>
    <label className="market-check"><input type="checkbox" checked={refundableOnly} onChange={(event) => setRefundableOnly(event.target.checked)} /> Refundable rates only</label>
    <div className="market-price-range">
      <label>Minimum total stay (AED)<input inputMode="numeric" value={minPriceAed} aria-label="Minimum total stay in whole AED" onChange={(event) => setMinPriceAed(event.target.value)} /></label>
      <label>Maximum total stay (AED)<input inputMode="numeric" value={maxPriceAed} aria-label="Maximum total stay in whole AED" onChange={(event) => setMaxPriceAed(event.target.value)} /></label>
    </div>
    <button type="button" className="portal-link" onClick={onClear}>Clear filters</button>
  </div>
}

function useDismiss(box: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    const onPointer = (event: PointerEvent) => { if (box.current && !box.current.contains(event.target as Node)) close() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [box, close])
}
