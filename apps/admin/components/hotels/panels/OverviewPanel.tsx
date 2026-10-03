'use client'

import Link from 'next/link'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { useCan } from '@/lib/auth/capabilities'
import { getHotelSetup } from '@/lib/data/hotel-setup'
import { getHotelAudit } from '@/lib/data/hotel-commercial'
import { hotelHref } from '@/lib/hotel-ui'
import { Completeness } from '../Completeness'
import { IssuePanel, ReadinessGates } from '../ui'

/**
 * Persisted summary. Completeness, gates and issues are computed by the API; the master-data form moved to Hotel Setup so that
 * publication always goes through the gate there.
 */
export function OverviewPanel({ data }: { data: HotelCommercial360; onChanged: () => void }) {
  const can = useCan()
  const setup = useOpsQuery(() => getHotelSetup(data.hotel.id), [data.hotel.id, data.hotel.updatedAt])
  const showAudit = can('audit.read')
  const recent = useOpsQuery(() => (showAudit ? getHotelAudit(data.hotel.id, { page: 1, pageSize: 5 }) : Promise.resolve(null)), [data.hotel.id, showAudit, data.hotel.updatedAt])
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <OpsState state={setup.state} onRetry={setup.reload}>
          {(s) => (
            <>
              <Completeness completeness={s.completeness} hotelId={data.hotel.id} compact />
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, margin: '12px 0 0' }} data-testid="overview-facts">
                <dt>Profile approval</dt><dd><strong data-testid="overview-status">{s.governance.status}</strong>{s.governance.approvedAt ? ` · approved ${when(s.governance.approvedAt)}` : ''}</dd>
                <dt>Canonical rooms</dt><dd>{s.rooms.active} active of {s.rooms.total} · {data.rooms.filter((r) => r.mapping === 'MAPPED' && r.isActive).length} mapped</dd>
                <dt>Supplier mappings</dt><dd>{data.suppliers.length ? `${data.suppliers.length} supplier${data.suppliers.length === 1 ? '' : 's'}: ${data.suppliers.map((x) => x.displayName).join(', ')}` : 'None'}</dd>
                <dt>Commercial coverage</dt><dd>{data.readiness} · assessed {data.window.from} → {data.window.to}</dd>
                <dt>Last saved</dt><dd>{when(s.governance.updatedAt)}</dd>
              </dl>
              <p style={{ color: '#3f565c', fontSize: 11, margin: '10px 0 0' }}>Profile approval, mapping verification, commercial coverage and sellability are separate: a published profile does not make a hotel sellable and enables no booking or payment path. <Link href={hotelHref(data.hotel.id, 'setup')}>Open Hotel Setup</Link></p>
            </>
          )}
        </OpsState>
      </div>
      <div className="workspace-panel" style={{ padding: 18 }}><ReadinessGates gates={data.gates} hotelId={data.hotel.id} /></div>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Commercial issues</h2>
        <IssuePanel issues={data.issues} hotelId={data.hotel.id} />
      </div>
      <div className="workspace-panel" style={{ padding: 18 }} data-testid="recent-changes">
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Recent changes</h2>
        {!showAudit ? <p style={{ color: '#3f565c', fontSize: 12, margin: 0 }}>Audit history needs the audit permission.</p> : (
          <OpsState state={recent.state} onRetry={recent.reload} isEmpty={(d) => !d || d.items.length === 0} empty={{ title: 'No changes recorded', description: 'Nothing has been audited for this hotel yet.' }}>
            {(d) => (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, display: 'grid', gap: 4 }}>
                {d!.items.map((e) => <li key={e.id}><code>{e.action}</code> · {when(e.at)}{e.userId ? <> · <code>{e.userId}</code></> : null}{e.requestId ? <> · req <code>{e.requestId}</code></> : null}</li>)}
              </ul>
            )}
          </OpsState>
        )}
        {showAudit && <p style={{ fontSize: 11, margin: '8px 0 0' }}><Link href={hotelHref(data.hotel.id, 'audit')}>Full audit trail</Link></p>}
      </div>
    </div>
  )
}
