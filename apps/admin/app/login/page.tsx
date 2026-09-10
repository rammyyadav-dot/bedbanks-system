import Link from 'next/link'

export const metadata = { title: 'Sign in · FBEDS Admin' }

export default function LoginPage() {
  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <span className="enterprise-mark" style={{ display: 'inline-flex' }}>F</span>
        <h1>FBEDS Admin Console</h1>
        <p>Sign in to manage tenants, hotel supply, and distribution. UI only — no authentication is enforced yet (that is P0-D).</p>
        <div className="admin-login-field">
          <label>EMAIL</label>
          <input type="email" placeholder="admin@fbeds.example" disabled />
        </div>
        <div className="admin-login-field">
          <label>PASSWORD</label>
          <input type="password" placeholder="••••••••" disabled />
        </div>
        <Link href="/dashboard" className="admin-btn admin-btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
          Continue to dashboard
        </Link>
      </div>
    </div>
  )
}
