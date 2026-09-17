import { LoginForm } from '@/components/auth/LoginForm'

export const metadata = { title: 'Sign in · FBEDS Admin' }

export default function LoginPage() {
  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <span className="admin-login-mark" aria-hidden="true">f</span>
        <div className="admin-login-breadcrumb" aria-label="Breadcrumb">FBEDS <span>/</span> ADMIN PORTAL</div>
        <h1>Sign in to your workspace</h1>
        <p>Access tenant-scoped hotel inventory, rates and booking operations.</p>
        <LoginForm />
      </div>
    </div>
  )
}
