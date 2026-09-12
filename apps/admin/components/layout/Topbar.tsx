'use client';

import { useState } from 'react';
import { Menu, Bell, HelpCircle, ChevronDown } from 'lucide-react';
import { Breadcrumbs } from './Breadcrumbs';
import { GlobalSearch } from './GlobalSearch';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  return (
    <header className="enterprise-topbar">
      <button type="button" className="mobile-nav-trigger" onClick={onMenuClick} aria-label="Open menu" style={{ display: 'grid' }}>
        <Menu size={20} />
      </button>
      <Breadcrumbs />
      <GlobalSearch />
      <div className="topbar-actions">
        <button type="button" className="icon-button" aria-label="Help">
          <HelpCircle size={17} />
        </button>
        <button type="button" className="icon-button" aria-label="Notifications">
          <Bell size={17} />
          <em />
        </button>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', cursor: 'pointer' }}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <span className="top-user">PA</span>
            <ChevronDown size={13} color="#8ba8ae" />
          </button>
          {userMenuOpen && (
            <div className="context-menu" style={{ top: 42, width: 180, right: 0, left: 'auto' }}>
              <button type="button" onClick={() => setUserMenuOpen(false)}>Profile</button>
              <button type="button" onClick={() => setUserMenuOpen(false)}>Preferences</button>
              <button type="button" onClick={() => setUserMenuOpen(false)}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
