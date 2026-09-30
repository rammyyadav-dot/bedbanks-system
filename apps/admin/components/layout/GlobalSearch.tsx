'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { flatNav } from './nav-config';

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

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return flatNav.filter((item) => item.label.toLowerCase().includes(q) || item.href.includes(q)).slice(0, 8);
  }, [query]);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
      <div className="hotel-top-search">
        <Search size={14} />
        <input
          placeholder="Jump to a page…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          aria-label="Jump to a page"
        />
      </div>
      {open && matches.length > 0 && (
        <div className="hotel-popover" style={{ width: '100%', maxHeight: 360, overflowY: 'auto' }}>
          <div style={{ font: "9px 'Courier New', monospace", color: '#7c949a', letterSpacing: '.8px', marginBottom: 6 }}>PAGES</div>
          {matches.map((item) => (
            <Link key={item.href} href={item.href} onClick={() => { setOpen(false); setQuery(''); }} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 4px', fontSize: 12, color: '#2c4a55', textDecoration: 'none', borderRadius: 4 }}>
              {item.label}
              {!item.live && <span style={{ color: '#8ba0a5', fontSize: 10 }}>Not available yet</span>}
            </Link>
          ))}
        </div>
      )}
      {open && query.trim() && matches.length === 0 && (
        <div className="hotel-popover" style={{ width: '100%', color: '#7e969d', fontSize: 11 }}>No pages match &ldquo;{query}&rdquo;</div>
      )}
    </div>
  );
}
