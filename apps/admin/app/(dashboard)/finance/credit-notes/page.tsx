'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, when } from '@/components/ops/ops-ui'
import { getCreditNotes } from '@/lib/data/operations'
import type { CreditNoteRow } from '@bedbanks/contracts'

/**
 * Credit note register (ADR 0054 slice 3): credit notes already issued as frozen booking documents. Read-only.
 * Issuing, numbering and content stay with the booking document service; nothing here creates or changes a document.
 */
export default function CreditNotesPage() {
  const amount = (minor: string | null, currency: string | null) => (minor !== null && currency ? <Money minor={minor} currency={currency} /> : <span title="Not recorded in the frozen document">—</span>)
  return (
    <OpsListPage<CreditNoteRow>
      eyebrow="FINANCE · CREDIT NOTES" title="Credit note register" description="Credit notes issued for cancelled bookings, newest first. Read-only: documents are frozen when issued and are issued from the booking."
      filters={[{ key: 'from', label: 'Issued from', type: 'date' }, { key: 'to', label: 'Issued to', type: 'date' }]}
      load={getCreditNotes} getRowId={r => r.id}
      emptyTitle="No credit notes issued" emptyDescription="The query succeeded and no credit note matches these filters."
      columns={[
        { key: 'issuedAt', header: 'Issued', render: r => when(r.issuedAt) },
        { key: 'number', header: 'Number', render: r => <code>{r.number}</code> },
        { key: 'booking', header: 'Booking', render: r => <Link href={`/bookings/${r.bookingId}`}>{r.bookingReference}</Link> },
        { key: 'total', header: 'Booking total', align: 'right', render: r => amount(r.totalMinor, r.currency) },
        { key: 'penalty', header: 'Penalty kept', align: 'right', render: r => amount(r.penaltyMinor, r.currency) },
        { key: 'refund', header: 'Credited', align: 'right', render: r => amount(r.refundMinor, r.currency) },
      ]}
    />
  )
}
