'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

export function DetailDrawer({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="admin-drawer-backdrop" onClick={onClose}>
      <div className="admin-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="admin-drawer-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <h2>{title}</h2>
        {subtitle && <p style={{ color: '#7c949a', fontSize: 11, margin: '0 0 16px' }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function DrawerField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="admin-drawer-field">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
