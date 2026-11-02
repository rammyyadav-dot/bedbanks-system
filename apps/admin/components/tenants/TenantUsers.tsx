'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { routes, TENANT_MEMBERSHIP_ACTIONS } from '@bedbanks/contracts'
import { agencyAccessLabels, membershipRoleLabel } from '@/lib/tenants-ui'
import { TenantShell } from './TenantShell'
import { useTenantControl } from './useTenantControl'

export function TenantUsers({ id }: { id: string }) {
  const { data, error, notice, busy, load, mutate, can } = useTenantControl(id)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<(typeof TENANT_MEMBERSHIP_ACTIONS)[number]>('member')

  async function membership(event: FormEvent) {
    event.preventDefault()
    if (await mutate(routes.platform.tenantMemberships, { email, role, version: data?.profile?.version ?? 0 })) setEmail('')
  }

  return (
    <TenantShell
      id={id}
      title={data ? `${data.tenant.name} · users` : 'Tenant'}
      description={data ? `${data.tenant.slug} · memberships and formal access keys for this tenant` : ''}
      data={data}
      error={error}
      notice={notice}
      onRetry={() => void load()}
      actions={<Link href="/tenants" className="admin-btn">Back to directory</Link>}
    >
      {data && (
        <section className="tenant-panel tenant-detail-panel">
          <h2>User roster</h2>
          <p className="tenant-note">
            Users are existing verified accounts attached to this tenant. Invitation delivery is unavailable.
            Membership roles are tenant administrator (owner) or tenant member. Formal agent-portal permission
            bundles are shown as assigned keys; they are edited in <Link href="/access">Roles &amp; Permissions</Link>,
            not as a separate agency-tier enum. Platform privileges never follow from tenant ownership.
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table" aria-label="Tenant users">
              <thead>
                <tr>
                  <th>Name / email</th>
                  <th>Account</th>
                  <th>Membership</th>
                  <th>Access</th>
                  <th>Formal permission keys</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {data.memberships.map((row) => (
                  <tr key={row.id}>
                    <td>{row.user.name ?? row.user.email}<small className="tenant-code">{row.user.email}</small></td>
                    <td><span className={`tenant-status ${row.user.status.toLowerCase()}`}>{row.user.status}</span></td>
                    <td>{membershipRoleLabel(row.role)}<small className="tenant-code">{row.revokedAt ? 'Revoked' : 'Active'}</small></td>
                    <td>{agencyAccessLabels(row.role, row.revokedAt, row.permissions).join(', ')}</td>
                    <td>{row.permissions.join(', ') || 'No formal role assignments'}</td>
                    <td>{row.user.lastLoginAt ? new Date(row.user.lastLoginAt).toLocaleString() : 'No verified sign-in'}</td>
                  </tr>
                ))}
                {!data.memberships.length && <tr><td colSpan={6}>No memberships are recorded for this tenant.</td></tr>}
              </tbody>
            </table>
          </div>
          {can('platform.tenants.memberships.manage') && (
            <form onSubmit={membership} className="tenant-inline-form" aria-label="Membership change">
              <label>Verified user email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label>Membership action
                <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                  {TENANT_MEMBERSHIP_ACTIONS.map((action) => <option key={action} value={action}>{membershipRoleLabel(action)}</option>)}
                </select>
              </label>
              <button type="submit" className="admin-btn tenant-primary" disabled={busy}>Apply membership change</button>
            </form>
          )}
          <h2>Security &amp; session controls</h2>
          <p className="tenant-note">
            Membership revocation is the configured security control: it is versioned, audited, and takes effect on the next authenticated request.
            Password reset is self-service for the user. Admin-triggered password reset, MFA re-enrollment and remote session revoke for another user are not configured.
          </p>
          <p className="tenant-note">
            Access-review evidence for the operator&apos;s own tenant stays in <Link href="/access-review">Access reviews</Link>.
          </p>
        </section>
      )}
    </TenantShell>
  )
}
