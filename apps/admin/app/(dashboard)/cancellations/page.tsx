'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { CancellationRow, ConnectorDefinitionRead, ExecuteSupplierCancellationResult } from '@bedbanks/contracts'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsCancellations } from '@/lib/data/operations'
import {
  getConnectors,
  ingestConnectorInventory,
  executeSupplierCancellation,
} from '@/lib/data'
import { formatMinorUnits } from '@/lib/minor-units'

export default function CancellationsPage() {
  const [connectors, setConnectors] = useState<ConnectorDefinitionRead[]>([])
  const [connectorsError, setConnectorsError] = useState<string | null>(null)
  const [bookingId, setBookingId] = useState('')
  const [connectorId, setConnectorId] = useState('')
  const [currency, setCurrency] = useState('AED')
  const [customerLiabilityMinor, setCustomerLiabilityMinor] = useState('25000')
  const [refundMinor, setRefundMinor] = useState('75000')
  const [reason, setReason] = useState('CUSTOMER_REQUEST')
  const [simulatedOutcome, setSimulatedOutcome] = useState<'confirmed' | 'rejected' | 'timeout'>('confirmed')
  const [simulatedSupplierPenaltyMinor, setSimulatedSupplierPenaltyMinor] = useState('25000')
  const [idempotencyKey, setIdempotencyKey] = useState('cx-op-2026-001')
  const [executionResult, setExecutionResult] = useState<ExecuteSupplierCancellationResult | null>(null)
  const [executionMessage, setExecutionMessage] = useState<string | null>(null)

  const [ingestFormat, setIngestFormat] = useState<'API_JSON' | 'XML_IN'>('XML_IN')
  const [ingestPayload, setIngestPayload] = useState(
    '<InventoryPush><InventoryItem><HotelCode>DXB-ATL-01</HotelCode><RoomCode>DLX-KING</RoomCode><RatePlanCode>RP-FLEX</RatePlanCode><StayDate>2026-12-20</StayDate><Occupancy>2</Occupancy><Allotment>8</Allotment><StopSell>false</StopSell><MinStay>1</MinStay><AmountMinor>95000</AmountMinor><AmountBasis>SELL</AmountBasis><Currency>AED</Currency></InventoryItem></InventoryPush>',
  )
  const [ingestStatus, setIngestStatus] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getConnectors()
      .then((rows) => {
        if (!active) return
        setConnectors(rows)
        if (rows[0]) setConnectorId(rows[0].id)
      })
      .catch(() => {
        if (active) setConnectorsError('Connector registry is unavailable.')
      })
    return () => { active = false }
  }, [])

  const handleExecuteCancellation = async () => {
    try {
      setExecutionMessage(null)
      const res = await executeSupplierCancellation({
        bookingId: bookingId.trim(),
        connectorId: connectorId || undefined,
        reason,
        idempotencyKey: idempotencyKey.trim(),
        requestedAt: new Date().toISOString(),
        expectedCustomerLiabilityMinor: customerLiabilityMinor.trim(),
        refundMinor: refundMinor.trim(),
        currency: currency.trim().toUpperCase(),
        simulatedSupplierOutcome: simulatedOutcome,
        simulatedSupplierPenaltyMinor: simulatedSupplierPenaltyMinor.trim(),
      })
      setExecutionResult(res)
      setExecutionMessage(`Supplier cancellation outcome: ${res.executionStatus} · Refund status: ${res.refundStatus}`)
    } catch (err) {
      setExecutionResult(null)
      setExecutionMessage(err instanceof Error ? err.message : 'Cancellation execution failed.')
    }
  }

  const handleIngestInventory = async () => {
    if (!connectorId) {
      setIngestStatus('Select an active connector first.')
      return
    }
    try {
      const parsedPayload = ingestFormat === 'API_JSON' ? JSON.parse(ingestPayload) : ingestPayload
      const res = await ingestConnectorInventory(connectorId, {
        idempotencyKey: `inv-${Date.now()}`,
        format: ingestFormat,
        payload: parsedPayload,
      })
      setIngestStatus(`Outcome: ${res.outcome} · Ingested rows: ${res.ingestedRows}${res.validationErrors.length ? ` · Errors: ${res.validationErrors.join(', ')}` : ''}`)
    } catch (err) {
      setIngestStatus(err instanceof Error ? err.message : 'Inventory ingestion failed.')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <OpsListPage<CancellationRow>
        eyebrow="CANCELLATIONS"
        title="Cancellations & refunds"
        description="Recorded cancellations compared with the refunds actually posted to the wallet ledger, plus supplier GDS adapter execution."
        load={getOpsCancellations}
        getRowId={(c) => c.bookingId}
        emptyTitle="No cancellations"
        emptyDescription="The query succeeded and this tenant has no cancellation records."
        columns={[
          { key: 'reference', header: 'Booking', render: (c) => <Link href={`/bookings/${c.bookingId}`} style={{ fontWeight: 600 }}>{c.reference}</Link> },
          { key: 'hotel', header: 'Hotel', render: (c) => c.hotelName ?? '—' },
          { key: 'checkIn', header: 'Check-in', render: (c) => c.checkIn ?? '—' },
          { key: 'total', header: 'Booking total', align: 'right', render: (c) => <Money minor={c.totalMinor} currency={c.currency} /> },
          { key: 'recorded', header: 'Refund recorded', align: 'right', render: (c) => <Money minor={c.refundMinor} currency={c.currency} /> },
          { key: 'posted', header: 'Refund posted', align: 'right', render: (c) => <Money minor={c.refundPosted} currency={c.currency} /> },
          { key: 'match', header: 'Reconciled', render: (c) => <Tag tone={c.refundMatches ? 'ok' : 'bad'}>{c.refundMatches ? 'MATCH' : 'MISMATCH'}</Tag> },
          { key: 'at', header: 'Cancelled', render: (c) => when(c.createdAt) },
        ]}
      />

      <section className="admin-card" aria-label="Automated Supplier Cancellation Execution">
        <h2>Automated Supplier Cancellation Execution</h2>
        {connectorsError && <p role="alert">{connectorsError}</p>}
        <div className="admin-filter-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <input aria-label="Booking ID" placeholder="Booking ID" value={bookingId} onChange={(e) => setBookingId(e.target.value)} className="admin-filter-select" />
          <select aria-label="Connector" value={connectorId} onChange={(e) => setConnectorId(e.target.value)} className="admin-filter-select">
            <option value="">Select Connector (optional)</option>
            {connectors.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
          </select>
          <input aria-label="Currency" placeholder="Currency (AED)" value={currency} onChange={(e) => setCurrency(e.target.value)} className="admin-filter-select" />
          <input aria-label="Idempotency key" placeholder="Idempotency key" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} className="admin-filter-select" />
          <input aria-label="Customer liability minor" placeholder="Customer liability (minor)" value={customerLiabilityMinor} onChange={(e) => setCustomerLiabilityMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Refund minor" placeholder="Customer refund (minor)" value={refundMinor} onChange={(e) => setRefundMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Supplier penalty minor" placeholder="Supplier penalty (minor)" value={simulatedSupplierPenaltyMinor} onChange={(e) => setSimulatedSupplierPenaltyMinor(e.target.value)} className="admin-filter-select" />
          <select aria-label="Supplier outcome" value={simulatedOutcome} onChange={(e) => setSimulatedOutcome(e.target.value as 'confirmed' | 'rejected' | 'timeout')} className="admin-filter-select">
            <option value="confirmed">Supplier CONFIRMED</option>
            <option value="timeout">Supplier TIMEOUT (UNKNOWN)</option>
            <option value="rejected">Supplier REJECTED</option>
          </select>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
          <input aria-label="Cancellation reason" placeholder="Reason code" value={reason} onChange={(e) => setReason(e.target.value)} className="admin-filter-select" />
          <button type="button" onClick={handleExecuteCancellation} className="admin-button-primary">Execute Supplier Cancellation</button>
        </div>
        {executionMessage && <p role="status" style={{ marginTop: 10 }}>{executionMessage}</p>}
        {executionResult && (
          <div style={{ marginTop: 12, padding: 14, background: 'var(--c-f6f6f4)', borderRadius: 6, fontSize: 13, display: 'grid', gap: 6 }}>
            <div><strong>Execution State:</strong> {executionResult.executionStatus} · <strong>Refund State:</strong> {executionResult.refundStatus}</div>
            <div><strong>Supplier Cancellation Ref:</strong> {executionResult.supplierCancellationRef ?? 'None (reconciliation required)'}</div>
            <div><strong>Customer Liability / Refund:</strong> {formatMinorUnits(executionResult.customerLiabilityMinor, executionResult.currency)} / {formatMinorUnits(executionResult.refundMinor, executionResult.currency)}</div>
            <div><strong>Ledger Refund Entry ID:</strong> {executionResult.ledgerEntryId ?? 'Not posted'}</div>
            <div><strong>Dispatched Voucher IDs:</strong> {executionResult.voucherNotificationIds.length ? executionResult.voucherNotificationIds.join(', ') : 'None'}</div>
            {executionResult.discrepancyReviewRequired && (
              <div role="alert" style={{ color: 'var(--c-b3141b)', fontWeight: 600 }}>Discrepancy blocked automatic confirmation: supplier penalty ({formatMinorUnits(executionResult.supplierPenaltyMinor ?? '0', executionResult.currency)}) exceeds accepted customer liability.</div>
            )}
          </div>
        )}
      </section>

      <section className="admin-card" aria-label="Real-Time XML/JSON Inventory Ingestion">
        <h2>Real-Time XML / JSON Inventory Adapter Ingestion</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <select aria-label="Payload format" value={ingestFormat} onChange={(e) => setIngestFormat(e.target.value as 'API_JSON' | 'XML_IN')} className="admin-filter-select">
              <option value="XML_IN">OTA / Bedbank XML (XML_IN)</option>
              <option value="API_JSON">Bedbank JSON Delta (API_JSON)</option>
            </select>
            <button type="button" onClick={handleIngestInventory} className="admin-button-secondary">Normalize &amp; Ingest Inventory</button>
          </div>
          <textarea
            aria-label="Raw inventory payload"
            rows={4}
            value={ingestPayload}
            onChange={(e) => setIngestPayload(e.target.value)}
            className="admin-filter-select"
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          {ingestStatus && <p role="status">{ingestStatus}</p>}
        </div>
      </section>
    </div>
  )
}
