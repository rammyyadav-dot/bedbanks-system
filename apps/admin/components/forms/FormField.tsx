import type { ReactNode } from 'react';

export function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-login-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
