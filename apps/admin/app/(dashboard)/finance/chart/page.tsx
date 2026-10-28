'use client'

import { useState } from 'react'
import { GL_ACCOUNT_TYPE_NAMES, GL_JOURNAL_EXPORT_HEADERS, type GlAccountTypeName, type GlChartView, type GlJournalView, type GlMappingView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { createGlAccount, deactivateGlAccount, downloadGlJournal, getGlChart, getGlJournal, initializeGlChart, setGlMapping } from '@/lib/data/finance-chart'
import { getFinancePeriods } from '@/lib/data/finance-periods'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-6b6b6b)' } as const
const note = { color: 'var(--c-6b6b6b)', fontSize: 11, margin: 0 } as const
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ')

/**
 * General-ledger chart of accounts (ADR 0102). The agency ledger stays the book of record; this maps its movements to accounts so a balanced
 * journal of a closed month can be given to the accountants. Every change is kept as history and the server refuses what is not allowed.
 */
export default function ChartPage() {
  const canManage = useCan()('finance.chart.manage')
  const [version, setVersion] = useState(0); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const data = useOpsQuery(() => getGlChart(), [version])

  async function act(work: () => Promise<string>) {
    setBusy(true); setMessage(null)
    try { setMessage(await work()); setVersion(v => v + 1) } catch (error) { setMessage(describeApiError(error)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Chart of accounts" description="General-ledger accounts and the account pair each kind of ledger movement posts to. A positive movement debits the first account and credits the second; a negative one does the reverse. The defaults are a starting point for your accountants to review: change a pair and a new version is kept. Revenue and supplier cost are not derived from the agency ledger and have no accounts here." />
      {message && <p role="status" data-testid="chart-message" style={{ fontSize: 12 }}>{message}</p>}
      <OpsState state={data.state} onRetry={data.reload}>
        {(chart) => (
          <>
            {!chart.initialized && (
              <section className="workspace-panel" style={{ padding: '12px 18px' }}>
                <p style={{ fontSize: 12 }}>No chart has been set up for this tenant.</p>
                {canManage
                  ? <button type="button" className="admin-btn" disabled={busy} data-testid="chart-initialize" onClick={() => void act(async () => { await initializeGlChart(); return 'Default chart created.' })}>Create the default chart</button>
                  : <p style={note}>Creating the chart needs the finance.chart.manage permission.</p>}
              </section>
            )}
            {chart.initialized && <Accounts chart={chart} canManage={canManage} busy={busy} act={act} />}
            {chart.initialized && <Mappings chart={chart} canManage={canManage} busy={busy} act={act} />}
            {chart.initialized && <Journal />}
          </>
        )}
      </OpsState>
    </div>
  )
}

function Accounts({ chart, canManage, busy, act }: { chart: GlChartView; canManage: boolean; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [type, setType] = useState<GlAccountTypeName>('ASSET')
  const used = new Set(chart.mappings.flatMap(m => [m.debit.id, m.credit.id]))
  return (
    <section className="workspace-panel" aria-label="Accounts" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Accounts</h2>
      <ScrollRegion label="Accounts">
        <table style={tableStyle}>
          <thead><tr>{['Code', 'Name', 'Type', 'Status', ''].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{chart.accounts.map(a => (
            <tr key={a.id}>
              <td style={td}><code>{a.code}</code></td><td style={td}>{a.name}</td><td style={td}>{words(a.type)}</td>
              <td style={td}><Tag tone={a.active ? 'ok' : 'neutral'}>{a.active ? 'active' : 'inactive'}</Tag></td>
              <td style={td}>{canManage && a.active && !used.has(a.id) && <button type="button" className="admin-btn" disabled={busy} data-testid="chart-deactivate" onClick={() => void act(async () => { await deactivateGlAccount(a.id); return `Account ${a.code} deactivated.` })}>Deactivate</button>}
                {used.has(a.id) && <span style={{ fontSize: 10 }}>used by a mapping</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </ScrollRegion>
      {canManage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 8 }}>
          <label style={lab}>Code<input className="input-wrap" maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} data-testid="chart-code" /></label>
          <label style={lab}>Name<input className="input-wrap" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} data-testid="chart-name" /></label>
          <label style={lab}>Type<select className="input-wrap" value={type} onChange={(e) => setType(e.target.value as GlAccountTypeName)}>{GL_ACCOUNT_TYPE_NAMES.map(t => <option key={t} value={t}>{words(t)}</option>)}</select></label>
          <button type="button" className="admin-btn" disabled={busy || !code.trim() || name.trim().length < 2} data-testid="chart-add" onClick={() => void act(async () => { await createGlAccount({ code: code.trim(), name: name.trim(), type }); setCode(''); setName(''); return 'Account added.' })}>Add account</button>
        </div>
      )}
    </section>
  )
}

function Mappings({ chart, canManage, busy, act }: { chart: GlChartView; canManage: boolean; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const active = chart.accounts.filter(a => a.active)
  return (
    <section className="workspace-panel" aria-label="Mappings" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Movement mappings</h2>
      {chart.unmappedCategories.length > 0 && <p style={note}>Not mapped yet: {chart.unmappedCategories.map(words).join(', ')}. A journal cannot be built until every kind is mapped.</p>}
      <ScrollRegion label="Mappings">
        <table style={tableStyle}>
          <thead><tr>{['Movement', 'Debit (positive)', 'Credit (positive)', 'Version'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{chart.mappings.map(m => <MappingRow key={m.category} m={m} active={active} canManage={canManage} busy={busy} act={act} />)}</tbody>
        </table>
      </ScrollRegion>
    </section>
  )
}

function MappingRow({ m, active, canManage, busy, act }: { m: GlMappingView; active: GlChartView['accounts']; canManage: boolean; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const [debit, setDebit] = useState(m.debit.id); const [credit, setCredit] = useState(m.credit.id)
  const changed = debit !== m.debit.id || credit !== m.credit.id
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <select className="input-wrap" aria-label={`${words(m.category)} ${label}`} value={value} disabled={!canManage} onChange={(e) => set(e.target.value)}>
      {active.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      {!active.some(a => a.id === value) && <option value={value}>{value}</option>}
    </select>
  )
  return (
    <tr data-testid={`mapping-${m.category}`}>
      <td style={td}><strong>{words(m.category)}</strong><div style={{ fontSize: 10 }}>{m.description}</div></td>
      <td style={td}>{pick(debit, setDebit, 'debit')}</td><td style={td}>{pick(credit, setCredit, 'credit')}</td>
      <td style={td}>v{m.version}{canManage && changed && <> <button type="button" className="admin-btn" disabled={busy || debit === credit} data-testid="mapping-save" onClick={() => void act(async () => { const r = await setGlMapping({ category: m.category, debitAccountId: debit, creditAccountId: credit }); return `${words(m.category)} now version ${r.version}.` })}>Save as new version</button></>}</td>
    </tr>
  )
}

function Journal() {
  const periods = useOpsQuery(() => getFinancePeriods({ pageSize: 100 }), [])
  const [month, setMonth] = useState(''); const [journal, setJournal] = useState<GlJournalView | null>(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [exported, setExported] = useState<string | null>(null)
  const canExport = useCan()('finance.journal.export')
  async function save(kind: 'lines' | 'totals') {
    setBusy(true); setError(null); setExported(null)
    try {
      const { blob, headers } = await downloadGlJournal(month, kind)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = `gl-journal-${month}-${kind}.csv`
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
      setExported(`Downloaded ${kind === 'lines' ? 'the journal lines' : 'the account totals'} (${headers.get(GL_JOURNAL_EXPORT_HEADERS.rows) ?? '?'} rows). The download was recorded in the audit log; SHA-256 ${headers.get(GL_JOURNAL_EXPORT_HEADERS.sha256) ?? 'unavailable'}.`)
    } catch (e) { setError(describeApiError(e)) } finally { setBusy(false) }
  }
  async function load() {
    setBusy(true); setError(null); setExported(null); setJournal(null)
    try { setJournal(await getGlJournal(month)) } catch (e) { setError(describeApiError(e)) } finally { setBusy(false) }
  }
  return (
    <section className="workspace-panel" aria-label="Journal" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Journal of a closed month</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <label style={lab}>Month
          <select className="input-wrap" value={month} onChange={(e) => { setMonth(e.target.value); setJournal(null) }} data-testid="journal-month">
            <option value="">Choose a closed month</option>
            {periods.state.status === 'ready' && periods.state.data.items.map(p => <option key={p.id} value={p.month}>{p.month}</option>)}
          </select>
        </label>
        <button type="button" className="admin-btn" disabled={busy || !month} data-testid="journal-load" onClick={() => void load()}>Show journal</button>
      </div>
      {periods.state.status === 'ready' && periods.state.data.items.length === 0 && <p style={note}>No month has been closed yet. Close a month in Period close first.</p>}
      {error && <p role="alert" style={{ fontSize: 12 }}>{error}</p>}
      {journal && (
        <div data-testid="journal-result" style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12 }}>
            {journal.entries} entries · <Tag tone={journal.balanced ? 'ok' : 'bad'}>{journal.balanced ? 'balanced' : 'NOT balanced'}</Tag> <Tag tone={journal.tiesToClose ? 'ok' : 'bad'}>{journal.tiesToClose ? 'ties to the period close' : 'does not tie to the period close'}</Tag>
          </p>
          {canExport && (
            <div style={{ display: 'flex', gap: 8, margin: '4px 0' }}>
              <button type="button" className="admin-btn" disabled={busy} data-testid="journal-export-lines" onClick={() => void save('lines')}>Download lines (CSV)</button>
              <button type="button" className="admin-btn" disabled={busy} data-testid="journal-export-totals" onClick={() => void save('totals')}>Download account totals (CSV)</button>
            </div>
          )}
          {exported && <p role="status" data-testid="journal-export-note" style={{ fontSize: 12 }}>{exported}</p>}
          {journal.unmappedEntries > 0 && <p role="alert" style={{ fontSize: 12 }}>{journal.unmappedEntries} entries could not be categorised and are not in this journal.</p>}
          {journal.otherCreditEntries > 0 && <p style={note}>{journal.otherCreditEntries} credits are neither funding nor commission; they sit in the suspense account until classified.</p>}
          <ScrollRegion label="Journal lines">
            <table style={tableStyle}>
              <thead><tr>{['Currency', 'Movement', 'Entries', 'Debit', 'Credit', 'Amount'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{journal.lines.map((l, i) => (
                <tr key={i}><td style={td}>{l.currency}</td><td style={td}>{words(l.category)} ({l.direction === 'POSITIVE' ? 'in' : 'out'})</td><td style={td}>{l.entries}</td>
                  <td style={td}><code>{l.debit}</code> {l.debitName}</td><td style={td}><code>{l.credit}</code> {l.creditName}</td><td style={{ ...td, textAlign: 'right' }}><Money minor={l.amountMinor} currency={l.currency} /></td></tr>
              ))}</tbody>
            </table>
          </ScrollRegion>
          <h3 style={{ fontSize: 12, marginTop: 8 }}>Totals by account</h3>
          <ScrollRegion label="Account totals">
            <table style={tableStyle}>
              <thead><tr>{['Currency', 'Account', 'Debits', 'Credits'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{journal.accountTotals.map((t, i) => (
                <tr key={i}><td style={td}>{t.currency}</td><td style={td}><code>{t.accountCode}</code> {t.accountName}</td>
                  <td style={{ ...td, textAlign: 'right' }}><Money minor={t.debitMinor} currency={t.currency} /></td><td style={{ ...td, textAlign: 'right' }}><Money minor={t.creditMinor} currency={t.currency} /></td></tr>
              ))}</tbody>
            </table>
          </ScrollRegion>
          <p style={note}>Recomputed on each view from the locked month using the mapping versions {Object.entries(journal.mappingVersions).map(([k, v]) => `${words(k)} v${v}`).join(', ')}.</p>
        </div>
      )}
    </section>
  )
}
