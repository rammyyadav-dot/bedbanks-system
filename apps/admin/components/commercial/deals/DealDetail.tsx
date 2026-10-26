'use client'

import { useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { HOTEL_DEAL_KIND_INFO, type HotelDealDetail, type HotelDealIssue } from '@bedbanks/contracts'
import { Tabs } from '@/components/common/Tabs'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { useCan } from '@/lib/auth/capabilities'
import { describeApiError } from '@/lib/api/describe-error'
import { ApiResponseError } from '@/lib/api/errors'
import { archiveDeal, decideDealApproval, executeDealApproval, getDeal, getDealAuditLog, getDealPerformance, pauseDeal, resumeDeal, returnDealToDraft, submitDeal, suspendDeal, validateDeal, withdrawDeal } from '@/lib/data/hotel-deals'
import { WEEKDAY_LABELS, describeTerms, issueMessages } from '@/lib/hotel-deal-form'
import { formatMinorUnits } from '@/lib/minor-units'
import { DealPreview } from './DealPreview'
import { DealStatusTag } from './DealStatusTag'
import { ReasonDialog } from './ReasonDialog'

type Action = 'submit' | 'approve' | 'reject' | 'activate' | 'pause' | 'suspend' | 'return' | 'archive'
const panel: React.CSSProperties = { padding: '16px 18px', display: 'grid', gap: 10, marginBottom: 12 }
const percent = (bp: number | null) => (bp === null ? '—' : `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`)
const money = (minor: string | null, currency: string | null) => (minor === null || currency === null ? '—' : formatMinorUnits(minor, currency))

function Row({ name, children }: { name: string; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 200px) 1fr', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--c-edf2f3)' }}><dt style={{ color: 'var(--c-3f565c)' }}>{name}</dt><dd style={{ margin: 0, color: 'var(--c-17333e)' }}>{children}</dd></div>
}

function Issues({ issues }: { issues: HotelDealIssue[] }) {
  if (issues.length === 0) return <p style={{ margin: 0, fontSize: 12 }}><Tag tone="ok">VALID</Tag> No findings against the current catalogue.</p>
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }} aria-label="Validation findings">
      {issues.map((issue, index) => <li key={index} style={{ fontSize: 12 }}><Tag tone={issue.severity === 'ERROR' ? 'bad' : 'warn'}>{issue.severity === 'ERROR' ? 'BLOCKER' : 'WARNING'}</Tag> {issue.message} <code style={{ fontSize: 10 }}>{issue.code}</code></li>)}
    </ul>
  )
}

/**
 * One promotion: its terms, scope, validation, approval, lifecycle actions, simulator, audit history and performance. The buttons come from the API's own
 * capability flags for this user and this state; the API still refuses anything that is not allowed.
 */
export function DealDetail({ dealId }: { dealId: string }) {
  const canManage = useCan()('supply.rates.manage')
  const saved = useSearchParams().get('saved') === '1'
  const { state, reload, refresh } = useOpsQuery(() => getDeal(dealId), [dealId])
  const [ask, setAsk] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string; details?: string[] } | null>(saved ? { tone: 'ok', text: 'Draft saved. It sells nothing until it is validated, submitted, approved and activated.' } : null)

  async function act(work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); setAsk(null); refresh() }
    catch (error) { setAsk(null); setNotice({ tone: 'bad', text: describeApiError(error, 'complete this step'), details: error instanceof ApiResponseError ? issueMessages(error) : undefined }) }
    finally { inFlight.current = false; setBusy(false) }
  }

  return (
    <OpsState state={state} onRetry={reload}>
      {(deal) => {
        const caps = deal.capabilities
        const version = { expectedVersion: deal.version }
        return (
          <div data-testid="deal-detail">
            <header style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'start', marginBottom: 12 }}>
              <div>
                <h1 style={{ fontSize: 20, margin: 0 }}>{deal.name} <span style={{ fontSize: 12, fontWeight: 400 }}>v{deal.version}</span></h1>
                <p style={{ margin: '4px 0', fontSize: 12, color: 'var(--c-3f565c)' }}><code>{deal.code}</code> · {HOTEL_DEAL_KIND_INFO[deal.kind].label} · {deal.hotelName} · {describeTerms(deal.terms)}</p>
                <DealStatusTag status={deal.status} effective={deal.effectiveStatus} />
                {deal.statusReason ? <p style={{ margin: '4px 0 0', fontSize: 11 }}>Reason: {deal.statusReason}</p> : null}
              </div>
              {canManage ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Promotion actions">
                  {caps.canEdit ? <Link className="admin-btn" href={`/commercial/promotions/${encodeURIComponent(deal.id)}/edit`}>Edit draft</Link> : null}
                  {caps.canValidate ? <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { const result = await validateDeal(deal.id); return result.valid ? 'Valid: no blocking findings.' : `${result.issues.filter((i) => i.severity === 'ERROR').length} blocking finding(s). See Validation below.` })}>Validate</button> : null}
                  {caps.canSubmit ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={() => setAsk('submit')}>Submit for approval</button> : null}
                  {caps.canWithdraw ? <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await withdrawDeal(deal.id); return 'Withdrawn. It is a new draft version you can edit.' })}>Withdraw request</button> : null}
                  {caps.canApprove ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={() => setAsk('approve')}>Approve</button> : null}
                  {caps.canReject ? <button type="button" className="admin-btn admin-btn-danger" disabled={busy} onClick={() => setAsk('reject')}>Reject</button> : null}
                  {caps.canActivate ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={() => setAsk('activate')}>Activate</button> : null}
                  {caps.canPause ? <button type="button" className="admin-btn" disabled={busy} onClick={() => setAsk('pause')}>Pause</button> : null}
                  {caps.canResume ? <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await resumeDeal(deal.id, version); return 'Resumed.' })}>Resume</button> : null}
                  {caps.canSuspend ? <button type="button" className="admin-btn admin-btn-danger" disabled={busy} onClick={() => setAsk('suspend')}>Suspend</button> : null}
                  {caps.canReturnToDraft ? <button type="button" className="admin-btn" disabled={busy} onClick={() => setAsk('return')}>Return to draft</button> : null}
                  {caps.canArchive ? <button type="button" className="admin-btn" disabled={busy} onClick={() => setAsk('archive')}>Archive</button> : null}
                </div>
              ) : <p style={{ fontSize: 11 }}>You can view this promotion but not change it.</p>}
            </header>

            {notice ? <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} style={{ marginBottom: 12, padding: notice.tone === 'ok' ? '8px 12px' : undefined }} data-testid="deal-notice">{notice.text}{notice.details?.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{notice.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul> : null}</div> : null}

            <Tabs defaultTab="overview" tabs={[
              { id: 'overview', label: 'Overview', content: <Overview deal={deal} /> },
              { id: 'simulator', label: 'Simulator', content: deal.ratePlans.length ? <DealPreview dealId={deal.id} version={deal.version} plans={deal.ratePlans} /> : <p>This promotion has no rate plan to price.</p> },
              { id: 'audit', label: 'Approval and audit history', content: <AuditTab dealId={deal.id} version={deal.version} /> },
              { id: 'performance', label: 'Performance and operations', content: <PerformanceTab dealId={deal.id} version={deal.version} /> },
            ]} />

            <ReasonDialog open={ask === 'submit'} title={`Submit ${deal.code} for approval`} confirmLabel="Submit" busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await submitDeal(deal.id, { expectedVersion: deal.version, requestId: `submit-${crypto.randomUUID()}`, reason }); return 'Submitted. A different person must approve exactly these terms. The deal is locked while it waits.' })}>
              The terms are validated again now. If any blocking finding exists, nothing is submitted. Say what the reviewer should know.
            </ReasonDialog>
            <ReasonDialog open={ask === 'approve' || ask === 'reject'} title={ask === 'reject' ? `Reject ${deal.code}` : `Approve ${deal.code}`} confirmLabel={ask === 'reject' ? 'Reject' : 'Approve'} tone={ask === 'reject' ? 'danger' : 'primary'} busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await decideDealApproval(deal.approval!.id, ask === 'reject' ? 'reject' : 'approve', { reason }); return ask === 'reject' ? 'Rejected. The reason is kept and the maker can return it to draft.' : 'Approved. It sells nothing until someone activates it.' })}>
              {ask === 'reject' ? 'The reason is recorded and shown to the person who made the request.' : 'You approve exactly the terms and rate plans shown on this page.'}
            </ReasonDialog>
            <ReasonDialog open={ask === 'activate'} title={`Activate ${deal.code}`} confirmLabel="Activate" reasonOptional busy={busy} onCancel={() => setAsk(null)}
              onConfirm={() => void act(async () => { await executeDealApproval(deal.approval!.id); return 'Activated. Search and recheck now price with it.' })}>
              Agents will see the discounted price for {deal.ratePlans.length} rate plan(s) {deal.terms.activeFrom ? `from ${deal.terms.activeFrom}` : 'immediately'}. The terms are checked again first; if anything changed since approval, nothing is activated.
            </ReasonDialog>
            <ReasonDialog open={ask === 'pause'} title={`Pause ${deal.code}`} confirmLabel="Pause" busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await pauseDeal(deal.id, { ...version, reason }); return 'Paused. Agents see the base price again. You can resume it later.' })}>Pausing stops the discount at once.</ReasonDialog>
            <ReasonDialog open={ask === 'suspend'} title={`Suspend ${deal.code}`} confirmLabel="Suspend" tone="danger" busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await suspendDeal(deal.id, { ...version, reason }); return 'Suspended. It cannot resume: make a new version and have it approved again.' })}>
              Use this when something is wrong with the deal or its prices. Stopping is always allowed; coming back needs a new version and a new approval.
            </ReasonDialog>
            <ReasonDialog open={ask === 'return'} title={`Return ${deal.code} to draft`} confirmLabel="Return to draft" reasonOptional busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await returnDealToDraft(deal.id, { ...version, ...(reason ? { reason } : {}) }); return 'It is a new draft version. Any earlier approval can no longer activate it.' })}>The deal becomes version {deal.version + 1}. Earlier approvals no longer apply.</ReasonDialog>
            <ReasonDialog open={ask === 'archive'} title={`Archive ${deal.code}`} confirmLabel="Archive" reasonOptional busy={busy} onCancel={() => setAsk(null)}
              onConfirm={(reason) => void act(async () => { await archiveDeal(deal.id, { ...version, ...(reason ? { reason } : {}) }); return 'Archived. It stays in the history and can not be used again.' })}>Archiving is final. The record and its audit history are kept.</ReasonDialog>
          </div>
        )
      }}
    </OpsState>
  )
}

function Overview({ deal }: { deal: HotelDealDetail }) {
  const t = deal.terms
  return (
    <div>
      <section className="workspace-panel" style={panel} aria-label="Terms">
        <h2 style={{ fontSize: 14, margin: 0 }}>Terms</h2>
        <dl style={{ margin: 0 }}>
          <Row name="What it does">{describeTerms(t)}</Row>
          {t.minNights !== null && t.kind !== 'STAY_X_PAY_Y' && t.kind !== 'EVERY_NTH_FREE' ? <Row name="Minimum stay">{t.minNights} nights</Row> : null}
          <Row name="Applies to">{t.discountBase === 'ROOM_ONLY' ? 'Room rate only' : 'Room and guest lines'} · {t.stayWindowMode === 'NIGHTS_IN_WINDOW' ? 'only nights inside the travel window' : 'the whole stay inside the travel window'}</Row>
          <Row name="Travel period">{t.stayFrom ?? 'any'} → {t.stayTo ?? 'any'}</Row>
          <Row name="Booking window">{t.bookFrom ?? 'any'} → {t.bookTo ?? 'any'}</Row>
          <Row name="Days of the week">{t.weekdays.length ? t.weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ') : 'Every day'}</Row>
          <Row name="Active window">{t.activeFrom ?? 'from activation'} → {t.activeTo ?? 'open ended'} (hotel calendar)</Row>
          <Row name="Channels">{t.channels.length ? t.channels.join(', ') : 'Every channel'}</Row>
          <Row name="Source markets">{t.sourceMarkets.length ? t.sourceMarkets.join(', ') : 'All markets'}</Row>
          <Row name="Agencies">{t.agencyIds.length ? `${t.agencyIds.length} selected` : 'All agencies'}</Row>
          <Row name="Funding">Supplier funded</Row>
          <Row name="Guards">Maximum discount {percent(t.maxDiscountBp)} · minimum sell floor {money(t.minSellFloorMinor, t.currency ?? 'AED')} · minimum margin {percent(t.minMarginBp)}</Row>
          <Row name="Stacking">{t.combinable ? 'May stack with other combinable promotions' : 'Does not stack'}{t.stackingGroup ? ` · group ${t.stackingGroup}` : ''}{t.incompatibleDealIds.length ? ` · never with ${t.incompatibleDealIds.length} promotion(s)` : ''} · priority {t.priority} (tie-break only)</Row>
          {t.publicDescription ? <Row name="Public description">{t.publicDescription}</Row> : null}
          {t.internalNotes ? <Row name="Internal notes">{t.internalNotes}</Row> : null}
          <Row name="Fingerprint">{deal.termsFingerprint ? <code style={{ fontSize: 10, wordBreak: 'break-all' }}>{deal.termsFingerprint}</code> : 'Not submitted yet'}</Row>
        </dl>
      </section>
      <section className="workspace-panel" style={panel} aria-label="Rate plans">
        <h2 style={{ fontSize: 14, margin: 0 }}>Rate plans ({deal.ratePlans.length})</h2>
        <ScrollRegion label="Rate plans in scope">
          <table style={tableStyle} aria-label="Rate plans in scope"><thead><tr>{['Room type', 'Plan', 'Plan status', 'Contract', 'Currency'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{deal.ratePlans.map((plan) => <tr key={plan.id}><td style={td}>{plan.roomTypeName}</td><td style={td}>{plan.code}</td><td style={td}><Tag tone={plan.status === 'ACTIVE' ? 'ok' : 'warn'}>{plan.status}</Tag></td><td style={td}><Tag tone={plan.contractStatus === 'ACTIVE' ? 'ok' : 'warn'}>{plan.contractStatus}</Tag></td><td style={td}>{plan.currency}</td></tr>)}</tbody>
          </table>
        </ScrollRegion>
      </section>
      <section className="workspace-panel" style={panel} aria-label="Validation"><h2 style={{ fontSize: 14, margin: 0 }}>Validation</h2><Issues issues={deal.validation} /></section>
      <section className="workspace-panel" style={panel} aria-label="Approval">
        <h2 style={{ fontSize: 14, margin: 0 }}>Approval</h2>
        {deal.approval ? (
          <dl style={{ margin: 0 }}>
            <Row name="State"><Tag tone={deal.approval.status === 'REJECTED' ? 'bad' : deal.approval.status === 'PENDING' ? 'warn' : 'ok'}>{deal.approval.status}</Tag></Row>
            <Row name="Requested by">{deal.approval.requestedById}: {deal.approval.reason}</Row>
            <Row name="Decided by">{deal.approval.decidedById ? `${deal.approval.decidedById}: ${deal.approval.decisionReason ?? ''}` : 'Not decided'}</Row>
          </dl>
        ) : <p style={{ margin: 0, fontSize: 12 }}>Not submitted. A promotion sells only after a different person approves it.</p>}
      </section>
    </div>
  )
}

function AuditTab({ dealId, version }: { dealId: string; version: number }) {
  const { state, reload } = useOpsQuery(() => getDealAuditLog(dealId), [dealId, version])
  return (
    <OpsState state={state} onRetry={reload} isEmpty={(trail) => trail.events.length === 0 && trail.approvals.length === 0} empty={{ title: 'No history', description: 'Nothing has been recorded for this promotion yet.' }}>
      {(trail) => (
        <div style={{ display: 'grid', gap: 12 }}>
          <section className="workspace-panel" style={panel} aria-label="Approval history">
            <h2 style={{ fontSize: 14, margin: 0 }}>Approval history</h2>
            {trail.approvals.length === 0 ? <p style={{ margin: 0, fontSize: 12 }}>No approval request yet.</p> : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>{trail.approvals.map((approval) => <li key={approval.id} style={{ fontSize: 12 }}><Tag tone={approval.status === 'REJECTED' ? 'bad' : approval.status === 'PENDING' ? 'warn' : 'ok'}>{approval.status}</Tag> requested {when(approval.createdAt)} by {approval.requestedById}: “{approval.reason}”{approval.decidedById ? ` · decided ${when(approval.decidedAt)} by ${approval.decidedById}: “${approval.decisionReason ?? ''}”` : ''}{approval.executedAt ? ` · activated ${when(approval.executedAt)}` : ''}</li>)}</ul>
            )}
          </section>
          <section className="workspace-panel" style={panel} aria-label="Audit log">
            <h2 style={{ fontSize: 14, margin: 0 }}>Audit log</h2>
            <ScrollRegion label="Audit events"><table style={tableStyle} aria-label="Audit events"><thead><tr>{['When', 'Action', 'By', 'Request', 'Detail'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{trail.events.map((event) => <tr key={event.id}><td style={td}>{when(event.at)}</td><td style={td}><code>{event.action}</code></td><td style={td}>{event.actorUserId ?? 'system'}</td><td style={td}><code style={{ fontSize: 10 }}>{event.requestId ?? '—'}</code></td><td style={{ ...td, maxWidth: 360, wordBreak: 'break-word', fontSize: 10 }}>{JSON.stringify(event.summary)}</td></tr>)}</tbody>
            </table></ScrollRegion>
          </section>
        </div>
      )}
    </OpsState>
  )
}

function PerformanceTab({ dealId, version }: { dealId: string; version: number }) {
  const { state, reload } = useOpsQuery(() => getDealPerformance(dealId), [dealId, version])
  return (
    <OpsState state={state} onRetry={reload}>
      {(perf) => (
        <div style={{ display: 'grid', gap: 12 }}>
          <section className="workspace-panel" style={panel} aria-label="Redemptions">
            <h2 style={{ fontSize: 14, margin: 0 }}>Redemptions and revenue</h2>
            <p style={{ margin: 0, fontSize: 12 }}><Tag tone="neutral">NOT AVAILABLE</Tag> {perf.redemptions.reason}</p>
          </section>
          <section className="workspace-panel" style={panel} aria-label="Channels">
            <h2 style={{ fontSize: 14, margin: 0 }}>Channel publication</h2>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>{perf.channels.map((channel) => <li key={channel.channel} style={{ fontSize: 12 }}><Tag tone={channel.published ? 'ok' : 'neutral'}>{channel.channel}: {channel.published ? 'PUBLISHED' : 'NOT PUBLISHED'}</Tag> {channel.reason}</li>)}</ul>
          </section>
          <section className="workspace-panel" style={panel} aria-label="Activation">
            <h2 style={{ fontSize: 14, margin: 0 }}>Activation</h2>
            <dl style={{ margin: 0 }}>
              <Row name="Stored status">{perf.status}</Row><Row name="Applies today">{perf.effectiveStatus}</Row>
              <Row name="Activated">{perf.activation.activatedAt ? when(perf.activation.activatedAt) : '—'}</Row>
              <Row name="Window">{perf.activation.activeFrom ?? 'from activation'} → {perf.activation.activeTo ?? 'open ended'}</Row>
              <Row name="Last status change">{perf.activation.lastStatusChangeAt ? when(perf.activation.lastStatusChangeAt) : '—'}</Row>
            </dl>
            <p style={{ margin: 0, fontSize: 10, color: 'var(--c-3f565c)' }}>Dates are enforced by the pricing evaluator in the hotel&apos;s calendar, so an expired or not-yet-started deal never sells even if its stored label is behind. Use “Update statuses” on the list to save the labels.</p>
          </section>
        </div>
      )}
    </OpsState>
  )
}
