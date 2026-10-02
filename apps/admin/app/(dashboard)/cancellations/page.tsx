'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsCancellations } from '@/lib/data/operations'
import type { CancellationRow } from '@bedbanks/contracts'

export default function CancellationsPage() {
  return (
    <OpsListPage<CancellationRow>
      eyebrow="CANCELLATIONS" title="Cancellations & refunds" description="Recorded cancellations compared with the refunds actually posted to the wallet ledger. Read-only: cancellation itself stays in the agent workflow."
      load={getOpsCancellations} getRowId={c => c.bookingId}
      emptyTitle="No cancellations" emptyDescription="The query succeeded and this tenant has no cancellation records."
      columns={[
        { key: 'reference', header: 'Booking', render: c => <Link href={`/bookings/${c.bookingId}`} style={{ fontWeight: 600 }}>{c.reference}</Link> },
        { key: 'hotel', header: 'Hotel', render: c => c.hotelName ?? '—' },
        { key: 'checkIn', header: 'Check-in', render: c => c.checkIn ?? '—' },
        { key: 'total', header: 'Booking total', align: 'right', render: c => <Money minor={c.totalMinor} currency={c.currency} /> },
        { key: 'recorded', header: 'Refund recorded', align: 'right', render: c => <Money minor={c.refundMinor} currency={c.currency} /> },
        { key: 'posted', header: 'Refund posted', align: 'right', render: c => <Money minor={c.refundPosted} currency={c.currency} /> },
        { key: 'match', header: 'Reconciled', render: c => <Tag tone={c.refundMatches ? 'ok' : 'bad'}>{c.refundMatches ? 'MATCH' : 'MISMATCH'}</Tag> },
        { key: 'at', header: 'Cancelled', render: c => when(c.createdAt) },
      ]}
    />
  )
}
