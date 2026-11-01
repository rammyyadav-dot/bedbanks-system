import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { buildMime } from '../booking-ops/email/mime'
import { EMAIL_SENDER, EmailSendError, type EmailSender } from '../booking-ops/email/email-sender.port'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Subject, text and HTML of the reset email. Pure: the link is built by the service from a trusted origin and a hex token. */
export function renderPasswordResetEmail(link: string, minutes: number): { subject: string; text: string; html: string } {
  const text = `We received a request to reset your fabBeds password.\n\nOpen this link within ${minutes} minutes to choose a new password:\n${link}\n\nIf you did not ask for this, you can ignore this email. Your password will not change.\n`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937"><p style="font-size:18px;font-weight:700;color:#e20a14">fabBeds</p><p>We received a request to reset your password.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#25589f;color:#fff;text-decoration:none;font-weight:700">Choose a new password</a></p><p style="font-size:13px;color:#4b5563">This link works once and expires in ${minutes} minutes. If you did not ask for this, you can ignore this email: your password will not change.</p></div>`
  return { subject: 'Reset your fabBeds password', text, html }
}

/** Sends the reset email through the shared EmailSender (SES in production, ADR 0066). Never logs the address, the link or the token. */
@Injectable()
export class PasswordResetMailer {
  private readonly logger = new Logger(PasswordResetMailer.name)

  constructor(@Inject(EMAIL_SENDER) private readonly sender: EmailSender, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  /** True only when a sender and an EMAIL_FROM address are configured. The sign-in page shows "Forgot your password?" only when this is true. */
  enabled(): boolean {
    return this.sender.configured() && Boolean(this.env.EMAIL_FROM?.trim())
  }

  async send(to: string, link: string, minutes: number): Promise<boolean> {
    if (!this.enabled()) return false
    const from = this.env.EMAIL_FROM!.trim()
    try {
      const raw = buildMime({ from, to: [to], cc: [], attachments: [], ...renderPasswordResetEmail(link, minutes) })
      await this.sender.send({ from, to: [to], cc: [] }, raw)
      return true
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'password_reset_email_failed', code: error instanceof EmailSendError ? error.code : 'SEND_ERROR' }))
      return false
    }
  }
}
