import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/auth/LoginForm'
import { LogoutButton } from '@/components/auth/LogoutButton'
import { safePostLoginPath } from '@/lib/auth/post-login-path'
import { getSession } from '@/lib/auth/session'
import { sessionMayUseAdminConsole } from '@/lib/auth/admin-access'

export const metadata = { title: 'Sign in · FBEDS Admin' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ from?: string | string[]; denied?: string | string[] }> }) {
  const params = await searchParams
  const from = Array.isArray(params.from) ? params.from[0] : params.from
  const denied = (Array.isArray(params.denied) ? params.denied[0] : params.denied) === 'role'
  const target = safePostLoginPath(from)

  let session = null
  let authUnavailable = false
  try {
    session = await getSession()
  } catch {
    authUnavailable = true
  }
  if (session && sessionMayUseAdminConsole(session.memberships)) {
    redirect(target)
  }
  const roleDenied = denied || Boolean(session && !sessionMayUseAdminConsole(session.memberships))

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <span className="admin-login-mark" aria-hidden="true">f</span>
        <div className="admin-login-breadcrumb" aria-label="Breadcrumb">FBEDS <span>/</span> ADMIN PORTAL</div>
        <h1>{roleDenied ? 'Admin access required' : 'Sign in to your workspace'}</h1>
        <p>
          {authUnavailable
            ? 'The authentication service could not be reached. Sign-in is unavailable until it recovers.'
            : roleDenied
              ? 'This session is signed in but does not hold ADMIN or SUPER_ADMIN on any tenant. Sign out, or use the Agent portal.'
              : 'Access tenant-scoped hotel inventory, rates and booking operations. Sessions are validated by the API, not by this form.'}
        </p>
        {authUnavailable ? null : roleDenied ? (
          <div role="alert" style={{ marginBottom: 16 }}>
            <LogoutButton />
          </div>
        ) : (
          <LoginForm from={target} />
        )}
      </div>
    </div>
  )
}
