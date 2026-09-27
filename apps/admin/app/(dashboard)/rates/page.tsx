'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { getRatePlans, getDailyRates, type AdminRatePlan, type AdminDailyRate } from '@/lib/data'

const today = new Date().toISOString().slice(0, 10)
const money = (minor: string, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(minor) / 100)

export default function RatesPage() {
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [rates, setRates] = useState<AdminDailyRate[]>([])
  const [dateValue, setDateValue] = useState(today)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { getRatePlans().then(setPlans).catch(() => setError('Rate Plans are unavailable. No mock data is shown.')) }, [])
  useEffect(() => { getDailyRates(dateValue).then(setRates).catch(() => { setRates([]); setError('Daily Rates are unavailable. No mock data is shown.') }) }, [dateValue])
  const planColumns: DataTableColumn<AdminRatePlan>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.roomType.hotel.name }, { key: 'room', header: 'Room', render: (r) => r.roomType.name },
    { key: 'board', header: 'Board', render: (r) => r.boardBasis.code.trim() }, { key: 'contract', header: 'Contract', render: (r) => r.contract.code },
    { key: 'supplier', header: 'Supplier', render: (r) => r.contract.supplier.displayName }, { key: 'occupancy', header: 'Occupancy', render: (r) => String(r.occupancy), align: 'right' },
    { key: 'currency', header: 'Currency', render: (r) => r.currency }, { key: 'stay', header: 'Stay', render: (r) => r.maxStay == null ? `${r.minStay}+ nights` : `${r.minStay}–${r.maxStay} nights` },
    { key: 'release', header: 'Release', render: (r) => `${r.releaseDays}d`, align: 'right' }, { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status.toLowerCase() as 'active' | 'inactive' | 'pending' | 'suspended'} /> },
  ]
  const rateColumns: DataTableColumn<AdminDailyRate>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.ratePlan.roomType.hotel.name }, { key: 'room', header: 'Room', render: (r) => r.ratePlan.roomType.name },
    { key: 'board', header: 'Board', render: (r) => r.ratePlan.boardBasis.code.trim() }, { key: 'date', header: 'Stay date', render: (r) => r.stayDate.slice(0, 10) },
    { key: 'occupancy', header: 'Occ.', render: (r) => r.occupancy, align: 'right' }, { key: 'amount', header: 'Amount', render: (r) => money(r.amountMinor, r.currency), align: 'right' },
    { key: 'basis', header: 'Basis', render: (r) => r.amountBasis === 'SELL' ? <span className="status-pill success"><i className="status-dot" />SELL</span> : <span className="status-pill warning"><i className="status-dot" />NET</span> },
  ]
  return <div className="admin-page">
    <PageHeader eyebrow="COMMERCIAL · RATE PLANS" title="Rate Plans" description="Authoritative contract, room, board, occupancy, stay rules and daily prices." actions={<input aria-label="Daily rate date" type="date" value={dateValue} onChange={(event) => setDateValue(event.target.value)} className="admin-filter-select" />} />
    {error ? <div role="alert" className="admin-empty-state">{error}</div> : null}
    <DataTable columns={planColumns} data={plans} getRowId={(r) => r.id} emptyTitle={error ? 'Rate Plans unavailable' : 'No Rate Plans found'} />
    <div className="admin-section-header"><h2>Daily Rates</h2><p>Explicit SELL/NET semantics. NET rates remain ineligible until a markup is authoritative.</p></div>
    <DataTable columns={rateColumns} data={rates} getRowId={(r) => r.id} emptyTitle={error ? 'Daily Rates unavailable' : 'No Daily Rates for selected date'} />
  </div>
}
