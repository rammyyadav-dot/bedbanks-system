'use client';

import { useActionState } from 'react';
import { loginAction } from '@/lib/auth/actions';

const initialState = { error: null };

export function LoginForm({ from }: { from?: string }) {
  const [state, dispatch, isPending] = useActionState(loginAction, initialState);

  return (
    <form action={dispatch}>
      {from && <input type="hidden" name="from" value={from} />}
      {state.error && (
        <div
          role="alert"
          style={{
            background: 'var(--c-fff0ef)',
            border: '1px solid var(--c-f5c6c2)',
            borderRadius: 4,
            padding: '10px 12px',
            fontSize: 11,
            color: 'var(--c-8c2e2a)',
            marginBottom: 14,
          }}
        >
          {state.error}
        </div>
      )}

      <div className="admin-login-field">
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          disabled={isPending}
        />
      </div>

      <div className="admin-login-field">
        <label htmlFor="password">Password</label>
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
        {isPending ? 'Signing in securely…' : 'Sign in securely'}
      </button>
    </form>
  );
}
