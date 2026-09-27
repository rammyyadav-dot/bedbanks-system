'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { getInventory, getRatePlans, bulkUpdateAvailability, checkSellability, type AdminAvailabilityRow, type AdminRatePlan } from '@/lib/data'
import { buildSevenDayAvailability, sellabilityMessage } from '@/lib/dubai-operations'

const today = new Date().toISOString().slice(0, 10)

export default function InventoryPage() {
  const [dateValue, setDateValue] = useState(today)
  const [rows, setRows] = useState<AdminAvailabilityRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [selectedPlan, setSelectedPlan] = useState('')
  const [allotment, setAllotment] = useState('5')
  const [stopSell, setStopSell] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  useEffect(() => { getRatePlans().then(setPlans).catch(() => setError('Rate Plans are unavailable.')) }, [])
  useEffect(() => { setError(null); getInventory(dateValue).then(setRows).catch(() => { setRows([]); setError('Inventory is unavailable. No mock data is shown.') }) }, [dateValue])
  const loadSevenDays = async () => {
    const plan = plans.find((item) => item.id === selectedPlan)
    if (!plan) return setOperation('Select a Rate Plan and enter a valid allotment.')
    try { const rows = buildSevenDayAvailability(plan, dateValue, allotment, stopSell); await bulkUpdateAvailability(rows); setRows(await getInventory(dateValue, rows[6].stayDate)); setOperation(stopSell ? 'Stop sell applied for 7 days.' : 'Availability opened for 7 days.') } catch { setOperation('Inventory update failed. No fallback data was written.') }
  }
  const verifySellability = async () => {
    const plan = plans.find((item) => item.id === selectedPlan); if (!plan) return setOperation('Select a Rate Plan first.')
    try { const result = await checkSellability({ ratePlanId: plan.id, stayDate: dateValue, occupancy: plan.occupancy }); setOperation(sellabilityMessage(result)) } catch { setOperation('Sellability check unavailable.') }
  }
  const columns: DataTableColumn<AdminAvailabilityRow>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.ratePlan.roomType.hotel.name },
    { key: 'room', header: 'Room', render: (r) => r.ratePlan.roomType.name },
    { key: 'board', header: 'Board', render: (r) => r.ratePlan.boardBasis.code.trim() },
    { key: 'date', header: 'Date', render: (r) => r.stayDate.slice(0, 10) },
    { key: 'allotment', header: 'Allotment', render: (r) => r.allotment, align: 'right' },
    { key: 'available', header: 'Available', render: (r) => Math.max(0, r.allotment - r.sold - r.held), align: 'right' },
    { key: 'stopSell', header: 'Stop Sell', render: (r) => r.stopSell ? <span className="status-pill danger"><i className="status-dot" />Stop sell</span> : 'Open' },
    { key: 'minStay', header: 'Min stay', render: (r) => `${r.minStay}n`, align: 'right' },
    { key: 'release', header: 'Release', render: (r) => `${r.ratePlan.releaseDays}d`, align: 'right' },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · INVENTORY" title="Inventory" description="Authoritative allotment, held/sold inventory and stop-sell state by rate plan and stay date." actions={<input aria-label="Inventory date" type="date" value={dateValue} onChange={(event) => setDateValue(event.target.value)} className="admin-filter-select" />} />
      {error ? <div role="alert" className="admin-empty-state">{error}</div> : null}
      <section className="admin-card" aria-label="Inventory Operations">
        <h2>7-Day Inventory Loader</h2>
        <div className="admin-filter-row">
          <select aria-label="Rate Plan" value={selectedPlan} onChange={(e) => setSelectedPlan(e.target.value)} className="admin-filter-select"><option value="">Select Rate Plan</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.roomType.hotel.name} · {plan.roomType.name} · {plan.boardBasis.code.trim()}</option>)}</select>
          <input aria-label="Allotment" inputMode="numeric" value={allotment} onChange={(e) => setAllotment(e.target.value)} className="admin-filter-select" />
          <label><input type="checkbox" checked={stopSell} onChange={(e) => setStopSell(e.target.checked)} /> Stop sell</label>
          <button type="button" onClick={loadSevenDays} className="admin-button-primary">{stopSell ? 'Apply Stop Sell' : 'Open / Update 7 Days'}</button>
          <button type="button" onClick={verifySellability} className="admin-button-secondary">Check Sellability</button>
        </div>
        {operation ? <p role="status">{operation}</p> : null}
      </section>

      <DataTable columns={columns} data={rows} getRowId={(r) => r.id} emptyTitle={error ? 'Inventory unavailable' : 'No inventory rows found'} />
    </div>
  )
}
