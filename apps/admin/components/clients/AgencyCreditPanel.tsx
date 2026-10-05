'use client'

import { useRef, useState } from 'react'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag } from '@/components/ops/ops-ui'
import { cancelAgencyCredit, decideAgencyCredit, executeAgencyCredit, getAgency, requestAgencyCreditLimit } from '@/lib/data/departments'
import { formatMinorUnits, parseMajorToMinor } from '@/lib/minor-units'
import { useCan } from '@/lib/auth/capabilities'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const

/**
 * Credit limit of one agency (ADR 0024). The server decides everything: a different approver, single use, and refusal of holds over
 * the limit. Amounts are integer minor units end to end; this component only converts what the operator types and formats what it reads.
 */
export function AgencyCreditPanel({ agencyId, version, busy, act }: { agencyId: string; version: number; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const can = useCan()
  const canManage = can('agency.manage')
  const detail = useOpsQuery(() => getAgency(agencyId), [agencyId, version])
  const [currency, setCurrency] = useState('AED'); const [amount, setAmount] = useState(''); const [reason, setReason] = useState('')
  const requestKey = useRef<string | null>(null)
  const minor = parseMajorToMinor(amount.trim(), currency.trim())
  const text = reason.trim()
  const newKey = () => (requestKey.current ??= crypto.randomUUID())
  return (
    <section className="workspace-panel" aria-label="Agency credit limit" data-testid="agency-credit" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Credit limit</h2>
      <OpsState state={detail.state} onRetry={detail.reload}>
        {(a) => {
          const c = a.credit
          if (!c) return <p style={note}>Credit information is not available.</p>
          const p = c.open
          return (
            <div style={{ display: 'grid', gap: 10 }}>
              {c.limit ? (
                <dl data-testid="credit-position" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, margin: 0 }}>
                  <div><dt style={note}>Limit</dt><dd style={{ margin: 0 }}><strong data-testid="credit-limit">{formatMinorUnits(c.limit.limitMinor, c.limit.currency)}</strong></dd></div>
                  <div><dt style={note}>Credit in use (pending holds + negative balance)</dt><dd style={{ margin: 0 }} data-testid="credit-committed">{c.committedUnavailable ? <em>Unavailable: the wallet, ledger and hold amounts are finance data the API role does not read</em> : formatMinorUnits(c.committedMinor ?? '0', c.limit.currency)}</dd></div>
                  <div><dt style={note}>Available</dt><dd style={{ margin: 0 }} data-testid="credit-available">{c.committedUnavailable ? <em>Unavailable</em> : formatMinorUnits(c.availableMinor ?? '0', c.limit.currency)}{c.nearLimit && <> <Tag tone="warn">near limit</Tag></>}</dd></div>
                  <div><dt style={note}>Overdue</dt><dd style={{ margin: 0 }} data-testid="credit-overdue">{!c.overdue ? <em>Unavailable</em> : c.overdue.state === 'HOLDS_REFUSED' ? <Tag tone="bad">{c.overdue.daysOverdue} days: holds refused</Tag> : c.overdue.state === 'NOTICE' ? <Tag tone="warn">{c.overdue.daysOverdue} days: notice</Tag> : 'None'}</dd></div>
                </dl>
              ) : <p style={note} data-testid="credit-none"><strong>No limit configured.</strong> Nothing is enforced for this agency.</p>}
              <p style={note}>A new hold that would take the agency over its limit is refused, with no override. Existing holds and bookings are not touched when a limit is lowered. Setting, changing or removing a limit needs a second person&apos;s approval. This is not a wallet or a payment.</p>
              {p && (
                <div data-testid="credit-request" style={{ display: 'grid', gap: 6 }}>
                  <p style={note}><Tag tone="warn">{p.status.toLowerCase()}</Tag>{' '}
                    {p.limitMinor === null ? 'Remove the limit' : <>Set the limit to <strong>{formatMinorUnits(p.limitMinor, p.currency ?? '')}</strong></>}
                    {p.previousLimitMinor !== null && p.currency ? <> (was {formatMinorUnits(p.previousLimitMinor, p.currency)})</> : null}. Reason: {p.reason}</p>
                  {p.canDecide && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                      <label style={lab}>Decision reason (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
                      <button type="button" className="admin-btn" disabled={busy || text.length < 3} data-testid="credit-approve" onClick={() => void act(async () => { await decideAgencyCredit(p.id, 'approve', text); setReason(''); return 'Approved.' })}>Approve</button>
                      <button type="button" className="admin-btn" disabled={busy || text.length < 3} data-testid="credit-reject" onClick={() => void act(async () => { await decideAgencyCredit(p.id, 'reject', text); setReason(''); return 'Rejected.' })}>Reject</button>
                    </div>
                  )}
                  {p.canCancel && <div><button type="button" className="admin-btn" disabled={busy} data-testid="credit-cancel" onClick={() => void act(async () => { await cancelAgencyCredit(p.id); return 'Request withdrawn.' })}>Withdraw request</button></div>}
                  {p.canExecute && <div><button type="button" className="admin-btn" disabled={busy} data-testid="credit-execute" onClick={() => void act(async () => { await executeAgencyCredit(p.id); return 'Credit limit applied.' })}>Apply credit limit</button></div>}
                </div>
              )}
              {!p && canManage && (
                <form data-testid="credit-form" onSubmit={(e) => { e.preventDefault() }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                  <label style={lab}>Currency<input className="input-wrap" value={currency} maxLength={3} size={4} onChange={(e) => { requestKey.current = null; setCurrency(e.target.value.toUpperCase()) }} /></label>
                  <label style={lab}>Limit<input className="input-wrap" inputMode="decimal" value={amount} onChange={(e) => { requestKey.current = null; setAmount(e.target.value) }} placeholder="e.g. 50000.00" /></label>
                  <label style={lab}>Reason (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => { requestKey.current = null; setReason(e.target.value) }} /></label>
                  <button type="submit" className="admin-btn" data-testid="credit-request-set" disabled={busy || minor === null || text.length < 3}
                    onClick={() => void act(async () => { await requestAgencyCreditLimit(agencyId, { requestId: newKey(), currency: currency.trim(), limitMinor: minor, reason: text }); requestKey.current = null; setAmount(''); setReason(''); return 'Credit limit requested; a second person must approve it.' })}>Request limit</button>
                  {c.limit && <button type="button" className="admin-btn" data-testid="credit-request-remove" disabled={busy || text.length < 3}
                    onClick={() => void act(async () => { await requestAgencyCreditLimit(agencyId, { requestId: newKey(), limitMinor: null, reason: text }); requestKey.current = null; setReason(''); return 'Removal requested; a second person must approve it.' })}>Request removal</button>}
                </form>
              )}
              {!p && canManage && amount.trim() !== '' && minor === null && <p role="note" style={{ ...note, color: '#8a1c1c' }}>Enter an amount with at most the currency&apos;s decimal places, for example 50000.00.</p>}
            </div>
          )
        }}
      </OpsState>
    </section>
  )
}
