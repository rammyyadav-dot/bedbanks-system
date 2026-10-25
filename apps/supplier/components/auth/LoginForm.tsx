'use client'

import { useActionState, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { loginAction } from '../../lib/actions'

export function LoginForm() {
  const [state, dispatch, pending] = useActionState(loginAction, { error: null })
  const [showPassword, setShowPassword] = useState(false)

  return (
    <form action={dispatch} className="login-form">
      {state.error && <p className="login-error" role="alert">{state.error}</p>}
      <div className="float-field">
        <input id="email" name="email" type="email" autoComplete="username" placeholder=" " required disabled={pending} />
        <label htmlFor="email">Email</label>
      </div>
      <div className="float-field">
        <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder=" " required minLength={8} disabled={pending} />
        <label htmlFor="password">Password</label>
        <button className="field-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
          {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      <label className="remember-row" htmlFor="rememberMe">
        <input id="rememberMe" name="rememberMe" type="checkbox" disabled={pending} />
        <span><strong>Remember me for 15 days</strong><small>Only select on your trusted personal device</small></span>
      </label>
      <button className="btn btn-primary login-submit" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  )
}
