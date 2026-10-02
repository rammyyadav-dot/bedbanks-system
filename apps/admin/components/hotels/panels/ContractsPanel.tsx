'use client'

import Link from 'next/link'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getHotelContracts } from '@/lib/data/hotel-commercial'
import { ContractChip, Chip, GateChip, ReadinessChip, ScrollRegion, td, th, tableStyle } from '../ui'

/** Contract status is not sellability: the chain below shows each downstream gate with the API's own verdict. */
const CHAIN: Array<{ key: string; label: string }> = [
  { key: 'contract', label: 'Contract active' }, { key: 'ratePlans', label: 'Rate plan active' }, { key: 'dailyRates', label: 'Rate present' },
  { key: 'availability', label: 'Availability present' }, { key: 'stopSell', label: 'No stop sell' }, { key: 'inventory', label: 'Inventory available' }, { key: 'sellability', label: 'Sellable' },
]

export function ContractsPanel({ hotelId, gates }: { hotelId: string; gates: HotelCommercial360['gates'] }) {
  const { state, reload } = useOpsQuery(() => getHotelContracts(hotelId), [hotelId])
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }} data-testid="sellability-chain">
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>From contract to sellable</h2>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {CHAIN.map((step, index) => { const gate = gates.find((g) => g.key === step.key); return (
            <li key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={gate?.detail}>{index > 0 && <span aria-hidden="true">→</span>}<span>{step.label}</span><GateChip state={gate?.state ?? 'NA'} /></li>
          ) })}
        </ol>
        <p style={{ color: '#3f565c', fontSize: 12, margin: '8px 0 0' }}>An ACTIVE contract does not make a hotel sellable: every step after it must also pass.</p>
      </div>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.contracts.length === 0 && d.ratePlans.length === 0} empty={{ title: 'No contracts', description: 'No contract is linked to this hotel through a mapping or a rate plan.' }}>
        {(data) => (
          <>
            <div className="workspace-panel" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Contracts ({data.contracts.length})</h2>
              <ScrollRegion label="Contracts"><table style={tableStyle} aria-label="Contracts">
                <thead><tr>{['Contract', 'Supplier', 'Status', 'Valid from', 'Valid to', 'Expiry', 'Currency', 'Rate plans', 'Policies', 'Updated'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.contracts.map((c) => (
                  <tr key={c.id}>
                    <td style={td}><Link href={`/contracts/${c.id}`} style={{ fontWeight: 600 }}>{c.code}</Link><div style={{ fontSize: 10, color: '#3f565c' }}>v{c.version} · {c.link === 'MAPPING' ? 'via hotel mapping' : 'via rate plan only'}</div></td>
                    <td style={td}>{c.supplierName}</td><td style={td}><Chip tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{c.status}</Chip></td>
                    <td style={td}>{c.validFrom}</td><td style={td}>{c.validTo}</td>
                    <td style={td}><ContractChip value={c.state} days={c.daysToExpiry} /> <span style={{ fontSize: 10 }}>{c.state === 'EXPIRED' ? `${Math.abs(c.daysToExpiry)}d ago` : `${c.daysToExpiry}d`}</span></td>
                    <td style={td}>{c.currency}</td><td style={td}>{c.ratePlans.active} active / {c.ratePlans.total}</td>
                    <td style={td}>{c.policies.cancellation} cancellation · {c.policies.child} child · {c.policies.leadTime} lead-time</td>
                    <td style={td}>{new Date(c.updatedAt).toLocaleDateString()}</td>
                  </tr>))}</tbody></table></ScrollRegion>
              <p style={{ color: '#3f565c', fontSize: 11 }}>EXPIRING means ACTIVE and ending within {data.expiringDays} days. validTo is the last check-out date.</p>
            </div>
            <div className="workspace-panel" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Rate plans ({data.ratePlans.length})</h2>
              {data.ratePlans.length === 0 ? <p data-testid="rateplans-empty">No rate plans exist for this hotel.</p> : (
                <ScrollRegion label="Rate plans"><table style={tableStyle} aria-label="Rate plans">
                  <thead><tr>{['Rate plan', 'Room', 'Board', 'Contract', 'Status', 'Currency', 'Amount basis', 'Occ.', 'Stay rules', 'Window (sellable / nights)', 'Readiness'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{data.ratePlans.map((p) => (
                    <tr key={p.id}>
                      <td style={td}><Link href={`/rates/plans/${p.id}`} style={{ fontWeight: 600 }}>{p.code}</Link></td><td style={td}>{p.roomName}</td>
                      <td style={td}>{p.boardCode}{!p.boardActive && <Chip tone="bad">INACTIVE</Chip>}</td><td style={td}>{p.contractCode}</td>
                      <td style={td}><Chip tone={p.status === 'ACTIVE' ? 'ok' : 'warn'}>{p.status}</Chip></td><td style={td}>{p.currency}</td>
                      <td style={td}><Chip tone={p.amountBasis === 'SELL' ? 'ok' : p.amountBasis === 'NONE' ? 'neutral' : 'bad'}>{p.amountBasis}</Chip></td>
                      <td style={td}>{p.occupancy}</td><td style={td}>min {p.minStay}{p.maxStay ? ` · max ${p.maxStay}` : ''} · release {p.releaseDays}d</td>
                      <td style={td}>{p.status === 'ACTIVE' ? `${p.window.sellable} / ${p.window.nights}` : 'not assessed'}</td>
                      <td style={td}><ReadinessChip value={p.readiness} /></td>
                    </tr>))}</tbody></table></ScrollRegion>
              )}
            </div>
          </>
        )}
      </OpsState>
    </div>
  )
}
