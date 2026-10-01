'use client';

import { useState } from 'react';
import { Menu, ChevronDown } from 'lucide-react';
import { Breadcrumbs } from './Breadcrumbs';
import { LogoutButton } from '@/components/auth/LogoutButton';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { userInitials } from '@/lib/auth/identity';

interface TopbarProps {
  onMenuClick: () => void;
  identity: AuthenticatedUser;
}

export function Topbar({ onMenuClick, identity }: TopbarProps) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const initials = userInitials(identity.user);
  const primaryTenant = identity.memberships[0];

  return (
    <header className="enterprise-topbar">
      <button type="button" className="mobile-nav-trigger" onClick={onMenuClick} aria-label="Open menu" style={{ display: 'grid' }}>
        <Menu size={20} />
      </button>
      <Breadcrumbs />
      <div style={{ flex: 1 }} />
      <div className="topbar-actions">
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', cursor: 'pointer' }}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            aria-label="User menu"
          >
            <span className="top-user" title={identity.user.email}>{initials}</span>
            <ChevronDown size={13} color="#8ba8ae" />
          </button>
          {userMenuOpen && (
            <div className="context-menu" style={{ top: 42, width: 200, right: 0, left: 'auto' }}>
              <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #1d3d48' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#c8dde1' }}>{identity.user.name ?? identity.user.email}</div>
                {primaryTenant && <div style={{ fontSize: 9, color: '#6d9199', marginTop: 2 }}>{primaryTenant.role} · {primaryTenant.tenantName}</div>}
              </div>
              <LogoutButton />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
