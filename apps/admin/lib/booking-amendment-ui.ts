// Pure helpers for the amendment dialogs and panel (ADR 0072). No React, no network.
// The checks here mirror the shared contract validators so a person sees problems before submitting; the API validates again and decides.
import {
  amendmentDifference, validateAmendmentApproval, validateAmendmentProposal,
  type BookingAmendmentApproval, type BookingAmendmentProposal, type BookingAmendmentView, type BookingDetailView,
} from '@bedbanks/contracts'
import { formatMinorUnits, parseMajorToMinor } from './minor-units'

export interface AmendmentRoomForm { position: number; label: string; adults: string; children: string; childAges: string }
export interface AmendmentRequestForm { checkIn: string; checkOut: string; rooms: AmendmentRoomForm[] }

/** The form starts as the booking is now, so only what a person changes is sent. */
export function initialAmendmentForm(d: Pick<BookingDetailView, 'booking' | 'rooms'>): AmendmentRequestForm {
  return {
    checkIn: d.booking.checkIn ?? '', checkOut: d.booking.checkOut ?? '',
    rooms: d.rooms.map((r) => ({ position: r.position, label: `${r.roomName ?? 'Room'} ${r.position}`, adults: String(r.adults), children: String(r.children), childAges: [...r.childAges].sort((a, b) => a - b).join(', ') })),
  }
}

const whole = (v: string): number | null => (/^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : null)

/** The proposal to send: only the parts that differ from the booking. `none` when nothing differs (the person may still send a free-text request). */
export function buildAmendmentProposal(form: AmendmentRequestForm, d: Pick<BookingDetailView, 'booking' | 'rooms'>, today: string): { proposal: BookingAmendmentProposal } | { none: true } | { errors: string[] } {
  const current = initialAmendmentForm(d)
  const raw: Record<string, unknown> = {}
  const errors: string[] = []
  if (form.checkIn.trim() && form.checkIn !== current.checkIn) raw.checkIn = form.checkIn.trim()
  if (form.checkOut.trim() && form.checkOut !== current.checkOut) raw.checkOut = form.checkOut.trim()
  const rooms: Array<{ position: number; adults: number; children: number; childAges: number[] }> = []
  form.rooms.forEach((r, i) => {
    const before = current.rooms[i]
    if (!before || (r.adults === before.adults && r.children === before.children && r.childAges.replace(/\s/g, '') === before.childAges.replace(/\s/g, ''))) return
    const adults = whole(r.adults); const children = whole(r.children || '0')
    const ages = r.childAges.split(',').map((a) => a.trim()).filter(Boolean).map((a) => whole(a))
    if (adults === null || children === null || ages.some((a) => a === null)) { errors.push(`${r.label}: adults, children and ages must be whole numbers`); return }
    rooms.push({ position: r.position, adults, children, childAges: ages as number[] })
  })
  if (rooms.length) raw.rooms = rooms
  if (errors.length) return { errors }
  if (Object.keys(raw).length === 0) return { none: true }
  const subject = { checkIn: d.booking.checkIn, checkOut: d.booking.checkOut, rooms: d.rooms.map((r) => ({ position: r.position, adults: r.adults, children: r.children, childAges: r.childAges })) }
  const checked = validateAmendmentProposal(raw, subject, today)
  return checked.ok ? { proposal: checked.proposal } : { errors: checked.issues.map((i) => i.message) }
}

export interface AmendmentApprovalForm { sell: string; net: string; deadline: string }
export const initialApprovalForm = (currency: string, current: { sellMinor: string; netMinor: string | null }): AmendmentApprovalForm => ({ sell: minorToMajor(current.sellMinor, currency), net: current.netMinor === null ? '' : minorToMajor(current.netMinor, currency), deadline: '' })

/** Integer minor units to the plain decimal a person types back (no thousands separators, no currency). Integer arithmetic only. */
export function minorToMajor(minor: string, currency: string): string {
  const shown = formatMinorUnits(minor, currency)
  return shown === '—' ? '' : shown.replace(`${currency} `, '').replace(/,/g, '')
}

export function buildApproval(form: AmendmentApprovalForm, currency: string): { approval: BookingAmendmentApproval } | { errors: string[] } {
  const errors: string[] = []
  const sell = parseMajorToMinor(form.sell, currency)
  if (sell === null || BigInt(sell) <= 0n) errors.push('Enter the new sell total as a plain number with at most the currency’s decimals')
  let net: string | null | undefined
  if (form.net.trim()) { const n = parseMajorToMinor(form.net, currency); if (n === null) errors.push('Enter the new net as a plain number'); else net = n } else net = null
  let cancelDeadline: string | undefined
  if (form.deadline.trim()) { const d = new Date(form.deadline); if (Number.isNaN(d.getTime())) errors.push('The cancellation deadline is not a valid date and time'); else cancelDeadline = d.toISOString() }
  if (errors.length || sell === null) return { errors }
  const approval: BookingAmendmentApproval = { sellMinor: sell, netMinor: net, ...(cancelDeadline ? { cancelDeadline } : {}) }
  const checked = validateAmendmentApproval(approval)
  return checked.ok ? { approval } : { errors: checked.issues.map((i) => i.message) }
}

/** What the approver is about to record, in words, before they confirm. Null until the sell parses. */
export function approvalPreview(currentSellMinor: string, form: AmendmentApprovalForm, currency: string): { text: string; tone: 'up' | 'down' | 'same' } | null {
  const sell = parseMajorToMinor(form.sell, currency)
  if (sell === null || BigInt(sell) <= 0n) return null
  const { differenceMinor, direction } = amendmentDifference(currentSellMinor, sell)
  if (direction === 'NONE') return { text: 'The price does not change. Nothing is recorded as a money fact.', tone: 'same' }
  const amount = formatMinorUnits(differenceMinor.replace('-', ''), currency)
  return direction === 'INCREASE'
    ? { text: `The price goes up by ${amount}. This is recorded as an amount awaiting Finance booking; nothing is charged here.`, tone: 'up' }
    : { text: `The price goes down by ${amount}. This is recorded as an amount awaiting Finance booking; nothing is refunded here.`, tone: 'down' }
}

/** The structured amendment awaiting a decision, if any. A free-text request has none. */
export const openAmendment = (d: Pick<BookingDetailView, 'amendments'>): BookingAmendmentView | null => d.amendments?.find((a) => a.status === 'REQUESTED') ?? null

/** One line saying what an amendment changes, for the panel and the approve dialog. */
export function describeProposal(a: Pick<BookingAmendmentView, 'proposal' | 'before'>): string[] {
  const out: string[] = []
  const p = a.proposal; const b = a.before
  if (p.checkIn || p.checkOut) out.push(`Stay ${b.checkIn ?? '—'} → ${b.checkOut ?? '—'} becomes ${p.checkIn ?? b.checkIn ?? '—'} → ${p.checkOut ?? b.checkOut ?? '—'}`)
  for (const r of p.rooms ?? []) {
    const was = b.rooms.find((x) => x.position === r.position)
    const head = (adults: number, children: number, ages: number[]) => `${adults} AD${children ? ` · ${children} C (${[...ages].sort((x, y) => x - y).join(', ')})` : ''}`
    out.push(`Room ${r.position}: ${was ? head(was.adults, was.children, was.childAges) : '—'} becomes ${head(r.adults, r.children, r.childAges)}`)
  }
  return out
}
