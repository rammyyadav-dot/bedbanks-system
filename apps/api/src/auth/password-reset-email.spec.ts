import { PasswordResetMailer, renderPasswordResetEmail } from './password-reset-email'
import { EmailSendError, type EmailSender } from '../booking-ops/email/email-sender.port'

const sender = (over: Partial<EmailSender> = {}): EmailSender => ({ name: 'test', configured: () => true, send: jest.fn().mockResolvedValue({ messageId: 'm1' }), ...over })

describe('password reset email', () => {
  it('escapes the link in HTML and states the lifetime', () => {
    const out = renderPasswordResetEmail('https://s.example/reset-password?token=ab&x="1"', 30)
    expect(out.html).toContain('&amp;x=&quot;1&quot;')
    expect(out.text).toContain('30 minutes')
    expect(out.html).not.toContain('<script')
  })
  it('is disabled without a sender or without EMAIL_FROM, and never sends then', async () => {
    const s = sender({ configured: () => false })
    expect(new PasswordResetMailer(s, { EMAIL_FROM: 'a@b.co' }).enabled()).toBe(false)
    expect(new PasswordResetMailer(sender(), {}).enabled()).toBe(false)
    expect(await new PasswordResetMailer(s, { EMAIL_FROM: 'a@b.co' }).send('u@x.co', 'https://l', 30)).toBe(false)
    expect(s.send).not.toHaveBeenCalled()
  })
  it('sends one MIME message to the recipient and reports a provider failure as false without throwing', async () => {
    const ok = sender()
    expect(await new PasswordResetMailer(ok, { EMAIL_FROM: 'no-reply@fabbeds.example' }).send('u@x.co', 'https://l/t', 30)).toBe(true)
    expect((ok.send as jest.Mock).mock.calls[0][0]).toEqual({ from: 'no-reply@fabbeds.example', to: ['u@x.co'], cc: [] })
    const bad = sender({ send: jest.fn().mockRejectedValue(new EmailSendError('SES_MESSAGEREJECTED', true)) })
    expect(await new PasswordResetMailer(bad, { EMAIL_FROM: 'no-reply@fabbeds.example' }).send('u@x.co', 'https://l/t', 30)).toBe(false)
  })
})
