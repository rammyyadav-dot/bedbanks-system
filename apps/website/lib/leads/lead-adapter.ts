import type { LeadInput } from './validation'
export type LeadResult = { status: 'success'; reference?: string } | { status: 'not_configured' } | { status: 'failed'; message: string }
export type LeadAdapterOptions = { endpoint?: string; fetcher?: typeof fetch; timeoutMs?: number }
export async function submitLead(input: Omit<LeadInput, 'website'>, options: LeadAdapterOptions = {}): Promise<LeadResult> {
  const endpoint = options.endpoint ?? process.env.FBEDS_LEAD_ENDPOINT_URL
  if (!endpoint) return { status: 'not_configured' }
  let target: URL
  try { target = new URL(endpoint) } catch { return { status: 'failed', message: 'The lead service is not configured with a valid URL.' } }
  if (target.protocol !== 'https:' && process.env.NODE_ENV === 'production') return { status: 'failed', message: 'The lead service requires HTTPS.' }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try { const response = await (options.fetcher ?? fetch)(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input), signal: controller.signal, cache: 'no-store' }); if (!response.ok) return { status: 'failed', message: 'The enquiry service did not accept the request.' }; const payload = await response.json().catch(() => ({})) as { accepted?: boolean; reference?: string }; if (payload.accepted !== true) return { status: 'failed', message: 'The enquiry service did not confirm the request.' }; return { status: 'success', reference: typeof payload.reference === 'string' ? payload.reference : undefined } } catch { return { status: 'failed', message: 'The enquiry service is temporarily unavailable.' } } finally { clearTimeout(timeout) }
}
