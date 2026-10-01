'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { navSections, isActiveRoute } from './nav-config';
import { useCan } from '@/lib/auth/capabilities';
import type { AuthenticatedUser } from '@/lib/api/auth-client';
import { userInitials } from '@/lib/auth/identity';

export function Sidebar({ mobileOpen, onClose, identity }: { mobileOpen: boolean; onClose: () => void; identity: AuthenticatedUser }) {
  const pathname = usePathname();
  const can = useCan();
  const membership = identity.memberships[0];

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
        {navSections.map((section) => ({ ...section, items: section.items.filter((item) => !item.requires || can(item.requires)) })).filter((section) => section.items.length > 0).map((section, i) => (
          <div key={section.label ?? `s${i}`} style={{ marginBottom: 4 }}>
            {section.label && <div className="shell-caption">{section.label.toUpperCase()}</div>}
            {section.items.map((item) => {
              const active = isActiveRoute(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className={active ? 'active' : ''} onClick={onClose}>
                  <span className="nav-glyph"><Icon size={15} /></span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="session-user" title={identity.user.email}>
          <span className="user-initials">{userInitials(identity.user)}</span>
          <span>
            <strong>{identity.user.name ?? identity.user.email}</strong>
            <small>{membership ? `${membership.role} · ${membership.tenantName}` : identity.user.email}</small>
          </span>
        </div>
      </div>
    </aside>
  );
}
