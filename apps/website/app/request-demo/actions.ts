'use server'
import { submitLead } from '../../lib/leads/lead-adapter'
import { leadFromFormData, validateLead, type LeadErrors } from '../../lib/leads/validation'
export type DemoFormState = { status: 'idle' | 'invalid' | 'not_configured' | 'failed' | 'success'; errors: LeadErrors; message?: string }
export const initialDemoFormState: DemoFormState = { status: 'idle', errors: {} }
export async function submitDemoRequest(_previous: DemoFormState, formData: FormData): Promise<DemoFormState> { const lead = leadFromFormData(formData); const errors = validateLead(lead); if (Object.keys(errors).length) return { status: 'invalid', errors }; const { website: _honeypot, ...payload } = lead; const result = await submitLead(payload); if (result.status === 'success') return { status: 'success', errors: {}, message: result.reference ? `Reference: ${result.reference}` : undefined }; if (result.status === 'not_configured') return { status: 'not_configured', errors: {}, message: 'Online lead submission is not configured yet. Please use the email option below.' }; return { status: 'failed', errors: { form: result.message }, message: result.message } }
