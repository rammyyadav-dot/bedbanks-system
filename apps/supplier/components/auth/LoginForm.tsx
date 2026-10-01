'use client'

import { useActionState } from 'react'
import { loginAction } from '../../lib/actions'

export function LoginForm() {
  const [state, dispatch, pending] = useActionState(loginAction, { error: null })

  return (
    <form action={dispatch}>
      {state.error && <p role="alert">{state.error}</p>}
      <label htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="username" required disabled={pending} /></label>
      <label htmlFor="password">Password<input id="password" name="password" type="password" autoComplete="current-password" required minLength={8} disabled={pending} /></label>
      <button className="btn btn-primary" type="submit" disabled={pending}>Sign in</button>
    </form>
  )
}
