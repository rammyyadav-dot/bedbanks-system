'use client'

import { CalendarDays, MapPin, Search } from 'lucide-react'

export function SearchCriteriaForm({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges,
  searching, onSubmit, onChange, submitLabel = 'Search hotels', destinationInvalid = false,
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
  childAges: number[]
  setChildAges: (value: number[]) => void
  searching: boolean
  onSubmit: () => void
  onChange: (action: () => void) => void
  submitLabel?: string
  destinationInvalid?: boolean
}) {
  return (
    <div className="portal-panel portal-search-panel" id="hotel-search">
      <div className="portal-search-form">
        <label className="portal-field wide"><span>DESTINATION OR HOTEL</span><div className={destinationInvalid ? 'has-error' : ''}><MapPin size={16} /><input value={destination} onChange={(event) => onChange(() => setDestination(event.target.value))} aria-label="Destination or hotel" aria-invalid={destinationInvalid} /></div></label>
        <label className="portal-field"><span>CHECK-IN</span><div><CalendarDays size={15} /><input type="date" value={checkIn} onChange={(event) => onChange(() => setCheckIn(event.target.value))} aria-label="Check-in" /></div></label>
        <label className="portal-field"><span>CHECK-OUT</span><div><CalendarDays size={15} /><input type="date" value={checkOut} onChange={(event) => onChange(() => setCheckOut(event.target.value))} aria-label="Check-out" /></div></label>
        <label className="portal-field"><span>ROOMS</span><div><input type="number" min={1} max={20} value={rooms} onChange={(event) => onChange(() => setRooms(Number(event.target.value)))} aria-label="Rooms" /></div></label>
        <label className="portal-field"><span>ADULTS</span><div><input type="number" min={1} max={40} value={adults} onChange={(event) => onChange(() => setAdults(Number(event.target.value)))} aria-label="Adults" /></div></label>
        <label className="portal-field"><span>CHILDREN</span><div><input type="number" min={0} max={40} value={children} onChange={(event) => onChange(() => updateChildren(Number(event.target.value)))} aria-label="Children" /></div></label>
        {childAges.map((age, index) => <label className="portal-field" key={index}><span>CHILD {index + 1} AGE</span><div><input type="number" min={0} max={17} value={age} onChange={(event) => onChange(() => setChildAges(childAges.map((value, position) => position === index ? Number(event.target.value) : value)))} aria-label={`Child ${index + 1} age`} /></div></label>)}
        <button className="portal-primary search-submit" type="button" onClick={onSubmit} disabled={searching}><Search size={16} /> {searching ? 'Searching…' : submitLabel}</button>
      </div>
      <p className="trade-search-note">Nationality IN and currency AED are sent with this search. Rates use the dates and occupancy shown here. A search total is not confirmed availability.</p>
    </div>
  )
}
