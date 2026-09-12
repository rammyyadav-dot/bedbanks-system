'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { tenants, users, hotels, bookings, suppliers } from '../../lib/mock';

interface ResultGroup { label: string; items: { id: string; title: string; href: string }[]; }

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const groups: ResultGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return [
      { label: 'Hotels', items: hotels.filter((h) => h.name.toLowerCase().includes(q)).slice(0, 3).map((h) => ({ id: h.id, title: h.name, href: `/hotels/${h.id}` })) },
      { label: 'Tenants', items: tenants.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 3).map((t) => ({ id: t.id, title: t.name, href: `/tenants/${t.id}` })) },
      { label: 'Users', items: users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)).slice(0, 3).map((u) => ({ id: u.id, title: `${u.name} · ${u.email}`, href: `/users/${u.id}` })) },
      { label: 'Bookings', items: bookings.filter((b) => b.reference.toLowerCase().includes(q)).slice(0, 3).map((b) => ({ id: b.id, title: b.reference, href: `/bookings/${b.id}` })) },
      { label: 'Suppliers', items: suppliers.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 3).map((s) => ({ id: s.id, title: s.name, href: `/suppliers/${s.id}` })) },
    ].filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
      <div className="hotel-top-search">
        <Search size={14} />
        <input
          placeholder="Search FBEDS — tenants, users, hotels, bookings, suppliers…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          aria-label="Global search"
        />
        <kbd>/</kbd>
      </div>
      {open && groups.length > 0 && (
        <div className="hotel-popover" style={{ width: '100%', maxHeight: 360, overflowY: 'auto' }}>
          {groups.map((group) => (
            <div key={group.label} style={{ marginBottom: 10 }}>
              <div style={{ font: "9px 'Courier New', monospace", color: '#7c949a', letterSpacing: '.8px', marginBottom: 6 }}>{group.label.toUpperCase()}</div>
              {group.items.map((item) => (
                <a key={item.id} href={item.href} style={{ display: 'block', padding: '7px 4px', fontSize: 12, color: '#2c4a55', textDecoration: 'none', borderRadius: 4 }}>
                  {item.title}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
      {open && query.trim() && groups.length === 0 && (
        <div className="hotel-popover" style={{ width: '100%', color: '#7e969d', fontSize: 11 }}>No results for &ldquo;{query}&rdquo;</div>
      )}
    </div>
  );
}
