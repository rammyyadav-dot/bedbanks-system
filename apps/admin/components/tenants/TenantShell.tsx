'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { TenantControlDetail } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { TenantSubnav } from './TenantSubnav'

export function TenantShell({
  id, title, description, data, error, notice, onRetry, actions, children,
}: {
  id: string
  title: string
  description: string
  data: TenantControlDetail | null
  error: string
  notice: string
  onRetry: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  if (!data) {
    return (
      <div className="admin-page tenant-control">
        <PageHeader eyebrow="BUSINESS" title="Tenant" description="Loading authorized tenant context." />
        {error
          ? <p className="tenant-error" role="alert">{error}<button type="button" className="admin-btn" onClick={onRetry}>Retry</button></p>
          : <p role="status">Loading tenant…</p>}
        <Link href="/tenants">Back to tenants</Link>
      </div>
    )
  }
  return (
    <div className="admin-page tenant-control">
      <PageHeader eyebrow="BUSINESS · TENANT" title={title} description={description} actions={actions} />
      <TenantSubnav id={id} />
      {error && <p role="alert" className="tenant-error">{error}</p>}
      {notice && <p className="tenant-notice" role="status">{notice}</p>}
      {children}
    </div>
  )
}
