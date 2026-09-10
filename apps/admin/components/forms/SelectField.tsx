'use client';

export function SelectField({
  value, onChange, options, label,
}: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <select className="admin-filter-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  );
}
