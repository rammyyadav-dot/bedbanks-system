'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { navSections } from './nav-config';
import { userInitials } from './user-initials';

export function Sidebar({ mobileOpen, onClose, identity }: { mobileOpen: boolean; onClose: () => void; identity: AuthenticatedUser }) {
  const pathname = usePathname();
  const primaryTenant = identity.memberships[0];

  return (
    <aside className={`enterprise-sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label="Admin navigation">
      <div className="enterprise-brand">
        <span className="enterprise-mark">F</span>
        <span>
          <strong>FBEDS</strong>
          <small>ADMIN CONSOLE</small>
        </span>
        <button type="button" className="sidebar-close" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <nav className="enterprise-nav" aria-label="Primary">
        {navSections.map((section, i) => (
          <div key={section.label ?? `s${i}`} style={{ marginBottom: 4 }}>
            {section.label && <div className="shell-caption">{section.label.toUpperCase()}</div>}
            {section.items.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className={active ? 'active' : ''} onClick={onClose}>
                  <span className="nav-glyph"><Icon size={15} /></span>
                  {item.label}
                  {!item.live && <span className="nav-soon" title="No production API yet">Soon</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="session-user">
          <span className="user-initials">{userInitials(identity.user)}</span>
          <span>
            <strong>{identity.user.name ?? identity.user.email}</strong>
            <small>{primaryTenant ? `${primaryTenant.role} · ${primaryTenant.tenantName}` : 'No tenant membership'}</small>
          </span>
        </div>
      </div>
    </aside>
  );
}
