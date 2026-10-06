'use client'

import Link from 'next/link'
import type { BookingListRow } from '@bedbanks/contracts'
import { AttentionTags, Money, Tag, bookingTone } from '@/components/ops/ops-ui'
import { BOOKING_COLUMN_LABEL, deadlineUrgency, formatInZone, statusLabel, type BookingColumnId } from '@/lib/booking-ui'

const small: React.CSSProperties = { display: 'block', color: '#3f565c', fontSize: 10, marginTop: 2 }
const dot = (tone: 'ok' | 'warn' | 'bad' | 'neutral') => ({ ok: '#22a58a', warn: '#d9962b', bad: '#c0443f', neutral: '#8aa0a6' }[tone])

/** One table cell per column. Display only: every value, flag and mask was decided by the API. */
export function BookingCell({ column, row, now, attentionAvailable }: { column: BookingColumnId; row: BookingListRow; now: Date; attentionAvailable: boolean }) {
  switch (column) {
    case 'reference':
      return (
        <>
          <Link href={`/bookings/${row.id}`} style={{ fontWeight: 600 }}>{row.reference}</Link>
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
            {row.isRefundable === false && <Tag tone="warn">NR</Tag>}
            {row.amended && <Tag tone="neutral">AMENDED</Tag>}
            {row.closedAt && <Tag tone="neutral">CLOSED</Tag>}
            {attentionAvailable ? <AttentionTags flags={row.attention ?? []} /> : null}
          </span>
        </>
      )
    case 'status': {
      const tone = bookingTone(row.status)
      return (
        <>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><i aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot(tone), display: 'inline-block' }} /><strong style={{ fontSize: 11 }}>{statusLabel(row.status)}</strong></span>
          {row.supplierStatus && row.supplierStatus.toUpperCase() !== row.status ? <span style={small}>Supplier: {row.supplierStatus}</span> : null}
        </>
      )
    }
    case 'agency':
      return <>{row.agency ? row.agency.name : <span style={{ color: '#3f565c' }} title="The agency could not be derived for this booking">Unassigned</span>}<span style={small}>{row.agent ?? '—'}</span></>
    case 'supplier':
      return <>{row.supplier}<span style={small}>{row.supplierRef ? <code>{row.supplierRef}</code> : row.missingSupplierRef ? <strong style={{ color: '#a11d1d' }}>Missing</strong> : '—'}</span></>
    case 'guest':
      return row.leadGuest ? <>{row.leadGuest.name}{row.leadGuest.masked && <span style={small} title="Names are masked without the guest-data permission">masked</span>}{row.guests && <span style={small}>{row.guests.adults} AD{row.guests.children ? ` · ${row.guests.children} C` : ''}</span>}</> : <span style={{ color: '#3f565c' }}>—</span>
    case 'hotel':
      return <>{row.hotel.name ?? <span style={{ color: '#3f565c' }}>Hotel not readable</span>}<span style={small}>{[row.room?.name, row.room?.board].filter(Boolean).join(' · ') || '—'}{row.room && row.room.quantity > 1 ? ` × ${row.room.quantity}` : ''}</span></>
    case 'stay':
      return row.checkIn && row.checkOut ? <>{row.checkIn} → {row.checkOut}<span style={small}>{row.nights ?? '—'} night{row.nights === 1 ? '' : 's'}</span></> : <span style={{ color: '#3f565c' }} title="No stay dates are recorded for this booking">—</span>
    case 'booked':
      return <>{formatInZone(row.createdAt, null)}</>
    case 'deadline': {
      const urgency = deadlineUrgency(row.cancelDeadline, now)
      return row.cancelDeadline
        ? <span style={{ color: urgency === 'soon' ? '#a11d1d' : urgency === 'passed' ? '#3f565c' : undefined, fontWeight: urgency === 'soon' ? 700 : 400 }}>{formatInZone(row.cancelDeadline, row.hotel.timeZone)}{urgency === 'soon' ? ' · < 48h' : urgency === 'passed' ? ' · passed' : ''}</span>
        : <span style={{ color: '#3f565c' }} title="No cancellation deadline is recorded">—</span>
    }
    case 'amount':
      return (
        <>
          <Money minor={row.sellMinor} currency={row.currency} />
          {row.netMinor !== null && row.marginMinor !== null ? <span style={small}>Net <Money minor={row.netMinor} currency={row.currency} /> · margin <Money minor={row.marginMinor} currency={row.currency} /></span> : null}
        </>
      )
    case 'actions':
      return <Link href={`/bookings/${row.id}`} className="admin-btn" aria-label={`View booking ${row.reference}`}>View</Link>
  }
}

export const columnHeader = (id: BookingColumnId): string => BOOKING_COLUMN_LABEL[id]
