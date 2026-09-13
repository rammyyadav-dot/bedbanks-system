import { LoginForm } from '@/components/auth/LoginForm'

export const metadata = { title: 'Sign in · FBEDS Admin' }

export default function LoginPage() {
  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <span className="enterprise-mark" style={{ display: 'inline-flex' }}>F</span>
        <h1>FBEDS Admin Console</h1>
        <p>Sign in to manage tenants, hotel supply, and distribution.</p>
        <LoginForm />
      </div>
    </div>
  )
}
