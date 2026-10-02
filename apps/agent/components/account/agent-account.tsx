'use client'

import type { AgentIdentity } from '@/lib/api-client'

/** Account fields from the authenticated context. Permissions are not listed here. */
export function AgentAccount({ identity, tenantId }: { identity: AgentIdentity; tenantId: string }) {
  const membership = identity.memberships.find((item) => item.tenantId === tenantId)
  return <section className="portal-bookings" aria-label="Account">
    <div className="portal-heading-row"><div><span className="portal-eyebrow">AGENCY</span><h1>Account</h1><p>These fields come from your signed-in session. Search currency is chosen on each search.</p></div></div>
    <dl className="booking-review">
      <div><dt>Agency</dt><dd>{membership?.tenantName ?? '—'}</dd></div>
      <div><dt>Agent</dt><dd>{identity.user.name ?? identity.user.email}</dd></div>
      <div><dt>Email</dt><dd>{identity.user.email}</dd></div>
      <div><dt>Role</dt><dd>{membership?.role ?? '—'}</dd></div>
      <div><dt>Account status</dt><dd>{identity.user.status}</dd></div>
    </dl>
  </section>
}
