'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DisputeQueue } from '@/components/finance/DisputeQueue'
import { ReconciliationStatements } from '@/components/finance/ReconciliationStatements'
import { useCan } from '@/lib/auth/capabilities'

type Tab = 'queue' | 'statements'

/**
 * Supplier statement reconciliation (ADR 0070). Import a supplier's settlement statement, let the worker match it against the ledger, and decide every
 * difference in the dispute queue. The server decides who may do what; this page only shows what the server offers. Nothing on it posts to the ledger.
 */
export default function ReconciliationPage() {
  const can = useCan()
  const [tab, setTab] = useState<Tab>('queue')
  const [statementId, setStatementId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const tabs: Array<[Tab, string]> = [['queue', 'Dispute queue'], ['statements', 'Statements']]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · RECONCILIATION" title="Supplier reconciliation" description="Supplier settlement statements matched against the ledger by booking reference and exact net amount. Every difference becomes an exception that finance decides; amounts of different currencies are never converted or added." />
      {message && <p role="status" data-testid="recon-message" style={{ fontSize: 12 }}>{message}</p>}
      <div role="tablist" aria-label="Reconciliation views" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`recon-tab-${id}`} aria-selected={tab === id} aria-controls={`recon-panel-${id}`} className="admin-btn" style={tab === id ? { background: 'var(--c-e8f6f7)', borderColor: 'var(--c-9fd6dc)' } : undefined} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`recon-panel-${tab}`} aria-labelledby={`recon-tab-${tab}`}>
        {tab === 'queue'
          ? <DisputeQueue statementId={statementId} onClearStatement={() => setStatementId(null)} canResolve={can('finance.reconcile.resolve')} version={version} onMessage={setMessage} />
          : <ReconciliationStatements canRun={can('finance.reconcile.run')} onMessage={(m) => { setMessage(m); setVersion((v) => v + 1) }} onOpenQueue={(id) => { setStatementId(id); setTab('queue') }} />}
      </div>
    </div>
  )
}
