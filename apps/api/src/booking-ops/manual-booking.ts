import { BadRequestException } from '@nestjs/common'
import type { ManualBookingRequest } from '@bedbanks/contracts'
import { enabledCurrency } from '../agent/currency'

/**
 * Validation and normalisation of a manual (offline or phone) booking. Pure: no database, no clock except the injected one.
 * Money is integer minor units (strings in, bigint out): there is no floating point anywhere in this file.
 */
export interface ValidManualBooking {
  agencyId: string; hotelId: string; supplier: string
  checkIn: string; checkOut: string; nights: number
  currency: string; sellMinor: bigint; netMinor: bigint | null; markupMinor: bigint | null
  paymentMode: 'CREDIT' | 'PREPAID' | 'PAY_AT_HOTEL' | null
  isRefundable: boolean | null; cancelDeadline: Date | null; agentRef: string | null
  rooms: Array<{ position: number; roomName: string; boardCode: string | null; adults: number; children: number; childAges: number[] }>
  guests: Array<{ title: string | null; firstName: string; lastName: string; isLead: boolean; type: 'ADULT' | 'CHILD'; age: number | null }>
}

const bad = (message: string, code = 'INVALID_MANUAL_BOOKING') => new BadRequestException({ message, code })
const MINOR = /^[0-9]{1,15}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (value: unknown, field: string, max: number, required = true): string | null => {
  if (value === undefined || value === null || value === '') { if (required) throw bad(`${field} is required`); return null }
  if (typeof value !== 'string') throw bad(`${field} must be text`)
  const v = value.trim()
  if (!v) { if (required) throw bad(`${field} is required`); return null }
  if (v.length > max) throw bad(`${field} is too long (max ${max})`)
  return v
}
const int = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(`${field} must be a whole number from ${min} to ${max}`)
  return value
}
function day(value: unknown, field: string): { text: string; ms: number } {
  if (typeof value !== 'string' || !DATE.test(value)) throw bad(`${field} must be a date as YYYY-MM-DD`)
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw bad(`${field} is not a real date`)
  return { text: value, ms }
}
function minor(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !MINOR.test(value)) throw bad(`${field} must be whole minor units (digits only)`)
  return BigInt(value)
}

export function validateManualBooking(body: Partial<ManualBookingRequest>): ValidManualBooking {
  const checkIn = day(body.checkIn, 'checkIn'); const checkOut = day(body.checkOut, 'checkOut')
  const nights = Math.round((checkOut.ms - checkIn.ms) / 86_400_000)
  if (nights < 1 || nights > 365) throw bad('checkOut must be 1 to 365 nights after checkIn')
  let currency: string
  try { currency = enabledCurrency(body.currency) } catch { throw bad('currency is not enabled for this deployment', 'CURRENCY_NOT_ENABLED') }
  const sellMinor = minor(body.sellMinor, 'sellMinor'); if (sellMinor <= 0n) throw bad('sellMinor must be greater than zero')
  const netMinor = body.netMinor === undefined || body.netMinor === null ? null : minor(body.netMinor, 'netMinor')
  const paymentMode = body.paymentMode === undefined ? null : body.paymentMode
  if (paymentMode !== null && !['CREDIT', 'PREPAID', 'PAY_AT_HOTEL'].includes(paymentMode)) throw bad('paymentMode is not recognised')
  if (body.isRefundable !== undefined && typeof body.isRefundable !== 'boolean') throw bad('isRefundable must be true or false')
  let cancelDeadline: Date | null = null
  if (body.cancelDeadline !== undefined && body.cancelDeadline !== null) {
    const d = new Date(body.cancelDeadline)
    if (typeof body.cancelDeadline !== 'string' || Number.isNaN(d.getTime())) throw bad('cancelDeadline must be a date-time')
    if (d.getTime() > checkIn.ms + 86_400_000) throw bad('cancelDeadline cannot be after check-in')
    cancelDeadline = d
  }
  if (!Array.isArray(body.rooms) || body.rooms.length < 1 || body.rooms.length > 9) throw bad('Enter 1 to 9 rooms')
  const rooms = body.rooms.map((r, i) => {
    const children = r.children === undefined ? 0 : int(r.children, `rooms[${i}].children`, 0, 9)
    const childAges = r.childAges ?? []
    if (!Array.isArray(childAges) || childAges.length !== children) throw bad(`rooms[${i}] needs one age per child`)
    for (const age of childAges) int(age, `rooms[${i}].childAges`, 0, 17)
    return { position: i + 1, roomName: str(r.roomName, `rooms[${i}].roomName`, 120) as string, boardCode: str(r.boardCode, `rooms[${i}].boardCode`, 8, false), adults: int(r.adults, `rooms[${i}].adults`, 1, 9), children, childAges }
  })
  if (!Array.isArray(body.guests) || body.guests.length < 1 || body.guests.length > 40) throw bad('Enter 1 to 40 guests')
  const leads = body.guests.filter((g) => g.isLead === true).length
  if (leads > 1) throw bad('Only one guest can be the lead guest')
  const guests = body.guests.map((g, i) => ({
    title: str(g.title, `guests[${i}].title`, 12, false), firstName: str(g.firstName, `guests[${i}].firstName`, 80) as string, lastName: str(g.lastName, `guests[${i}].lastName`, 80) as string,
    isLead: leads === 1 ? g.isLead === true : i === 0, type: (g.type === 'CHILD' ? 'CHILD' : 'ADULT') as 'ADULT' | 'CHILD', age: g.age === undefined || g.age === null ? null : int(g.age, `guests[${i}].age`, 0, 120),
  }))
  return {
    agencyId: str(body.agencyId, 'agencyId', 64) as string, hotelId: str(body.hotelId, 'hotelId', 64) as string, supplier: str(body.supplier, 'supplier', 80) as string,
    checkIn: checkIn.text, checkOut: checkOut.text, nights, currency, sellMinor, netMinor, markupMinor: netMinor === null ? null : sellMinor - netMinor, paymentMode: paymentMode as ValidManualBooking['paymentMode'],
    isRefundable: body.isRefundable ?? null, cancelDeadline, agentRef: str(body.agentRef, 'agentRef', 64, false), rooms, guests,
  }
}
