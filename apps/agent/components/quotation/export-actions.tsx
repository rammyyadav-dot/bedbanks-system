'use client'

import { useEffect, useRef, useState } from 'react'
import type { QuotationExportFormat, QuotationExportJob } from '@bedbanks/contracts/agent'
import { QUOTATION_EXPORT_FORMATS } from '@bedbanks/contracts/agent'
import { getQuotationExportJob, requestQuotationExport } from '@/lib/api-client'

const newKey = () => `quote-export-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

const FORMAT_LABEL: Record<QuotationExportFormat, string> = { pdf: 'PDF proposal', xlsx: 'Excel proposal' }

/**
 * Starts PDF/Excel generation for a saved quotation and polls until the job reports READY or FAILED. The download
 * link only appears once the server returns a real signed URL — this never fabricates a success state while the
 * backend export pipeline doesn't exist yet or is unreachable (CLAUDE.md invariant 10).
 */
export function ExportActions({ tenantId, quotationId, disabled }: { tenantId: string; quotationId: string; disabled: boolean }) {
  const [job, setJob] = useState<QuotationExportJob | null>(null)
  const [pendingFormat, setPendingFormat] = useState<QuotationExportFormat | null>(null)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const poll = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      getQuotationExportJob(tenantId, quotationId, jobId)
        .then((next) => {
          setJob(next)
          if (next.status !== 'QUEUED' && pollRef.current) { clearInterval(pollRef.current); setPendingFormat(null) }
        })
        .catch((err) => {
          if (pollRef.current) clearInterval(pollRef.current)
          setPendingFormat(null)
          setError(err instanceof Error ? err.message : 'Could not check the export status')
        })
    }, 2_000)
  }

  const startExport = async (format: QuotationExportFormat) => {
    setError('')
    setPendingFormat(format)
    setJob(null)
    try {
      const created = await requestQuotationExport(tenantId, quotationId, format, newKey())
      setJob(created)
      if (created.status === 'QUEUED') poll(created.id)
      else setPendingFormat(null)
    } catch (err) {
      setPendingFormat(null)
      setError(err instanceof Error ? err.message : 'Could not start the export')
    }
  }

  return <section className="bb-quote-export" aria-labelledby="bb-quote-export-title">
    <h2 id="bb-quote-export-title">Export proposal</h2>
    <div className="bb-quote-export-actions">
      {QUOTATION_EXPORT_FORMATS.map((format) => (
        <button key={format} type="button" className="bb-quote-export-button" disabled={disabled || pendingFormat !== null}
          onClick={() => startExport(format)}>
          {pendingFormat === format ? 'Generating…' : `Export ${FORMAT_LABEL[format]}`}
        </button>
      ))}
    </div>
    {error && <p className="bb-field-error">{error}</p>}
    {job?.status === 'READY' && job.downloadUrl && <p className="bb-quote-export-ready"><a href={job.downloadUrl}>Download {FORMAT_LABEL[job.format]}</a></p>}
    {job?.status === 'FAILED' && <p className="bb-field-error">{job.failureReason ?? 'The export failed. Try again.'}</p>}
  </section>
}
