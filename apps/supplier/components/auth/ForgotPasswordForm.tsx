'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { CircleCheck } from 'lucide-react'
import { requestPasswordResetAction } from '../../lib/actions'

export function ForgotPasswordForm() {
  const [state, dispatch, pending] = useActionState(requestPasswordResetAction, { error: null })

  if (state.requested) {
    return (
      <div className="login-form">
        <p className="inline-notice success login-status" role="status"><CircleCheck size={18} aria-hidden="true" /><span>If an account exists for that address, we have emailed a link to reset the password. It works once and expires in 30 minutes.</span></p>
        <Link className="btn login-submit-secondary" href="/login">Back to sign in</Link>
      </div>
    )
  }

  return (
    <form action={dispatch} className="login-form">
      {state.error && <p className="login-error" role="alert">{state.error}</p>}
      <div className="float-field">
        <input id="email" name="email" type="email" autoComplete="username" placeholder=" " required disabled={pending} />
        <label htmlFor="email">Email</label>
      </div>
      <button className="btn btn-primary login-submit" type="submit" disabled={pending}>{pending ? 'Sending…' : 'Email me a reset link'}</button>
      <p className="login-links"><Link href="/login">Back to sign in</Link></p>
    </form>
  )
}
