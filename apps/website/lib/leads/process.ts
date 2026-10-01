import { submitLead, type LeadAdapterOptions } from './lead-adapter'
import type { RateLimiter } from './rate-limit'
import type { DemoFormState } from './state'
import { leadFromFormData, validateLead } from './validation'

/** Identical for accepted and honeypot submissions so a bot cannot tell which one it hit. */
const GENERIC_SUCCESS: DemoFormState = { status: 'success', errors: {} }

export type ProcessDeps = {
  limiter: RateLimiter
  clientId: string
  submit?: (lead: Parameters<typeof submitLead>[0], options?: LeadAdapterOptions) => ReturnType<typeof submitLead>
  adapterOptions?: LeadAdapterOptions
  /** Pads the honeypot path so it is not trivially faster than a real submission. */
  pause?: (ms: number) => Promise<void>
  random?: () => number
}

export async function processLeadSubmission(formData: FormData, deps: ProcessDeps): Promise<DemoFormState> {
  const limit = deps.limiter.check(deps.clientId)
  if (!limit.allowed) return { status: 'failed', errors: { form: 'Too many requests.' }, message: 'Too many requests. Please try again later or use the email option below.' }

  const lead = leadFromFormData(formData)
  if (lead.website) {
    const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    await pause(300 + Math.floor((deps.random ?? Math.random)() * 500))
    return GENERIC_SUCCESS
  }

  const errors = validateLead(lead)
  if (Object.keys(errors).length) return { status: 'invalid', errors }

  const { website: _honeypot, ...payload } = lead
  const result = await (deps.submit ?? submitLead)(payload, deps.adapterOptions)
  if (result.status === 'success') return GENERIC_SUCCESS
  if (result.status === 'not_configured') return { status: 'not_configured', errors: {}, message: 'Online lead submission is not configured yet. Please use the email option below.' }
  return { status: 'failed', errors: { form: result.message }, message: result.message }
}
