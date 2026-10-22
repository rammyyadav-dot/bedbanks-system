'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import './hotel-admin.css';
import './shell-theme.css';
import { HotelAdminHeader } from './HotelAdminHeader';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { RouteGuard } from './RouteGuard';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { CapabilityProvider } from '@/lib/auth/capabilities';
import { setActiveTenantId } from '@/lib/api/tenant-context';

interface AdminShellProps {
  children: ReactNode;
  identity: AuthenticatedUser;
  /** Resolved on the server from the validated selection; null only when the user has no membership. */
  activeTenantId: string | null;
}

export function AdminShell({ children, identity, activeTenantId }: AdminShellProps) {
  const pathname = usePathname();
  const hotelLayout = pathname === '/hotels' || pathname.startsWith('/hotels/');
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!mobileOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [mobileOpen]);
  // Set during render so it is in place before any child effect issues its first API call.
  setActiveTenantId(activeTenantId);

  return (
    <CapabilityProvider tenantId={activeTenantId}>
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <div className={hotelLayout ? 'hotel-admin-shell' : undefined} style={{ display: 'flex', minHeight: '100vh' }}>
      {!hotelLayout && <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} identity={identity} activeTenantId={activeTenantId} />}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu overlay"
          onClick={() => setMobileOpen(false)}
          style={{ position: 'fixed', inset: 0, background: '#08252b66', border: 0, zIndex: 15, cursor: 'default' }}
        />
      )}
      <div className="enterprise-main">
        {hotelLayout ? <HotelAdminHeader key={pathname} identity={identity} activeTenantId={activeTenantId} /> : <Topbar identity={identity} activeTenantId={activeTenantId} onMenuClick={() => setMobileOpen(true)} />}
        <main id="main-content" tabIndex={-1}><RouteGuard key={activeTenantId ?? 'none'}>{children}</RouteGuard></main>
      </div>
    </div>
    </CapabilityProvider>
  );
}
