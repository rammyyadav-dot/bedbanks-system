import Link from 'next/link'
import type { ReactNode } from 'react'
import type { CommercialIssue, CommercialReadiness, ContractState, GateState, InventoryState, MappingState, ReadinessGate, SupplyDataState } from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'
import { contractTone, gateTone, hotelHref, inventoryTone, mappingTone, ratesTone, readinessTone, reasonText, sectionTab, severityTone, type Tone } from '@/lib/hotel-ui'

/** Every state is conveyed by its word, never by colour alone. */
export const Chip = ({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) => <span title={title}><Tag tone={tone}>{children}</Tag></span>
export const ReadinessChip = ({ value, blockers }: { value: CommercialReadiness; blockers?: string[] }) => <Chip tone={readinessTone(value)} title={blockers?.length ? blockers.map(reasonText).join('; ') : undefined}>{value}</Chip>
export const MappingChip = ({ value }: { value: MappingState }) => <Chip tone={mappingTone(value)}>{value === 'NONE' ? 'NOT MAPPED' : value}</Chip>
export const ContractChip = ({ value, days }: { value: ContractState; days?: number | null }) => <Chip tone={contractTone(value)} title={days != null && value !== 'NONE' ? `${days} days to expiry` : undefined}>{value === 'NONE' ? 'NO CONTRACT' : value}</Chip>
export const RatesChip = ({ value }: { value: SupplyDataState }) => <Chip tone={ratesTone(value)}>{value === 'GAPS' ? 'RATE GAPS' : value === 'NONE' ? 'NO PLAN' : 'RATES OK'}</Chip>
export const InventoryChip = ({ value }: { value: InventoryState }) => <Chip tone={inventoryTone(value)}>{value === 'GAPS' ? 'AVAIL. GAPS' : value === 'STOP_SELL' ? 'STOP SELL' : value === 'EXHAUSTED' ? 'EXHAUSTED' : value === 'NONE' ? 'NO PLAN' : 'INVENTORY OK'}</Chip>
export const GateChip = ({ state }: { state: GateState }) => <Chip tone={gateTone(state)}>{state === 'NA' ? 'N/A' : state}</Chip>

/** Horizontally scrollable table region that is reachable by keyboard (a scrollable region must be focusable). */
export function ScrollRegion({ label, children, maxHeight }: { label: string; children: ReactNode; maxHeight?: number }) {
  return <div role="region" aria-label={label} tabIndex={0} style={{ overflow: 'auto', maxHeight, position: 'relative' }}>{children}</div>
}
export const th: React.CSSProperties = { textAlign: 'left', padding: '10px 14px', color: '#3f565c', borderBottom: '1px solid #e6eef0', whiteSpace: 'nowrap', background: '#fff', position: 'sticky', top: 0 }
export const td: React.CSSProperties = { padding: '10px 14px', color: '#2c4a55', verticalAlign: 'middle', borderBottom: '1px solid #edf2f3' }
export const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11 }

export function ReadinessGates({ gates, hotelId }: { gates: ReadinessGate[]; hotelId: string }) {
  return (
    <section aria-labelledby="gates-title" data-testid="readiness-gates">
      <h2 id="gates-title" style={{ fontSize: 14, margin: '0 0 8px' }}>Commercial readiness</h2>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {gates.map((gate) => (
          <li key={gate.key} style={{ display: 'grid', gridTemplateColumns: '150px 70px 1fr', gap: 8, padding: '6px 0', borderBottom: '1px solid #edf2f3', alignItems: 'center' }} data-gate={gate.key} data-state={gate.state}>
            <Link href={hotelHref(hotelId, sectionTab(gate.section))} style={{ color: '#17333e', fontWeight: 600, textDecoration: 'none' }}>{gate.label}</Link>
            <GateChip state={gate.state} />
            <span style={{ color: '#3f565c' }}>{gate.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function IssuePanel({ issues, hotelId, showHotel = false, emptyText = 'No commercial issues were found in the assessed window.' }: { issues: CommercialIssue[]; hotelId?: string; showHotel?: boolean; emptyText?: string }) {
  if (issues.length === 0) return <p data-testid="issues-empty" style={{ color: '#3f565c' }}>{emptyText}</p>
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="issue-list">
      {issues.map((issue) => (
        <li key={issue.id} style={{ padding: '8px 0', borderBottom: '1px solid #edf2f3' }} data-severity={issue.severity} data-category={issue.category}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip tone={severityTone(issue.severity)}>{issue.severity}</Chip>
            <Link href={hotelHref(hotelId ?? issue.hotelId, sectionTab(issue.section), issue.section === 'rates' ? { from: issue.from, roomTypeId: issue.roomTypeId } : {})} style={{ color: '#17333e', fontWeight: 600 }}>{showHotel ? `${issue.hotelName} · ` : ''}{issue.message}</Link>
          </div>
          <div style={{ color: '#3f565c', fontSize: 11, marginTop: 2 }}>
            {issue.reason ? <code>{issue.reason}</code> : null}
            {issue.from ? ` · ${issue.from === issue.to ? issue.from : `${issue.from} → ${issue.to}`} (${issue.nights} night${issue.nights === 1 ? '' : 's'})` : ''}
            {issue.supplierName ? ` · ${issue.supplierName}` : ''}
          </div>
        </li>
      ))}
    </ul>
  )
}
