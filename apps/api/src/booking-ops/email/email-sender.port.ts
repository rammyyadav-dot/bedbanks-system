/**
 * Sends one already-built MIME message (ADR 0066). Implementations never log addresses, names or the body.
 * `EmailSendError.permanent` means retrying cannot help (a rejected message or address); anything else is retried.
 */
export interface EmailEnvelope { from: string; to: string[]; cc: string[] }
export interface EmailSender {
  readonly name: string
  configured(): boolean
  send(envelope: EmailEnvelope, rawMime: string): Promise<{ messageId: string }>
}

export class EmailSendError extends Error {
  constructor(readonly code: string, readonly permanent: boolean) { super(code); this.name = 'EmailSendError' }
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER')
