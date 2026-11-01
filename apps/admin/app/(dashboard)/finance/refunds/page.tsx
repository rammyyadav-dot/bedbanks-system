'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, when } from '@/components/ops/ops-ui'
import { getOpsLedger } from '@/lib/data/operations'
import type { LedgerEntryView } from '@bedbanks/contracts'

/**
 * Refund register (ADR 0054 slice 2): the REFUND entries of the immutable ledger, which the cancellation flow already posts.
 * Read-only. It issues nothing, moves no money and creates no document; it is the ledger filtered to refunds, newest first.
 */
export default function RefundsPage() {
  return (
    <OpsListPage<LedgerEntryView>
      eyebrow="FINANCE · REFUNDS" title="Refund register" description="Refunds already posted to agency wallets by the cancellation flow. Read-only: refunds are not issued from this page."
      filters={[{ key: 'bookingId', label: 'Booking id', type: 'text' }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]}
      load={(p) => getOpsLedger({ ...p, type: 'REFUND' })} getRowId={e => e.id}
      emptyTitle="No refunds posted" emptyDescription="The query succeeded and no refund entry matches these filters."
      columns={[
        { key: 'at', header: 'When', render: e => when(e.at) },
        { key: 'amount', header: 'Refunded', align: 'right', render: e => <Money minor={e.amountMinor} currency={e.currency} /> },
        { key: 'booking', header: 'Booking', render: e => (e.bookingId ? <Link href={`/bookings/${e.bookingId}`}>{e.bookingId}</Link> : '—') },
        { key: 'key', header: 'Idempotency key', render: e => <code>{e.idempotencyKey}</code> },
      ]}
    />
  )
}
