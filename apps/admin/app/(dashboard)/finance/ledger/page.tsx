'use client'

import { useEffect, useState } from 'react'
import type { WalletLedgerSummaryRead } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { getWalletLedgerSummaries, postLedgerAdjustment } from '@/lib/data'
import { formatMinorUnits } from '@/lib/minor-units'

type LedgerRow = WalletLedgerSummaryRead['entries'][number] & { walletId: string }

export default function LedgerPage() {
  const [wallets, setWallets] = useState<WalletLedgerSummaryRead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedWalletId, setSelectedWalletId] = useState('')
  const [currency, setCurrency] = useState('AED')
  const [type, setType] = useState<'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE'>('REFUND')
  const [amountMinor, setAmountMinor] = useState('50000')
  const [authorizedRefundableMinor, setAuthorizedRefundableMinor] = useState('100000')
  const [reference, setReference] = useState('booking:bk_dubai_001')
  const [idempotencyKey, setIdempotencyKey] = useState('adj-2026-001')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const loadWallets = async () => {
    try {
      setLoading(true)
      const data = await getWalletLedgerSummaries()
      setWallets(data)
      if (data[0] && !selectedWalletId) {
        setSelectedWalletId(data[0].walletId)
        setCurrency(data[0].currency)
      }
      setError(null)
    } catch {
      setWallets([])
      setError('B2B Wallet & Ledger summaries are unavailable. No fallback data is shown.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadWallets()
  }, [])

  const submitAdjustment = async () => {
    try {
      setStatusMessage(null)
      const res = await postLedgerAdjustment({
        walletId: selectedWalletId || undefined,
        currency: currency.trim().toUpperCase(),
        type,
        amountMinor: amountMinor.trim(),
        authorizedRefundableMinor: type === 'REFUND' && authorizedRefundableMinor.trim() ? authorizedRefundableMinor.trim() : undefined,
        reference: reference.trim(),
        idempotencyKey: idempotencyKey.trim(),
      })
      await loadWallets()
      setStatusMessage(
        `Posted ${res.type} (${formatMinorUnits(res.amountMinor, res.currency)}) · Available B2B credit: ${formatMinorUnits(res.availableCreditMinor, res.currency)}`,
      )
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to post ledger adjustment.')
    }
  }

  const allEntries: LedgerRow[] = wallets.flatMap((w) =>
    w.entries.map((entry) => ({ ...entry, walletId: w.walletId })),
  )

  const columns: DataTableColumn<LedgerRow>[] = [
    { key: 'walletId', header: 'Wallet', render: (e) => e.walletId },
    { key: 'type', header: 'Type', render: (e) => e.type },
    { key: 'amount', header: 'Amount', render: (e) => formatMinorUnits(e.amountMinor, e.currency), align: 'right' },
    { key: 'reference', header: 'Reference', render: (e) => e.reference ?? '—' },
    { key: 'idempotencyKey', header: 'Idempotency Key', render: (e) => e.idempotencyKey },
    { key: 'immutableAt', header: 'Posted At (UTC)', render: (e) => e.immutableAt.slice(0, 19).replace('T', ' ') },
  ]

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="FINANCE · LEDGER ADJUSTMENTS"
        title="B2B Wallet Credit Limits & Ledger Adjustments"
        description="Connect cancellation refunds and commercial adjustments directly to B2B agency credit limits and append-only ledger tables."
      />
      {error && <div role="alert" className="admin-empty-state">{error}</div>}
      {loading && <p role="status">Loading B2B wallets and ledger entries…</p>}

      {wallets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>
          {wallets.map((w) => (
            <div key={w.walletId} className="admin-card" style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: '#698088' }}>WALLET · {w.currency} ({w.walletId})</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                Available Credit: {formatMinorUnits(w.availableCreditMinor, w.currency)}
              </div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                Credit Limit: {formatMinorUnits(w.creditLimitMinor, w.currency)} · Durable Balance: {formatMinorUnits(w.durableBalanceMinor, w.currency)}
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="admin-card" aria-label="Post B2B Ledger Adjustment" style={{ marginBottom: 20 }}>
        <h2>Post Idempotent Cancellation Refund / Ledger Adjustment</h2>
        <div className="admin-filter-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <select aria-label="Wallet" value={selectedWalletId} onChange={(e) => setSelectedWalletId(e.target.value)} className="admin-filter-select">
            <option value="">Auto-resolve by currency</option>
            {wallets.map((w) => <option key={w.walletId} value={w.walletId}>{w.walletId} ({w.currency})</option>)}
          </select>
          <select aria-label="Adjustment type" value={type} onChange={(e) => setType(e.target.value as 'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE')} className="admin-filter-select">
            <option value="REFUND">REFUND (Cancellation credit restore)</option>
            <option value="RELEASE">RELEASE (Hold release)</option>
            <option value="CREDIT">CREDIT (Agency top-up / waiver)</option>
            <option value="DEBIT">DEBIT (Penalty / receivable debit)</option>
          </select>
          <input aria-label="Currency" placeholder="Currency (AED)" value={currency} onChange={(e) => setCurrency(e.target.value)} className="admin-filter-select" />
          <input aria-label="Amount minor" placeholder="Amount minor units" value={amountMinor} onChange={(e) => setAmountMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Authorized refundable minor" placeholder="Max authorized refundable (minor)" value={authorizedRefundableMinor} onChange={(e) => setAuthorizedRefundableMinor(e.target.value)} className="admin-filter-select" />
          <input aria-label="Booking reference" placeholder="Reference (e.g. booking:id)" value={reference} onChange={(e) => setReference(e.target.value)} className="admin-filter-select" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <input aria-label="Idempotency key" placeholder="Idempotency key" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} className="admin-filter-select" />
          <button type="button" onClick={submitAdjustment} className="admin-button-primary">Post Ledger Adjustment</button>
        </div>
        {statusMessage && <p role="status" style={{ marginTop: 10 }}>{statusMessage}</p>}
      </section>

      <DataTable
        columns={columns}
        data={allEntries}
        getRowId={(e) => e.id}
        emptyTitle={loading ? 'Loading ledger entries' : 'No immutable ledger entries recorded'}
      />
    </div>
  )
}
