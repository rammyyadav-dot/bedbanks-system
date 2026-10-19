'use client'

import { useState } from 'react'
import { describeApiError } from '@/lib/api/describe-error'
import { IMPORT_TEMPLATE, issuesToCsv } from '@/lib/calendar-tools'
import { LargeChangeConfirm } from '@/components/commercial/LargeChangeConfirm'
import { applyCalendar, previewCalendarImport, type CalendarImportPreview } from '@/lib/data'
import { CalendarReview } from './CalendarReview'
import { ScrollRegion, td, th, tableStyle } from '../ui'

const MAX_BYTES = 90_000
const download = (name: string, text: string) => { const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url) }

/**
 * CSV import of rates and availability (ADR 0057, S7). The file is checked row by row on the server; accepted rows are shown as an exact
 * before/after review and applied atomically through the normal calendar apply. Rejected rows are listed, downloadable as an error file, and
 * are NOT applied: the operator must say so explicitly.
 */
export function CalendarImport({ hotelId, planCodeById, onApplied }: { hotelId: string; planCodeById: (id: string) => string; onApplied: () => void }) {
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<CalendarImportPreview | null>(null)
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false)
  const [confirmLarge, setConfirmLarge] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  async function pick(file: File | undefined) {
    setResult(null); setMessage(null); setAck(false); setConfirmLarge(false)
    if (!file) return
    if (file.size > MAX_BYTES) { setCsv(''); setFileName(null); return setMessage({ kind: 'error', text: `The file is ${file.size} bytes; the limit is ${MAX_BYTES}. Split it (one review covers at most 366 cells).` }) }
    setCsv(await file.text()); setFileName(file.name)
  }
  async function check() {
    setBusy(true); setMessage(null); setResult(null); setAck(false); setConfirmLarge(false)
    try { setResult(await previewCalendarImport({ hotelId, csv })) } catch (e) { setMessage({ kind: 'error', text: describeApiError(e, 'check the file') }) } finally { setBusy(false) }
  }
  async function apply() {
    if (!result?.edit) return
    setBusy(true); setMessage(null)
    try { const done = await applyCalendar({ ...result.edit, ...(confirmLarge ? { confirmLargeChanges: true } : {}) }); setMessage({ kind: 'ok', text: `Applied ${done.affectedCells} cell(s) atomically. ${result.stats.rejectedRows} rejected row(s) were not applied.` }); setResult(null); setCsv(''); setFileName(null); onApplied() } catch (e) { setMessage({ kind: 'error', text: describeApiError(e, 'apply the import') }) } finally { setBusy(false) }
  }
  const issues = result ? [...result.fatal, ...result.errors] : []
  const needsAck = (result?.stats.rejectedRows ?? 0) > 0
  const largeWarnings = (result?.preview?.largePriceChanges ?? []).map((c) => `${c.stayDate}: ${c.warning}`)

  return (
    <section aria-label="Import rates from a CSV file" style={{ display: 'grid', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 11, color: '#3f565c' }}>Columns: <code>plan_code</code> (or <code>plan_id</code>), <code>date</code>, <code>amount</code> + <code>basis</code> (NET or SELL, never assumed), optional <code>allotment</code>, <code>stop_sell</code>, <code>min_stay</code>, <code>release_days</code> (a check-in release for that night, or <code>plan</code> to use the plan release), <code>occupancy</code>, <code>currency</code>. Amounts are plain major units, no separators or symbols.{' '}
        <button type="button" className="admin-btn" onClick={() => download('rate-import-template.csv', IMPORT_TEMPLATE)}>Download template</button></p>
      <label style={{ fontSize: 11 }}>CSV file <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void pick(e.target.files?.[0])} /></label>
      <label style={{ fontSize: 11 }}>…or paste the file contents <textarea aria-label="CSV text" rows={4} value={csv} onChange={(e) => { setCsv(e.target.value); setFileName(null); setResult(null); setAck(false); setConfirmLarge(false) }} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} /></label>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="admin-btn admin-btn-primary" disabled={busy || csv.trim() === ''} onClick={check}>{busy && !result ? 'Checking…' : 'Check file'}</button>
        {fileName ? <span style={{ fontSize: 11 }}>{fileName}</span> : null}
      </span>
      {result ? (
        <div data-testid="import-result" style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12 }}><strong>{result.stats.acceptedRows}</strong> of {result.stats.dataRows} rows accepted · <strong>{result.stats.rejectedRows}</strong> rejected{result.stats.identicalDuplicatesIgnored ? ` · ${result.stats.identicalDuplicatesIgnored} identical duplicate(s) ignored` : ''}</p>
          {issues.length ? (
            <>
              <ScrollRegion label="Rejected rows" maxHeight={220}>
                <table style={tableStyle} aria-label="Rejected rows"><thead><tr>{['Line', 'Problem', 'Detail'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{issues.map((i, n) => <tr key={n}><td style={td}>{i.line}</td><td style={td}><code>{i.code}</code></td><td style={td}>{i.message}</td></tr>)}</tbody></table>
              </ScrollRegion>
              {result.truncatedErrors ? <p style={{ margin: 0, fontSize: 11 }}>Only the first 200 problems are listed; the count above is complete.</p> : null}
              <span><button type="button" className="admin-btn" onClick={() => download('rate-import-errors.csv', issuesToCsv(issues))}>Download error file</button></span>
            </>
          ) : null}
          {result.preview ? <CalendarReview preview={result.preview} planCode={planCodeById} /> : result.fatal.length ? null : <p style={{ margin: 0, fontSize: 12 }}>No row was accepted, so there is nothing to apply.</p>}
          {result.edit && result.preview ? (
            <>
              {needsAck ? <label style={{ fontSize: 12 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand {result.stats.rejectedRows} rejected row(s) will NOT be applied.</label> : null}
              <LargeChangeConfirm warnings={largeWarnings} confirmed={confirmLarge} onChange={setConfirmLarge} />
              <span><button type="button" className="admin-btn admin-btn-primary" disabled={busy || (needsAck && !ack) || (largeWarnings.length > 0 && !confirmLarge)} onClick={apply}>{busy ? 'Applying…' : `Apply ${result.preview.affectedCells} accepted cell(s) atomically`}</button></span>
            </>
          ) : null}
        </div>
      ) : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a', fontSize: 12, margin: 0 }}>{message.text}</p> : null}
    </section>
  )
}
