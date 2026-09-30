'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { StatCard } from '@/components/common/StatCard'
import { StatusBadge } from '@/components/status/StatusBadge'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { getSupplier, type SupplySupplier } from '@/lib/data'
import type { Status } from '@/lib/types/admin'

const supplierStatus = (status: string): Status => status === 'ACTIVE' ? 'active' : status === 'SUSPENDED' ? 'suspended' : status === 'INACTIVE' ? 'inactive' : 'pending'

export default function SupplierDetailPage() {
  const params = useParams<{ id: string }>()
  const [supplier, setSupplier] = useState<SupplySupplier | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => { getSupplier(params.id).then(setSupplier).catch(() => setError(true)) }, [params.id])
  if (error) return <div className="admin-page"><ErrorState title="Supplier unavailable" description="The authoritative supplier record could not be loaded. No fallback summary is shown." /></div>
  if (!supplier) return <div className="admin-page"><LoadingState rows={5} /></div>
  return (
    <div className="admin-page">
      <PageHeader eyebrow={`SUPPLIER · ${supplier.type.split('_').join(' ')}`} title={supplier.displayName} description={supplier.legalName} actions={<StatusBadge status={supplierStatus(supplier.status)} />} />
      <div className="admin-summary-cards">
        <StatCard label="Country" value={supplier.countryCode} />
        <StatCard label="Default Currency" value={supplier.defaultCurrency} />
        <StatCard label="Supplier Type" value={supplier.type.split('_').join(' ')} />
        <StatCard label="Status" value={supplier.status} />
      </div>
      <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>
        <strong>Authoritative supplier record</strong>
        <div style={{ marginTop: 10 }}>Created {new Date(supplier.createdAt).toLocaleString()}</div>
        <div>Updated {new Date(supplier.updatedAt).toLocaleString()}</div>
      </div>
    </div>
  )
}
