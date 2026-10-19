'use client'

import { useMemo, useRef, useState } from 'react'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getSuppliers } from '@/lib/data'
import { importReconStatement } from '@/lib/data/finance-reconciliation'
import { describeApiError } from '@/lib/api/describe-error'
import { parseStatementCsv } from '@/lib/statement-csv'

/** Placeholder text for the paste box: the shape of a statement, not data. */
const EXAMPLE = 'reference,kind,currency,amount\nBK-1042,CHARGE,AED,450.00\nBK-1017,CREDIT,AED,120.50'
const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const

/** Paste a supplier settlement statement. Rows are checked here for shape only; the API converts amounts and is the authority. */
export function StatementImport({ onImported }: { onImported: (message: string) => void }) {
  const suppliers = useOpsQuery(() => getSuppliers('pageSize=100'), [])
  const [supplierId, setSupplierId] = useState(''); const [statementRef, setStatementRef] = useState('')
  const [periodStart, setPeriodStart] = useState(''); const [periodEnd, setPeriodEnd] = useState('')
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const parsed = useMemo(() => parseStatementCsv(text), [text])
  const ready = supplierId && statementRef.trim() && periodStart && periodEnd && parsed.lines.length > 0 && parsed.errors.length === 0

  async function submit() {
    setBusy(true); setError(null)
    try {
      const requestId = (key.current ??= crypto.randomUUID())
      const view = await importReconStatement({ supplierId, statementRef: statementRef.trim(), periodStart, periodEnd, lines: parsed.lines, requestId })
      key.current = null; setText(''); setStatementRef('')
      onImported(`Imported ${view.lineCount} lines as ${view.statementRef}. Run matching to compare it with the ledger.`)
    } catch (err) { setError(describeApiError(err, 'import the statement')) } finally { setBusy(false) }
  }

  return (
    <section className="workspace-panel" aria-label="Import a statement" style={{ padding: '12px 18px', marginBottom: 12 }}>
      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Import a supplier statement</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={lab}>Supplier
          <select className="input-wrap" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} data-testid="recon-supplier">
            <option value="">Choose</option>
            {suppliers.state.status === 'ready' && suppliers.state.data.items.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </label>
        <label style={lab}>Statement number<input className="input-wrap" maxLength={80} value={statementRef} onChange={(e) => setStatementRef(e.target.value)} data-testid="recon-ref" /></label>
        <label style={lab}>Period from<input className="input-wrap" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label>
        <label style={lab}>Period to<input className="input-wrap" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
      </div>
      {suppliers.state.status === 'failed' && <p role="alert" style={{ fontSize: 11, color: '#a11d1d' }}>The supplier list could not be loaded, so a statement cannot be imported right now.</p>}
      <label style={{ ...lab, marginTop: 8 }}>Statement lines (columns: reference, kind, currency, amount; kind is CHARGE, CREDIT or SURCHARGE; amounts use a dot)
        <textarea className="input-wrap" style={{ height: 110, padding: 6, fontFamily: "'Courier New', monospace" }} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} data-testid="recon-lines" />
      </label>
      {parsed.errors.length > 0 && <ul role="alert" style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11, color: '#a11d1d' }}>{parsed.errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}{parsed.errors.length > 6 && <li>and {parsed.errors.length - 6} more</li>}</ul>}
      {parsed.lines.length > 0 && parsed.errors.length === 0 && <p style={{ margin: '6px 0 0', fontSize: 11, color: '#3f565c' }}>{parsed.lines.length} line{parsed.lines.length === 1 ? '' : 's'} ready.</p>}
      {error && <p role="alert" style={{ margin: '6px 0 0', color: '#a11d1d', fontSize: 12 }}>{error}</p>}
      <div style={{ marginTop: 8 }}><button type="button" className="admin-btn" disabled={busy || !ready} data-testid="recon-import" onClick={() => void submit()}>Import statement</button></div>
    </section>
  )
}
