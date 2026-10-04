'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentFundingView } from '@bedbanks/contracts'
import { declareFundingReceipt, getFundingReceipts } from '@/lib/api-client'
import { formatMinorAmount } from '@/lib/format'
import { parseMajorAmount } from '@/lib/search-filters'

const STATUS: Record<string, string> = { DECLARED: 'Waiting for finance', VERIFIED: 'Verified, not yet credited', POSTED: 'Credited', REJECTED: 'Rejected' }

/**
 * Tell finance about a bank transfer the agency has sent (ADR 0028 slice 2). The agency comes from the user's membership on the server.
 * A declaration adds nothing to any balance: finance checks it against the bank statement and only then credits the account.
 */
export function AgentFunding({ tenantId }: { tenantId: string }) {
  const [view, setView] = useState<AgentFundingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [amount, setAmount] = useState(''); const [reference, setReference] = useState(''); const [valueDate, setValueDate] = useState(''); const [payerName, setPayerName] = useState('')
  const [method, setMethod] = useState<'BANK_TRANSFER' | 'CASH_DEPOSIT'>('BANK_TRANSFER'); const [payerType, setPayerType] = useState<'AGENCY' | 'THIRD_PARTY'>('AGENCY')
  const key = useRef<string | null>(null)

  const load = useCallback(() => {
    getFundingReceipts(tenantId).then(v => { setView(v); setError(null) }, (e: unknown) => setError(e instanceof Error && e.message === 'Access denied' ? 'Your role cannot see agency payments.' : 'Payments could not be loaded.'))
  }, [tenantId])
  useEffect(() => { load() }, [load])

  const parsed = parseMajorAmount(amount, 'AED')
  const ready = parsed.state === 'minor' && parsed.minor > 0 && reference.trim() && valueDate && payerName.trim()

  async function submit() {
    if (parsed.state !== 'minor') return
    setBusy(true); setMessage(null)
    try {
      await declareFundingReceipt(tenantId, { currency: 'AED', amountMinor: String(parsed.minor), method, bankReference: reference, valueDate, payerName, payerType, requestId: (key.current ??= crypto.randomUUID()) })
      key.current = null; setAmount(''); setReference(''); setPayerName('')
      setMessage('Sent to finance. Your balance changes only after finance confirms the money arrived.')
      load()
    } catch {
      setMessage('The payment could not be declared. Check the details; a reference can only be declared once.')
    } finally { setBusy(false) }
  }

  if (error) return <div className="portal-panel" role="status"><p>{error}</p></div>
  if (!view) return <div className="portal-panel" role="status"><p>Loading payments…</p></div>
  if (!view.agency) return <div className="portal-panel" role="status"><p>Your user is not linked to an agency, so payments cannot be declared here.</p></div>

  return (
    <div className="portal-panel" aria-label="Agency payments" data-testid="agent-funding">
      <span className="portal-eyebrow">PAYMENTS TO FBEDS</span>
      <h2>Tell us about a bank transfer</h2>
      {!view.enabled
        ? <p role="status">Declaring payments is not enabled for this workspace yet.</p>
        : <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label>Amount (AED)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} data-testid="agent-funding-amount" /></label>
            <label>Bank reference<input maxLength={80} value={reference} onChange={e => setReference(e.target.value)} /></label>
            <label>Date received<input type="date" value={valueDate} onChange={e => setValueDate(e.target.value)} /></label>
            <label>Paid by<input maxLength={140} value={payerName} onChange={e => setPayerName(e.target.value)} /></label>
            <label>Method<select value={method} onChange={e => setMethod(e.target.value as typeof method)}><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH_DEPOSIT">Cash deposit</option></select></label>
            <label>Payer<select value={payerType} onChange={e => setPayerType(e.target.value as typeof payerType)}><option value="AGENCY">{view.agency.name}</option><option value="THIRD_PARTY">Someone else</option></select></label>
            <button className="portal-primary" disabled={busy || !ready} onClick={() => void submit()} data-testid="agent-funding-declare">Declare payment</button>
          </div>
          {(method === 'CASH_DEPOSIT' || payerType === 'THIRD_PARTY') && <p>Cash and payments from someone else are reviewed by compliance before they are credited.</p>}
        </>}
      {message && <p role="status">{message}</p>}
      {view.receipts.length > 0 && (
        <table className="booking-table" aria-label="Declared payments">
          <thead><tr><th>Declared</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead>
          <tbody>{view.receipts.map(r => (
            <tr key={r.id}><td>{r.declaredAt.slice(0, 10)}</td><td>{formatMinorAmount(r.amountMinor, r.currency)}</td><td>{r.bankReference}</td>
              <td>{STATUS[r.status] ?? r.status}{r.rejectionReason ? `: ${r.rejectionReason}` : ''}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}
