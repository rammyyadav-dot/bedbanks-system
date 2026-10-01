'use server'
import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { createRateLimiter } from '../../lib/leads/rate-limit'
import { processLeadSubmission } from '../../lib/leads/process'
import type { DemoFormState } from '../../lib/leads/state'

export type { DemoFormState }

// Per-instance and best-effort only; the edge rate-limit rule in the README is the primary control.
const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 })

async function clientId(): Promise<string> {
  const list = await headers()
  const address = list.get('x-vercel-forwarded-for') ?? list.get('x-real-ip') ?? list.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  return createHash('sha256').update(address).digest('hex').slice(0, 32)
}

export async function submitDemoRequest(_previous: DemoFormState, formData: FormData): Promise<DemoFormState> {
  return processLeadSubmission(formData, { limiter, clientId: await clientId() })
}
