import { LoginForm } from '@/components/auth/LoginForm'
import { safePostLoginPath } from '@/lib/auth/post-login-path'

export const metadata = { title: 'Sign in · FBEDS Admin' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams
  const target = safePostLoginPath(Array.isArray(from) ? from[0] : from)
  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <span className="admin-login-mark" aria-hidden="true">f</span>
        <div className="admin-login-breadcrumb" aria-label="Breadcrumb">FBEDS <span>/</span> ADMIN PORTAL</div>
        <h1>Sign in to your workspace</h1>
        <p>Access tenant-scoped hotel inventory, rates and booking operations.</p>
        <LoginForm from={target} />
      </div>
    </div>
  )
}
