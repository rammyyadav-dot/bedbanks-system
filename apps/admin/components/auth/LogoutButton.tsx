'use client';

import { logoutAction } from '@/lib/auth/actions';
import { LogOut } from 'lucide-react';

export function LogoutButton() {
  return (
    <form action={logoutAction} style={{ margin: 0 }}>
      <button
        type="submit"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
          padding: '7px 10px',
          fontSize: 11,
          color: '#5c7d85',
          textAlign: 'left',
        }}
      >
        <LogOut size={13} />
        Sign out
      </button>
    </form>
  );
}
