'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { SelectField } from '@/components/forms/SelectField'
import { useState } from 'react'

const REPORTS = ['Sales', 'Bookings', 'Revenue', 'Gross Margin', 'Supplier Performance', 'Agent Performance', 'Destination Performance', 'Cancellation', 'Wallet']

export default function ReportsPage() {
  const [tenant, setTenant] = useState('all')
  const [supplier, setSupplier] = useState('all')

  return (
    <div className="admin-page">
      <PageHeader eyebrow="REPORTS" title="Reports" description="Report catalogue across sales, bookings, revenue, and performance." />
      <div className="admin-filter-bar">
        <input type="date" defaultValue="2026-09-01" className="admin-filter-select" aria-label="Start date" />
        <input type="date" defaultValue="2026-09-09" className="admin-filter-select" aria-label="End date" />
        <SelectField label="Tenant" value={tenant} onChange={setTenant} options={[{ value: 'all', label: 'All tenants' }]} />
        <SelectField label="Supplier" value={supplier} onChange={setSupplier} options={[{ value: 'all', label: 'All suppliers' }]} />
      </div>
      <div className="workspace-panel">
        {REPORTS.map((name) => (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #edf2f3' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#2c4a55' }}>{name}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="admin-btn">View Report</button>
              <button type="button" className="admin-btn">Export CSV</button>
              <button type="button" className="admin-btn">Export Excel</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
