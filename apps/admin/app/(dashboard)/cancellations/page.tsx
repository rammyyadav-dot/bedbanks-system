'use client'

import { useEffect, useState } from 'react'
import type { ConnectorDefinitionRead, ExecuteSupplierCancellationResult } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import {
  getConnectors,
  ingestConnectorInventory,
  executeSupplierCancellation,
} from '@/lib/data'
import { formatMinorUnits } from '@/lib/minor-units'

export default function CancellationsPage() {
  const [connectors, setConnectors] = useState<ConnectorDefinitionRead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        if (active) setError('Connector registry is unavailable. No fallback data is shown.')
      })
      .finally(() => {
        if (active) setLoading(false)
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

  const connectorColumns: DataTableColumn<ConnectorDefinitionRead>[] = [
    { key: 'name', header: 'Connector', render: (c) => c.name },
    { key: 'type', header: 'Transport', render: (c) => c.type },
    { key: 'version', header: 'Version', render: (c) => c.version },
    { key: 'health', header: 'Health', render: (c) => c.healthState },
    { key: 'status', header: 'Status', render: (c) => c.status },
  ]

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="BOOKINGS · CANCELLATIONS & GDS ADAPTERS"
        title="Supplier Cancellations & Real-Time Adapters"
        description="Execute idempotent bedbank/GDS cancellations, reconcile supplier penalty discrepancies, and ingest real-time XML/JSON inventory."
      />
      {error && <div role="alert" className="admin-empty-state">{error}</div>}
      {loading && <p role="status">Loading supplier connectors…</p>}

      <section className="admin-card" aria-label="Automated Supplier Cancellation Execution" style={{ marginBottom: 20 }}>
        <h2>Automated Supplier Cancellation Execution</h2>
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
          <div style={{ marginTop: 12, padding: 14, background: '#f5f8f9', borderRadius: 6, fontSize: 13, display: 'grid', gap: 6 }}>
            <div><strong>Execution State:</strong> {executionResult.executionStatus} · <strong>Refund State:</strong> {executionResult.refundStatus}</div>
            <div><strong>Supplier Cancellation Ref:</strong> {executionResult.supplierCancellationRef ?? 'None (reconciliation required)'}</div>
            <div><strong>Customer Liability / Refund:</strong> {formatMinorUnits(executionResult.customerLiabilityMinor, executionResult.currency)} / {formatMinorUnits(executionResult.refundMinor, executionResult.currency)}</div>
            <div><strong>Ledger Refund Entry ID:</strong> {executionResult.ledgerEntryId ?? 'Not posted'}</div>
            <div><strong>Dispatched Voucher IDs:</strong> {executionResult.voucherNotificationIds.length ? executionResult.voucherNotificationIds.join(', ') : 'None'}</div>
            {executionResult.discrepancyReviewRequired && (
              <div role="alert" style={{ color: '#9e2a2b', fontWeight: 600 }}>Discrepancy blocked automatic confirmation: supplier penalty ({formatMinorUnits(executionResult.supplierPenaltyMinor ?? '0', executionResult.currency)}) exceeds accepted customer liability.</div>
            )}
          </div>
        )}
      </section>

      <section className="admin-card" aria-label="Real-Time XML/JSON Inventory Ingestion" style={{ marginBottom: 20 }}>
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

      <DataTable
        columns={connectorColumns}
        data={connectors}
        getRowId={(c) => c.id}
        emptyTitle={loading ? 'Loading connectors' : 'No bedbank or GDS connectors registered'}
      />
    </div>
  )
}
