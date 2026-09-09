'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'

export default function NewTenantPage() {
  const router = useRouter()

  return (
    <div className="admin-page" style={{ maxWidth: 640 }}>
      <PageHeader eyebrow="BUSINESS · TENANTS" title="Add tenant" description="Create a new agency workspace. This is UI-only — no tenant is actually created." />
      <form
        className="workspace-panel"
        style={{ padding: 22 }}
        onSubmit={(e) => { e.preventDefault(); router.push('/tenants') }}
      >
        <FormField label="TENANT NAME"><input placeholder="e.g. Sunrise Tours" required /></FormField>
        <FormField label="TENANT CODE"><input placeholder="e.g. SUN-118" required /></FormField>
        <FormField label="PLAN">
          <select defaultValue="Starter">
            <option>Starter</option><option>Growth</option><option>Enterprise</option>
          </select>
        </FormField>
        <FormField label="PRIMARY CONTACT EMAIL"><input type="email" placeholder="owner@agency.example" required /></FormField>
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button type="submit" className="admin-btn admin-btn-primary">Create tenant</button>
          <Link href="/tenants" className="admin-btn">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
