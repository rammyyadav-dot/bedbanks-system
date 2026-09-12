'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import type { AuthenticatedUser } from '@/lib/api/auth-client';

interface AdminShellProps {
  children: ReactNode;
  identity: AuthenticatedUser;
}

export function AdminShell({ children, identity }: AdminShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
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
  );
}
