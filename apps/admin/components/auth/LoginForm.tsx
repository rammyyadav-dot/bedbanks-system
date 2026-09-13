'use client';

import { useActionState } from 'react';
import { loginAction } from '@/lib/auth/actions';

const initialState = { error: null };

export function LoginForm() {
  const [state, dispatch, isPending] = useActionState(loginAction, initialState);

  return (
    <form action={dispatch}>
      {state.error && (
        <div
          role="alert"
          style={{
            background: '#fff0ef',
            border: '1px solid #f5c6c2',
            borderRadius: 4,
            padding: '10px 12px',
            fontSize: 11,
            color: '#8c2e2a',
            marginBottom: 14,
          }}
        >
          {state.error}
        </div>
      )}

      <div className="admin-login-field">
        <label htmlFor="email">EMAIL</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="admin@fbeds.example"
          disabled={isPending}
        />
      </div>

      <div className="admin-login-field">
        <label htmlFor="password">PASSWORD</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          disabled={isPending}
          minLength={8}
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="admin-btn admin-btn-primary"
        style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
      >
        {isPending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
