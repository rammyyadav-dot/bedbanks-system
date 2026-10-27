'use client'

import { useState } from 'react'
import type { FinancePeriodCurrencyTotals, PeriodBlockerName } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { closeFinancePeriod, getFinancePeriods, previewFinancePeriod } from '@/lib/data/finance-periods'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-3f565c)' } as const
const note = { color: 'var(--c-3f565c)', fontSize: 11, margin: 0 } as const

const BLOCKER_TEXT: Record<PeriodBlockerName, string> = {
  PERIOD_NOT_ENDED: 'The month has not ended yet (a few minutes of grace are kept after midnight UTC).',
  PERIOD_ALREADY_CLOSED: 'This month is already closed.',
  PERIOD_NOT_NEXT: 'Months close in order with no gap: close the earlier month first.',
  INTEGRITY_ISSUES: 'The ledger integrity report has critical findings. Resolve them in Finance, Ledger integrity, then try again.',
  INTEGRITY_INCOMPLETE: 'The ledger is too large for one integrity scan, so nothing can be claimed. Closing is refused.',
}

function Totals({ totals }: { totals: FinancePeriodCurrencyTotals[] }) {
  if (totals.length === 0) return <p style={note}>No ledger entries up to this month end.</p>
  return (
    <ScrollRegion label="Control totals">
      <table style={tableStyle}>
        <thead><tr>{['Currency', 'Entries', 'Opening', 'Movement', 'Closing'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{totals.map(t => (
          <tr key={t.currency}>
            <td style={td}><strong>{t.currency}</strong></td><td style={td}>{t.entries}</td>
            <td style={{ ...td, textAlign: 'right' }}><Money minor={t.openingMinor} currency={t.currency} /></td>
            <td style={{ ...td, textAlign: 'right' }}><Money minor={t.movementMinor} currency={t.currency} /><div style={{ fontSize: 10 }}>{t.byType.map(b => `${b.type.toLowerCase()} ${b.entries}`).join(', ')}</div></td>
            <td style={{ ...td, textAlign: 'right' }}><Money minor={t.closingMinor} currency={t.currency} /></td>
          </tr>
        ))}</tbody>
      </table>
    </ScrollRegion>
  )
}

/**
 * Finance period close (ADR 0101). Preview reads the ledger and writes nothing. The server decides whether a month can close and
 * refuses with the reason; closing locks the month against new ledger entries and is never undone.
 */
export default function FinancePeriodsPage() {
  const canClose = useCan()('finance.period.close')
  const [page, setPage] = useState(1); const [version, setVersion] = useState(0)
  const [month, setMonth] = useState(''); const [text, setText] = useState('')
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewFinancePeriod>> | null>(null)
  const data = useOpsQuery(() => getFinancePeriods({ page }), [page, version])

  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage(null)
    try { await work() } catch (error) { setMessage(describeApiError(error)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Period close" description="Close a calendar month (UTC) of the ledger. Closing records the control totals per currency (opening plus movement equals closing), the integrity verdict and the hash chain heads, then locks the month: the database refuses any ledger entry dated inside it. A closed month is never reopened; a late correction is posted in the open month. Months close in order." />
      {message && <p role="status" data-testid="period-message" style={{ fontSize: 12 }}>{message}</p>}
      <section className="workspace-panel" aria-label="Close a month" style={{ padding: '12px 18px', marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={lab}>Month<input className="input-wrap" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPreview(null) }} data-testid="period-month" /></label>
          <button type="button" className="admin-btn" disabled={busy || !month} data-testid="period-preview" onClick={() => void run(async () => { setPreview(await previewFinancePeriod(month)) })}>Preview</button>
        </div>
        {preview && (
          <div data-testid="period-preview-result" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 12 }}>
              {preview.periodStart} to {preview.periodEnd} (end not included) · integrity <Tag tone={preview.integrityVerdict === 'CLEAN' ? 'ok' : preview.integrityVerdict === 'WARNINGS' ? 'warn' : 'bad'}>{preview.integrityVerdict.toLowerCase()}</Tag>
              {' '}· {preview.integrityCriticalCount} critical, {preview.integrityWarningCount} warnings
            </p>
            {preview.blockers.length > 0 && <ul style={{ fontSize: 12 }}>{preview.blockers.map(b => <li key={b}>{BLOCKER_TEXT[b]}</li>)}</ul>}
            <Totals totals={preview.totals} />
            {canClose && preview.closable && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 8 }}>
                <label style={lab}>Note (optional)<input className="input-wrap" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} data-testid="period-note" /></label>
                <button type="button" className="admin-btn" disabled={busy} data-testid="period-close" onClick={() => {
                  if (!window.confirm(`Close ${preview.month}? The month is locked against new ledger entries and cannot be reopened.`)) return
                  void run(async () => { await closeFinancePeriod(preview.month, text.trim() || undefined); setMessage(`Closed ${preview.month}.`); setPreview(null); setText(''); setVersion(v => v + 1) })
                }}>Close month</button>
              </div>
            )}
            {!canClose && preview.closable && <p style={note}>You can preview but not close: closing needs the finance.period.close permission.</p>}
          </div>
        )}
      </section>
      <h2 style={{ fontSize: 14, marginTop: 16 }}>Closed months</h2>
      <OpsState state={data.state} onRetry={data.reload}>
        {(d) => d.items.length === 0 ? <p style={note}>No month has been closed yet.</p> : (
          <div className="workspace-panel">
            {d.items.map(p => (
              <div key={p.id} data-testid="period-closed" style={{ padding: '10px 18px', borderBottom: '1px solid var(--c-edf2f3)' }}>
                <strong>{p.month}</strong> <Tag tone={p.integrityVerdict === 'CLEAN' ? 'ok' : 'warn'}>{p.integrityVerdict.toLowerCase()}{p.warningCount ? ` (${p.warningCount} warnings)` : ''}</Tag> closed {when(p.closedAt)}
                {p.note && <div style={{ fontSize: 11 }}>{p.note}</div>}
                <Totals totals={p.totals} />
              </div>
            ))}
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}
