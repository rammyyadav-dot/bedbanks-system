import Link from 'next/link'
import { AuthCard } from '../../components/auth/AuthCard'
import { ForgotPasswordForm } from '../../components/auth/ForgotPasswordForm'
import { loadAuthCapabilities } from '../../lib/supplier-api'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Forgot password · fabBeds Supplier Extranet', robots: { index: false } }

export default async function ForgotPasswordPage() {
  const { passwordReset } = await loadAuthCapabilities()
  if (!passwordReset) {
    return (
      <AuthCard title="Reset unavailable" lede="Password reset by email is not available right now. Ask your fabBeds account manager to reset your password.">
        <p className="login-links"><Link href="/login">Back to sign in</Link></p>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Forgot your password?" lede="Enter your account email and we will send you a link to choose a new password.">
      <ForgotPasswordForm />
    </AuthCard>
  )
}
