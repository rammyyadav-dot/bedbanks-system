'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { CircleCheck, Eye, EyeOff } from 'lucide-react'
import { confirmPasswordResetAction } from '../../lib/actions'

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, dispatch, pending] = useActionState(confirmPasswordResetAction, { error: null })
  const [show, setShow] = useState(false)

  if (state.done) {
    return (
      <div className="login-form">
        <p className="inline-notice success login-status" role="status"><CircleCheck size={18} aria-hidden="true" /><span>Your password has been changed and you have been signed out everywhere. Sign in with the new password.</span></p>
        <Link className="btn btn-primary login-submit" href="/login">Go to sign in</Link>
      </div>
    )
  }

  return (
    <form action={dispatch} className="login-form">
      <input type="hidden" name="token" value={token} />
      {state.error && <p className="login-error" role="alert">{state.error} {state.error.includes('link') && <Link href="/forgot-password">Request a new link</Link>}</p>}
      <div className="float-field">
        <input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder=" " required minLength={12} maxLength={128} disabled={pending} aria-describedby="password-help" />
        <label htmlFor="password">New password</label>
        <button className="field-toggle" type="button" onClick={() => setShow((value) => !value)} aria-label={show ? 'Hide characters' : 'Show characters'} aria-pressed={show}>
          {show ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      <p id="password-help" className="field-help">At least 12 characters. A short sentence works well. Do not use your email address.</p>
      <div className="float-field">
        <input id="confirm" name="confirm" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder=" " required minLength={12} maxLength={128} disabled={pending} />
        <label htmlFor="confirm">Confirm new password</label>
      </div>
      <button className="btn btn-primary login-submit" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Set new password'}</button>
    </form>
  )
}
