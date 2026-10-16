import { buildMime } from './mime'
import { renderConfirmationEmail } from './booking-email.render'
import { SesEmailSender } from './ses-email-sender'
import { EmailSendError } from './email-sender.port'

const voucher = { number: 'VCH-FB-1', issuedAt: '2099-01-01T00:00:00.000Z', payload: {
  bookingReference: 'FB-1', issuedFor: 'Acme <Travel>', hotel: { name: 'Marina <b>Bay</b>', city: 'Dubai' }, room: { name: 'Deluxe' }, board: { name: 'Bed and Breakfast' },
  stay: { checkIn: '2099-05-01', checkOut: '2099-05-03', nights: 2, rooms: 1, adults: 2, children: 0, childAges: [] }, leadGuest: { firstName: 'Layla', lastName: "O'Hara" },
  agentRef: 'TR-1', hotelDetails: { address: '1 Marina Walk', checkInTime: '15:00', checkOutTime: '12:00' }, cancellationPolicy: [{ daysBeforeCheckin: 7, penalty: '100% of the booking total' }],
  specialRequests: { items: ['Late check-in'], note: 'After <midnight>' },
} }
const invoice = { number: 'INV-FB-1', issuedAt: '2099-01-01T00:00:00.000Z', payload: { ...voucher.payload, currency: 'AED', totalMinor: '90000', lines: [{ description: 'Accommodation', amountMinor: '90000' }], payment: { status: 'PAID' } } }
const decode = (raw: string, type: string) => Buffer.from(raw.split(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8')

describe('confirmation email (ADR 0066)', () => {
  it('renders from the documents, escapes every value and links only to an https portal', () => {
    const mail = renderConfirmationEmail({ voucher, invoice, bookingStatus: 'CONFIRMED', portalUrl: 'https://agent.example/bookings/' })
    expect(mail.subject).toBe('Booking confirmed: Marina <b>Bay</b> · 2099-05-01 · FB-1')
    expect(mail.html).toContain('Marina &lt;b&gt;Bay&lt;/b&gt;'); expect(mail.html).not.toContain('<b>Bay'); expect(mail.html).toContain('AED 900.00')
    expect(mail.html).toContain('After &lt;midnight&gt;'); expect(mail.html).toContain('href="https://agent.example/bookings"'); expect(mail.html).not.toMatch(/<script|<img|http:\/\//)
    expect(mail.text).toContain('Total charged: AED 900.00'); expect(mail.text).toContain('Within 7 day(s) of check-in: 100% of the booking total')
    expect(mail.attachments.map((a) => a.filename)).toEqual(['Voucher-VCH-FB-1.html', 'Invoice-INV-FB-1.html'])
    expect(mail.attachments[0].content).toContain('Hotel Voucher'); expect(mail.attachments[0].content).not.toContain('AED 900.00')
    expect(renderConfirmationEmail({ voucher, invoice, bookingStatus: 'CONFIRMED', portalUrl: 'javascript:alert(1)' }).html).not.toContain('javascript:')
    expect(renderConfirmationEmail({ voucher, invoice, bookingStatus: 'CONFIRMED', portalUrl: 'http://plain.example' }).html).not.toContain('plain.example')
  })

  it('builds a multipart MIME message whose headers cannot be injected and whose bodies are base64', () => {
    const raw = buildMime({ from: 'Res <res@fbeds.example>', to: ['agent@agency.example\r\nBcc: victim@evil.example'], cc: ['ops@agency.example'], subject: 'Hi\r\nBcc: x@evil.example · ✓', html: '<p>Hello</p>', text: 'Hello', attachments: [{ filename: 'a"b\r\n.html', contentType: 'text/html; charset=UTF-8', content: '<p>doc</p>' }] }, 'seed')
    expect(raw).not.toMatch(/\r\nBcc:/i)
    expect(raw).toContain('To: agent@agency.example Bcc: victim@evil.example')
    expect(raw).toMatch(/\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/)
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="mixed_seed"'); expect(raw).toContain('filename="a_b .html"')
    expect(decode(raw, 'text/html')).toBe('<p>Hello</p>'); expect(decode(raw, 'text/plain')).toBe('Hello')
    expect(raw.trimEnd().endsWith('--mixed_seed--')).toBe(true)
  })

  it('SES: refuses to send unconfigured, maps rejections to permanent and throttling to retryable, never sends without a message id', async () => {
    await expect(new SesEmailSender({}).send({ from: 'a@b.example', to: ['c@d.example'], cc: [] }, 'raw')).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED', permanent: false })
    const env = { EMAIL_FROM: 'res@fbeds.example', EMAIL_SES_REGION: 'me-central-1' }
    const fail = (name: string) => new SesEmailSender(env, () => ({ send: async () => { const e = new Error('x'); e.name = name; throw e } }) as never)
    await expect(fail('MessageRejected').send({ from: 'a@b.example', to: ['c@d.example'], cc: [] }, 'raw')).rejects.toEqual(new EmailSendError('SES_MESSAGEREJECTED', true))
    await expect(fail('TooManyRequestsException').send({ from: 'a@b.example', to: ['c@d.example'], cc: [] }, 'raw')).rejects.toMatchObject({ permanent: false })
    const calls: unknown[] = []
    const ok = new SesEmailSender(env, () => ({ send: async (command: { input: unknown }) => { calls.push(command.input); return { MessageId: 'ses-1' } } }) as never)
    await expect(ok.send({ from: 'a@b.example', to: ['c@d.example'], cc: ['e@f.example'] }, 'raw-mime')).resolves.toEqual({ messageId: 'ses-1' })
    expect(calls[0]).toMatchObject({ FromEmailAddress: 'a@b.example', Destination: { ToAddresses: ['c@d.example'], CcAddresses: ['e@f.example'] } })
    const empty = new SesEmailSender(env, () => ({ send: async () => ({}) }) as never)
    await expect(empty.send({ from: 'a@b.example', to: ['c@d.example'], cc: [] }, 'raw')).rejects.toMatchObject({ code: 'SES_NO_MESSAGE_ID' })
  })
})
