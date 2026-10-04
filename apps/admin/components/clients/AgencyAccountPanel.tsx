'use client'

import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { td, th, tableStyle } from '@/components/hotels/ui'
import { getOpsAgencyAccount } from '@/lib/data/operations'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const

/**
 * One agency's account (ADR 0028 slice 1). Read-only: the server reports each account's ledger balance, and each enabled currency
 * with no account as "not opened" (no money held). Funding arrives in slice 2; until slice 3, holds and bookings post to the house
 * account, which the server states and this panel repeats.
 */
export function AgencyAccountPanel({ agencyId, version }: { agencyId: string; version: number }) {
  const account = useOpsQuery(() => getOpsAgencyAccount(agencyId), [agencyId, version])
  return (
    <section className="workspace-panel" aria-label="Agency account" data-testid="agency-account" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Account</h2>
      <OpsState state={account.state} onRetry={account.reload}>
        {(v) => (
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={note}><strong>{v.agency.name}</strong> (<code>{v.agency.code}</code>). Balance is the sum of the account&apos;s immutable ledger entries.</p>
            {v.accounts.map((a) => (
              <div key={a.currency} data-testid={`agency-account-${a.currency}`} style={{ display: 'grid', gap: 6 }}>
                <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, margin: 0 }}>
                  <div><dt style={note}>Currency</dt><dd style={{ margin: 0 }}>{a.currency} {a.status === 'OPEN' ? <Tag tone="ok">open</Tag> : <Tag>not opened</Tag>}</dd></div>
                  <div><dt style={note}>Balance</dt><dd style={{ margin: 0 }} data-testid="agency-account-balance"><strong><Money minor={a.balanceMinor} currency={a.currency} /></strong></dd></div>
                  <div><dt style={note}>Entries</dt><dd style={{ margin: 0 }}>{a.entryCount}</dd></div>
                  <div><dt style={note}>Last entry</dt><dd style={{ margin: 0 }}>{a.lastEntryAt ? when(a.lastEntryAt) : '—'}</dd></div>
                </dl>
                {a.status === 'NOT_OPENED'
                  ? <p style={note}>No account yet in {a.currency}. It opens when the first bank transfer for this agency is verified and posted.</p>
                  : a.recent.length > 0 && (
                    <table style={tableStyle}>
                      <thead><tr>{['When', 'Type', 'Amount', 'Reference'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                      <tbody>{a.recent.map((e) => (
                        <tr key={e.id}><td style={td}>{when(e.at)}</td><td style={td}>{e.type}</td><td style={{ ...td, textAlign: 'right' }}><Money minor={e.amountMinor} currency={e.currency} /></td><td style={td}>{e.reference ?? '—'}</td></tr>
                      ))}</tbody>
                    </table>
                  )}
              </div>
            ))}
            <p style={note} data-testid="agency-account-notice">
              {v.fundingEnabled ? null : <>Funding is not enabled yet. </>}
              {v.bookingsPostTo === 'HOUSE' ? <>Holds and bookings for this agency are still charged to the tenant house account, not to this account.</> : null}
            </p>
          </div>
        )}
      </OpsState>
    </section>
  )
}
