'use client'

import { useState } from 'react'
import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'
import type { CancellationVoucherDeliveryRead } from '@bedbanks/contracts'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { getCancellationVouchers, dispatchCancellationVoucher } from '@/lib/data'
import { formatMinorUnits } from '@/lib/minor-units'

export default function NotificationsPage() {
  const [deliveries, setDeliveries] = useState<CancellationVoucherDeliveryRead[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [bookingId, setBookingId] = useState('bk_dubai_001')
  const [bookingReference, setBookingReference] = useState('FB-DXB-90812')
  const [supplierCancellationRef, setSupplierCancellationRef] = useState('CX-FB-DXB-90812')
  const [currency, setCurrency] = useState('AED')
  const [penaltyMinor, setPenaltyMinor] = useState('25000')
  const [refundMinor, setRefundMinor] = useState('75000')
  const [idempotencyKey, setIdempotencyKey] = useState('voucher-op-2026-001')
  const [dispatchStatus, setDispatchStatus] = useState<string | null>(null)

  const loadDeliveries = async () => {
    try {
      setLoading(true)
      const rows = await getCancellationVouchers()
      setDeliveries(rows)
      setError(null)
    } catch {
      setDeliveries([])
      setError('Cancellation voucher delivery logs are unavailable. No fallback data is shown.')
    } finally {
      setLoading(false)
    }
  }

  const triggerDispatch = async () => {
    try {
      setDispatchStatus(null)
      const created = await dispatchCancellationVoucher({
        bookingId: bookingId.trim(),
        bookingReference: bookingReference.trim(),
        supplierCancellationRef: supplierCancellationRef.trim() || null,
        channels: ['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK'],
        currency: currency.trim().toUpperCase(),
        penaltyMinor: penaltyMinor.trim(),
        refundMinor: refundMinor.trim(),
        idempotencyKey: idempotencyKey.trim(),
      })
      await loadDeliveries()
      setDispatchStatus(`Dispatched ${created.length} cancellation voucher notification(s) across CLIENT_EMAIL & SUPPLIER_WEBHOOK.`)
    } catch (err) {
      setDispatchStatus(err instanceof Error ? err.message : 'Failed to dispatch cancellation vouchers.')
    }
  }

  const columns: DataTableColumn<CancellationVoucherDeliveryRead>[] = [
    { key: 'bookingReference', header: 'Booking Ref', render: (d) => d.bookingReference },
    { key: 'channel', header: 'Channel', render: (d) => d.channel },
    { key: 'supplierRef', header: 'Supplier CX Ref', render: (d) => d.supplierCancellationRef ?? '—' },
    { key: 'penalty', header: 'Penalty', render: (d) => formatMinorUnits(d.penaltyMinor, d.currency), align: 'right' },
    { key: 'refund', header: 'Approved Refund', render: (d) => formatMinorUnits(d.refundMinor, d.currency), align: 'right' },
    { key: 'status', header: 'Status', render: (d) => d.status },
    { key: 'dispatchedAt', header: 'Dispatched At (UTC)', render: (d) => d.dispatchedAt.slice(0, 19).replace('T', ' ') },
  ]

  return (
    <div className="admin-page">
      <FeatureUnavailable
        eyebrow="COMMUNICATIONS"
        title="Notifications"
        reason="General notification delivery logs are not enabled for the Dubai MVP; cancellation voucher dispatch is available below."
      />
      {error && <div role="alert" className="admin-empty-state">{error}</div>}
      {loading && <p role="status">Loading cancellation voucher deliveries…</p>}

      <section className="admin-card" aria-label="Dispatch Cancellation Voucher" style={{ marginBottom: 20 }}>
        <h2>Trigger Client Email &amp; Supplier Webhook Voucher</h2>
        <div className="admin-filter-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <input aria-label="Booking ID" placeholder="Booking ID" value={bookingId} onChange={(e) => setBookingId(e.target.value)} className="admin-filter-select" />
          <input aria-label="Booking Reference" placeholder="Booking Ref" value={bookingReference} onChange={(e) => setBookingReference(e.target.value)} className="admin-filter-select" />
          <input aria-label="Supplier Cancellation Ref" placeholder="Supplier CX Ref" value={supplierCancellationRef} onChange={(e) => setSupplierCancellationRef(e.target.value)} className="admin-filter-select" />
          <input aria-label="Currency" placeholder="Currency (AED)" value={currency} onChange={(e) => setCurrency(e.target.value)} className="admin-filter-select" />
          <input aria-label="Penalty minor" placeholder="Penalty (minor)" value={penaltyMinor} onChange={(e) => setPenaltyMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Refund minor" placeholder="Refund (minor)" value={refundMinor} onChange={(e) => setRefundMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Idempotency key" placeholder="Idempotency key" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} className="admin-filter-select" />
          <button type="button" onClick={triggerDispatch} className="admin-button-primary">Dispatch Vouchers</button>
        </div>
        {dispatchStatus && <p role="status" style={{ marginTop: 10 }}>{dispatchStatus}</p>}
      </section>

      <DataTable
        columns={columns}
        data={deliveries}
        getRowId={(d) => d.id}
        emptyTitle={loading ? 'Loading voucher deliveries' : 'No cancellation vouchers dispatched yet'}
      />
    </div>
  )
}
