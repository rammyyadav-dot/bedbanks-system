'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { navSections } from './nav-config';

export function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();

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
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="security-note">
          <ShieldIcon />
          <span>
            <strong>UI only — mock data</strong>
            <small>Backend authorization enforced later</small>
          </span>
        </div>
        <div className="session-user">
          <span className="user-initials">PA</span>
          <span>
            <strong>Admin User</strong>
            <small>Platform Administrator</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5l-8-3Z" />
    </svg>
  );
}
