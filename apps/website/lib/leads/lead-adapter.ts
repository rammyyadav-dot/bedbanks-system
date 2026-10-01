import { isIP } from 'node:net'
import { MIN_SECRET_LENGTH, signLeadRequest } from './signing'
import type { LeadInput } from './validation'

export type LeadResult = { status: 'success'; reference?: string } | { status: 'not_configured' } | { status: 'failed'; message: string }
export type LeadAdapterOptions = { endpoint?: string; signingSecret?: string; fetcher?: typeof fetch; timeoutMs?: number; log?: (event: string) => void }

const FAILURE = { unavailable: 'The enquiry service is temporarily unavailable.', rejected: 'The enquiry service did not accept the request.', unconfirmed: 'The enquiry service did not confirm the request.', config: 'The lead service is not configured correctly.' } as const

/** Only reason codes are logged: never lead fields, the endpoint URL, the secret or response bodies. */
const defaultLog = (event: string) => console.error(`[lead] ${event}`)

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host) === 4) { const [a, b] = host.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) }
  if (isIP(host) === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  return false
}

export async function submitLead(input: Omit<LeadInput, 'website'>, options: LeadAdapterOptions = {}): Promise<LeadResult> {
  const log = options.log ?? defaultLog
  const endpoint = options.endpoint ?? process.env.FBEDS_LEAD_ENDPOINT_URL
  if (!endpoint) return { status: 'not_configured' }
  let target: URL
  try { target = new URL(endpoint) } catch { log('endpoint_invalid'); return { status: 'failed', message: FAILURE.config } }
  const production = process.env.NODE_ENV === 'production'
  if (target.username || target.password) { log('endpoint_has_credentials'); return { status: 'failed', message: FAILURE.config } }
  if (production && (target.protocol !== 'https:' || privateHost(target.hostname))) { log('endpoint_not_public_https'); return { status: 'failed', message: FAILURE.config } }

  // Fail closed: an unsigned lead request is never sent.
  const secret = options.signingSecret ?? process.env.FBEDS_LEAD_SIGNING_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) { log('signing_secret_missing_or_short'); return { status: 'failed', message: FAILURE.config } }

  const body = JSON.stringify(input)
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try {
    const response = await (options.fetcher ?? fetch)(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...signLeadRequest(secret, body) },
      body, signal: controller.signal, cache: 'no-store', redirect: 'error',
    })
    if (!response.ok) { log(`receiver_status_${response.status}`); return { status: 'failed', message: FAILURE.rejected } }
    const payload = await response.json().catch(() => ({})) as { accepted?: boolean; reference?: string }
    if (payload.accepted !== true) { log('receiver_not_accepted'); return { status: 'failed', message: FAILURE.unconfirmed } }
    return { status: 'success', reference: typeof payload.reference === 'string' ? payload.reference : undefined }
  } catch { log('receiver_unreachable'); return { status: 'failed', message: FAILURE.unavailable } } finally { clearTimeout(timeout) }
}
