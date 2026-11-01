import Link from 'next/link'
import { AuthCard } from '../../components/auth/AuthCard'
import { ResetPasswordForm } from '../../components/auth/ResetPasswordForm'
import { loadAuthCapabilities } from '../../lib/supplier-api'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Choose a new password · fabBeds Supplier Extranet', robots: { index: false }, referrer: 'no-referrer' }

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).token
  const token = typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw) ? raw : null
  const { passwordReset } = await loadAuthCapabilities()
  if (!token || !passwordReset) {
    return (
      <AuthCard title="Link not valid" lede="This reset link is missing, invalid or has expired.">
        <p className="login-links">{passwordReset ? <Link href="/forgot-password">Request a new link</Link> : <Link href="/login">Back to sign in</Link>}</p>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Choose a new password" lede="Pick a password you do not use anywhere else.">
      <ResetPasswordForm token={token} />
    </AuthCard>
  )
}
