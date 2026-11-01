'use client'

import { useState } from 'react'
import { COMPLIANCE_REPORT_MAX_DAYS } from '@bedbanks/contracts'
import { downloadComplianceReport } from '@/lib/data/operations'
import { describeActionError } from '@/lib/booking-actions-ui'

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

/**
 * Per-period compliance report download (ADR 0067 amendment 3). The API builds the report, attests it (SHA-256 over the records), refuses a period
 * over its record cap and audits every download as DATA_EXPORT evidence. The browser only saves the file it receives.
 */
export function ComplianceReportPanel() {
  const [from, setFrom] = useState(day(-29)); const [to, setTo] = useState(day(0))
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null); const [note, setNote] = useState<string | null>(null)
  async function run(format: 'json' | 'csv') {
    if (busy) return
    setBusy(format); setNote(null)
    try {
      const { blob, headers, requestId } = await downloadComplianceReport({ from, to, format })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `compliance-report-${from}-to-${to}.${format}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
      setNote(`Downloaded ${headers.get('x-compliance-records') ?? '?'} record(s). Records SHA-256 ${headers.get('x-compliance-records-sha256') ?? 'unavailable'}.${requestId ? ` Request ${requestId}.` : ''}`)
    } catch (error) { setNote(describeActionError(error).message) } finally { setBusy(null) }
  }
  return (
    <section className="workspace-panel" aria-label="Compliance report" data-testid="compliance-report" style={{ padding: '10px 14px', marginBottom: 12, fontSize: 12, color: 'var(--c-111111)' }}>
      <strong>Period report</strong>
      <span style={{ color: 'var(--c-444444)' }}> · every record of the period with counts, export coverage and an attestation hash; at most {COMPLIANCE_REPORT_MAX_DAYS} days. Each download is audited.</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--c-444444)' }}><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--c-444444)' }}><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="admin-btn" disabled={busy !== null || !from || !to} aria-busy={busy === 'csv'} onClick={() => void run('csv')}>{busy === 'csv' ? 'Preparing…' : 'Download CSV'}</button>
        <button type="button" className="admin-btn" disabled={busy !== null || !from || !to} aria-busy={busy === 'json'} onClick={() => void run('json')}>{busy === 'json' ? 'Preparing…' : 'Download JSON'}</button>
      </div>
      {note && <div role="status" style={{ marginTop: 6, wordBreak: 'break-all' }}>{note}</div>}
    </section>
  )
}
