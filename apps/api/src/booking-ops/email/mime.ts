import { randomBytes } from 'crypto'

export interface MimeAttachment { filename: string; contentType: string; content: string }
export interface MimeMessage { from: string; to: string[]; cc: string[]; subject: string; html: string; text: string; attachments: MimeAttachment[]; messageIdDomain?: string }

/** Header values never carry a line break: that is how header injection works. */
const headerValue = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
const ascii = (value: string) => /^[\x20-\x7e]*$/.test(value)
/** RFC 2047 encoded word for non-ASCII header text. */
const encodeWord = (value: string) => ascii(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
/** Base64 wrapped at 76 characters (RFC 2045). */
const base64 = (value: string) => (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
const safeFilename = (value: string) => headerValue(value).replace(/["\\/]/g, '_').slice(0, 120) || 'attachment'

/**
 * A multipart/mixed message: a text + HTML alternative, then the attachments. Every body part is base64, so no content can break out of its part,
 * and boundaries are random. Pure: the caller supplies already-escaped HTML.
 */
export function buildMime(message: MimeMessage, boundarySeed = randomBytes(12).toString('hex')): string {
  const mixed = `mixed_${boundarySeed}`
  const alternative = `alt_${boundarySeed}`
  const lines = [
    `From: ${headerValue(message.from)}`,
    `To: ${message.to.map(headerValue).join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(headerValue).join(', ')}`] : []),
    `Subject: ${encodeWord(headerValue(message.subject))}`,
    'MIME-Version: 1.0', // no-float-check: display-only (protocol header version, not an amount)
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    '',
    `--${alternative}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(message.text),
    `--${alternative}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(message.html),
    `--${alternative}--`,
  ]
  for (const attachment of message.attachments) {
    const name = safeFilename(attachment.filename)
    lines.push(`--${mixed}`, `Content-Type: ${headerValue(attachment.contentType)}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', base64(attachment.content))
  }
  lines.push(`--${mixed}--`, '')
  return lines.join('\r\n')
}
