import type { LeadErrors } from './validation'
export type DemoFormState = { status: 'idle' | 'invalid' | 'not_configured' | 'failed' | 'success'; errors: LeadErrors; message?: string }
