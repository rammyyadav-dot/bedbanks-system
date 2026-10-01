import { redirect } from 'next/navigation'
import { LoginForm } from '../../components/auth/LoginForm'
import { loadIdentity, SupplierApiError } from '../../lib/supplier-api'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  try {
    const identity = await loadIdentity()
    if (identity && !('ambiguous' in identity)) redirect('/dashboard')
  } catch (error) {
    if (!(error instanceof SupplierApiError)) throw error
  }

  return (
    <main className="supplier-login">
      <section className="supplier-login-card">
        <span className="supplier-brand-mark" aria-hidden="true">f</span>
        <p className="page-eyebrow"><i />SUPPLIER EXTRANET</p>
        <h1>Sign in</h1>
        <p>Use your fBeds account. The server checks supplier-organization membership after sign-in.</p>
        <LoginForm />
      </section>
    </main>
  )
}
