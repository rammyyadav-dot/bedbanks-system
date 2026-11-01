'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { HOTEL_DEAL_KIND_INFO } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { useCan } from '@/lib/auth/capabilities'
import { describeApiError } from '@/lib/api/describe-error'
import { decideDealApproval, executeDealApproval, getDealApprovalQueue, withdrawDeal } from '@/lib/data/hotel-deals'
import { DealStatusTag } from './DealStatusTag'
import { ReasonDialog } from './ReasonDialog'

type Ask = { kind: 'approve' | 'reject'; approvalId: string; code: string } | { kind: 'activate'; approvalId: string; code: string }

/**
 * Promotions waiting for a second person, or approved and waiting to go live. The queue shows what each would do and what validation found now, so a
 * reviewer decides on the current catalogue. The API refuses the maker deciding their own request; the buttons shown come from its own flags.
 */
export function DealApprovalQueue() {
  const canManage = useCan()('supply.rates.manage')
  const { state, reload } = useOpsQuery(() => getDealApprovalQueue(), [])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  async function act(work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); setAsk(null); reload() } catch (error) { setNotice({ tone: 'bad', text: describeApiError(error, 'complete this step') }); setAsk(null) } finally { inFlight.current = false; setBusy(false) }
  }

  return (
    <section aria-label="Approval queue" data-testid="deal-queue">
      {notice ? <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} style={{ margin: '8px 0', padding: notice.tone === 'ok' ? '8px 12px' : undefined }}>{notice.text}</div> : null}
      <OpsState state={state} onRetry={reload} isEmpty={(items) => items.length === 0} empty={{ title: 'Nothing is waiting', description: 'No promotion is waiting for approval or activation.' }}>
        {(items) => (
          <div className="workspace-panel">
            <ScrollRegion label="Promotions awaiting a decision">
              <table style={tableStyle} aria-label="Promotions awaiting a decision">
                <thead><tr>{['Promotion', 'Hotel', 'What it does', 'Plans', 'Checks now', 'Request', 'Decision'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{items.map((item) => {
                  const blockers = item.validation.filter((issue) => issue.severity === 'ERROR'); const warnings = item.validation.filter((issue) => issue.severity === 'WARNING')
                  return (
                    <tr key={item.deal.id} data-testid={`queue-${item.deal.id}`}>
                      <td style={td}><Link href={`/commercial/promotions/${encodeURIComponent(item.deal.id)}`}><strong>{item.deal.name}</strong></Link><div style={{ fontSize: 10 }}><code>{item.deal.code}</code> · {HOTEL_DEAL_KIND_INFO[item.deal.kind].label} · v{item.deal.version}</div><DealStatusTag status={item.deal.status} effective={item.deal.effectiveStatus} /></td>
                      <td style={td}>{item.deal.hotelName}</td>
                      <td style={td}>{item.summary}<div style={{ fontSize: 10 }}>{item.deal.activeFrom ?? 'from approval'} → {item.deal.activeTo ?? 'open'}</div></td>
                      <td style={td}>{item.ratePlanCount}</td>
                      <td style={td}>
                        {blockers.length === 0 && warnings.length === 0 ? <Tag tone="ok">NO FINDINGS</Tag> : null}
                        {blockers.length ? <div><Tag tone="bad">{blockers.length} BLOCKER{blockers.length === 1 ? '' : 'S'}</Tag><ul style={{ margin: '4px 0 0', paddingLeft: 14, fontSize: 10 }}>{blockers.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div> : null}
                        {warnings.length ? <div style={{ marginTop: 4 }}><Tag tone="warn">{warnings.length} WARNING{warnings.length === 1 ? '' : 'S'}</Tag><ul style={{ margin: '4px 0 0', paddingLeft: 14, fontSize: 10 }}>{warnings.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div> : null}
                      </td>
                      <td style={td}>{item.approval.reason}<div style={{ fontSize: 10 }}>by {item.approval.requestedById}</div></td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {!canManage ? <span style={{ fontSize: 10 }}>View only</span> : <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {item.approval.canDecide ? <>
                            <button type="button" className="admin-btn" disabled={busy || blockers.length > 0} title={blockers.length ? 'Resolve the blockers first' : undefined} onClick={() => setAsk({ kind: 'approve', approvalId: item.approval.id, code: item.deal.code })}>Approve</button>
                            <button type="button" className="admin-btn admin-btn-danger" disabled={busy} onClick={() => setAsk({ kind: 'reject', approvalId: item.approval.id, code: item.deal.code })}>Reject</button>
                          </> : null}
                          {item.approval.canExecute ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy || blockers.length > 0} onClick={() => setAsk({ kind: 'activate', approvalId: item.approval.id, code: item.deal.code })}>Activate</button> : null}
                          {item.deal.status === 'PENDING_APPROVAL' && item.approval.canCancel ? <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await withdrawDeal(item.deal.id); return `${item.deal.code} was withdrawn and is a new draft version.` })}>Withdraw</button> : null}
                          {item.approval.status === 'PENDING' && !item.approval.canDecide ? <span style={{ fontSize: 10 }}>{item.approval.canCancel ? 'You made this request; a different person must decide it.' : 'Waiting for a reviewer.'}</span> : null}
                        </span>}
                      </td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </ScrollRegion>
          </div>
        )}
      </OpsState>
      <ReasonDialog open={ask !== null && ask.kind !== 'activate'} title={ask?.kind === 'reject' ? `Reject ${ask.code}` : `Approve ${ask?.code ?? ''}`} confirmLabel={ask?.kind === 'reject' ? 'Reject' : 'Approve'} tone={ask?.kind === 'reject' ? 'danger' : 'primary'} busy={busy}
        onCancel={() => setAsk(null)} onConfirm={(reason) => { if (ask && ask.kind !== 'activate') void act(async () => { await decideDealApproval(ask.approvalId, ask.kind, { reason }); return ask.kind === 'approve' ? `${ask.code} approved. It sells nothing until someone activates it.` : `${ask.code} rejected. The reason is kept with the request.` }) }}>
        {ask?.kind === 'reject' ? 'The reason is recorded and shown to the person who made the request.' : 'Approving records your decision on exactly the terms shown. It does not put the promotion on sale.'}
      </ReasonDialog>
      <ReasonDialog open={ask?.kind === 'activate'} title={`Activate ${ask?.code ?? ''}`} confirmLabel="Activate" reasonOptional busy={busy} onCancel={() => setAsk(null)}
        onConfirm={() => { if (ask?.kind === 'activate') void act(async () => { await executeDealApproval(ask.approvalId); return `${ask.code} is activated. Search and recheck now price with it.` }) }}>
        Activating makes agents see the discounted price for the selected rate plans immediately (or from its start date). The terms are checked again first; if anything changed since approval, nothing is activated.
      </ReasonDialog>
    </section>
  )
}
