'use client';

import { Search } from 'lucide-react';

export function SearchInput({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="admin-search-box">
      <Search size={13} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}
