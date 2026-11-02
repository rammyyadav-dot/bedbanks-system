'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { routes, type TenantDirectory } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { PageHeader } from '@/components/common/PageHeader'
import { canCreateTenant, tenantPath } from '@/lib/tenants-ui'
import { TenantWizard } from './TenantWizard'

export function TenantOnboarding() {
  const router = useRouter()
  const [gate, setGate] = useState<TenantDirectory | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let valid = true
    void apiRequest<TenantDirectory>(`${routes.platform.tenants}?pageSize=1`).then(
      (directory) => { if (valid) setGate(directory) },
      (cause) => { if (valid) setError(cause instanceof Error ? cause.message : 'Tenant onboarding unavailable') },
    )
    return () => { valid = false }
  }, [])

  if (error) {
    return (
      <div className="admin-page tenant-control">
        <PageHeader eyebrow="BUSINESS · TENANT ONBOARDING" title="Register tenant" description="Tenant creation requires an authorized platform operator and configured authoring." />
        <p className="tenant-error" role="alert">{error}</p>
        <Link href="/tenants" className="admin-btn">Back to directory</Link>
      </div>
    )
  }
  if (!gate) {
    return (
      <div className="admin-page tenant-control">
        <PageHeader eyebrow="BUSINESS · TENANT ONBOARDING" title="Register tenant" description="Checking whether tenant authoring is available." />
        <p role="status">Checking tenant creation access…</p>
      </div>
    )
  }
  if (!canCreateTenant(gate)) {
    return (
      <div className="admin-page tenant-control">
        <PageHeader eyebrow="BUSINESS · TENANT ONBOARDING" title="Register tenant" description="Tenant creation is not available for this operator." actions={<Link href="/tenants" className="admin-btn">Back to directory</Link>} />
        <p className="tenant-note" role="status">
          {gate.authoringConfigured
            ? 'platform.tenants.create and platform.tenants.memberships.manage are required to provision a tenant.'
            : 'Tenant control authoring is not configured. Creation stays unavailable rather than falling back to an ordinary database role.'}
        </p>
      </div>
    )
  }

  return (
    <TenantWizard
      variant="page"
      onClose={() => router.push('/tenants')}
      onCreated={(id) => router.push(tenantPath(id))}
    />
  )
}
