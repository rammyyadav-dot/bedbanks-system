'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { CapabilityProvider } from '@/lib/auth/capabilities';
import { pickActiveTenantId, setActiveTenantId } from '@/lib/api/tenant-context';

interface AdminShellProps {
  children: ReactNode;
  identity: AuthenticatedUser;
}

export function AdminShell({ children, identity }: AdminShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Set during render so it is in place before any child effect issues its first API call.
  setActiveTenantId(pickActiveTenantId(identity.memberships));

  return (
    <CapabilityProvider>
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} identity={identity} />
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu overlay"
          onClick={() => setMobileOpen(false)}
          style={{ position: 'fixed', inset: 0, background: '#08252b66', border: 0, zIndex: 15, cursor: 'default' }}
        />
      )}
      <div className="enterprise-main">
        <Topbar identity={identity} onMenuClick={() => setMobileOpen(true)} />
        <main>{children}</main>
      </div>
    </div>
    </CapabilityProvider>
  );
}
