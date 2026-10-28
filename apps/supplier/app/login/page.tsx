import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { BrandLogo } from '../../components/brand/BrandLogo'
import { LoginForm } from '../../components/auth/LoginForm'
import { homeUrl } from '../../lib/server-env'
import { loadAuthCapabilities, loadIdentity, SupplierApiError } from '../../lib/supplier-api'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  try {
    const identity = await loadIdentity()
    if (identity && !('ambiguous' in identity)) redirect('/dashboard')
  } catch (error) {
    if (!(error instanceof SupplierApiError)) throw error
  }

  const home = homeUrl()
  const { passwordReset } = await loadAuthCapabilities()

  return (
    <main className="supplier-login">
      <div className="login-scene" aria-hidden="true" />
      <section className="supplier-login-card" aria-labelledby="login-title">
        <div className="login-card-head">
          <BrandLogo width={150} priority />
          <p className="supplier-brand-tag"><i />Supplier extranet</p>
          <svg viewBox="0 0 400 38" preserveAspectRatio="none" aria-hidden="true"><path d="M0 24 C 90 6, 230 2, 400 14 L400 38 L0 38 Z" fill="var(--fb-ink-0)" /><path d="M0 24 C 90 6, 230 2, 400 14" fill="none" stroke="var(--fb-ink-200)" strokeWidth="6" /></svg>
        </div>
        <div className="login-card-body">
          <h1 id="login-title">Sign in</h1>
          <p className="login-lede">Use your fabBeds account to manage your hotels, contracts and bookings.</p>
          <LoginForm />
          {(home || passwordReset) && (
            <p className="login-links">
              {home ? <a href={home}>Home</a> : <span />}
              {passwordReset && <Link href="/forgot-password">Forgot your password?</Link>}
            </p>
          )}
          <p className="login-foot"><ShieldCheck size={16} aria-hidden="true" /><span>Access is checked against your supplier-organization membership after sign-in. Need access? Ask your fabBeds account manager.</span></p>
        </div>
      </section>
    </main>
  )
}
