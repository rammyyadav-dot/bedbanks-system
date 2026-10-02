'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsLedger } from '@/lib/data/operations'
import type { LedgerEntryView } from '@bedbanks/contracts'

export default function LedgerPage() {
  return (
    <OpsListPage<LedgerEntryView>
      eyebrow="FINANCE" title="Ledger" description="Immutable wallet ledger entries, newest first. Entries cannot be edited or deleted here."
      filters={[
        { key: 'type', label: 'Type', type: 'select', options: ['CREDIT', 'DEBIT', 'HOLD', 'RELEASE', 'REFUND'].map(v => ({ value: v, label: v })) },
        { key: 'bookingId', label: 'Booking id', type: 'text' }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' },
      ]}
      load={getOpsLedger} getRowId={e => e.id}
      emptyTitle="No ledger entries" emptyDescription="The query succeeded and no ledger entry matches these filters."
      columns={[
        { key: 'at', header: 'When', render: e => when(e.at) },
        { key: 'type', header: 'Type', render: e => <Tag tone={e.type === 'DEBIT' ? 'warn' : e.type === 'REFUND' ? 'ok' : 'neutral'}>{e.type}</Tag> },
        { key: 'amount', header: 'Amount', align: 'right', render: e => <Money minor={e.amountMinor} currency={e.currency} /> },
        { key: 'booking', header: 'Booking', render: e => (e.bookingId ? <Link href={`/bookings/${e.bookingId}`}>{e.bookingId}</Link> : '—') },
        { key: 'key', header: 'Idempotency key', render: e => <code>{e.idempotencyKey}</code> },
      ]}
    />
  )
}
