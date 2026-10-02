'use client'

import { useState } from 'react'
import type { AccessFlag } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getAccessReviewSummary, getAccessReviewUsers } from '@/lib/data/operations'

const FLAGS: Array<{ value: AccessFlag; label: string }> = [
  { value: 'HOLDS_SENSITIVE', label: 'Holds sensitive permissions' }, { value: 'NO_ROLE', label: 'No role' }, { value: 'INACTIVE', label: 'Inactive' },
  { value: 'NEVER_LOGGED_IN', label: 'Never logged in' }, { value: 'STALE_LOGIN', label: 'Stale login' },
]
const flagTone = (f: AccessFlag) => (f === 'HOLDS_SENSITIVE' ? 'warn' : 'bad') as 'warn' | 'bad'
const PAGE_SIZE = 25

/** Who holds which authority in this tenant. Read-only evidence for a periodic access review; it changes nothing. */
export default function AccessReviewPage() {
  const [flag, setFlag] = useState(''); const [page, setPage] = useState(1)
  const summary = useOpsQuery(() => getAccessReviewSummary(), [])
  const users = useOpsQuery(() => getAccessReviewUsers({ flag: flag || undefined, page, pageSize: PAGE_SIZE }), [flag, page])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="RISK & COMPLIANCE" title="Access reviews" description="Members of this tenant, their roles and the sensitive permissions they hold. Roles and assignments are changed in Roles & Permissions, not here." />
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <section aria-label="Access summary" data-testid="access-summary" style={{ marginBottom: 12 }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              {[['Members', s.members.total], ['Active', s.members.active], ['Inactive', s.members.inactive], ['Never logged in', s.members.neverLoggedIn], [`No login in ${s.staleLoginDays}d`, s.members.staleLogin], ['No role', s.members.noRole], ['Hold sensitive permissions', s.members.holdingSensitive]].map(([label, value]) => (
                <li key={label as string} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 22px system-ui', color: '#17333e' }}>{value}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{label}</div></li>
              ))}
            </ul>
          </section>
        )}
      </OpsState>
      <form aria-label="Access filters" onSubmit={(e) => e.preventDefault()} style={{ marginBottom: 8 }}>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#3f565c' }}><span>Flag</span>
          <select style={{ color: '#17333e' }} value={flag} onChange={(e) => { setFlag(e.target.value); setPage(1) }}><option value="">All members</option>{FLAGS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select>
        </label>
      </form>
      <OpsState state={users.state} onRetry={users.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No members match', description: 'The review succeeded and no member has this flag.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="access-table">
            <ScrollRegion label="Members">
              <table style={tableStyle} aria-label="Members">
                <thead><tr>{['Member', 'Status', 'Roles', 'Sensitive permissions', 'Last login', 'Flags'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((u) => (
                  <tr key={u.userId}>
                    <td style={td}><strong>{u.name ?? u.email}</strong>{u.name ? <div style={{ fontSize: 10 }}>{u.email}</div> : null}</td>
                    <td style={td}>{u.status}</td>
                    <td style={td}>{u.roles.length ? u.roles.join(', ') : '—'}</td>
                    <td style={td}>{u.sensitivePermissions.length ? u.sensitivePermissions.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) : '—'}</td>
                    <td style={td}>{u.lastLoginAt ? when(u.lastLoginAt) : 'never'}</td>
                    <td style={td}>{u.flags.length ? u.flags.map((f) => <span key={f} style={{ marginRight: 4 }}><Tag tone={flagTone(f)}>{f.split('_').join(' ')}</Tag></span>) : '—'}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}
