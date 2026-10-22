'use client';

import { useState, useTransition } from 'react';
import { Building2, Check } from 'lucide-react';
import { switchTenantAction } from '@/lib/auth/actions';
import type { MembershipSummary } from '@/lib/api/auth-client';

/**
 * Lists the caller's own memberships and asks the server to select one. The server re-validates the choice against the
 * session's memberships; nothing here decides which tenant is trusted. Renders nothing for a single-tenant user.
 */
export function TenantSwitcher({ memberships, activeTenantId }: { memberships: MembershipSummary[]; activeTenantId: string | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (memberships.length < 2) return null;

  function select(tenantId: string) {
    if (tenantId === activeTenantId) return;
    setError(null);
    startTransition(async () => {
      const result = await switchTenantAction(tenantId);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div role="group" aria-label="Switch tenant" aria-busy={pending}>
      <div className="shell-caption" style={{ padding: '8px 12px 4px' }}>SWITCH TENANT</div>
      {memberships.map((membership) => {
        const active = membership.tenantId === activeTenantId;
        return (
          <button key={membership.tenantId} type="button" role="menuitemradio" aria-checked={active} disabled={pending} onClick={() => select(membership.tenantId)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Building2 size={12} />{membership.tenantName}</span>
            <small>{active ? <Check size={12} aria-label="Active" /> : membership.role}</small>
          </button>
        );
      })}
      {error && <p role="alert" style={{ margin: 0, padding: '6px 12px', fontSize: 10, color: 'var(--k-f0c3bd)' }}>{error}</p>}
    </div>
  );
}
