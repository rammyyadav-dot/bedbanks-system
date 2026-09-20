import { AlertTriangle, LockKeyhole, LogIn, RefreshCw, ServerCrash } from 'lucide-react'
import Link from 'next/link'

export function AccessDenied({ permission, onBack }: { permission: string; onBack?: () => void }) {
  return <section className="admin-auth-state admin-auth-state-denied" role="alert"><span className="admin-auth-state-icon"><LockKeyhole size={22} /></span><h2>Access restricted</h2><p>Your account is signed in, but it does not currently have permission to view this area.</p><code>{permission}</code>{onBack ? <button type="button" onClick={onBack}>Back to dashboard</button> : <Link href="/dashboard">Back to dashboard</Link>}</section>
}

export function AuthRequired() {
  return <section className="admin-auth-state" role="alert"><span className="admin-auth-state-icon"><LogIn size={22} /></span><h2>Sign-in required</h2><p>Your session is no longer available. Sign in again to continue.</p><Link href="/login">Sign in</Link></section>
}

export function PermissionUnavailable({ onRetry }: { onRetry: () => void }) {
  return <section className="admin-auth-state" role="alert"><span className="admin-auth-state-icon"><AlertTriangle size={22} /></span><h2>Permission status unavailable</h2><p>We could not verify access for this workspace. No dashboard data was loaded.</p><button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button></section>
}

export function AdminServiceUnavailable({ onRetry, network = false }: { onRetry: () => void; network?: boolean }) {
  return <section className="admin-auth-state" role="alert"><span className="admin-auth-state-icon"><ServerCrash size={22} /></span><h2>{network ? 'Connection unavailable' : 'Admin service unavailable'}</h2><p>{network ? 'Check your connection and try again.' : 'The Admin API is not responding. Dashboard data was not loaded.'}</p><button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button></section>
}

export function AdminLoadingState() {
  return <section className="admin-auth-state admin-loading-state" aria-busy="true" aria-label="Loading dashboard"><span /><span /><span /></section>
}
