'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Minus, Plus, Search } from 'lucide-react'
import type { DestinationRef, DestinationResolution, SearchSort } from '@bedbanks/domain'
import { marketplaceHome } from '@/lib/marketplace-content'
import { canSubmitDestination, destinationSuggestions } from '@/lib/destination-suggestions'
import { fetchDestinations } from '@/lib/destination-client'
import { criteriaFilters } from '@/lib/search-filters'
import { useCurrencyOptions } from '@/components/search/currency-options'
import { GUEST_MARKETS, guestMarketName } from '@/lib/guest-market'
import { buildRoomStays, MAX_ADULTS_PER_ROOM, MAX_CHILDREN_PER_ROOM, MAX_ROOMS, roomStaySummary, type RoomStayDraft } from '@/lib/occupancy'
import { formatCompactStay, weekdayShort } from '@/lib/format'
import { addUtcDays, applyStayPick, monthGrid, monthLabel, nightCount, shiftMonth, utcToday } from '@/lib/stay-calendar'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function SearchCriteriaForm({
  destination, destinationRef, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  roomStays, setRoomStays, currency, setCurrency,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPrice, setMinPrice, maxPrice, setMaxPrice, boardBasisIds, setBoardBasisIds, propertyTypes, setPropertyTypes,
  boards, propertyTypeOptions, sort, setSort,
  searching, searchFailed = false, onSubmit, onChange, destinationInvalid = false, tenantId,
}: {
  destination: string
  destinationRef: DestinationRef | null
  setDestination: (label: string, ref: DestinationRef | null, cityName: string) => void
  checkIn: string
  setCheckIn: (value: string) => void
  checkOut: string
  setCheckOut: (value: string) => void
  roomStays: RoomStayDraft[]
  setRoomStays: (value: RoomStayDraft[]) => void
  currency: string
  setCurrency: (value: string) => void
  nationality: string
  setNationality: (value: string) => void
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPrice: string
  setMinPrice: (value: string) => void
  maxPrice: string
  setMaxPrice: (value: string) => void
  boardBasisIds: string[]
  setBoardBasisIds: (value: string[]) => void
  propertyTypes: string[]
  setPropertyTypes: (value: string[]) => void
  boards: { id: string; name: string }[]
  propertyTypeOptions: string[]
  sort: SearchSort
  setSort: (value: SearchSort) => void
  searching: boolean
  searchFailed?: boolean
  onSubmit: () => void
  onChange: (action: () => void) => void
  destinationInvalid?: boolean
  tenantId: string
}) {
  const currencyOptions = useCurrencyOptions()
  const [advanced, setAdvanced] = useState(false)
  const [formError, setFormError] = useState('')
  const submitLabel = searching ? marketplaceHome.searchingCta : searchFailed ? marketplaceHome.retryCta : marketplaceHome.searchCta
  const nights = nightCount(checkIn, checkOut)
  const change = (action: () => void) => { setFormError(''); onChange(action) }
  const submit = () => {
    const parsed = criteriaFilters({ starRatings, refundableOnly, minPrice, maxPrice, currency, boardBasisIds, propertyTypes })
    const stays = buildRoomStays(roomStays)
    if (!canSubmitDestination(destinationRef)) return setFormError('Select a city or hotel. Typed text is not a destination.')
    if (!parsed.ok) return setFormError(parsed.reason)
    if (!stays.ok) return setFormError(stays.reason)
    if (nights === null || nights > 30) return setFormError('Choose a stay of 1 to 30 nights.')
    setFormError('')
    onSubmit()
  }
  return (
    <form className="market-search" id="hotel-search" aria-label="Hotel search" onSubmit={(event) => { event.preventDefault(); if (!searching) submit() }}>
      <div className="market-search-row">
        <DestinationField destination={destination} resolved={canSubmitDestination(destinationRef)} invalid={destinationInvalid || Boolean(formError && !canSubmitDestination(destinationRef))} tenantId={tenantId} onChange={(label, ref, cityName) => change(() => setDestination(label, ref, cityName))} />
        <StayField checkIn={checkIn} checkOut={checkOut} nights={nights} onChange={(next) => change(() => { setCheckIn(next.checkIn); setCheckOut(next.checkOut) })} />
        <OccupancyField stays={roomStays} onChange={(next) => change(() => setRoomStays(next))} />
        <NationalityField nationality={nationality} onChange={(value) => change(() => setNationality(value))} />
        <button className="portal-primary market-search-cta" type="submit" disabled={searching}><Search size={16} /> {submitLabel}</button>
      </div>
      <div className="market-search-tools">
        <button type="button" className="portal-link" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>+ {marketplaceHome.advancedLabel}</button>
        <label><span>{marketplaceHome.currencyLabel}</span> <select aria-label="Selling currency" value={currency} onChange={(event) => change(() => setCurrency(event.target.value))}>{currencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
      </div>
      {formError && <p className="portal-field-error" role="alert">{formError}</p>}
      <p className="trade-search-note">{marketplaceHome.currencyNote} {marketplaceHome.nationalityHelper} {marketplaceHome.residencyNote} A search total is not confirmed availability.</p>
      {advanced && <AdvancedFields currency={currency} starRatings={starRatings} setStarRatings={(value) => change(() => setStarRatings(value))} refundableOnly={refundableOnly} setRefundableOnly={(value) => change(() => setRefundableOnly(value))} minPrice={minPrice} setMinPrice={(value) => change(() => setMinPrice(value))} maxPrice={maxPrice} setMaxPrice={(value) => change(() => setMaxPrice(value))} boardBasisIds={boardBasisIds} setBoardBasisIds={(value) => change(() => setBoardBasisIds(value))} boards={boards} propertyTypes={propertyTypes} setPropertyTypes={(value) => change(() => setPropertyTypes(value))} propertyTypeOptions={propertyTypeOptions} sort={sort} setSort={(value) => change(() => setSort(value))} onClear={() => change(() => { setStarRatings([]); setRefundableOnly(false); setMinPrice(''); setMaxPrice(''); setBoardBasisIds([]); setPropertyTypes([]); setSort('default') })} />}
    </form>
  )
}

function DestinationField({ destination, resolved, invalid, tenantId, onChange }: { destination: string; resolved: boolean; invalid: boolean; tenantId: string; onChange: (label: string, ref: DestinationRef | null, cityName: string) => void }) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [remote, setRemote] = useState<DestinationResolution[]>([])
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => setOpen(false))
  useEffect(() => {
    if (!open || destination.trim().length < 2) { setRemote([]); return }
    const timer = window.setTimeout(() => { void fetchDestinations(destination, tenantId).then(setRemote) }, 200)
    return () => window.clearTimeout(timer)
  }, [destination, open, tenantId])
  const local = destinationSuggestions(destination).map((item) => item.ref.type === 'city' ? { type: 'city' as const, id: item.ref.id, name: item.value, countryCode: item.ref.countryCode } : null).filter((item): item is Extract<DestinationResolution, { type: 'city' }> => item !== null)
  const remoteIds = new Set(remote.map((item) => `${item.type}:${item.id}`))
  const suggestions = [...remote, ...local.filter((item) => !remoteIds.has(`city:${item.id}`))]
  return (
    <div className="market-field" ref={box}>
      <span>Destination</span>
      <div className={invalid ? 'has-error' : ''}>
        <MapPin size={16} aria-hidden="true" />
        <input value={destination} placeholder="Select a city or hotel" aria-label="Destination" aria-invalid={invalid} aria-expanded={open} aria-controls={listId} role="combobox" autoComplete="off" onFocus={() => setOpen(true)} onChange={(event) => { onChange(event.target.value, null, ''); setOpen(true) }} />
      </div>
      {resolved && <small>Canonical destination selected</small>}
      {open && suggestions.length > 0 && <ul className="market-suggest" id={listId} role="listbox">
        {suggestions.map((item) => <li key={`${item.type}:${item.id}`} role="presentation"><button type="button" role="option" onClick={() => { if (item.type === 'city') onChange(item.name, { type: 'city', id: item.id, countryCode: item.countryCode }, item.name); else onChange(`${item.name}, ${item.cityName}`, { type: 'hotel', id: item.id }, item.cityName); setOpen(false) }}><strong>{item.name}</strong><small>{item.type === 'city' ? 'City' : 'Hotel'}</small><span>{item.type === 'city' ? item.countryCode : item.cityName}</span></button></li>)}
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

function OccupancyField({ stays, onChange }: { stays: RoomStayDraft[]; onChange: (value: RoomStayDraft[]) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => setOpen(false))
  const update = (index: number, next: RoomStayDraft) => onChange(stays.map((stay, position) => position === index ? next : stay))
  return (
    <div className="market-field" ref={box}>
      <span>Rooms & guests</span>
      <button type="button" className="market-control" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span><strong>{roomStaySummary(stays)}</strong><small>Each room has its own guests</small></span>
      </button>
      {open && <div className="market-popover market-occupancy" role="dialog" aria-label="Rooms and guests">
        {stays.map((stay, index) => <fieldset key={index} className="market-room-stay"><legend>Room {index + 1}</legend>
          <Stepper label={`Room ${index + 1} adults`} value={stay.adults} min={1} max={MAX_ADULTS_PER_ROOM} onChange={(adults) => update(index, { ...stay, adults })} />
          <Stepper label={`Room ${index + 1} children`} value={stay.childAges.length} min={0} max={MAX_CHILDREN_PER_ROOM} onChange={(count) => update(index, { ...stay, childAges: Array.from({ length: count }, (_, child) => stay.childAges[child] ?? null) })} />
          {stay.childAges.map((age, child) => <label key={child} className="market-child-age">Room {index + 1} child {child + 1} age<select aria-label={`Room ${index + 1} child ${child + 1} age`} value={age ?? ''} onChange={(event) => { const picked = event.target.value; if (picked === '') return; update(index, { ...stay, childAges: stay.childAges.map((current, position) => position === child ? Number(picked) : current) }) }}><option value="" disabled>Age</option>{Array.from({ length: 18 }, (_, value) => <option key={value} value={value}>{value} years</option>)}</select></label>)}
        </fieldset>)}
        <div className="market-room-actions">
          <button type="button" disabled={stays.length >= MAX_ROOMS} onClick={() => onChange([...stays, { adults: 2, childAges: [] }])}>Add room</button>
          <button type="button" disabled={stays.length <= 1} onClick={() => onChange(stays.slice(0, -1))}>Remove room</button>
        </div>
        <p>Every child needs an age before search. Mixed room occupancies are sent as separate rooms.</p>
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

function AdvancedFields({ currency, starRatings, setStarRatings, refundableOnly, setRefundableOnly, minPrice, setMinPrice, maxPrice, setMaxPrice, boardBasisIds, setBoardBasisIds, boards, propertyTypes, setPropertyTypes, propertyTypeOptions, sort, setSort, onClear }: {
  currency: string
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPrice: string
  setMinPrice: (value: string) => void
  maxPrice: string
  setMaxPrice: (value: string) => void
  boardBasisIds: string[]
  setBoardBasisIds: (value: string[]) => void
  boards: { id: string; name: string }[]
  propertyTypes: string[]
  setPropertyTypes: (value: string[]) => void
  propertyTypeOptions: string[]
  sort: SearchSort
  setSort: (value: SearchSort) => void
  onClear: () => void
}) {
  const toggleStar = (star: number) => setStarRatings(starRatings.includes(star) ? starRatings.filter((value) => value !== star) : [...starRatings, star])
  const toggle = (current: string[], value: string, set: (next: string[]) => void) => set(current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  return <div className="market-advanced">
    <p>{marketplaceHome.advancedNote}</p>
    <label>Sort<select aria-label="Sort hotels" value={sort} onChange={(event) => setSort(event.target.value as SearchSort)}><option value="default">Default order</option><option value="price">Total stay</option><option value="stars">Star rating</option><option value="name">Hotel name</option></select></label>
    <fieldset><legend>Star rating</legend><div>{[5, 4, 3, 2, 1].map((star) => <label key={star}><input type="checkbox" checked={starRatings.includes(star)} onChange={() => toggleStar(star)} /> {star}★</label>)}</div></fieldset>
    <label className="market-check"><input type="checkbox" checked={refundableOnly} onChange={(event) => setRefundableOnly(event.target.checked)} /> Refundable rates only</label>
    {boards.length > 0 && <fieldset><legend>Board</legend><div>{boards.map((board) => <label key={board.id}><input type="checkbox" checked={boardBasisIds.includes(board.id)} onChange={() => toggle(boardBasisIds, board.id, setBoardBasisIds)} /> {board.name}</label>)}</div></fieldset>}
    {propertyTypeOptions.length > 0 && <fieldset><legend>Property type</legend><div>{propertyTypeOptions.map((type) => <label key={type}><input type="checkbox" checked={propertyTypes.includes(type)} onChange={() => toggle(propertyTypes, type, setPropertyTypes)} /> {type}</label>)}</div></fieldset>}
    <div className="market-price-range">
      <label>Minimum total stay ({currency})<input inputMode="decimal" value={minPrice} aria-label={`Minimum total stay in ${currency}`} onChange={(event) => setMinPrice(event.target.value)} /></label>
      <label>Maximum total stay ({currency})<input inputMode="decimal" value={maxPrice} aria-label={`Maximum total stay in ${currency}`} onChange={(event) => setMaxPrice(event.target.value)} /></label>
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
