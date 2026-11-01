'use client';

import { logoutAction } from '@/lib/auth/actions';
import { LogOut } from 'lucide-react';
import { confirmDiscard } from '@/components/hotels/unsaved-guard';
import { clearAllDrafts } from '@/lib/draft-store';

export function LogoutButton() {
  return (
    <form action={logoutAction} style={{ margin: 0 }} onSubmit={(event) => {
      if (!confirmDiscard('You have unsaved hotel changes. Signing out discards them. Sign out anyway?')) { event.preventDefault(); return; }
      clearAllDrafts(); // a signed-out tab must not keep this operator's unsaved edits for the next person
    }}>
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
          color: 'var(--c-6b6b6b)',
          textAlign: 'left',
        }}
      >
        <LogOut size={13} />
        Sign out
      </button>
    </form>
  );
}
