import { Injectable, Optional } from '@nestjs/common'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { EmailSendError, type EmailEnvelope, type EmailSender } from './email-sender.port'

/** Errors where a retry cannot help: the message or an address was refused, or the sender identity is not verified. */
const PERMANENT = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'BadRequestException', 'NotFoundException'])

/**
 * AWS SES v2 (ADR 0066). Configured by `EMAIL_FROM` and `EMAIL_SES_REGION`; credentials come from the task role through the SDK's default
 * provider chain, never from a variable this code reads. Sends raw MIME so the voucher and invoice travel as attachments.
 */
@Injectable()
export class SesEmailSender implements EmailSender {
  readonly name = 'ses'
  private client: SESv2Client | null = null

  constructor(@Optional() private readonly env: Record<string, string | undefined> = process.env, @Optional() private readonly clientFactory?: (region: string) => Pick<SESv2Client, 'send'>) {}

  configured(): boolean {
    return Boolean(this.env.EMAIL_FROM?.trim() && this.env.EMAIL_SES_REGION?.trim())
  }

  async send(envelope: EmailEnvelope, rawMime: string): Promise<{ messageId: string }> {
    if (!this.configured()) throw new EmailSendError('EMAIL_NOT_CONFIGURED', false)
    const region = this.env.EMAIL_SES_REGION!.trim()
    const client = this.clientFactory ? this.clientFactory(region) : (this.client ??= new SESv2Client({ region }))
    try {
      const out = await client.send(new SendEmailCommand({
        FromEmailAddress: envelope.from,
        Destination: { ToAddresses: envelope.to, ...(envelope.cc.length ? { CcAddresses: envelope.cc } : {}), ...(envelope.bcc?.length ? { BccAddresses: envelope.bcc } : {}) },
        Content: { Raw: { Data: Buffer.from(rawMime, 'utf8') } },
      }))
      if (!out.MessageId) throw new EmailSendError('SES_NO_MESSAGE_ID', false)
      return { messageId: out.MessageId }
    } catch (error) {
      if (error instanceof EmailSendError) throw error
      const name = error instanceof Error ? error.name : 'Unknown'
      const code = `SES_${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 48)}`
      throw new EmailSendError(code, PERMANENT.has(name))
    }
  }
}
