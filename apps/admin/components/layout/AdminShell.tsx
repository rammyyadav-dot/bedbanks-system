'use client';

import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import './hotel-admin.css';
import { HotelAdminHeader } from './HotelAdminHeader';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { RouteGuard } from './RouteGuard';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { CapabilityProvider } from '@/lib/auth/capabilities';
import { pickActiveTenantId, setActiveTenantId } from '@/lib/api/tenant-context';

interface AdminShellProps {
  children: ReactNode;
  identity: AuthenticatedUser;
}

export function AdminShell({ children, identity }: AdminShellProps) {
  const pathname = usePathname();
  const hotelLayout = pathname === '/hotels' || pathname.startsWith('/hotels/');
  const [mobileOpen, setMobileOpen] = useState(false);
  // Set during render so it is in place before any child effect issues its first API call.
  const activeTenantId = pickActiveTenantId(identity.memberships);
  setActiveTenantId(activeTenantId);

  return (
    <CapabilityProvider tenantId={activeTenantId}>
    <div className={hotelLayout ? 'hotel-admin-shell' : undefined} style={{ display: 'flex', minHeight: '100vh' }}>
      {!hotelLayout && <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} identity={identity} />}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu overlay"
          onClick={() => setMobileOpen(false)}
          style={{ position: 'fixed', inset: 0, background: '#08252b66', border: 0, zIndex: 15, cursor: 'default' }}
        />
      )}
      <div className="enterprise-main">
        {hotelLayout ? <HotelAdminHeader key={pathname} identity={identity} /> : <Topbar identity={identity} onMenuClick={() => setMobileOpen(true)} />}
        <main><RouteGuard>{children}</RouteGuard></main>
      </div>
    </div>
    </CapabilityProvider>
  );
}
