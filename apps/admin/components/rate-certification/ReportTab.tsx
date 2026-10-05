'use client'

import { useState } from 'react'
import { RATE_CERTIFICATION_NOT_APPLICABLE } from '@bedbanks/contracts'
import { describeApiError } from '@/lib/api/describe-error'
import { getRateCertificationReport } from '@/lib/data/rate-certification'
import { downloadText } from '@/lib/rate-certification-ui'

/** Exports the audit as text the API generated from the same scan. The download is local; nothing is stored or sent anywhere. */
export function ReportTab({ window }: { window: { days: number } }) {
  const [busy, setBusy] = useState<'json' | 'markdown' | null>(null); const [error, setError] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null)
  async function exportReport(format: 'json' | 'markdown') {
    setBusy(format); setError(null); setDone(null)
    try {
      const report = await getRateCertificationReport({ format, days: window.days })
      downloadText(report.filename, report.mediaType, report.content)
      setDone(`${report.filename} generated ${new Date(report.generatedAt).toLocaleString()}`)
    } catch (e) { setError(describeApiError(e, 'generate the report')) } finally { setBusy(null) }
  }
  return (
    <div data-testid="report-tab">
      <div className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12 }}>Download the audit for the selected window ({window.days} nights). It lists counts, hotel and plan names, finding codes and suggested next steps. It holds no credentials, guest data or supplier payloads.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void exportReport('markdown')}>{busy === 'markdown' ? 'Generating…' : 'Download Markdown'}</button>
          <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void exportReport('json')}>{busy === 'json' ? 'Generating…' : 'Download JSON'}</button>
        </div>
        {done && <p role="status" style={{ margin: 0, fontSize: 12 }} data-testid="report-done">{done}</p>}
        {error && <div className="admin-error" role="alert"><strong>Report failed</strong><span>{error}</span></div>}
      </div>
      <div className="workspace-panel" style={{ padding: 14, marginTop: 12 }} data-testid="not-applicable">
        <h2 style={{ margin: '0 0 6px', fontSize: 13 }}>Not applicable to fBeds</h2>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#3f565c' }}>These concepts exist in other bedbank pricing specifications. They are not part of this system, so they are not audited and never reported as passed.</p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: 'grid', gap: 4 }}>{RATE_CERTIFICATION_NOT_APPLICABLE.map((item) => <li key={item.concept}><strong>{item.concept}.</strong> {item.reason}</li>)}</ul>
      </div>
    </div>
  )
}
