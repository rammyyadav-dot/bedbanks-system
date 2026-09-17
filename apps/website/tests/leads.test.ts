import assert from 'node:assert/strict'
import test from 'node:test'
import { submitLead } from '../lib/leads/lead-adapter'
import { validateLead, type LeadInput } from '../lib/leads/validation'
const validLead: LeadInput = { fullName: 'Asha Patel', businessEmail: 'asha@example.com', company: 'Example Travel', market: 'United Kingdom', businessType: 'Travel agency', monthlyVolume: '100–999', interestArea: 'B2B distribution', message: 'We need to review a controlled distribution workflow.', consent: true, website: '' }
test('accepts a complete qualified lead model', () => assert.deepEqual(validateLead(validLead), {}))
test('returns field errors and rejects the honeypot', () => { const errors = validateLead({ ...validLead, businessEmail: 'invalid', consent: false, website: 'spam.test' }); assert.ok(errors.businessEmail); assert.ok(errors.consent); assert.ok(errors.form) })
test('reports disconnected submission without false success', async () => assert.deepEqual(await submitLead(validLead, { endpoint: '' }), { status: 'not_configured' }))
test('requires explicit accepted confirmation from the endpoint', async () => { const result = await submitLead(validLead, { endpoint: 'https://leads.example.test', fetcher: async () => new Response('{}', { status: 200 }) }); assert.equal(result.status, 'failed') })
test('returns success only after confirmed acceptance', async () => { const result = await submitLead(validLead, { endpoint: 'https://leads.example.test', fetcher: async () => Response.json({ accepted: true, reference: 'lead-1' }) }); assert.deepEqual(result, { status: 'success', reference: 'lead-1' }) })
test('handles lead service errors without throwing', async () => { const result = await submitLead(validLead, { endpoint: 'https://leads.example.test', fetcher: async () => { throw new Error('offline') } }); assert.deepEqual(result, { status: 'failed', message: 'The enquiry service is temporarily unavailable.' }) })
